import type { Plugin } from "@opencode/plugin"
import type { SessionCompaction, SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { tokens, type ArchivedCall, type Part } from "./tokens.ts"
import { adoptNative, archiveAnchor, episodeRows, planCut, renderHandoff, resolveMemory, type Checkpoint, type Episode, type Pending, type Row } from "./memory.ts"
import { budgetGateNotice, checkpointReminder, CHECKPOINT_NOW_DESCRIPTION, RECALL_DESCRIPTION, workingPrompt } from "./prompts.ts"
import { budgetFailure, DEFAULT_MEMORY_BUDGET, episodeNote, HandoffError, measureWorking, parseHandoff, parsePatchHandoff, type Handoff } from "./working.ts"
import { address, formatCall, formatCatalog, formatCatalogEntry, formatGraduated, formatRow, formatTranscript, LAYERS, MAX_SEARCH_HITS, parseTarget, recallPage, resolveHandle, search, SEARCH_PAGE_HITS, shortId, type Layer, type RecallContent, type RecallFile, type SearchDocument } from "./recall.ts"
import { createStore, createProjectStore, exclusive, rowCalls, type GraduatedNote, type GateStats, type SessionOwner } from "./store.ts"
import { budgetBounds, effectiveBudget, shortCycles, SPIKE, type BudgetBounds, type ThermostatEntry } from "./thermostat.ts"
import { formatDuration, recencyBoost } from "./time.ts"
import { createModels } from "./models.ts"
import { createLifecycle } from "./lifecycle.ts"
import { modelLabel, type ModelRef } from "./model-rpc.ts"
import { memoryRpc, type BudgetScope, type MemoryDecision, type MemoryRequest, type MemoryStatus } from "./memory-rpc.ts"
import { object, positive, modelRef } from "./guards.ts"
import { DEFAULT_OUTPUT_RESERVE, durableTokens, evidenceTokens, latestProviderUsage, recentDurable, requestParts, retainedTokens, usageScale, REQUEST_MARGIN, type ViewMessage } from "./estimate.ts"
import { captureEvidence, changedEvidence, CHECKPOINT_INPUT, parseCheckpoint, type CheckpointInput, type Evidence, type Publication } from "./checkpoint.ts"
import { freshEvidence, liveBudget, NEAR_SHARE, pause, reminderFor, type Reminder } from "./safeguard.ts"
import { commandsIn, createNudge, renderNudge } from "./recurring.ts"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>
type Store = ReturnType<typeof createStore>
type RecallInput = { readonly id?: string; readonly query?: string; readonly episode?: string; readonly layer?: Layer; readonly page?: number }
type Transcript = { readonly text: string; readonly files: readonly RecallFile[]; readonly echoes: readonly (readonly [number, number])[]; readonly size: number }
type Round = { busy: number; idle?: number }
type Deferral = Round & { approved: boolean }
type Gate = Round & { checkpoint: string | null; growth: number }
type Admission = { readonly status: "requested" | "already-pending" | "not-admitted" | "failed"; readonly reason: string }
type Thermostat = { readonly bounds: BudgetBounds; readonly entry: ThermostatEntry | undefined }
type Proposal = { readonly checkpoint: string | null; readonly evidence: Evidence; readonly publication: Publication; readonly handoff: Handoff; stale?: string }
// The working state covers the whole cut and originals stay recallable, so no
// verbatim host tail rides beside it: a non-ID keepID tells OpenCode to keep none.
const handoffMetadata = (author?: Checkpoint["author"], keep?: string) => ({ keepID: keep ?? null, nextdcp: { version: 2, ...(author ? { author } : {}) } })

// All per-session runtime state in one record, so a session's lifecycle — above all
// deletion — touches a single entry instead of a dozen maps keyed in parallel.
type SessionState = {
  guard?: ReturnType<typeof setTimeout>
  admission?: Promise<Admission>
  attempt?: { key: string; time: number; reason: string }
  cooldownUntil?: number
  inheritance?: Promise<void>
  view?: { checkpoint: string | null; after: string | null; threshold: number; scope: BudgetScope }
  /** Last build's fixed request overhead for read-only status; never persisted. */
  live?: { checkpoint: string | null; model: string; overhead: number }
  /** Last guidance delivery, not a cut/admission. Cooldown spans rounds until a cut. */
  reminder?: Reminder
  deferral?: Deferral
  /** The open budget gate: one evaluation window per budget crossing, stamped with the round and checkpoint it belongs to. */
  gate?: Gate
  /** Semantic evidence at the last main-model build, and its admitted working-state edit. */
  evidence?: { checkpoint: string | null; value: Evidence }
  proposal?: Proposal
  /** A checkpoint call held at its call-time boundary: its cut waits for the model's
   *  next action. Tool work continues the round and applies the staged cut; a final
   *  reply's round end discards it and next-prompt scheduling re-cuts steered. */
  hold?: { readonly boundary: string; readonly proposal?: Proposal; readonly at: number }
  /** The queued message that triggered a deferred-marker compaction; evidence for the
   *  working state, consumed only by whichever generation commits its handoff. Failed
   *  generations keep the signal for their retry; the round's end clears what never ran. */
  hint?: string
  /** Prepared archive boundaries by checkpoint id, until their handoff commits. */
  boundaries?: Map<string, Pending>
  /** The session's main model as last built; the thermostat's per-model key. */
  model?: ModelRef
  /** Stamped at the first session read: subagent sessions never feed the thermostat
   *  or graduate notes; their findings return via the delegation summary. */
  owner?: SessionOwner
  /** The recurring one-shot nudge has landed in this session; set only when the
   *  notice actually fits — a capacity-refused nudge retries on a later build. */
  nudged?: boolean
  /** Numeric, observational diagnostics only; never injected or persisted. */
  request?: MemoryRequest
  decision?: MemoryDecision
  cut?: { id: string; reason: string; author?: Checkpoint["author"] }
  lastCut?: MemoryDecision
}
const sameRound = (round: Round | undefined, info: { time?: { busy?: number; idle?: number } }): boolean =>
  round !== undefined && round.busy === info.time?.busy && round.idle === info.time?.idle
const activeCheckpoint = (rows: readonly Row[]) => rows.findLast((row) => row.type === "compaction" && row.status === "completed")?.id ?? null
const running = (rows: readonly Row[]) => rows.some((row) => row.type === "compaction" && row.status === "running")
const GUARD_TIMEOUT = 3 * 60_000
const TRANSCRIPT_CACHE_CHARS = 8_000_000
const INDEX_CACHE_CHARS = 8_000_000
/** The measurement window for the live growth rate: the most recent assistant
 *  turns whose durable tokens one backwards walk counts. */
const RECENT_TURNS = 10

/** Controller is independent of hook registration so fallback and concurrency can be tested. */
export function createController(context: Plugin.Context) {
  const rawStorage = context.storage, lifecycle = createLifecycle(rawStorage)
  const ctx = { ...context, storage: lifecycle.storage }
  const rawMemory = object(ctx.options.memory) ? ctx.options.memory : {}
  const idleOption = ctx.options.idle === false ? Infinity : positive(ctx.options.idle, 0)
  const budgetOption = ctx.options.budget === false ? Infinity : positive(ctx.options.budget, 0), memoryBudget = positive(rawMemory.budget, DEFAULT_MEMORY_BUDGET)
  const automatic = budgetOption === 0
  const debug = ctx.options.debug === true
  // Provider-compatibility fallback for the gate notice: the conversation tail
  // (default) or a system part.
  const noticeInSystem = ctx.options.notice === "system"
  const sessions = new Map<string, SessionState>()
  const state = (sessionID: string): SessionState => {
    let entry = sessions.get(sessionID)
    if (entry === undefined) sessions.set(sessionID, entry = {})
    return entry
  }
  const windows = new Map<string, Promise<{ context: number; output: number; input?: number } | undefined>>()
  const transcripts = new Map<string, Transcript>()
  let transcriptChars = 0
  // Search documents are immutable per id (rows and calls are write-once, transcripts
  // never change), but the searchable set follows the archive and the active episode
  // chain. The corpus is cached per session, keyed on the checkpoint, dropped at
  // every archive mutation, and LRU-evicted under the same ceiling as transcripts;
  // the next query rebuilds it from the cached transcripts.
  const indexes = new Map<string, { checkpoint: string | null; documents: SearchDocument[]; chars: number }>()
  let indexChars = 0
  const dropIndex = (sessionID: string) => {
    const cached = indexes.get(sessionID)
    if (cached === undefined) return
    indexes.delete(sessionID)
    indexChars -= cached.chars
  }
  /** Record a session's corpus, evicting least-recently-used entries so the cache
   *  stays bounded the way transcripts are. */
  const keepIndex = (sessionID: string, entry: { checkpoint: string | null; documents: SearchDocument[]; chars: number }) => {
    dropIndex(sessionID)
    indexes.set(sessionID, entry)
    indexChars += entry.chars
    for (const [oldest, value] of indexes) {
      if (indexChars <= INDEX_CACHE_CHARS || oldest === sessionID) break
      indexes.delete(oldest)
      indexChars -= value.chars
    }
  }
  const keyFor = (sessionID: string, id: string) => `${sessionID}\0${id}`
  const warn = (where: string, error?: unknown) => {
    const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`
    console.warn(`[nextdcp] ${where}${detail}`)
  }
  const log = (where: string, error: unknown) => {
    if (debug) warn(where, error)
  }
  // The recurring one-shot pool scans the host database in the background at
  // startup and every TTL; `false` disables the nudge entirely.
  const nudge = ctx.options.nudge === false ? undefined : createNudge(warn)
  // Fire-and-forget gate telemetry: counted, logged when debugging, never load-bearing.
  const gateStat = (sessionID: string, field: keyof GateStats) => {
    void storeFor(sessionID).countGate(field).then((stats) => {
      if (debug) console.info(`[nextdcp] gate ${field}${stats ? ` ${JSON.stringify(stats)}` : " not counted"}`)
    })
  }
  const storeFor = (id: string) => createStore(ctx.storage, id, warn)
  const projectFor = (id: string) => createProjectStore(ctx.storage, id, warn)
  const sessionInfo = async (sessionID: SessionID): Promise<SessionInfo> => {
    const info = await ctx.session.get({ sessionID }, { signal: lifecycle.signal(sessionID) })
    if (!info.projectID || !info.location?.directory) throw new Error("Session ownership is unavailable")
    const owner: SessionOwner = { projectID: info.projectID, location: info.location, subagent: !!info.parentID && !info.fork }
    const entry = state(sessionID)
    if (JSON.stringify(entry.owner) !== JSON.stringify(owner)) {
      await storeFor(sessionID).saveOwner(owner)
      entry.owner = owner
    }
    return info
  }
  const ownerFor = async (sessionID: SessionID): Promise<SessionOwner> => {
    try { await sessionInfo(sessionID) }
    catch (error) {
      const owner = sessions.get(sessionID)?.owner ?? await storeFor(sessionID).getOwner()
      if (owner) return owner
      throw error
    }
    return state(sessionID).owner!
  }
  const models = createModels(ctx, { lifecycle, access: sessionInfo })
  const graduatedCache = new Map<string, { revision: unknown; notes: GraduatedNote[] }>()
  const readGraduated = async (projectID: string): Promise<GraduatedNote[]> => {
    const project = projectFor(projectID), revision = await project.graduatedRevision()
    const cached = graduatedCache.get(projectID)
    if (cached && cached.revision === revision) return cached.notes
    const notes = await project.graduatedNotes()
    graduatedCache.set(projectID, { revision, notes })
    return notes
  }
  /** The model's learned thermostat entry plus bounded safeguard policy —
   *  one accessor shared by the auto budget, the spike guard, and the gate
   *  notice so all three judge the same state. */
  const thermostatFor = async (sessionID: SessionID, model: ModelRef | undefined, window: number, output: number, input?: number): Promise<Thermostat> => {
    const bounds = budgetBounds(window, output || DEFAULT_OUTPUT_RESERVE, input)
    if (!model) return { bounds, entry: undefined }
    const entry = (await projectFor((await ownerFor(sessionID)).projectID).readThermostat())[modelLabel(model)]
    return { bounds, entry }
  }
  const softBudget = (thermostat?: Thermostat) => budgetOption || (thermostat === undefined ? 0 : effectiveBudget(thermostat.entry, thermostat.bounds))
  /** The live-budget triple every consumer must agree on: fresh cycle evidence
   *  buys temporary room within `room` — safe capacity less fixed overhead. */
  const liveFor = (baseline: number, cycleRows: readonly Row[], scale: number, room: number) => {
    const evidence = automatic && baseline > 0 && Number.isFinite(baseline) ? freshEvidence(cycleRows, scale) : { tokens: 0, weighted: 0 }
    return automatic ? liveBudget(baseline, evidence, room) : { baseline, allowance: 0, budget: baseline }
  }
  const decide = (entry: SessionState, action: string, reason: string) => { entry.decision = { at: Date.now(), action, reason } }
  /** Close one thermostat cycle at a committed handoff: fold the cycle's durable
   *  tokens and assistant turns into the main model's entry. Fire-and-forget —
   *  advisory, never blocking. */
  const closeThermostatCycle = (sessionID: SessionID, spanRows: readonly Row[], baseline: number, scale: number) => {
    const model = sessions.get(sessionID)?.model
    if (!model) return
    const turns = spanRows.filter((row) => row.type === "assistant").length
    if (turns < 1) return
    // A one-off bulk read buys temporary room now, not a permanently higher
    // baseline for subsequent ordinary work. Errors/human answers still train.
    const tokens = Math.round(Math.max(0, durableTokens(spanRows) - evidenceTokens(spanRows)) * scale)
    const key = modelLabel(model)
    void lifecycle.run(sessionID, async () => {
      const info = await sessionInfo(sessionID)
      // Subagents share the parent's model but not its cycles; forks are real sessions.
      if (info.parentID && !info.fork) return
      const sizes = await windowSize(model)
      if (sizes === undefined) return
      const learned = await projectFor(info.projectID).closeCycle(key, tokens, turns, budgetBounds(sizes.context, sizes.output || DEFAULT_OUTPUT_RESERVE, sizes.input), baseline)
      if (!learned) return
      if (debug) console.info(`[nextdcp] thermostat ${key}: cycle ${learned.cycles}, growth ${learned.growth.toFixed(0)} tokens/turn, span ${learned.span.toFixed(1)} turns, budget ${learned.budget}`)
    }, undefined).catch((error) => warn(`thermostat cycle for ${key}`, error))
  }
  const inheritSession = (sessionID: SessionID, rows: readonly Row[], seen = new Set<string>()): Promise<void> => {
    if (seen.has(sessionID)) return Promise.reject(new Error("Cyclic fork ancestry"))
    const previous = sessions.get(sessionID)?.inheritance
    if (previous) return previous
    const work = (async () => {
      if (await storeFor(sessionID).hasInherited()) return
      const info = await sessionInfo(sessionID)
      if (!info.fork) return // parentID alone denotes a subagent, not a fork.
      const source = await ctx.session.context({ sessionID: info.fork.sessionID })
      const snapshot = await storeFor(info.fork.sessionID).forkSnapshot(info.fork.boundary, source)
      const ancestry = new Set(seen).add(sessionID)
      await inheritSession(info.fork.sessionID, snapshot, ancestry)
      // The import adds searchable rows, calls, and checkpoints to this archive.
      dropIndex(sessionID)
      await storeFor(sessionID).inherit(info.fork.sessionID, rows, snapshot)
    })()
    const entry = state(sessionID)
    entry.inheritance = work
    void work.catch(() => { if (entry.inheritance === work) entry.inheritance = undefined })
    return work
  }
  const windowSize = async (ref: unknown): Promise<{ context: number; output: number; input?: number } | undefined> => {
    const model = modelRef(ref)
    if (!model) return undefined
    const key = JSON.stringify([model.providerID, model.id])
    let lookup = windows.get(key)
    if (!lookup) {
      lookup = ctx.model.list().then((models) => {
        const limit = models.data.find((item) => item.providerID === model.providerID && item.id === model.id)?.limit
        if (typeof limit?.context !== "number" || !Number.isFinite(limit.context) || limit.context <= 0) return undefined
        return { context: limit.context, output: typeof limit.output === "number" && Number.isFinite(limit.output) && limit.output > 0 ? limit.output : 0,
          ...(typeof limit.input === "number" && Number.isFinite(limit.input) && limit.input > 0 ? { input: limit.input } : {}) }
      })
      windows.set(key, lookup)
    }
    try {
      const size = await lookup
      if (size === undefined && windows.get(key) === lookup) windows.delete(key)
      return size
    } catch (error) {
      if (windows.get(key) === lookup) windows.delete(key)
      throw error
    }
  }
  const clearGuard = (sessionID: string) => {
    const entry = sessions.get(sessionID)
    if (entry === undefined) return
    if (entry.guard !== undefined) clearTimeout(entry.guard)
    entry.guard = undefined
  }
  const requestCompact = (sessionID: SessionID, checkpoint: string | null, growth: number, reason: string, proposal?: Proposal): Promise<Admission> => {
    const key = `${checkpoint ?? ""}:${growth}`, now = Date.now()
    const entry = state(sessionID)
    const outcome = (status: Admission["status"], detail: string): Admission => { decide(entry, status, detail); return { status, reason: detail } }
    // Sharing admission never turns a failed first request into a successful second one.
    if (entry.admission) return entry.admission.then((result) => result.status === "requested"
      ? outcome("already-pending", "A compaction request is already admitted.") : result)
    if (entry.guard !== undefined) return Promise.resolve(outcome("already-pending", "A compaction request is guarded as pending; completion is not confirmed."))
    if ((entry.cooldownUntil ?? 0) > now) return Promise.resolve(outcome("not-admitted", "A failed cut is cooling down; retry after three minutes."))
    if (entry.attempt?.key === key && now - entry.attempt.time < GUARD_TIMEOUT) return Promise.resolve(outcome("not-admitted", "A recent request covered this same boundary and growth; wait for its outcome or the retry timeout."))
    const attempt = { key, time: now, reason }
    entry.attempt = attempt
    entry.proposal = proposal // Only a new admission can stage an edit; duplicates cannot replace it.
    const timer = setTimeout(() => {
      const current = sessions.get(sessionID)
      if (current?.guard !== timer) return
      current.guard = undefined
      if (current.attempt === attempt) current.attempt = undefined
      if (current.admission === admission) current.admission = undefined
      if (current.proposal === proposal) current.proposal = undefined
      decide(current, "timed-out", "The local compaction guard expired; completion is unconfirmed and a retry is permitted.")
    }, GUARD_TIMEOUT)
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
    entry.guard = timer
    // Prompt hooks await admission (not the summary) so the control is queued before
    // the new message. Context hooks must never wait on the runner.
    const admission = lifecycle.run<Admission>(sessionID, async (signal) => {
      await lifecycle.assertOpen(sessionID)
      await ctx.session.compact({ sessionID }, { signal })
      return outcome("requested", reason)
    }, { status: "not-admitted", reason: "Session archive is closed." }).catch((error): Admission => {
      log("compact admission", error)
      return outcome("failed", "Compaction admission failed; no checkpoint was confirmed.")
    }).then((result) => {
      const current = sessions.get(sessionID)
      if ((result.status === "failed" || result.status === "not-admitted") && current?.guard === timer) {
        clearTimeout(timer)
        current.guard = undefined
      }
      if ((result.status === "failed" || result.status === "not-admitted") && current?.attempt === attempt) current.attempt = undefined
      if ((result.status === "failed" || result.status === "not-admitted") && current && current.proposal === proposal) current.proposal = undefined
      return result
    })
    entry.admission = admission
    void admission.then(() => {
      const current = sessions.get(sessionID)
      if (current?.admission === admission) current.admission = undefined
    })
    return admission
  }

  /** A held cut waits for the model's next action. Non-question tool work continues the
   *  round — a pause, so the staged cut applies at its call-time boundary and the new
   *  work rides live beside the summary. A question's ask or a final reply ends the
   *  round: that boundary belongs to next-prompt scheduling, steered by the user. */
  const continuesWork = (rows: readonly Row[], boundary: string): boolean => {
    const at = rows.findIndex((row) => row.id === boundary)
    return at >= 0 && rows.slice(at + 1)
      .some((row) => row.type === "assistant" && rowCalls(row).some((call) => call.name !== "question"))
  }

  /** Apply a staged cut: request the compaction carrying the staged proposal, and keep the
   *  hold alive for onCompaction — it is the staged boundary the cut must honor. A refused
   *  apply spends the staging instead of leaving a dead hold that blocks future calls: say
   *  so explicitly. Nothing was evicted, so a fresh call re-stages the same boundary. */
  const applyStaged = (sessionID: SessionID, held: NonNullable<SessionState["hold"]>, checkpoint: string | null, growth: number, reason: string): void => {
    void requestCompact(sessionID, checkpoint, growth, reason, held.proposal).then((result) => {
      if (result.status !== "failed" && result.status !== "not-admitted") return
      const entry = sessions.get(sessionID)
      if (entry?.hold === held) entry.hold = undefined
      void models.warning(sessionID, `A staged checkpoint could not be applied (${result.reason}) The conversation is unchanged; call checkpoint_now again to re-stage the cut.`)
    })
  }

  const onContext = async (event: SessionContext) => {
    let rows: readonly Row[], info: SessionInfo
    try {
      ;[rows, info] = await Promise.all([
        ctx.session.context({ sessionID: event.sessionID }, { signal: lifecycle.signal(event.sessionID) }), sessionInfo(event.sessionID),
      ])
    } catch (error) {
      log("read context", error)
      return
    }
    const checkpoint = activeCheckpoint(rows)
    // Stamp the main model per build: it is the thermostat's per-model key when
    // this session's cycle closes at its next committed handoff.
    const model = modelRef(event.model)
    if (model) state(event.sessionID).model = model
    try {
      const messages = event.messages as unknown as ViewMessage[]
      const entry = state(event.sessionID)
      // The model continued with tool work after a staged checkpoint: apply the held cut
      // at its call-time boundary. The new work rides live beside the summary (keepID).
      const held = entry.hold
      if (held && continuesWork(rows, held.boundary)) {
        const heldStart = checkpoint === null ? 0 : rows.findIndex((row) => row.id === checkpoint) + 1
        applyStaged(event.sessionID, held, checkpoint, durableTokens(rows.slice(heldStart)) * usageScale(rows),
          "The model continued working after a staged checkpoint; the cut lands at its staged boundary.")
      }
      const start = checkpoint === null ? 0 : rows.findIndex((row) => row.id === checkpoint) + 1
      // Automatic fallback meters the whole retained conversation. Explicit budget
      // and idle overrides keep their historical NEW-durable-growth semantics.
      const scale = usageScale(rows), cycleRows = rows.slice(start), growth = durableTokens(cycleRows) * scale
      // A main-authored edit's evidence is observed over the cycle only: rows before
      // the checkpoint are pinned by the checkpoint-id comparison and immutable while
      // it is active, so re-hashing them proves nothing.
      state(event.sessionID).evidence = { checkpoint, value: captureEvidence(cycleRows) }
      const measured = automatic ? retainedTokens(rows) * scale : growth
      const sizes = await windowSize(event.model)
      const window = sizes?.context
      const reserve = positive(event.options?.maxTokens, sizes?.output || DEFAULT_OUTPUT_RESERVE)
      const thermostat = window === undefined ? undefined : await thermostatFor(event.sessionID, model, window, reserve, sizes?.input)
      const baseline = softBudget(thermostat)
      entry.view = { checkpoint, after: rows.at(-1)?.id ?? null, threshold: idleOption || baseline || Infinity,
        scope: idleOption > 0 || !automatic ? "growth" : "retained" }
      // Capacity is rechecked on EVERY build, before any held-round or growth return.
      // All assembled instructions, tool definitions and projected history count.
      const parts = requestParts(event), projected = parts.total * scale
      const ceiling = safeCeiling(sizes, reserve)
      entry.request = { at: Date.now(), checkpoint, model: model ? modelLabel(model) : "unknown", scale,
        messages: parts.messages * scale, system: parts.system * scale, tools: parts.tools * scale, total: projected,
        outputReserve: reserve, margin: REQUEST_MARGIN,
        ...(sizes ? { window: sizes.context, ceiling, ...(sizes.input === undefined ? {} : { inputLimit: sizes.input }) } : {}) }
      // Fresh tool evidence buys temporary room on the very build carrying
      // it; fixed overhead, output reserve and margin stay out of reach.
      const overhead = Math.max(0, projected - measured)
      const live = liveFor(baseline, cycleRows, scale, ceiling - overhead)
      const budget = live.budget
      entry.live = automatic && sizes ? { checkpoint, model: entry.request.model, overhead } : undefined
      // Our own notices count toward capacity too. Optional guidance is omitted
      // when it won't fit; a required gate notice yields to capacity recovery.
      const appendNotice = (text: string, required = false): boolean => {
        const notice = tokens(text) * scale, request = entry.request!
        if (request.total + notice > ceiling) {
          if (required) {
            entry.gate = entry.deferral = undefined
            gateStat(event.sessionID, "capacity")
            void requestCompact(event.sessionID, checkpoint, growth, "The required gate notice would exceed safe input capacity.")
          }
          return false
        }
        if (noticeInSystem) event.system.push({ type: "text", text })
        else messages.push({ role: "user", content: [{ type: "text", text } as Part] })
        entry.request = { ...request, total: request.total + notice, ...(noticeInSystem ? { system: request.system + notice } : { messages: request.messages + notice }) }
        return true
      }
      // The recurring one-shot nudge rides the tail once per session, before any
      // held-round or capacity return: it corrects behavior, it does not compact.
      // A capacity-refused notice leaves the flag unset and retries next build.
      if (nudge && !entry.nudged && !entry.owner?.subagent) {
        nudge.refresh()
        const family = nudge.scan(commandsIn(cycleRows), info.location.directory)
        if (family && appendNotice(renderNudge(family))) entry.nudged = true
      }
      if (info.revert) { decide(entry, "held", "A staged revert is active."); return }
      if (running(rows)) { decide(entry, "held", "A compaction is already running."); return }
      if (projected > ceiling && growth > 0) {
        entry.gate = entry.deferral = undefined
        gateStat(event.sessionID, "capacity")
        void requestCompact(event.sessionID, checkpoint, growth, "Complete request exceeds safe input capacity.")
        return
      }
      if (budget <= 0) {
        decide(entry, "held", "Auto budget is unavailable because the model window is unknown.")
        return log("budget trigger is disabled; the model window is unknown and options.budget is not set", undefined)
      }
      if (budget === Infinity) { decide(entry, "held", "Soft budget scheduling is disabled."); return }
      // A large unchanged native tail/summary cannot be improved by another cut
      // with no new durable rows; reasoning counts as such a row on replaying hosts.
      if (growth <= 0) { decide(entry, "held", "No new durable growth; unchanged summary/tail is not re-compacted."); return }
      if (measured <= budget) {
        // Fresh evidence may have bought room on this very build: a gate whose
        // crossing no longer exists must not be repaid at idle or failure.
        entry.gate = undefined
        // Optional guidance rides the tail only: a system part would rewrite the
        // cached prefix of the whole request for a suggestion.
        const seen = pause(cycleRows)
        const reminder = automatic && !noticeInSystem && info.time?.busy !== undefined && entry.guard === undefined && (entry.cooldownUntil ?? 0) <= Date.now()
          ? reminderFor({ checkpoint, pause: { ...seen, unseen: seen.unseen * scale }, growth, baseline, request: projected, ceiling }, entry.reminder) : undefined
        if (reminder && appendNotice(checkpointReminder(growth, reminder.kind === "boundary" && measured >= budget * NEAR_SHARE ? budget : undefined,
            reminder.kind === "capacity" ? { total: projected, ceiling } : undefined))) {
          entry.reminder = reminder
          decide(entry, "reminded", reminder.kind === "capacity" ? "The complete request nears safe capacity; one checkpoint warning, no cut queued."
            : "The model paused after substantial work; one spaced checkpoint suggestion, no cut queued.")
          return
        }
        decide(entry, "held", !automatic ? "New durable growth is within the soft budget."
          : live.allowance > 0 ? "Fresh tool evidence has temporary working room; the complete request fits capacity."
          : "Retained conversation is within the overdue-checkpoint safeguard.")
        return
      }
      if (entry.deferral?.approved && sameRound(entry.deferral, info)) { decide(entry, "held", "The automatic rate-spike hold still covers this round."); return }
      const current = state(event.sessionID)
      if (current.gate) {
        const gate = current.gate
        current.gate = undefined
        // Build N+1 closes the gate it opened; a gate from another round or boundary is
        // stale and falls through to a fresh crossing. A held gate stays open so the
        // grant's idempotent re-affirmation keeps its round.
        if (sameRound(gate, info) && gate.checkpoint === checkpoint) {
          gateStat(event.sessionID, "continued")
          return void requestCompact(event.sessionID, checkpoint, growth, "The budget gate's evaluation step ended.")
        }
      }
      // Explicit growth-budget compatibility only: recent turns are growing at multiples of the learned
      // rate — bulk reads and dumps, not conversation — so a cut here would shred
      // work recall cannot reassemble cheaply. Hold this round's compaction the way
      // a granted deferral did, automatically and for one round. The complete request
      // capacity check above has already established room for this build.
      if (!automatic && info.time?.busy !== undefined && !sameRound(current.deferral, info) &&
          thermostat?.entry && thermostat.entry.growth > 0) {
        const recent = recentDurable(rows, RECENT_TURNS)
        if (recent.turns > 0 && (recent.tokens * scale) / recent.turns >= SPIKE * thermostat.entry.growth) {
          current.deferral = { busy: info.time.busy, idle: info.time.idle, approved: true }
          decide(current, "held", "Recent durable growth is at least twice the learned rate; this round still fits capacity.")
          gateStat(event.sessionID, "spikeHeld")
          return
        }
      }
      // Arm the gate together with its notice. The notice rides the conversation tail
      // — the most salient and the cheapest position: a request-scoped message touches
      // no cached prefix, unlike a system part before the whole history.
      // Explicit growth overrides may postpone during diagnosis. An overdue
      // automatic safeguard gets its one evaluation step even after tool errors.
      // This never bypasses capacity. The next build re-evaluates the latest result.
      if (!automatic && recentToolFailure(rows)) { decide(entry, "held", "A recent tool failure postpones the soft cut during diagnosis."); return }
      if (info.time?.busy !== undefined && current.guard === undefined && (current.cooldownUntil ?? 0) <= Date.now() && !sameRound(current.deferral, info)) {
        if (!appendNotice(budgetGateNotice(measured, budget, window, automatic && thermostat !== undefined && shortCycles(thermostat.entry, thermostat.bounds),
          automatic ? "retained" : "growth"), true)) return
        current.gate = { busy: info.time.busy, idle: info.time.idle, checkpoint, growth }
        decide(current, "gate-open", automatic ? "A checkpoint is overdue under the adaptive safeguard; one evaluation step precedes compaction admission." : "One evaluation step precedes the soft cut; compaction is not yet admitted.")
        gateStat(event.sessionID, "gates")
        return
      }
      gateStat(event.sessionID, "silent")
      void requestCompact(event.sessionID, checkpoint, growth, automatic ? "Retained conversation exceeds the overdue-checkpoint safeguard without an eligible gate." : "New durable growth exceeds the soft budget without an eligible gate.")
    } catch (error) { log("context", error) }
  }

  // A saved record is authoritative; anything else with a textual summary is adopted as a native episode.
  const ensureCheckpoint = async (sessionID: SessionID, id: string, row?: Row, rows?: readonly Row[], seen = new Set<string>(), external = true): Promise<void> => {
    if (seen.has(id)) throw new Error("Cyclic native checkpoint")
    seen.add(id)
    const store = storeFor(sessionID), saved = await store.getCheckpoint(id)
    if (saved?.id === id) return
    if (!row) {
      const archived = await store.getRow(id)
      if (!archived) throw new Error("Missing checkpoint row")
      row = JSON.parse(archived) as Row
    }
    // An encrypted native window cannot be represented by an empty textual episode.
    if (typeof row.summary !== "string" || !row.summary.trim()) throw new Error("Native checkpoint has no textual summary")
    let boundary = await store.getPending(id) ?? sessions.get(sessionID)?.boundaries?.get(id)
    const pluginCycle = boundary !== undefined
    if (!boundary && rows?.some((item) => item.id === id)) {
      const cut = planCut(rows, id)
      boundary = { id, parent: cut.parent, rowIDs: cut.rowIDs, archived: false }
    }
    const parent = boundary?.parent
    if (parent) await ensureCheckpoint(sessionID, parent, rows?.find((item) => item.id === parent), rows, seen, false)
    // Native summaries invalidate patch state; only standing constraints carry over.
    dropIndex(sessionID)
    const inherited = parent ? await store.getCheckpoint(parent) : undefined
    await store.saveCheckpoint(adoptNative(row, boundary?.episode ?? await store.nextEpisode(), boundary, inherited))
    if (external && !pluginCycle) {
      await models.warning(sessionID, `Native compaction ${id} ran without a nextdcp handoff. Require compaction.background: false; a held summary or host reload may have bypassed the hook. History not archived before that cut is not recallable.`)
    }
    const live = sessions.get(sessionID)
    if (live?.boundaries) live.boundaries.delete(id)
  }

  const memoryAt = async (sessionID: SessionID, rows: readonly Row[], checkpoint: string | null) => {
    await inheritSession(sessionID, rows)
    const store = storeFor(sessionID)
    if (checkpoint) {
      // Different host contexts share the archive, including during a reload.
      await exclusive(keyFor(sessionID, "adopt"), () => ensureCheckpoint(sessionID, checkpoint, rows.find((row) => row.id === checkpoint), rows))
    }
    return resolveMemory(checkpoint, await store.chain(checkpoint))
  }

  const onCompaction = async (event: SessionCompaction) => {
    // Warnings raised during this cycle describe a live condition — a compaction model
    // that fell back to the main model will fall back again — so only prior-cycle
    // warnings go stale when a handoff commits.
    let warned = false
    const warnCycle = (message: string) => { warned = true; return models.warning(event.sessionID, message) }
    const store = storeFor(event.sessionID)
    // Archival mutates the searchable set: rows, calls, and possibly the chain.
    dropIndex(event.sessionID)
    let rows: readonly Row[], boundary: Pending
    try {
      rows = await ctx.session.context({ sessionID: event.sessionID }, { signal: lifecycle.signal(event.sessionID) })
      await inheritSession(event.sessionID, rows)
    } catch (error) {
      await warnCycle("Cannot read the episode boundary; using native OpenCode compaction.")
      return
    }
    if (!running(rows)) {
      // Current host background preparation has no durable cut ID and may apply its
      // held result without invoking this hook again. Refuse it, rather than silently
      // preparing a native summary that bypasses the archive/handoff contract.
      const start = rows.findLastIndex((row) => row.type === "compaction" && row.status === "completed")
      await store.archiveRows(rows.slice(start + 1))
      const message = "nextdcp requires compaction.background: false; background preparation has no durable checkpoint boundary."
      await warnCycle(message)
      throw new Error(message)
    }
    const entry = state(event.sessionID), cutID = rows.findLast((row) => row.type === "compaction" && row.status === "running")!.id
    if (entry.cut?.id !== cutID) entry.cut = { id: cutID, reason: entry.guard === undefined ? "Host compaction; no local request trigger recorded." : entry.attempt?.reason ?? "Host compaction." }
    // A staged cut carries the model's own call-time boundary: its episode ends there
    // and any newer work rides live beside the summary instead of joining the cut.
    const staged = entry.hold
    entry.hold = undefined
    if (staged) {
      // The gate outcome is counted where the checkpoint actually lands, not at the call:
      // a staging the model withdrew by finishing its reply never became a checkpoint.
      gateStat(event.sessionID, "checkpoints")
      if (entry.cut) entry.cut.reason = "The model's staged checkpoint applied at its call-time boundary."
    }
    let cut: ReturnType<typeof planCut>, keep: string | undefined, parentIndex: number
    try {
      cut = planCut(rows)
      parentIndex = cut.parent === null ? -1 : rows.findIndex((row) => row.id === cut.parent)
      const at = staged ? rows.findIndex((row) => row.id === staged.boundary) : -1
      if (staged && at > parentIndex) {
        // The staged boundary is the model's own cut: the episode ends there — after
        // the planned parent, at the call itself — and any newer work rides live.
        cut = { ...cut, rowIDs: rows.slice(parentIndex + 1, at + 1).map((row) => row.id) }
      }
      // The running cut row is the host's container, not model work: never keep it live.
      keep = at >= 0 && rows[at + 1]?.id !== cutID ? rows[at + 1]?.id : undefined
      const saved = await store.getCheckpoint(cut.checkpoint)
      if (saved?.working && !saved.episode.native) {
        if (saved.parent !== cut.parent || JSON.stringify(saved.episode.rowIDs) !== JSON.stringify(cut.rowIDs)) throw new Error("Committed compaction boundary changed")
        if (!event.result) {
          const summary = renderHandoff(resolveMemory(saved.id, await store.chain(saved.id)))
          await lifecycle.assertOpen(event.sessionID)
          event.result = { summary, metadata: handoffMetadata(saved.author, keep) }
        }
        if (entry.cut) entry.cut.author = saved.author
        entry.proposal = undefined
        return
      }
      boundary = { id: cut.checkpoint, parent: cut.parent, rowIDs: cut.rowIDs, archived: false }
      const boundaries = state(event.sessionID).boundaries ??= new Map()
      boundaries.set(boundary.id, boundary)
      boundary = await store.prepareArchive(rows, cut.rowIDs)
      boundaries.delete(boundary.id)
    } catch (error) {
      warn("archive before compaction; using native", error)
      await warnCycle("Cannot prepare the episode archive; using native OpenCode compaction and its configured model.")
      return
    }
    // Do not replace a result already supplied by another plugin; the archive remains useful.
    if (event.result) return
    try {
      const existing = await memoryAt(event.sessionID, rows, boundary.parent)
      const id = boundary.episode ?? await store.nextEpisode()
      // The reservation rides the pending record: if this cycle fails into native,
      // the fallback's adoption reuses the id instead of burning another number.
      await store.pendingEpisode(boundary.id, id)
      const included = new Set(boundary.rowIDs)
      const transcriptRows = rows.filter((row) => included.has(row.id))
      const stamps = transcriptRows.flatMap((row) => typeof row.time?.created === "number" ? [row.time.created] : [])
      const ids = new Set([...existing.catalog.keys(), id])
      const gap = !boundary.archived || [...existing.catalog.values()].some((episode) => episode.gap)
      const queued = sessions.get(event.sessionID)?.hint
      const context = { through: id, budget: memoryBudget,
        archives: [...new Set([id, ...(existing.through ? [existing.through] : []), ...(existing.working?.references.map((ref) => ref.id) ?? [])])],
        ...(queued ? { queued } : {}) }
      // The exact episode record the handoff will commit; its anchor must be part of every
      // rendering of the working state, so the byte-identical summary can be re-rendered
      // from durable records alone when a fork boundary hides the native row.
      const episodeFor = (summary: string): Episode => ({
        id, summary, rowIDs: boundary.rowIDs,
        ...(stamps.length ? { start: Math.min(...stamps), end: Math.max(...stamps) } : {}),
        ...(!boundary.archived ? { gap: true } : {}),
      })
      // One shared two-attempt budget across patch, full and selected-model fallback.
      // Valid oversized state is kept as a candidate; never truncate constraints.
      const candidates: { readonly handoff: Handoff; readonly rendered: string; readonly size: number }[] = []
      let chosen: { readonly handoff: Handoff; readonly summary: string } | undefined
      const prior = existing.working ?? { constraints: existing.constraints }
      const priorSummary = existing.working ? undefined : existing.episodes.at(-1)?.summary
      let author: Checkpoint["author"] = "compactor"
      const proposal = entry.proposal ?? staged?.proposal
      entry.proposal = undefined
      if (proposal) {
        // A staged cut covers only its own span: rows outside it (the parent's tail, later
        // work riding live) are not the edit's evidence and must not invalidate it. An
        // unstaged edit's evidence was observed over one checkpoint cycle, so that same
        // cycle — the rows after the parent — is its comparison scope.
        const within = staged ? new Set(cut.rowIDs) : undefined
        const before = within ? proposal.evidence.filter(([id]) => within.has(id)) : proposal.evidence
        const scope = within ? rows.filter((row) => within.has(row.id)) : rows.slice(parentIndex + 1)
        const stale = proposal.stale ?? (proposal.checkpoint !== boundary.parent ? "The base checkpoint changed."
          : changedEvidence(before, scope, proposal.publication, true))
        try {
          if (stale) throw new HandoffError(stale)
          const handoff = parseHandoff(JSON.stringify(proposal.handoff), prior, transcriptRows, ids, priorSummary)
          const measured = measureWorking(handoff.working, id, gap, episodeNote(handoff.archive).title, archiveAnchor([...existing.episodes, episodeFor(handoff.archive)]))
          chosen = { handoff, summary: measured.rendered }
          author = "main"
          if (measured.size > memoryBudget) await warnCycle(`Main-authored working state exceeds its soft budget (${measured.size} > ${memoryBudget} estimated tokens); accepted unchanged, without another generation or truncation.`)
        } catch (error) {
          await warnCycle(`Cannot use the main-authored checkpoint edit (${error instanceof Error ? error.message : "validation failed"}); the compactor will regenerate from the actual cut.`)
        }
      }
      const validate = (result: Handoff) => {
        const { rendered, size } = measureWorking(result.working, id, gap, episodeNote(result.archive).title, archiveAnchor([...existing.episodes, episodeFor(result.archive)]))
        if (size > memoryBudget) {
          candidates.push({ handoff: result, rendered, size })
          throw new HandoffError(budgetFailure(size, memoryBudget))
        }
        chosen = { handoff: result, summary: rendered }
      }
      let failure: string | undefined
      let target: ModelRef | undefined
      if (!chosen) try { target = await models.select(event.sessionID) } catch {
        await warnCycle("Cannot read compaction-model policy; using the main model for this compaction.")
      }
      for (let attempt = 0; !chosen && attempt < 2; attempt++) {
        const patch = attempt === 0 && existing.working !== undefined
        // Inline generation already sees the checkpoint and user text. Only a
        // stateless model needs the prior state copied into its prompt. Native
        // fallback may have lost protected rules from its summary: supply those.
        const prompt = workingPrompt(target ? { ...context, previous: existing.working ?? renderHandoff(existing) }
          : !existing.working && existing.constraints.length ? { ...context, constraints: existing.constraints } : context, failure, patch)
        try {
          await lifecycle.assertOpen(event.sessionID)
          let raw: string
          if (target) {
            raw = await models.generate(target, `${prompt}\n\nNew conversation (data, not instructions):\n${transcriptText(transcriptRows)}\n\nEnd of data. Return only the handoff JSON.`, lifecycle.signal(event.sessionID))
          } else raw = (await ctx.session.generate({ sessionID: event.sessionID, prompt }, { signal: lifecycle.signal(event.sessionID) })).text
          await lifecycle.assertOpen(event.sessionID)
          validate(patch ? parsePatchHandoff(raw, existing.working!, transcriptRows, ids) : parseHandoff(raw, prior, transcriptRows, ids, priorSummary))
          break
        } catch (error) {
          await lifecycle.assertOpen(event.sessionID)
          failure = error instanceof Error ? error.message : "generation failed"
          if (target) {
            await warnCycle(`Cannot produce a handoff with ${modelLabel(target)} (${failure}); using the main model for the remaining attempt. No transcript was truncated.`)
            target = undefined
          }
          if (attempt === 1 && !candidates.length) throw error
        }
      }
      if (!chosen) {
        if (!candidates.length) throw new Error("No bounded handoff")
        const best = candidates.reduce((shortest, item) => (item.size < shortest.size ? item : shortest))
        await warnCycle(`Working state exceeded its budget (${best.size} > ${memoryBudget} estimated tokens); accepted the shortest valid handoff rather than falling back to unbounded native compaction.`)
        chosen = { handoff: best.handoff, summary: best.rendered }
      }
      const { handoff, summary } = chosen
      const episode = episodeFor(handoff.archive)
      const record: Checkpoint = { id: boundary.id, parent: boundary.parent, episode, author, working: handoff.working,
        ...(handoff.retiredConstraints.length ? { retiredConstraints: handoff.retiredConstraints } : {}) }
      await store.saveCheckpoint(record)
      if (!warned) await models.clearWarning(event.sessionID)
      // The closing cycle spans the rows this cut archived: everything after the
      // previous checkpoint. Measured in durable tokens and assistant turns.
      const scale = usageScale(rows)
      closeThermostatCycle(event.sessionID, rows.slice(parentIndex + 1), retainedTokens(rows.slice(0, parentIndex + 1)) * scale, scale)
      const live = sessions.get(event.sessionID)
      if (live) live.hint = undefined // The committed handoff is the signal's only consumer.
      if (entry.cut) entry.cut.author = author
      await lifecycle.assertOpen(event.sessionID)
      event.result = { summary, metadata: handoffMetadata(author, keep) }
    } catch (error) {
      await lifecycle.assertOpen(event.sessionID)
      const detail = error instanceof HandoffError ? error.message : "generation or checkpoint storage failed"
      await warnCycle(`Working-state compaction failed (${detail}); using native OpenCode compaction and its configured model. This safety fallback is not size-bounded; no active constraints were silently truncated.`)
    }
  }

  /** An open gate's evaluation window closed with the round. With next-prompt
   *  scheduling live, repay the crossing as a deferred marker so the cut lands
   *  steered by the next message; otherwise request the compaction now. */
  const repayGate = async (sessionID: SessionID, gate: Gate, after: string | undefined) => {
    gateStat(sessionID, "repaid")
    if (after === undefined) {
      void requestCompact(sessionID, gate.checkpoint, gate.growth, "The round ended before its budget gate could close.")
      return
    }
    await storeFor(sessionID).saveDeferredCompaction({ checkpoint: gate.checkpoint, after, tokens: gate.growth, threshold: 0 })
    decide(state(sessionID), "deferred", "The round ended before its budget gate could close; the crossing is repaid at the next prompt, steered by it.")
  }

  const onRoundEnded = async (sessionID: SessionID) => {
    const entry = sessions.get(sessionID)
    if (entry === undefined) return
    const { gate, deferral, hold } = entry
    entry.gate = entry.deferral = entry.hint = entry.evidence = undefined
    // A failed or interrupted round continues the same work, so a staged cut applies at
    // its boundary — later steering only resumes this task. An open gate's crossing is
    // repaid here too: at the next prompt when the machinery is live, so even a failed
    // round's cut lands steered by the steering/continuation message.
    let read: Promise<readonly Row[]> | undefined
    const rows = () => (read ??= ctx.session.context({ sessionID }, { signal: lifecycle.signal(sessionID) }))
    if (hold) {
      try {
        const live = await rows()
        const checkpoint = activeCheckpoint(live)
        const start = checkpoint === null ? 0 : live.findIndex((row) => row.id === checkpoint) + 1
        applyStaged(sessionID, hold, checkpoint, durableTokens(live.slice(start)) * usageScale(live),
          "A staged checkpoint closed a failed or interrupted round; applying it at its staged boundary.")
      } catch (error) { log("round end", error) }
    }
    if (gate && !deferral?.approved) {
      let after: string | undefined
      if (!state(sessionID).owner?.subagent && idleOption !== Infinity) try {
        after = (await rows()).at(-1)?.id
      } catch (error) { log("round end", error) }
      await repayGate(sessionID, gate, after)
    }
  }
  const onIdle = async (sessionID: SessionID) => {
    try {
      const [info, rows] = await Promise.all([
        sessionInfo(sessionID), ctx.session.context({ sessionID }, { signal: lifecycle.signal(sessionID) }),
      ])
      const entry = sessions.get(sessionID)
      const decision = entry?.deferral
      // The round ended, so its grant expires. A grant that carried through this verified
      // round owes no catch-up marker: the next round re-affirms or the mid-turn trigger
      // catches up in one bounded compaction. busy alone identifies the round, because
      // hosts stamp the new idle time when the round ends, before this event fires.
      const held = decision !== undefined && decision.approved && decision.busy === info.time?.busy
      if (entry) entry.deferral = entry.hint = entry.evidence = undefined // Authoring observations die with their round.
      if (entry?.guard !== undefined && !running(rows)) clearGuard(sessionID)
      // The round ended with an open gate: its evaluation window is over, so the crossing
      // it consumed is repaid unless a grant held the round or the boundary already moved.
      // A round end belongs to next-prompt scheduling: with the machinery live the crossing
      // is repaid as a deferred marker, so its cut lands steered by the user's next message.
      const scheduled = !state(sessionID).owner?.subagent && idleOption !== Infinity
      const gate = entry?.gate
      if (gate) {
        if (entry) entry.gate = undefined
        if (!held && gate.checkpoint === activeCheckpoint(rows)) await repayGate(sessionID, gate, scheduled ? rows.at(-1)?.id : undefined)
      }
      // The round ended with a staged cut: a final reply's round end belongs to next-prompt
      // scheduling. The context stays intact — nothing is evicted — and the cut is re-made
      // at the user's next message, steered by it, covering everything from the last
      // checkpoint through the staged call itself. Without live scheduling machinery the
      // staged cut applies immediately rather than being lost.
      const stagedHold = entry?.hold
      if (stagedHold) {
        const checkpoint = activeCheckpoint(rows), after = rows.at(-1)?.id
        const start = checkpoint === null ? 0 : rows.findIndex((row) => row.id === checkpoint) + 1
        const growth = durableTokens(rows.slice(start)) * usageScale(rows)
        if (scheduled && after && growth > 0) {
          entry.hold = undefined // The staging dissolves into the marker: the classic post-round cut covers the call itself.
          await storeFor(sessionID).saveDeferredCompaction({ checkpoint, after, tokens: growth, threshold: 0 })
          decide(state(sessionID), "deferred", "A staged checkpoint closed the round; its cut waits for the next prompt, steered by the user's message.")
          return
        }
        if (growth > 0) applyStaged(sessionID, stagedHold, checkpoint, growth, "A staged checkpoint closed a round without next-prompt scheduling; applying it now.")
        else {
          entry.hold = undefined
          decide(state(sessionID), "held", "A staged checkpoint closed a round without new durable work; there is nothing to cut.")
        }
      }
      if (!scheduled) return
      // Add output produced after the last request, including an updated retry row.
      // Never reuse a view whose raw boundary disappeared or admitted another prompt.
      const view = entry?.view, checkpoint = activeCheckpoint(rows)
      if (!view || view.checkpoint !== checkpoint) return
      const start = view.after === null ? 0 : rows.findIndex((row) => row.id === view.after)
      if (start < 0 || rows.slice(view.after === null ? 0 : start + 1).some((row) => row.type === "user")) return
      const afterCheckpoint = checkpoint === null ? 0 : rows.findIndex((row) => row.id === checkpoint) + 1
      const scale = usageScale(rows), growth = durableTokens(rows.slice(afterCheckpoint)) * scale
      const measured = view.scope === "retained" ? retainedTokens(rows) * scale : growth
      const after = rows.at(-1)?.id
      if (!held && growth > 0 && measured >= view.threshold && after) {
        // Ending a turn only writes a small, branch-specific marker; no model call.
        await storeFor(sessionID).saveDeferredCompaction({ checkpoint, after, tokens: measured, threshold: view.threshold })
        decide(state(sessionID), "deferred", view.scope === "retained" ? "Successful-turn retained conversation reached the overdue-checkpoint safeguard; wait for the next prompt." : "Successful-turn growth reached the idle threshold; wait for the next prompt.")
      }
    } catch (error) {
      const entry = sessions.get(sessionID)
      if (entry) entry.deferral = undefined
      log("idle", error)
    }
  }
  const onPrompt = async (event: SessionPrompt) => {
    const entry = sessions.get(event.sessionID)
    if (entry) {
      entry.evidence = undefined
      const stale = "New user input arrived after the model authored the edit."
      if (entry.proposal) entry.proposal.stale = stale
      // A hold that outlived its round (a missed idle event) keeps its boundary for any
      // later compaction, but its edit was authored before this input and must regenerate.
      if (entry.hold?.proposal) entry.hold = { ...entry.hold, proposal: { ...entry.hold.proposal, stale } }
    }
    if (idleOption === Infinity) return
    try {
      const deferred = await storeFor(event.sessionID).getDeferredCompaction()
      if (!deferred || deferred.tokens < deferred.threshold) return
      const [info, rows] = await Promise.all([
        sessionInfo(event.sessionID), ctx.session.context({ sessionID: event.sessionID }, { signal: lifecycle.signal(event.sessionID) }),
      ])
      // Do not reuse another branch/boundary's marker or commit a staged revert.
      if (state(event.sessionID).owner?.subagent || info.revert || running(rows) ||
          deferred.checkpoint !== activeCheckpoint(rows) || deferred.after !== rows.at(-1)?.id) return
      // Marker tokens use their scheduling scope, but admission identity always
      // uses NEW growth, just like context/manual requests for this same boundary.
      const start = deferred.checkpoint === null ? 0 : rows.findIndex((row) => row.id === deferred.checkpoint) + 1
      const growth = durableTokens(rows.slice(start)) * usageScale(rows)
      if (growth <= 0) return
      // The queued message is the strongest relevance signal for what the working
      // state must keep live; it stays evidence, never a summarized or obeyed row.
      const queued = event.prompt.text.trim().slice(0, 2_000)
      if (queued) state(event.sessionID).hint = queued
      await requestCompact(event.sessionID, deferred.checkpoint, growth, "A new prompt resumed a matching deferred-compaction marker.")
    } catch (error) { log("deferred compaction; admitting prompt unchanged", error) }
  }
  const onCompactionFinished = (sessionID: string, failed = false) => {
    const entry = state(sessionID)
    entry.lastCut = { at: Date.now(), action: failed ? "failed" : "completed",
      reason: (entry.cut?.reason ?? (entry.guard === undefined ? undefined : entry.attempt?.reason) ?? "Host compaction; trigger unavailable.") +
        (entry.cut?.author ? entry.cut.author === "main" ? " Main-authored working state; no compaction generation." : " Compactor-generated working state." : ""),
      ...(entry.cut ? { id: entry.cut.id } : {}) }
    entry.cut = undefined
    entry.proposal = undefined
    entry.live = undefined
    clearGuard(sessionID)
    // A failing compaction must not be retried on every following step.
    if (failed) entry.cooldownUntil = Date.now() + GUARD_TIMEOUT
    else {
      entry.cooldownUntil = undefined
      // A completed cut moved the boundary; its open gate is stale now.
      entry.gate = undefined
      entry.reminder = undefined
    }
  }
  const onDeleted = async (sessionID: string) => {
    clearGuard(sessionID)
    // Close admission synchronously, then drain even non-cancellable writes before
    // intentional graduation and the FINAL clear. Never invent missing ownership.
    const closed = lifecycle.deleteSession(sessionID)
    try {
      await closed
      const rawStore = createStore(rawStorage, sessionID, warn)
      let owner = sessions.get(sessionID)?.owner
      try { owner ??= await rawStore.getOwner() } catch (error) { warn("read deleted session ownership; skipping graduation", error) }
      await exclusive(keyFor(sessionID, "delete"), async () => {
        try {
          if (owner && !owner.subagent) {
            await createProjectStore(rawStorage, owner.projectID, warn).graduate(await rawStore.episodeNotes(), sessionID)
            graduatedCache.delete(owner.projectID)
          }
        } catch (error) { warn("graduate session notes; deletion proceeds", error) }
        await rawStore.clear()
        await lifecycle.completeDeletion(sessionID)
      })
    } finally {
      sessions.delete(sessionID)
      dropIndex(sessionID)
      for (const key of [...transcripts.keys()]) if (key.startsWith(`${sessionID}\0`)) {
        transcriptChars -= transcripts.get(key)!.size
        transcripts.delete(key)
      }
    }
  }

  const onFork = async (sessionID: SessionID) => {
    try { await inheritSession(sessionID, await ctx.session.context({ sessionID })) }
    catch (error) { warn("inherit fork archive; will retry on first use", error) }
  }

  /** Hydrate only the calls referenced by these rows. A broken original is local
   *  to that call, not a reason to hide unrelated rows or an entire episode. */
  const callsForRows = async (store: Store, rows: readonly { readonly text?: string }[]) => {
    const ids = new Set<string>(), calls = new Map<string, ArchivedCall>()
    for (const row of rows) if (row.text !== undefined) {
      try { for (const call of rowCalls(JSON.parse(row.text) as Row)) ids.add(call.id) }
      catch { /* the row renderer discloses an unreadable row */ }
    }
    await Promise.all([...ids].map(async (id) => {
      try { const call = await store.getCall(id); if (call) calls.set(id, call) }
      catch (error) { warn(`read archived call ${id}; using its row evidence`, error) }
    }))
    return calls
  }
  // Episode transcripts are immutable once their checkpoint exists, so searches can reuse them.
  const transcript = async (sessionID: string, store: Store, id: string, catalog: ReadonlyMap<string, Episode>, layer: Layer = "full", calls?: ReadonlyMap<string, ArchivedCall>) => {
    const key = `${keyFor(sessionID, id)}\0${layer}`, cached = transcripts.get(key)
    if (cached !== undefined) {
      transcripts.delete(key)
      transcripts.set(key, cached)
      return cached
    }
    const episode = episodeRows(id, catalog)
    const rows = await Promise.all(episode.rowIDs.map(async (rowID) => ({ id: rowID, text: await store.getRow(rowID) })))
    const originals = calls ?? (layer === "conversation" ? new Map<string, ArchivedCall>() : await callsForRows(store, rows))
    const files: RecallFile[] = [], echoes: [number, number][] = []
    const text = formatTranscript(id, rows, { layer, gap: episode.gap, title: episodeNote(catalog.get(id)?.summary ?? "").title, files, echoes, call: (callID) => originals.get(callID) })
    const result = { text, files, echoes, size: text.length + files.reduce((sum, item) => sum + item.file.uri.length, 0) }
    if (result.size > TRANSCRIPT_CACHE_CHARS) return result
    transcripts.set(key, result)
    transcriptChars += result.size
    for (const [oldest, value] of transcripts) {
      if (transcriptChars <= TRANSCRIPT_CACHE_CHARS || oldest === key) break
      transcripts.delete(oldest)
      transcriptChars -= value.size
    }
    return result
  }

  const recall = async (sessionID: SessionID, input: RecallInput): Promise<RecallContent> => {
    try {
      const id = typeof input.id === "string" ? input.id.trim() : ""
      const query = typeof input.query === "string" ? input.query.trim() : ""
      const scope = typeof input.episode === "string" ? input.episode.trim() : undefined
      const page = input.page
      const layer: Layer = input.layer ?? "conversation"
      if ((!id && !query) || (id && query)) return "Provide either id or query."
      if (input.episode !== undefined && id) return "episode applies only to a query, not an id fetch."
      if (input.episode !== undefined && (scope === undefined || !/^E[1-9]\d*$/.test(scope))) return "episode must be an exact episode label, such as E57."
      if (!(LAYERS as readonly string[]).includes(layer)) return `layer must be one of: ${LAYERS.join(", ")}.`
      if (query.length > 2_000) return "Use a query of at most 2,000 characters; prefer exact identifiers and a few task keywords."
      if (id.length > 2_000) return "Use an id of at most 2,000 characters; addresses are short handles like E57, call_01HZ2a3 or catalog."
      if (page !== undefined && (!Number.isSafeInteger(page) || page < 1)) return "Page must be a positive safe integer."
      const store = storeFor(sessionID)
      const target = id ? parseTarget(id) : undefined
      if (target?.kind === "error") return target.message
      // Call and row originals live in the store alone: an elided original must not
      // hide behind an unreadable episode chain, unrelated record or owner lookup.
      const readFacts = async () => {
        const calls = await store.getCalls(), rows = await store.getRows()
        return { byID: new Map(calls.map((call) => [call.id, call])), calls, rows }
      }
      let projectRead: Promise<GraduatedNote[]> | undefined
      const projectNotes = () => projectRead ??= ownerFor(sessionID).then(({ projectID }) => readGraduated(projectID))
      const renderOriginal = async (handle: string, wanted: number | undefined): Promise<RecallContent | undefined> => {
        const files: RecallFile[] = []
        const call = await store.getCall(handle)
        if (call) return recallPage(shortId(handle), formatCall(call, files), wanted, files)
        const raw = await store.getRow(handle)
        if (raw !== undefined) {
          const calls = await callsForRows(store, [{ text: raw }])
          return recallPage(shortId(handle), formatRow(raw, (id) => calls.get(id), files), wanted, files)
        }
        if (/^P[1-9]\d*$/.test(handle)) {
          const note = await projectFor((await ownerFor(sessionID)).projectID).graduatedNote(handle)
          if (note) return recallPage(shortId(handle), formatGraduated(note), wanted)
        }
        return undefined
      }
      const renderOpaque = async (handle: string, wanted: number | undefined): Promise<{ content: RecallContent } | { error: string }> => {
        const exact = await renderOriginal(handle, wanted)
        if (exact !== undefined) return { content: exact }
        const notes = handle.startsWith("P") ? await projectNotes() : []
        const resolved = resolveHandle(handle, [...await store.matchingIDs(handle), ...notes.map((note) => note.id)])
        if ("error" in resolved) return resolved
        const content = await renderOriginal(resolved.id, wanted)
        return content === undefined ? { error: `Archived original ${shortId(resolved.id)} is unavailable; recall gap.` } : { content }
      }
      if (target?.kind === "opaque") {
        const wanted = target.page ?? page
        let verdict = await renderOpaque(target.handle, wanted)
        if ("content" in verdict) return verdict.content
        try {
          // A fork's originals may arrive only with inheritance; retry once it ran.
          await inheritSession(sessionID, await ctx.session.context({ sessionID }))
          verdict = await renderOpaque(target.handle, wanted)
        } catch { /* keep the store-only verdict */ }
        return "content" in verdict ? verdict.content : verdict.error
      }

      const rows = await ctx.session.context({ sessionID })
      await inheritSession(sessionID, rows)
      const checkpoint = activeCheckpoint(rows)
      const memory = await memoryAt(sessionID, rows, checkpoint)
      if (scope && !memory.catalog.has(scope)) return `No episode "${scope.slice(0, 120)}" in the active archive; recall the catalog for current labels.`
      if (target?.kind === "catalog") {
        const entries = [...memory.catalog.values()].map((episode) => {
          const { title, body } = episodeNote(episode.summary)
          return {
            id: episode.id, ...(title ? { title } : {}), note: body,
            ...(episode.start !== undefined && episode.end !== undefined ? { start: episode.start, end: episode.end } : {})
          }
        })
        if (!entries.length) return "Nothing is archived yet."
        if (target.entry !== undefined) {
          const entry = entries.find((one) => one.id === target.entry)
          if (!entry) return `No catalog entry "${target.entry}"; recall the catalog for current labels.`
          return recallPage(`catalog ${entry.id}`, formatCatalogEntry(entry), target.page ?? page)
        }
        // Listings page like search hits: one page per call, never a whole dump.
        return recallPage(`catalog${target.all ? " all" : ""}`, formatCatalog(entries, target.all ? "all" : "compact"), target.page ?? page ?? 1)
      }

      if (target?.kind === "episode") {
        const resolved = resolveHandle(target.handle, [...memory.catalog.keys()])
        if ("error" in resolved) return resolved.error
        const depth = target.layer ?? layer
        const full = await transcript(sessionID, store, resolved.id, memory.catalog, depth)
        return recallPage(address(resolved.id, undefined, depth), full.text, target.page ?? page, full.files)
      }

      // One home per fact: dialogue and tool/shell tags in the episode's conversation home,
      // tool output in its call original, shell output in its row; summaries surface only as
      // labeled pointer hits. Every search page therefore lands on fetchable text.
      const cached = indexes.get(sessionID)
      if (cached !== undefined) { // refresh the LRU position, as transcripts do
        indexes.delete(sessionID)
        indexes.set(sessionID, cached)
      }
      let documents = cached?.checkpoint === checkpoint ? cached.documents : undefined
      if (documents === undefined) {
        documents = []
        const facts = await readFacts()
        const rowEpisodes = new Map<string, string[]>(), callEpisodes = new Map<string, string[]>()
        for (const episode of memory.catalog.values()) for (const id of episode.rowIDs) rowEpisodes.set(id, [...(rowEpisodes.get(id) ?? []), episode.id])
        for (const row of facts.rows) {
          const episodes = rowEpisodes.get(row.id)
          if (!episodes) continue
          try { for (const call of rowCalls(JSON.parse(row.text) as Row)) callEpisodes.set(call.id, [...new Set([...(callEpisodes.get(call.id) ?? []), ...episodes])]) }
          catch { /* unreadable row */ }
        }
        for (const episode of memory.catalog.values()) {
          const full = await transcript(sessionID, store, episode.id, memory.catalog, "conversation", facts.byID)
          documents.push({ id: episode.id, text: full.text, echoes: full.echoes, layer: "conversation", episodes: [episode.id] })
          const { title, body } = episodeNote(episode.summary)
          if (title || body) documents.push({ id: `${episode.id}#note`, note: true, episodes: [episode.id],
            text: formatCatalogEntry({ id: episode.id, ...(title ? { title } : {}), note: body,
              ...(episode.start === undefined ? {} : { start: episode.start }), ...(episode.end === undefined ? {} : { end: episode.end }) }) })
        }
        for (const call of facts.calls) {
          const callEchoes: [number, number][] = []
          const text = formatCall(call, [], callEchoes)
          documents.push({ id: call.id, text, layer: "tools", outsideChain: !callEpisodes.has(call.id), episodes: callEpisodes.get(call.id), ...(callEchoes.length ? { echoes: callEchoes } : {}) })
        }
        for (const row of facts.rows) {
          try {
            // Shell output and injected content (skill and attachment text) home in their
            // row originals; a user row with neither renders empty and joins no corpus.
            const type = JSON.parse(row.text).type
            if (type === "shell" || type === "user" || type === "skill") {
              const text = formatRow(row.text, (callID) => facts.byID.get(callID))
              if (text) documents.push({ id: row.id, text, layer: "tools", outsideChain: !rowEpisodes.has(row.id), episodes: rowEpisodes.get(row.id) })
            }
          } catch { /* unreadable row */ }
        }
        keepIndex(sessionID, { checkpoint, documents, chars: documents.reduce((sum, document) => sum + document.text.length, 0) })
      }
      // Graduated notes join only unfiltered queries: they have no layer home, and at
      // the full layer the note itself is the fetchable original. The cached documents
      // array is never mutated — the corpus is per-call.
      const graduated = !scope && layer === "full" ? await projectNotes() : []
      const corpus: readonly SearchDocument[] = scope ? documents.filter((document) => document.episodes?.includes(scope)) : graduated.length ? [...documents, ...graduated.map((note): SearchDocument =>
        ({ id: note.id, text: formatGraduated(note), boost: recencyBoost(note.end), graduated: { session: note.session, end: note.end } }))] : documents
      if (!corpus.length) return "Nothing is archived to search yet."
      const hits = search(query, corpus, MAX_SEARCH_HITS, layer), at = page ?? 1, start = (at - 1) * SEARCH_PAGE_HITS
      if (start >= hits.length) return at === 1 ? "No matching snippets. Try broader keywords or exact identifiers." : "No more search results."
      const lines = hits.slice(start, start + SEARCH_PAGE_HITS).map((hit) => {
        const target = `recall id=${hit.note ? `catalog ${hit.id.split("#")[0]} page ${hit.page}` : address(hit.id, hit.page)}`
        const also = hit.also?.length ? ` (also ${hit.also.map((location) => (hit.note ? `catalog ${location.id.split("#")[0]} page ${location.page}` : address(location.id, location.page))).join(", ")})` : ""
        const label = hit.note ? " (archive note, not original evidence)"
          : hit.graduated ? ` (graduated session note, ${shortId(hit.graduated.session)}, ${formatDuration(Math.max(0, Date.now() - hit.graduated.end))} ago)`
          : hit.outsideChain ? " (archived evidence outside the active episode chain; may be from a reverted branch)"
          : ""
        return `- ${target}${also}${label}: ${hit.snippet}`
      })
      return `Historical evidence${scope ? ` in ${scope}` : ""}, page ${at} of ${Math.ceil(hits.length / SEARCH_PAGE_HITS)} (${hits.length} hit${hits.length === 1 ? "" : "s"})${hits.length === MAX_SEARCH_HITS ? `; top ${MAX_SEARCH_HITS} matches only—narrow the query for other evidence` : ""}\n${lines.join("\n")}`
    } catch (error) { log("recall", error); return `Recall unavailable: ${error instanceof Error ? error.message : "unexpected error"}` }
  }
  // Main-authored edits replace the canonical working state, never append a notes
  // log. Admission stages them; the archived cut must prove the evidence still fits.
  const checkpointNow = async (input: CheckpointInput, context: ToolContext) => {
    const { sessionID } = context
    if (!object(input)) return "Not admitted: provide a working-state edit object, or {} for compactor generation."
    const edited = Object.keys(input).length > 0
    let info: SessionInfo, rows: readonly Row[]
    try {
      [info, rows] = await Promise.all([sessionInfo(sessionID), ctx.session.context({ sessionID }, { signal: lifecycle.signal(sessionID) })])
    } catch (error) {
      log("checkpoint now", error)
      return "Failed: the conversation could not be read, so no checkpoint was requested."
    }
    if (running(rows)) return "Already pending: a compaction is running. No additional checkpoint was requested."
    if (info.revert || info.time.busy === undefined) return "Not admitted: checkpointing needs an active round without a staged revert."
    const entry = state(sessionID), checkpoint = activeCheckpoint(rows)
    if (entry.hold) return "Already pending: a staged checkpoint is waiting for your next action."
    // The refusals admission itself would make, made here: never stage a cut the
    // machinery could not apply at the very next step. The wording matches admission.
    const scale = usageScale(rows), index = checkpoint === null ? -1 : rows.findIndex((row) => row.id === checkpoint)
    const growth = durableTokens(index < 0 ? rows : rows.slice(index + 1)) * scale
    const key = `${checkpoint ?? ""}:${growth}`
    if (entry.guard !== undefined) return "Already pending: A compaction request is guarded as pending; completion is not confirmed."
    if ((entry.cooldownUntil ?? 0) > Date.now()) return "Not admitted: A failed cut is cooling down; retry after three minutes."
    if (entry.attempt?.key === key && Date.now() - entry.attempt.time < GUARD_TIMEOUT) return "Not admitted: A recent request covered this same boundary and growth; wait for its outcome or the retry timeout."
    // Hold the cut at this step boundary and let the model's next action decide: tool
    // work continues the round and applies the staged cut; a final reply's round end
    // keeps the context intact and next-prompt scheduling re-cuts it, steered by the
    // user's message. Nothing is generated or evicted before that choice — the staged
    // boundary preserves this exact context either way. The claim is synchronous, so a
    // concurrent call cannot overwrite this staging's edit with its own.
    entry.hold = { boundary: context.messageID, at: Date.now() }
    let proposal: Proposal | undefined, regenerate: string | undefined, warning = ""
    if (edited) try {
      const existing = await memoryAt(sessionID, rows, checkpoint)
      const handoff = parseCheckpoint(input, existing.working, existing.constraints, rows.slice(index + 1), new Set(existing.catalog.keys()), existing.working ? undefined : existing.episodes.at(-1)?.summary)
      const episode: Episode = { id: "next", summary: handoff.archive, rowIDs: [] }
      const { size } = measureWorking(handoff.working, "next", existing.episodes.some((item) => item.gap), episodeNote(handoff.archive).title, archiveAnchor([...existing.episodes, episode]))
      if (size > memoryBudget) warning = ` Merged working state ~${size} estimated tokens exceeds the soft target ${memoryBudget}; no truncation or size-only rewrite will be requested.`
      const observed = entry.evidence
      regenerate = !observed ? "No current main-model evidence observation is available."
        : observed.checkpoint !== checkpoint ? "The base checkpoint changed."
        : changedEvidence(observed.value, index < 0 ? rows : rows.slice(index + 1), context)
      if (!regenerate) proposal = { checkpoint, evidence: observed!.value, publication: { messageID: context.messageID, id: context.id }, handoff }
    } catch (error) {
      entry.hold = undefined
      log("checkpoint edit", error)
      return error instanceof HandoffError ? `Not admitted: ${error.message}. Nothing was truncated or requested.`
        : "Failed: the working-state edit could not be validated, so no checkpoint was requested."
    }
    if (proposal) entry.hold = { ...entry.hold, proposal }
    entry.gate = undefined // An open gate is a schedule; this call answers it with a staged cut.
    return `Prepared: the compact state is staged at this step boundary. ${proposal ? "Validated working-state edit staged; no compaction generation if the evidence still matches at the cut."
      : regenerate ? `Edit not staged: ${regenerate} The compactor will generate from the staged boundary.` : "The compactor will generate the working state at the staged boundary."}${proposal ? warning : ""} The cut lands when your next step continues the work; if it closes the task, finish your reply — the cut then waits for the user's next message, steered by it. Completion is not confirmed; archived evidence becomes recallable after the cut.`
  }

  /** Observation only: do not inherit/adopt, save ownership, update the thermostat,
   *  or rebuild a request just to display status. Missing hook observations stay missing. */
  const inspectMemory = async (sessionID: SessionID): Promise<MemoryStatus> => {
    const signal = lifecycle.signal(sessionID)
    const [info, rows] = await Promise.all([ctx.session.get({ sessionID }, { signal }), ctx.session.context({ sessionID }, { signal })])
    const entry = sessions.get(sessionID), checkpoint = activeCheckpoint(rows)
    const index = checkpoint === null ? -1 : rows.findIndex((row) => row.id === checkpoint), current = rows[index]
    const cycle = rows.slice(index + 1), scale = usageScale(rows), growth = durableTokens(cycle) * scale
    const model = modelRef(info.model) ?? entry?.model, sizes = await windowSize(model)
    const reserve = model && entry?.request?.model === modelLabel(model) ? entry.request.outputReserve : sizes?.output || DEFAULT_OUTPUT_RESERVE
    const thermostat: Thermostat | undefined = sizes ? { bounds: budgetBounds(sizes.context, reserve, sizes.input),
      entry: model && info.projectID ? (await projectFor(info.projectID).readThermostat())[modelLabel(model)] : undefined } : undefined
    const baseline = softBudget(thermostat)
    const liveRequest = entry?.live, sameModel = model && liveRequest?.model === modelLabel(model)
    const ceiling = safeCeiling(sizes, reserve)
    const overhead = sameModel && liveRequest?.checkpoint === checkpoint ? liveRequest.overhead : 0
    const live = liveFor(baseline, cycle, scale, ceiling - overhead)
    const budget = live.budget
    const saved = checkpoint ? await storeFor(sessionID).getCheckpoint(checkpoint) : undefined
    const metadata = object(current?.metadata) ? current.metadata : {}
    const summary = current?.type === "compaction" && current.status === "completed" ? current.summary ?? "" : ""
    const recent = typeof metadata.recent === "string" ? metadata.recent : ""
    const latestCut = rows.findLast((row) => row.type === "compaction" && (row.status === "completed" || row.status === "failed"))
    const usage = latestProviderUsage(rows)
    return { sessionID, at: Date.now(),
      ...(checkpoint ? { checkpoint: { id: checkpoint, ...(saved ? { episode: saved.episode.id, ...(saved.author ? { author: saved.author } : {}) } : {}), native: saved?.episode.native ?? !(object(metadata.nextdcp) && metadata.nextdcp.version === 2) } } : {}),
      summary: { chars: summary.length, tokens: tokens(summary) * scale }, recent: { chars: recent.length, tokens: tokens(recent) * scale },
      growth: { rows: cycle.length, tokens: growth }, retained: retainedTokens(rows) * scale, scale,
      budgetMode: budgetOption === Infinity ? "disabled" : budgetOption > 0 ? "explicit" : thermostat ? "auto" : "unknown",
      budgetScope: automatic ? "retained" : "growth",
      ...(budget > 0 && Number.isFinite(budget) ? { budget } : {}),
      ...(automatic && thermostat ? { budgetBounds: thermostat.bounds, budgetBaseline: baseline, liveAllowance: live.allowance } : {}),
      compaction: running(rows) ? "running" : entry?.hold !== undefined || entry?.guard !== undefined || entry?.admission ? "pending" : "idle",
      ...(entry?.request ? { request: entry.request } : {}), ...(usage ? { usage } : {}),
      ...(entry?.decision ? { decision: entry.decision } : {}),
      ...(entry?.lastCut ? { lastCut: entry.lastCut } : latestCut ? { lastCut: { action: latestCut.status!, reason: "Host record; trigger unavailable since plugin load.", id: latestCut.id,
        ...(latestCut.time?.created === undefined ? {} : { at: latestCut.time.created }) } } : {}),
    }
  }
  const memoryStatus = async (sessionID: SessionID): Promise<MemoryStatus> => {
    const closed = Symbol("closed"), result = await lifecycle.run<MemoryStatus | typeof closed>(sessionID, () => inspectMemory(sessionID), closed)
    if (result === closed) throw new Error("Session archive is closed")
    return result
  }
  const deletions = new Set<Promise<void>>()
  let disposed = false, recovery: Promise<void> | undefined
  const trackDeletion = (work: Promise<void>) => {
    deletions.add(work)
    void work.then(() => deletions.delete(work), () => deletions.delete(work))
    return work
  }
  const deleteSession = (id: string) => trackDeletion(onDeleted(id).catch((error) => {
    warn(`delete session ${id}; raw cleanup remains pending and will retry`, error)
    throw error
  }))
  const recoverDeleted = () => {
    if (disposed) return Promise.resolve()
    if (recovery) return recovery
    const work = trackDeletion((async () => {
      let failed = false
      for await (const id of lifecycle.pendingDeletions()) {
        if (disposed) return
        try { await deleteSession(id) }
        catch { failed = true } // One stuck namespace must not strand the other tombstones.
      }
      if (failed) throw new Error("Raw cleanup remains pending for deleted sessions")
    })())
    recovery = work
    const done = () => { if (recovery === work) recovery = undefined }
    void work.then(done, done)
    return work
  }
  /** Events are global. Route by their recorded Location, or durable ownership if
   *  the session has already disappeared. ctx.location is NOT a session owner. */
  const acceptsEvent = async (id: string, location?: SessionOwner["location"]) => {
    const sameLocation = (one: SessionOwner["location"]) => one.directory === ctx.location.directory && one.workspaceID === ctx.location.workspaceID
    if (location) return sameLocation(location)
    const owner = sessions.get(id)?.owner ?? await createStore(rawStorage, id).getOwner()
    if (owner) return sameLocation(owner.location)
    try {
      const info = await ctx.session.get({ sessionID: id as SessionID })
      if (!sameLocation(info.location)) return false
      await lifecycle.run(id, () => sessionInfo(id as SessionID), undefined)
      return true
    } catch { return false }
  }
  return {
    onPrompt: (event: SessionPrompt) => lifecycle.run(event.sessionID, () => onPrompt(event), undefined),
    onContext: (event: SessionContext) => lifecycle.run(event.sessionID, () => onContext(event), undefined),
    onCompaction: (event: SessionCompaction) => lifecycle.run(event.sessionID, () => exclusive(keyFor(event.sessionID, "cut"), () => onCompaction(event)), undefined),
    onIdle: (id: SessionID) => lifecycle.run(id, () => onIdle(id), undefined),
    onRoundEnded: (id: SessionID) => lifecycle.run(id, async () => onRoundEnded(id), undefined),
    onCompactionFinished: (id: string, failed = false) => lifecycle.run(id, async () => onCompactionFinished(id, failed), undefined),
    onDeleted: deleteSession,
    recoverDeleted,
    onFork: (id: SessionID) => lifecycle.run(id, () => onFork(id), undefined),
    recall: (id: SessionID, input: RecallInput) => lifecycle.run<RecallContent>(id, () => recall(id, input), "Recall unavailable: session archive is closed."),
    checkpointNow: (input: CheckpointInput, tool: ToolContext) => lifecycle.run(tool.sessionID, () => checkpointNow(input, tool), "Not admitted: session archive is closed."),
    memoryStatus,
    registerMemory: () => ctx.rpc.register(memoryRpc, { get: (input) => memoryStatus((input as { sessionID: SessionID }).sessionID) }),
    registerModels: models.register,
    acceptsEvent,
    async dispose() {
      disposed = true
      for (const id of sessions.keys()) clearGuard(id)
      await lifecycle.dispose()
      await Promise.allSettled([...deletions])
      sessions.clear(); transcripts.clear(); transcriptChars = 0; graduatedCache.clear(); indexes.clear(); indexChars = 0
    },
  }
}

/** Register the documented v2 hooks and tools. */
export async function install(ctx: Plugin.Context) {
  const controller = createController(ctx)
  await controller.registerModels()
  await controller.registerMemory()
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "recall",
      description: RECALL_DESCRIPTION,
      input: { type: "object", properties: { id: { type: "string" }, query: { type: "string" }, episode: { type: "string", pattern: "^E[1-9][0-9]*$", description: "Optional query-only scope: one exact episode label, e.g. E57." }, layer: { type: "string", enum: [...LAYERS] }, page: { type: "integer", minimum: 1 } }, additionalProperties: false },
      options: { codemode: false },
      execute: async (input, context) => ({ content: await controller.recall(context.sessionID, input as RecallInput) }),
    })
    editor.add({
      name: "checkpoint_now",
      description: CHECKPOINT_NOW_DESCRIPTION,
      input: CHECKPOINT_INPUT,
      options: { codemode: false },
      execute: async (input, context) => ({ content: await controller.checkpointNow(input as CheckpointInput, context) }),
    })
  })
  // Compaction outcomes arrive on the shared event subscription in setup(), which
  // owns the reconnect backoff; install only registers tools and hooks.
  await ctx.session.hook("prompt", controller.onPrompt)
  await ctx.session.hook("context", controller.onContext)
  await ctx.session.hook("compaction", controller.onCompaction)
  await ctx.session.hook("fork", ({ sessionID }) => controller.onFork(sessionID))
  return controller
}

/** Safe input capacity of one request: the context window less the output reserve,
 *  the input limit and the request margin, never negative. An unknown window
 *  imposes no ceiling. */
function safeCeiling(sizes: { readonly context: number; readonly output: number; readonly input?: number } | undefined, reserve: number): number {
  return sizes ? Math.max(0, Math.min(sizes.context - reserve, sizes.input ?? Infinity) - REQUEST_MARGIN) : Infinity
}

/** A tool failure in the last two minutes means the model is mid-diagnosis; cutting
 *  right then would archive the error detail it still needs. The gate stays closed
 *  one build — the next context build re-evaluates, and native overflow is the backstop. */
function recentToolFailure(rows: readonly Row[], now = Date.now()): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (typeof row.time?.created === "number" && now - row.time.created > 120_000) break
    if (row.type === "user") return false
    if (row.type === "assistant") return (row.content ?? []).some((part) =>
      object(part) && part.type === "tool" && object(part.state) && part.state.status === "error")
  }
  return false
}

function textOnly(row: Row): boolean {
  const data = row as Row & Record<string, unknown>
  if (row.type === "user") return !(Array.isArray(data.files) && data.files.length) && !(Array.isArray(data.skills) && data.skills.length)
  if (row.type === "assistant") return (row.content ?? []).every((part) => {
    if (!object(part)) return false
    if (part.type === "text" || part.type === "reasoning") return true
    if (part.type !== "tool" || !object(part.state)) return false
    return Array.isArray(part.state.content) ? part.state.content.every((item) => object(item) && ["text", "json"].includes(String(item.type))) : true
  })
  return ["shell", "system", "synthetic", "skill", "location-switched", "idle"].includes(row.type)
}

/** The new episode's transcript as model-readable text for a stateless request:
 *  text-only rows, attachments refused (the main-model inline path reads the live
 *  session instead). */
function transcriptText(rows: readonly Row[]): string {
  if (rows.some((row) => !textOnly(row))) throw new Error("transcript contains attachments or unsupported content")
  const files: RecallFile[] = []
  const transcript = formatTranscript("current", rows.map((row) => ({ id: row.id, text: JSON.stringify(row) })), { files })
  if (files.length) throw new Error("transcript contains attachments")
  return transcript
}
