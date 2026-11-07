import { tokens } from "./tokens.ts"

export const DEFAULT_MEMORY_BUDGET = 2_000
export class HandoffError extends Error {}
export type WorkingMemory = {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly state: readonly string[]
  readonly next: readonly string[]
  readonly references: readonly { readonly id: string; readonly why: string }[]
}
type Retirement = { readonly constraint: string; readonly messageID: string; readonly quote: string }
export type Handoff = { readonly archive: string; readonly working: WorkingMemory; readonly retiredConstraints: readonly Retirement[] }
/** Compact always-on archive pointer: how many episodes, since when, and how to open them. */
export type Anchor = { readonly count: number; readonly first?: string; readonly last?: string; readonly span?: string }
type UserRow = { readonly id: string; readonly type: string; readonly text?: unknown }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim()
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).every((key) => expected.includes(key))

export function validWorking(value: unknown): value is WorkingMemory {
  return object(value) && keys(value, ["objective", "constraints", "state", "next", "references"]) && text(value.objective) &&
    list(value.constraints) && list(value.state) && list(value.next) && Array.isArray(value.references) && value.references.length <= 3 &&
    value.references.every((ref) => object(ref) && keys(ref, ["id", "why"]) && text(ref.id) && text(ref.why))
}

/** Only the compactor's explicit Title line names an episode; the note body stays archived. */
export function episodeNote(summary: string): { readonly title?: string; readonly body: string } {
  const match = /^Title:[\t ]*([^\r\n]+?)[\t ]*(?:\r?\n|$)/.exec(summary)
  return match ? { title: match[1], body: summary.slice(match[0].length).replace(/^\r?\n/, "") } : { body: summary }
}

/** Old archives are evidence, not an instruction stream or a permanent episode directory.
 *  The handoff ends with one compact archive anchor: episode count, the covered span at
 *  adaptive precision, and how to browse or search — the only always-on archive context. */
export function renderWorking(working: WorkingMemory, through: string, gap = false, title?: string, anchor?: Anchor): string {
  const section = (name: string, items: readonly string[]) => items.length ? `\n\n${name}:\n${items.map((item) => `- ${item}`).join("\n")}` : ""
  // The latest episode's title is already shown as the boundary; the anchor bounds the other
  // end without repeating it. With no boundary title, name both endpoints.
  let range = ""
  if (anchor?.count) {
    const { first, last } = anchor
    if (title) { if (first && first !== title) range = ` since "${first}"` }
    else if (first && last && first !== last) range = ` "${first}" … "${last}"`
    else if (first || last) range = ` "${first ?? last}"`
  }
  const tail = anchor?.count ? ` — ${anchor.count} episode${anchor.count === 1 ? "" : "s"}${range}${anchor.span ? `, ${anchor.span}` : ""}` : ""
  return `## Current working state\nObjective: ${working.objective}` +
    section("Applicable user constraints", working.constraints) + section("Relevant state and decisions", working.state) +
    section("Unfinished work and next action", working.next) + section("Evidence references", working.references.map((ref) => `${ref.id}: ${ref.why}`)) +
    `\n\nArchive through ${through}${title ? ` (${title})` : ""}: older tasks and exact evidence are archived${tail}. Browse: recall catalog; search: recall(query).` +
    (gap ? " Some original history was not archived; recall reports these gaps." : "")
}

/** Validate before committing. Never repair malformed JSON by silently discarding fields. */
export function parseHandoff(raw: string, previous: WorkingMemory | undefined, users: readonly UserRow[], ids: ReadonlySet<string>): Handoff {
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")) } catch { throw new HandoffError("Compactor did not return valid JSON") }
  if (!object(value) || !keys(value, ["archive", "working", "retiredConstraints"]) || !text(value.archive) || value.archive.length > 4_000 ||
      !validWorking(value.working) || !Array.isArray(value.retiredConstraints)) throw new HandoffError("Compactor returned an invalid handoff schema")
  const retired = new Set<string>()
  for (const item of value.retiredConstraints) {
    if (!object(item) || !keys(item, ["constraint", "messageID", "quote"]) || !text(item.constraint) || !text(item.messageID) || !text(item.quote) ||
        !previous?.constraints.includes(item.constraint) || retired.has(item.constraint)) throw new HandoffError("Invalid constraint retirement")
    const user = users.find((row) => row.type === "user" && row.id === item.messageID)
    if (typeof user?.text !== "string" || !user.text.includes(item.quote)) throw new HandoffError("Constraint retirement needs a verbatim quote from a new user message")
    retired.add(item.constraint)
  }
  if (value.working.references.some((ref) => !ids.has(ref.id))) throw new HandoffError("Handoff references an unavailable archive")
  // An omission is NOT evidence that a standing instruction stopped applying.
  // Retirement must be explicit, auditable, and grounded in a new user message.
  const constraints = [...new Set([...(previous?.constraints ?? []).filter((item) => !retired.has(item)), ...value.working.constraints])]
  if (constraints.some((item) => retired.has(item))) throw new HandoffError("A retired constraint is still present in the handoff")
  return { archive: value.archive.trim(), working: { ...value.working, constraints }, retiredConstraints: value.retiredConstraints as Retirement[] }
}

export function assertMemoryBudget(working: WorkingMemory, through: string, gap: boolean, budget: number, title?: string, anchor?: Anchor): string {
  const rendered = renderWorking(working, through, gap, title, anchor)
  const size = tokens(rendered)
  if (size > budget) throw new HandoffError(`Working state exceeds its budget (${size} > ${budget} estimated tokens); active constraints were not truncated`)
  return rendered
}
