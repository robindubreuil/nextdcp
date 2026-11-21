import { createHash } from "node:crypto"
import { object } from "./guards.ts"
import type { Row } from "./memory.ts"
import { questionSource } from "./user-sources.ts"
import { HandoffError, parseHandoff, parsePatchHandoff, type Handoff, type WorkingMemory } from "./working.ts"

export type CheckpointInput = {
  readonly archive?: string
  readonly working?: Partial<WorkingMemory>
  readonly retire?: readonly { readonly constraint: string; readonly quote: string }[]
}
type Users = Parameters<typeof parseHandoff>[2]
export type Publication = { readonly messageID: string; readonly id: string }
export type Evidence = readonly (readonly [string, string])[]

/** Main-model edits use the same canonical merger and constraint proof as generated
 *  handoffs. Resolve quotes against NEW user text and structured human question
 *  replies, never assistant statements or arbitrary tool output. */
export function parseCheckpoint(input: CheckpointInput, previous: WorkingMemory | undefined, constraints: readonly string[], users: Users, ids: ReadonlySet<string>, priorSummary?: string): Handoff {
  if (!object(input) || Object.keys(input).some((key) => !["archive", "working", "retire"].includes(key)) ||
      input.retire !== undefined && !Array.isArray(input.retire)) throw new HandoffError("Invalid checkpoint edit schema")
  for (const item of input.retire ?? []) {
    if (!object(item) || Object.keys(item).some((key) => !["constraint", "quote"].includes(key)) ||
        typeof item.constraint !== "string" || typeof item.quote !== "string" || !item.quote.trim()) throw new HandoffError("Invalid constraint retirement")
  }
  if (typeof input.archive !== "string" || !input.archive.trim())
    throw new HandoffError("Archive note is required on a direct edit: 'Title: <episode name>' then 1–3 short outcome/search-cue sentences; use {} for compactor generation")
  const raw = JSON.stringify({ archive: input.archive, working: input.working === undefined ? {} : input.working, retiredConstraints: input.retire ?? [] })
  if (!previous && !input.working) throw new HandoffError("No structured working state yet; supply all working fields or call with {} to let the compactor seed it")
  return previous ? parsePatchHandoff(raw, previous, users, ids) : parseHandoff(raw, { constraints }, users, ids, priorSummary)
}

/** Hash semantic evidence, not mutable timing, billing or provider bookkeeping.
 *  User/tool payload keys remain untouched, including keys named time or tokens. */
function evidence(row: Row): unknown {
  const data = row as Row & Record<string, unknown>
  if (row.type === "assistant") return { id: row.id, type: row.type, content: (row.content ?? []).flatMap((part) => {
    if (!object(part) || part.type === "reasoning") return []
    if (part.type === "text") return [{ type: part.type, text: part.text }]
    if (part.type !== "tool" || !object(part.state)) return [part]
    const source = questionSource(part)
    return [{ type: part.type, id: part.id, name: part.name, executed: part.executed,
      state: { status: part.state.status, input: part.state.input, content: part.state.content, error: part.state.error,
        ...(source ? { answers: source.answers } : {}) } }]
  }) }
  if (row.type === "compaction") return { id: row.id, type: row.type, status: row.status, summary: row.summary,
    native: data.native, recent: object(data.metadata) ? data.metadata.recent : undefined }
  const { time: _time, metadata: _metadata, ...facts } = data
  return { ...facts, ...(row.type === "shell" && object(data.metadata) ? { background: data.metadata.background } : {}) }
}

export function captureEvidence(rows: readonly Row[]): Evidence {
  return rows.filter((row) => row.type !== "idle" && !(row.type === "compaction" && row.status !== "completed"))
    .map((row) => [row.id, createHash("sha256").update(JSON.stringify(evidence(row))).digest("hex")] as const)
}

/** A handoff is authored with the last model request's evidence. Its own sole tool
 *  publication is expected; other results, new rows and edits invalidate the fast path. */
export function changedEvidence(before: Evidence, rows: readonly Row[], publication: Publication, completed = false): string | undefined {
  const ownRows = rows.filter((row) => row.id === publication.messageID), own = ownRows[0]
  const parts = own?.type === "assistant" ? own.content ?? [] : []
  const isOwn = (part: unknown) => object(part) && part.type === "tool" && part.id === publication.id && part.name === "checkpoint_now"
  if (ownRows.length !== 1 || parts.filter(isOwn).length !== 1 ||
      parts.some((part) => !object(part) || !["text", "reasoning"].includes(String(part.type)) && !isOwn(part)))
    return "The checkpoint must be the only tool in its step; its publication could not be isolated."
  const call = parts.find(isOwn) as { state?: { status?: string } }
  if (completed && call.state?.status !== "completed") return "The checkpoint tool did not complete successfully."
  const after = captureEvidence(rows.filter((row) => row.id !== publication.messageID))
  const expected = before.filter(([id]) => id !== publication.messageID)
  if (expected.length !== after.length || expected.some(([id, hash], at) => after[at][0] !== id || after[at][1] !== hash))
    return "Conversation evidence changed after the model authored the edit."
  return undefined
}

const text = { type: "string", minLength: 1 } as const
const list = { type: "array", items: text } as const
export const CHECKPOINT_INPUT = {
  type: "object", additionalProperties: false, properties: {
    archive: { ...text, description: "Required on a direct edit: 'Title: <name>' then 1–3 short outcome/search-cue sentences. Cold note, not live state." },
    working: { type: "object", additionalProperties: false, properties: {
      objective: text, constraints: { ...list, description: "Standing user rules: short self-contained exact quotes from new user text. Not host/AGENTS.md rules, plans or task requirements. Remove old rules only via retire." }, state: list, next: list,
      references: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["id", "why"], properties: { id: text, why: text } } },
    } },
    retire: { type: "array", description: "Explicit new-user withdrawal/misattribution correction: exact old constraint plus verbatim user quote.",
      items: { type: "object", additionalProperties: false, required: ["constraint", "quote"], properties: { constraint: text, quote: text } } },
  },
} as const
