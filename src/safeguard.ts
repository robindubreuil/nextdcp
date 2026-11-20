import type { Row } from "./memory.ts"
import { durableTokens, evidenceTokens } from "./estimate.ts"
import { object } from "./guards.ts"
import { rowCalls } from "./store.ts"
import { tokens } from "./tokens.ts"

// Scheduling heuristics, not measured quality boundaries or a checkpoint cadence.
export const EVIDENCE_GRACE_STEPS = 12, EVIDENCE_EXPIRE_STEPS = 28
/** Room for returned evidence plus 50% to work with it, until it ages out. */
export const EVIDENCE_WORK_SHARE = 0.5
/** A reminder needs this share of the baseline in new conversation since the
 *  checkpoint, and again since the previous reminder: enough to be worth a cut. */
export const REMINDER_SHARE = 0.25
/** Larger results the model has not seen yet mean it is still gathering. */
export const UNSEEN_SHARE = 0.05
/** Visible text this long after work reads as stated conclusions, not a preamble. */
export const CONCLUSION_TOKENS = 60
export const NEAR_SHARE = 0.75, CAPACITY_SHARE = 0.85

export type FreshEvidence = { readonly tokens: number; readonly weighted: number }
export type Pause = { readonly steps: number; readonly unseen: number; readonly concluded: boolean }
export type Reminder = {
  readonly checkpoint: string | null
  readonly steps: number
  readonly growth: number
  readonly kind: "boundary" | "capacity"
  /** Capacity is warned once per checkpoint. */
  readonly warned: boolean
}

export const evidenceWeight = (age: number): number =>
  Math.max(0, Math.min(1, (EVIDENCE_EXPIRE_STEPS - age) / (EVIDENCE_EXPIRE_STEPS - EVIDENCE_GRACE_STEPS)))

/** Each result keeps its own age in assistant steps: retries, reloads and later
 *  reads cannot make an old cohort young again. Credit ends at a successful turn
 *  end, which next-prompt scheduling owns; interruptions, failures and steering
 *  continue the same work. Call with rows after the checkpoint. */
export function freshEvidence(rows: readonly Row[], scale = 1): FreshEvidence {
  let age = 0, total = 0, weighted = 0
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at]
    if (row.type === "idle" && !["interrupted", "failed"].includes(String((row as Row & { readonly outcome?: unknown }).outcome))) break
    const count = evidenceTokens([row]) * scale
    total += count
    weighted += count * evidenceWeight(age)
    if (row.type === "assistant") age++
  }
  return { tokens: total, weighted }
}

/** Only temporary headroom can exceed the learned baseline, and never into room
 *  needed for fixed request overhead, output or the margin. The complete-request
 *  capacity check stays authoritative even when the baseline itself cannot fit. */
export function liveBudget(baseline: number, evidence: FreshEvidence, conversationCapacity: number) {
  const allowance = Math.max(0, Math.min(evidence.weighted * (1 + EVIDENCE_WORK_SHARE), conversationCapacity - baseline))
  return { baseline, allowance, budget: baseline + allowance }
}

const visibleText = (row: Row) => (row.content ?? []).reduce<number>((sum, part) =>
  sum + (object(part) && part.type === "text" && typeof part.text === "string" ? tokens(part.text) : 0), 0)

/** Where the latest completed step left the workflow. A pause is a step that
 *  stated conclusions about its own previous tool work and keeps working: it
 *  called tools, so the round goes on. A final reply's round end belongs to
 *  next-prompt scheduling, steered by the user's message; a reply to the user,
 *  a steering message or a question's answer takes precedence over a reminder.
 *  The step's own results/errors and any newer input are still unseen. */
export function pause(rows: readonly Row[], conclusion = CONCLUSION_TOKENS): Pause {
  const last = rows.findLastIndex((row) => row.type === "assistant")
  const steps = rows.reduce((sum, row) => sum + (row.type === "assistant" ? 1 : 0), 0)
  if (last < 0) return { steps, unseen: durableTokens(rows), concluded: false }
  const step = rows[last], after = rows.slice(last + 1)
  const tools = (step.content ?? []).filter((part) => object(part) && part.type === "tool") as readonly Record<string, unknown>[]
  const ownWork = rows.slice(0, last).findLast((row) => row.type === "assistant" || row.type === "user")?.type === "assistant"
  const working = tools.length > 0 && !tools.some((part) => part.name === "question") && !after.some((row) => row.type === "user")
  const failed = rowCalls(step).some((call) => call.result.type === "error")
  return { steps, unseen: evidenceTokens([step]) + durableTokens(after), concluded: ownWork && working && !failed && visibleText(step) >= conclusion }
}

/** Advisory and spaced by real progress, never by hook calls or wall time. An
 *  identical rebuild/retry replays guidance the model has not answered yet. */
export function reminderFor(input: {
  readonly checkpoint: string | null; readonly pause: Pause; readonly growth: number
  readonly baseline: number; readonly request: number; readonly ceiling: number
}, previous?: Reminder): Reminder | undefined {
  const same = previous?.checkpoint === input.checkpoint ? previous : undefined
  if (same?.steps === input.pause.steps) return same
  const floor = input.baseline * REMINDER_SHARE
  if (input.growth < floor) return undefined
  const base = { checkpoint: input.checkpoint, steps: input.pause.steps, growth: input.growth }
  if (!same?.warned && Number.isFinite(input.ceiling) && input.request >= input.ceiling * CAPACITY_SHARE)
    return { ...base, kind: "capacity", warned: true }
  if (!input.pause.concluded || input.pause.unseen > input.baseline * UNSEEN_SHARE) return undefined
  if (same && input.growth - same.growth < floor) return undefined
  return { ...base, kind: "boundary", warned: same?.warned ?? false }
}
