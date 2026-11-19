import type { ArchivedCall } from "./tokens.ts"
import { planCut, renderHandoff, resolveMemory, type Checkpoint, type Episode, type Pending, type Row } from "./memory.ts"
import { object } from "./guards.ts"
import { episodeNote } from "./working.ts"
import { closeCycle, effectiveBudget, thermostatModels, type BudgetBounds, type ThermostatEntry, type ThermostatModels } from "./thermostat.ts"

// The v2 storage domain accepts JSON; storing serialized records also keeps rows as plain text.
export type Storage = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: string) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan: (options: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => Promise<{
    readonly entries: readonly { readonly key: string; readonly value: unknown }[]
    readonly next?: string
  }>
}

export type DeferredCompaction = {
  readonly checkpoint: string | null
  readonly after: string
  readonly tokens: number
}

/** A graduated episode note at `project/episodes/P<n>`: the searchable pointer that
 *  outlives its session. Notes only — raw transcripts and calls die with the session. */
export type GraduatedNote = { readonly id: string; readonly note: string; readonly session: string; readonly end: number }
/** The project archive keeps at most this many graduated notes, most recent first. */
export const GRADUATE_CAP = 200

/** Per-session counts of budget-gate outcomes. Telemetry only: never a trigger input. */
export type GateStats = {
  gates: number; silent: number; continued: number; repaid: number
  deferPrompted: number; deferGranted: number; deferUserRefused: number; deferPhysicsRefused: number
  checkpoints: number
  precomputes: number; precomputeHits: number; gateAliases: number
}

const ZERO_STATS: GateStats = {
  gates: 0, silent: 0, continued: 0, repaid: 0,
  deferPrompted: 0, deferGranted: 0, deferUserRefused: 0, deferPhysicsRefused: 0,
  checkpoints: 0,
  precomputes: 0, precomputeHits: 0, gateAliases: 0,
}
const statsShape = (value: unknown): value is GateStats =>
  object(value) && Object.keys(ZERO_STATS).every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)

const encode = (value: unknown): string => {
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error("Record is not JSON serializable")
  return text
}
const decode = <T>(value: unknown, key: string): T | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`Invalid stored record: ${key}`)
  try { return JSON.parse(value) as T } catch { throw new Error(`Invalid stored JSON: ${key}`) }
}
const archivedCall = (value: unknown, id: string): ArchivedCall => {
  if (!object(value) || value.id !== id || typeof value.name !== "string" || !("input" in value) ||
      !object(value.result) || typeof value.result.type !== "string" || !("value" in value.result)) throw new Error("Invalid archived call")
  return value as ArchivedCall
}
type Reporter = (message: string, error?: unknown) => void
const defaultReport: Reporter = (message, error) => {
  const detail = error instanceof Error ? `: ${error.message}` : ""
  console.warn(`[nextdcp] ${message}${detail}`)
}

// Host contexts wrap the same plugin namespace in different objects. Share locks
// across contexts AND hot-reloaded modules; idle queues remove themselves.
const QUEUES = Symbol.for("nextdcp.write-queues.v1")
const shared = globalThis as typeof globalThis & { [QUEUES]?: Map<string, Promise<void>> }
const queues = shared[QUEUES] ??= new Map<string, Promise<void>>()
export function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).then(work)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(key, tail)
  return result.finally(() => { if (queues.get(key) === tail) queues.delete(key) })
}

// Match v2's conversion of completed rows to provider tool results, while retaining errors too.
export function rowCalls(row: Row): ArchivedCall[] {
  if (row.type !== "assistant") return []
  const calls: ArchivedCall[] = []
  for (const part of row.content ?? []) {
    if (!object(part) || part.type !== "tool" || typeof part.id !== "string" || typeof part.name !== "string" || !object(part.state)) continue
    const state = part.state
    if (state.status === "completed") {
      const content = Array.isArray(state.content) ? state.content : []
      const single = content.length === 1 ? content[0] : undefined
      const result = content.length === 0 ? { type: "text", value: "" } : object(single) && single.type === "text" && typeof single.text === "string"
        ? { type: "text", value: single.text }
        : { type: "content", value: content }
      calls.push({ id: part.id, name: part.name, input: state.input, result })
    } else if (state.status === "error") {
      calls.push({ id: part.id, name: part.name, input: state.input, result: { type: "error", value: { error: state.error, content: state.content ?? [] } } })
    }
  }
  return calls
}

/** A project-scoped, JSON-only wrapper: records shared by every session of this
 *  project instance. Failure-tolerant by contract — the callers treat these as
 *  advisory and must never let them block a trigger or a cut. */
export function createProjectStore(storage: Storage, report: Reporter = defaultReport) {
  const thermostatKey = "project/thermostat"
  const episodesPrefix = "project/episodes/"
  const graduatedKey = (id: string) => `${episodesPrefix}${id}`
  const get = async <T>(name: string) => decode<T>(await storage.get(name), name)
  const put = async (name: string, value: unknown) => storage.set(name, encode(value))
  // A record that cannot even be decoded is treated as absent: the next write
  // self-heals over it rather than permanently blocking the loop.
  const readModels = async (): Promise<ThermostatModels> => {
    try { return thermostatModels(await get<unknown>(thermostatKey)) }
    catch (error) { report("Unable to read the budget thermostat; using defaults", error); return {} }
  }
  const graduatedRecord = (value: unknown, id: string): GraduatedNote | undefined =>
    object(value) && value.id === id && typeof value.note === "string" && value.note &&
    typeof value.session === "string" && value.session && typeof value.end === "number" && Number.isFinite(value.end) && value.end >= 0
      ? { id, note: value.note, session: value.session, end: value.end } : undefined
  const scanGraduated = async (): Promise<GraduatedNote[]> => {
    const found: GraduatedNote[] = []
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix: episodesPrefix, after, limit: 500 })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(episodesPrefix)) throw new Error("Invalid storage scan entry")
        const id = decodeURIComponent(entry.key.slice(episodesPrefix.length))
        // One undecodable record is skipped, not fatal: the rest of the archive stays readable.
        try {
          const record = graduatedRecord(decode<unknown>(entry.value, entry.key), id)
          if (record) found.push(record)
        } catch { /* unreadable note */ }
      }
      if (page.next !== undefined && page.next === after) throw new Error("Storage scan did not advance")
      after = page.next
    } while (after !== undefined)
    return found
  }
  return {
    /** The learned thermostat state per model, dropping corrupt entries. */
    readThermostat: () => readModels(),
    /** Fold one completed cycle into a model's entry and persist it. Returns the
     *  new entry, or undefined when storage failed (reported, never thrown). */
    closeCycle: async (model: string, recalls: number, bounds: BudgetBounds): Promise<ThermostatEntry | undefined> => {
      try {
        return await exclusive(thermostatKey, async () => {
          const models = await readModels()
          const entry = closeCycle(models[model], recalls, bounds)
          await put(thermostatKey, { ...models, [model]: entry })
          return entry
        })
      } catch (error) {
        report(`Unable to record a thermostat cycle for ${model}`, error)
        return undefined
      }
    },
    /** The project's graduated notes, dropping corrupt records. */
    graduatedNotes: async (): Promise<GraduatedNote[]> => {
      try { return await scanGraduated() }
      catch (error) { report("Unable to read graduated notes", error); return [] }
    },
    /** Graduate episode notes into the project archive: notes only, deduplicated by
     *  exact text (fork copies), numbered above the highest existing P<n>, kept to
     *  the 200 most recent. Returns how many notes were added; failures are
     *  reported, never thrown. */
    graduate: async (notes: readonly { readonly note: string; readonly end: number }[], session: string): Promise<number> => {
      try {
        return await exclusive(episodesPrefix, async () => {
          const existing = await scanGraduated()
          const texts = new Set(existing.map((one) => one.note))
          let next = existing.reduce((highest, one) => Math.max(highest, Number(/^P(\d+)$/.exec(one.id)?.[1] ?? 0)), 0) + 1
          const kept = [...existing]
          let added = 0
          for (const item of notes) {
            if (!item.note || texts.has(item.note)) continue
            texts.add(item.note)
            const record: GraduatedNote = { id: `P${next++}`, note: item.note, session, end: item.end }
            kept.push(record)
            await put(graduatedKey(record.id), record)
            added++
          }
          // The cap keeps the most recent notes; overflow is removed, oldest first.
          for (const old of kept.sort((a, b) => b.end - a.end).slice(GRADUATE_CAP)) await storage.remove(graduatedKey(old.id))
          return added
        })
      } catch (error) {
        report("Unable to graduate session notes", error)
        return 0
      }
    },
  }
}

/** A session-scoped, JSON-only wrapper over the verified v2 plugin storage API. */
export function createStore(storage: Storage, sessionID: string, report: Reporter = defaultReport) {
  const root = `sessions/${encodeURIComponent(sessionID)}/`
  const key = (kind: string, id: string) => `${root}${kind}/${encodeURIComponent(id)}`
  const counterKey = `${root}episode-counter`
  const deferredKey = `${root}deferred-compaction`
  const statsKey = `${root}gate-stats`
  const get = async <T>(name: string) => decode<T>(await storage.get(name), name)
  const put = async (name: string, value: unknown) => storage.set(name, encode(value))
  const getDeferredCompaction = async (): Promise<DeferredCompaction | undefined> => {
    const value = await get<unknown>(deferredKey)
    if (value === undefined) return undefined
    if (!object(value) || (value.checkpoint !== null && typeof value.checkpoint !== "string") ||
        typeof value.after !== "string" || typeof value.tokens !== "number" || !Number.isFinite(value.tokens) || value.tokens < 0) {
      throw new Error("Invalid deferred compaction")
    }
    return value as DeferredCompaction
  }
  const saveDeferredCompaction = (value: DeferredCompaction) => put(deferredKey, value)
  /** Count one gate event and return the new totals. Failures are reported, never thrown:
   *  telemetry must not break a trigger. */
  const countGate = async (field: keyof GateStats): Promise<GateStats | undefined> => {
    try {
      return await exclusive(statsKey, async () => {
        const stored = await get<unknown>(statsKey)
        if (stored !== undefined && !statsShape(stored)) throw new Error(`Invalid gate stats record: ${statsKey}`)
        const stats: GateStats = stored === undefined ? { ...ZERO_STATS } : stored
        const next = { ...stats, [field]: stats[field] + 1 }
        await put(statsKey, next)
        return next
      })
    } catch (error) {
      report(`Unable to count gate event "${field}"`, error)
      return undefined
    }
  }
  const getGateStats = async (): Promise<GateStats> => {
    const stored = await get<unknown>(statsKey)
    if (stored !== undefined && !statsShape(stored)) throw new Error(`Invalid gate stats record: ${statsKey}`)
    return stored === undefined ? { ...ZERO_STATS } : stored as GateStats
  }
  const hasInherited = async () => {
    const source = await get<unknown>(`${root}fork`)
    if (source !== undefined && typeof source !== "string") throw new Error("Invalid fork archive marker")
    return source !== undefined
  }

  const getRow = async (id: string): Promise<string | undefined> => {
    const name = key("rows", id), value = await storage.get(name)
    if (value !== undefined && typeof value !== "string") throw new Error(`Invalid archived row: ${name}`)
    return value as string | undefined
  }
  const getCall = async (id: string): Promise<ArchivedCall | undefined> => {
    const value = await get<unknown>(key("calls", id))
    return value === undefined ? undefined : archivedCall(value, id)
  }
  const saveCall = async (call: ArchivedCall): Promise<boolean> => {
    try {
      return await exclusive(key("calls", call.id), async () => {
        // The first complete original wins.
        const existing = await getCall(call.id)
        if (existing === undefined) {
          archivedCall(JSON.parse(encode(call)), call.id)
          await put(key("calls", call.id), call)
          return true
        }
        if (existing.name === call.name && encode(existing.input) === encode(call.input) && encode(existing.result) === encode(call.result)) return true
        report(`Conflicting archived tool call id ${call.id}; keeping the first original`)
        return false
      })
    } catch (error) {
      report(`Unable to archive tool call ${call.id}`, error)
      return false
    }
  }
  const archiveRows = async (rows: readonly Row[]): Promise<boolean> => {
    const seen = new Set<string>()
    let complete = true
    for (const row of rows) {
      if (!object(row) || typeof row.id !== "string" || seen.has(row.id)) {
        report("Invalid or duplicate archived row id")
        complete = false
        continue
      }
      seen.add(row.id)
      try { await storage.set(key("rows", row.id), encode(row)) } catch (error) {
        report(`Unable to archive row ${row.id}`, error)
        complete = false
      }
      try {
        for (const call of rowCalls(row)) if (!await saveCall(call)) complete = false
      } catch (error) {
        report(`Unable to index calls in row ${row.id}`, error)
        complete = false
      }
    }
    return complete
  }
  const getPending = (id: string) => get<Pending>(key("pending", id))
  const prepareArchive = async (rows: readonly Row[]): Promise<Pending> => {
    const cut = planCut(rows)
    const pending: Pending = { id: cut.checkpoint, parent: cut.parent, rowIDs: cut.rowIDs, archived: false }
    await put(key("pending", pending.id), pending)
    // Historical rows are immutable. Re-save only this cut and its completed parent
    // (which was still running when the preceding cut was archived).
    const needed = new Set([...cut.rowIDs, ...(cut.parent ? [cut.parent] : [])])
    const complete = await archiveRows(rows.filter((row) => needed.has(row.id)))
    if (!complete) return pending
    const archived = { ...pending, archived: true }
    await put(key("pending", pending.id), archived)
    return archived
  }
  const getCheckpoint = (id: string) => get<Checkpoint>(key("checkpoints", id))
  const saveCheckpoint = (checkpoint: Checkpoint) => put(key("checkpoints", checkpoint.id), checkpoint)
  /** Every committed episode's note text and end time, unreadable records skipped:
   *  the graduation input when this session is deleted. */
  const episodeNotes = async (): Promise<{ readonly note: string; readonly end: number }[]> => (await all("checkpoints")).flatMap(({ id, value }) => {
    try {
      const record = decode<Checkpoint>(value, key("checkpoints", id))
      if (!record || record.id !== id || !object(record.episode) || typeof record.episode.summary !== "string") return []
      const { title, body } = episodeNote(record.episode.summary)
      const note = [title, body].filter(Boolean).join("\n")
      if (!note) return []
      const end = record.episode.end
      return [{ note, end: typeof end === "number" && Number.isFinite(end) && end >= 0 ? end : Date.now() }]
    } catch { return [] }
  })
  const chain = async (id: string | null): Promise<Map<string, Checkpoint>> => {
    const result = new Map<string, Checkpoint>()
    while (id !== null) {
      if (result.has(id)) throw new Error("Cyclic checkpoint chain")
      const checkpoint = await getCheckpoint(id)
      if (!checkpoint || checkpoint.id !== id) throw new Error("Missing checkpoint in memory chain")
      result.set(id, checkpoint)
      id = checkpoint.parent
    }
    return result
  }
  const nextEpisode = () => exclusive(counterKey, async () => {
    const previous = await get<unknown>(counterKey) ?? 0
    if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid episode counter")
    const next = previous + 1
    await put(counterKey, next)
    return `E${next}`
  })
  /** Record the episode id a cycle reserved, inside its pending record: a native
   *  fallback adopting that checkpoint reuses the id, so the counter never burns
   *  a number on a failed generation and the catalog shows no holes. */
  const pendingEpisode = async (id: string, episode: string) => {
    const stored = await getPending(id)
    if (stored && stored.episode !== episode) await put(key("pending", id), { ...stored, episode })
  }
  /** Whether any committed checkpoint already carries this episode id: a reservation
   *  left by an abandoned branch (revert, precompute) must never be reused then. */
  const episodeCommitted = async (episode: string): Promise<boolean> => {
    for (const { id, value } of await all("checkpoints")) {
      try { if (decode<Checkpoint>(value, key("checkpoints", id))?.episode?.id === episode) return true } catch { /* unreadable record */ }
    }
    return false
  }
  /** The episode id for a cut below this checkpoint. A failed gate-window precompute
   *  leaves its reservation here; the next cut for the same parent (or the next
   *  precompute over it) reuses it — unless the id was committed in the meantime by
   *  a branch that has since been reverted away. */
  const reservedEpisode = async (parent: string | null): Promise<string> => {
    if (parent !== null) {
      const reserved = await get<string>(key("reserved", parent))
      if (typeof reserved === "string" && reserved && !(await episodeCommitted(reserved))) return reserved
    }
    const episode = await nextEpisode()
    if (parent !== null) await put(key("reserved", parent), episode)
    return episode
  }
  const all = async (kind: string): Promise<{ id: string; value: unknown }[]> => {
    const prefix = `${root}${kind}/`, result: { id: string; value: unknown }[] = []
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix, after, limit: 500 })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(prefix)) throw new Error("Invalid storage scan entry")
        result.push({ id: decodeURIComponent(entry.key.slice(prefix.length)), value: entry.value })
      }
      if (page.next !== undefined && page.next === after) throw new Error("Storage scan did not advance")
      after = page.next
    } while (after !== undefined)
    return result
  }
  /** Reconstruct only the checkpoint and tail at a historical fork boundary.
   * Pending cuts retain chronological row IDs, even after compaction or revert.
   */
  const forkSnapshot = async (boundary: { readonly messageID: string; readonly type: "before" | "through" }, live: readonly Row[]): Promise<readonly Row[]> => {
    const index = live.findIndex((row) => row.id === boundary.messageID)
    if (index >= 0) return live.slice(0, index + (boundary.type === "through" ? 1 : 0))
    const cuts = (await all("pending")).map(({ id, value }) => {
      const cut = decode<Pending>(value, key("pending", id))
      if (!cut || cut.id !== id || !Array.isArray(cut.rowIDs) || !cut.rowIDs.every((rowID) => typeof rowID === "string") ||
          (cut.parent !== null && typeof cut.parent !== "string")) throw new Error("Invalid archived fork boundary")
      return cut
    })
    const cut = cuts.find((cut) => cut.id === boundary.messageID) ?? cuts.find((cut) => cut.rowIDs.includes(boundary.messageID))
    if (!cut) throw new Error("Fork boundary is unavailable in the parent history and archive")
    const ids = [...(cut.parent ? [cut.parent] : []), ...cut.rowIDs, cut.id]
    const end = ids.indexOf(boundary.messageID) + (boundary.type === "through" ? 1 : 0)
    const snapshot: Row[] = []
    for (const id of ids.slice(0, end)) {
      const raw = await getRow(id)
      if (raw === undefined) {
        if (id === cut.parent || id === cut.id) {
          // A revert may hide a completed checkpoint before the next cut saves its
          // native row. Recreate only its matching summary from durable records;
          // do not manufacture or store an allegedly original transcript row.
          const record = await getCheckpoint(id)
          if (!record) throw new Error("Missing archived fork checkpoint")
          const summary = record.episode.native ? record.episode.summary : renderHandoff(resolveMemory(id, await chain(id)))
          snapshot.push({ id, type: "compaction", status: "completed", summary })
          continue
        }
        // A missing live-tail row is still copied by OpenCode into the child.
        // Completed episodes already disclose their archive gaps separately.
        continue
      }
      const row = JSON.parse(raw) as Row
      if (row.id !== id) throw new Error("Invalid archived fork row")
      snapshot.push(row)
    }
    return snapshot
  }
  // Forks get fresh row IDs and a new plugin-storage namespace. Match checkpoint
  // summaries against the parent's fork-boundary snapshot, then copy only that branch.
  const inherit = (sourceSessionID: string, rows: readonly Row[], sourceRows: readonly Row[] = rows): Promise<void> => exclusive(`${root}fork`, async () => {
    if (await hasInherited()) return
    if (sourceSessionID === sessionID) throw new Error("Cyclic fork ancestry")
    const source = createStore(storage, sourceSessionID, report)
    const rowIDs = new Set(rows.map((row) => row.id))
    const sourceCheckpoints = sourceRows.filter((row) => row.type === "compaction" && row.status === "completed")
    const aliases = new Map<string, string>()
    let before = sourceCheckpoints.length
    for (const row of rows.filter((row) => row.type === "compaction" && row.status === "completed").reverse()) {
      const index = sourceCheckpoints.findLastIndex((item, index) => index < before &&
        (item.id === row.id || typeof row.summary === "string" && item.summary === row.summary))
      if (index < 0) continue // A pre-existing fork may already have checkpoints of its own.
      aliases.set(sourceCheckpoints[index].id, row.id)
      before = index
    }
    if (sourceCheckpoints.length && !aliases.size) throw new Error("Unable to match inherited checkpoint")
    const tail = sourceRows.findLastIndex((row) => row.type === "compaction" && row.status === "completed") + 1
    for (const row of sourceRows.slice(tail)) rowIDs.add(row.id)
    const checkpoints = new Set<string>()
    let highest = 0
    const collect = (episodes: readonly Episode[]) => {
      for (const episode of episodes) {
        const match = /^E(\d+)$/.exec(episode.id)
        if (!match) throw new Error("Invalid inherited episode ID")
        highest = Math.max(highest, Number(match[1]))
        for (const rowID of episode.rowIDs) rowIDs.add(rowID)
      }
    }
    let active: string | null = [...aliases.keys()][0] ?? null
    while (active !== null) {
      if (checkpoints.has(active)) throw new Error("Cyclic checkpoint chain")
      checkpoints.add(active)
      rowIDs.add(active)
      const record = await source.getCheckpoint(active)
      const boundary = await source.getPending(active)
      const id = aliases.get(active) ?? active
      if (record) {
        collect([record.episode])
        if (!await getCheckpoint(id)) await saveCheckpoint({ ...record, id, parent: record.parent === null ? null : aliases.get(record.parent) ?? record.parent })
      }
      if (boundary) {
        for (const rowID of boundary.rowIDs) rowIDs.add(rowID)
        if (!await getPending(id)) await put(key("pending", id), { ...boundary, id, parent: boundary.parent === null ? null : aliases.get(boundary.parent) ?? boundary.parent })
      }
      active = record ? record.parent : boundary?.parent ?? null
    }
    const calls = new Set<string>()
    for (const row of [...rows, ...sourceRows.slice(tail)]) for (const call of rowCalls(row)) calls.add(call.id)
    for (const id of rowIDs) {
      const raw = await source.getRow(id)
      if (raw === undefined) continue
      if (await getRow(id) === undefined) await storage.set(key("rows", id), raw)
      for (const call of rowCalls(JSON.parse(raw) as Row)) calls.add(call.id)
    }
    for (const id of calls) {
      const call = await source.getCall(id)
      if (call && !await saveCall(call)) throw new Error(`Unable to inherit tool call ${id}`)
    }
    // Reserve above inherited IDs, including episodes hidden by merges/reverts.
    await exclusive(counterKey, async () => {
      const own = await get<number>(counterKey) ?? 0
      const parent = await get<number>(`sessions/${encodeURIComponent(sourceSessionID)}/episode-counter`) ?? 0
      if (!Number.isSafeInteger(own) || own < 0 || !Number.isSafeInteger(parent) || parent < 0) throw new Error("Invalid episode counter")
      if (!Number.isSafeInteger(highest)) throw new Error("Invalid inherited episode ID")
      await put(counterKey, Math.max(own, parent, highest))
    })
    // Last write is the commit marker; partial imports are safe to retry.
    await put(`${root}fork`, sourceSessionID)
  })
  const getRows = async (): Promise<{ id: string; text: string }[]> => (await all("rows")).map(({ id, value }) => {
    if (typeof value !== "string") throw new Error("Invalid archived row")
    return { id, text: value }
  })
  const getCalls = async (): Promise<ArchivedCall[]> => (await all("calls")).map(({ id, value }) => {
    return archivedCall(decode<unknown>(value, key("calls", id)), id)
  })
  /** Remove every record of a deleted session, including keys written outside this store. */
  const clear = async () => {
    // A prefix scan of the session root replaces any per-kind list: preferences and
    // warnings live under the same root but are not written through this store.
    const keys: string[] = []
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix: root, after, limit: 500 })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(root)) throw new Error("Invalid storage scan entry")
        keys.push(entry.key)
      }
      if (page.next !== undefined && page.next === after) throw new Error("Storage scan did not advance")
      after = page.next
    } while (after !== undefined)
    for (const key of keys) await storage.remove(key)
  }
  return { getRow, getRows, getCall, getCalls, saveCall, archiveRows, prepareArchive, getPending, pendingEpisode, getCheckpoint, saveCheckpoint, chain, nextEpisode, reservedEpisode, episodeNotes, hasInherited, inherit, forkSnapshot, getDeferredCompaction, saveDeferredCompaction, countGate, getGateStats, clear }
}
