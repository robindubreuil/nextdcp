import { renderMask, type ArchivedCall, type Mask, type MaskPlan } from "./mask.ts"
import { planCut, renderHandoff, resolveMemory, type Checkpoint, type Episode, type Pending, type Row } from "./memory.ts"

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

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
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
const hasInputStub = (value: unknown): boolean => typeof value === "string"
  ? value.startsWith("[Input elided to save context:")
  : Array.isArray(value) ? value.some(hasInputStub) : object(value) ? Object.values(value).some(hasInputStub) : false
const hasOutputStub = (call: ArchivedCall) => call.result.type === "text" && typeof call.result.value === "string" && call.result.value.startsWith("[Output elided to save context:")
type Reporter = (message: string, error?: unknown) => void
const defaultReport: Reporter = (message, error) => {
  const detail = error instanceof Error ? `: ${error.message}` : ""
  console.warn(`[nextdcp] ${message}${detail}`)
}

function validField(field: unknown): boolean {
  return object(field) && typeof field.stub === "string" && Array.isArray(field.path) &&
    field.path.every((part: unknown) => typeof part === "string" || typeof part === "number")
}

function validMask(mask: unknown): mask is Mask {
  return object(mask) && typeof mask.id === "string" && typeof mask.name === "string" &&
    (mask.output === undefined || typeof mask.output === "string") &&
    (mask.input === undefined || (Array.isArray(mask.input) && mask.input.every(validField)))
}

function matchesCommittedView(existing: ArchivedCall, call: ArchivedCall, mask: Mask): boolean {
  const view = renderMask([
    { content: [{ type: "tool-call", id: existing.id, name: existing.name, input: existing.input }] },
    { content: [{ type: "tool-result", id: existing.id, name: existing.name, result: existing.result }] },
  ], [mask])
  const maskedInput = (view[0].content[0] as { input: unknown }).input
  const maskedResult = (view[1].content[0] as { result: ArchivedCall["result"] }).result
  const same = (left: unknown, right: unknown) => encode(left) === encode(right)
  return (same(existing.input, call.input) || same(maskedInput, call.input)) &&
    (same(existing.result, call.result) || same(maskedResult, call.result))
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

/** A session-scoped, JSON-only wrapper over the verified v2 plugin storage API. */
export function createStore(storage: Storage, sessionID: string, report: Reporter = defaultReport) {
  const root = `sessions/${encodeURIComponent(sessionID)}/`
  const key = (kind: string, id: string) => `${root}${kind}/${encodeURIComponent(id)}`
  const masksKey = (checkpoint: string | null) => key("masks", checkpoint ?? "root")
  const counterKey = `${root}episode-counter`
  const deferredKey = `${root}deferred-compaction`
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
  const getMasks = async (checkpoint: string | null = null): Promise<readonly Mask[]> => {
    const value = await get<unknown>(masksKey(checkpoint))
    if (value === undefined) return []
    if (!Array.isArray(value) || !value.every(validMask)) throw new Error("Invalid stored masks")
    if (new Set(value.map((mask) => mask.id)).size !== value.length) throw new Error("Duplicate stored mask id")
    return value as Mask[]
  }
  const saveCall = async (call: ArchivedCall, checkpoint: string | null = null): Promise<boolean> => {
    try {
      return await exclusive(key("calls", call.id), async () => {
        // The first complete original wins; accept only its exact committed elisions.
        const existing = await getCall(call.id)
        if (existing === undefined) {
          if ((hasInputStub(call.input) || hasOutputStub(call)) && (await getMasks(checkpoint)).some((mask) => mask.id === call.id)) {
            report(`Missing original for committed mask ${call.id}`)
            return false
          }
          archivedCall(JSON.parse(encode(call)), call.id)
          await put(key("calls", call.id), call)
          return true
        }
        if (existing.name === call.name) {
          if (encode(existing.input) === encode(call.input) && encode(existing.result) === encode(call.result)) return true
          const mask = (await getMasks(checkpoint)).find((item) => item.id === call.id)
          if (mask && matchesCommittedView(existing, call, mask)) return true
        }
        report(`Conflicting archived tool call id ${call.id}; keeping the first original`)
        return false
      })
    } catch (error) {
      report(`Unable to archive tool call ${call.id}`, error)
      return false
    }
  }
  const commitMask = (plan: MaskPlan, checkpoint: string | null = null): Promise<{ committed: boolean; masks: readonly Mask[] }> => {
    if (!plan.commit) return Promise.resolve({ committed: false, masks: plan.base })
    const name = masksKey(checkpoint)
    return exclusive(name, async () => {
      // Another hook may have committed since planning. Re-plan instead of losing masks or
      // committing a now-subthreshold batch; existing stub bytes must never be rewritten.
      const current = await getMasks(checkpoint)
      if (encode(current) !== encode(plan.base)) return { committed: false, masks: current }
      const accepted = new Set<string>()
      for (const call of plan.calls) if (await saveCall(call, checkpoint)) accepted.add(call.id)
      if (!accepted.size) return { committed: false, masks: current }
      const proposed = new Set(plan.calls.map((call) => call.id))
      const previous = new Map(plan.base.map((mask) => [mask.id, mask]))
      // Keep the old mask for a failed call, and commit every successfully archived item.
      const masks = plan.masks.flatMap((mask) => {
        if (!proposed.has(mask.id) || accepted.has(mask.id)) return [mask]
        const old = previous.get(mask.id)
        return old ? [old] : []
      })
      await put(name, masks)
      return { committed: true, masks }
    })
  }
  const archiveRows = async (rows: readonly Row[], checkpoint: string | null = null): Promise<boolean> => {
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
        for (const call of rowCalls(row)) if (!await saveCall(call, checkpoint)) complete = false
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
    const complete = await archiveRows(rows.filter((row) => needed.has(row.id)), cut.parent)
    if (!complete) return pending
    const archived = { ...pending, archived: true }
    await put(key("pending", pending.id), archived)
    return archived
  }
  const getCheckpoint = (id: string) => get<Checkpoint>(key("checkpoints", id))
  const saveCheckpoint = (checkpoint: Checkpoint) => put(key("checkpoints", checkpoint.id), checkpoint)
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
    for (const checkpoint of [null, ...checkpoints]) {
      const masks = (await source.getMasks(checkpoint)).filter((mask) => calls.has(mask.id))
      for (const mask of masks) if (!await getCall(mask.id)) throw new Error(`Missing inherited original ${mask.id}`)
      const target = checkpoint === null ? null : aliases.get(checkpoint) ?? checkpoint
      if (await storage.get(masksKey(target)) === undefined) await put(masksKey(target), masks)
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
  return { getRow, getRows, getCall, getCalls, saveCall, getMasks, commitMask, archiveRows, prepareArchive, getPending, getCheckpoint, saveCheckpoint, chain, nextEpisode, hasInherited, inherit, forkSnapshot, getDeferredCompaction, saveDeferredCompaction, clear }
}
