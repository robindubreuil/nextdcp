import { tokens } from "./tokens.ts"
import { object } from "./guards.ts"

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

/** A compactor may drift into another language on a valid schema, which silently locks
 *  the user out of their own archive. The note must not use a script the user never did. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** Parse a model response shell (fence-stripped): archive note, working object, retirements. */
function parseShell(raw: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")) } catch { throw new HandoffError("Compactor did not return valid JSON") }
  if (!object(value) || !keys(value, ["archive", "working", "retiredConstraints"]) || !text(value.archive) || value.archive.length > 4_000 ||
      !object(value.working) || !Array.isArray(value.retiredConstraints)) throw new HandoffError("Compactor returned an invalid handoff schema")
  return value
}

/** The new episode's note: a Title line first, in the language of the user's messages. */
function shellArchive(value: Record<string, unknown>, users: readonly UserRow[]): string {
  if (!text(value.archive)) throw new HandoffError("Compactor returned an invalid handoff schema")
  const archive = value.archive.trim()
  if (!/^Title:[\t ]*\S/.test(archive)) throw new HandoffError("Archive note must begin with a 'Title: <episode name>' line")
  if (CJK.test(archive) && !users.some((row) => row.type === "user" && typeof row.text === "string" && CJK.test(row.text)))
    throw new HandoffError("Archive note must stay in the language of the user's messages")
  return archive
}

/** An omission is NOT evidence that a standing instruction stopped applying.
 *  Retirement must be explicit, auditable, and grounded in a new user message. */
function shellRetirements(value: Record<string, unknown>, previous: WorkingMemory | undefined, users: readonly UserRow[]): Retirement[] {
  const retired = new Set<string>()
  const items = value.retiredConstraints as readonly unknown[]
  for (const item of items) {
    if (!object(item) || !keys(item, ["constraint", "messageID", "quote"]) || !text(item.constraint) || !text(item.messageID) || !text(item.quote) ||
        !previous?.constraints.includes(item.constraint) || retired.has(item.constraint)) throw new HandoffError("Invalid constraint retirement")
    const user = users.find((row) => row.type === "user" && row.id === item.messageID)
    if (typeof user?.text !== "string" || !user.text.includes(item.quote)) throw new HandoffError("Constraint retirement needs a verbatim quote from a new user message")
    retired.add(item.constraint)
  }
  return items as Retirement[]
}

const mergeConstraints = (previous: readonly string[], retired: ReadonlySet<string>, next: readonly string[]): string[] => {
  const constraints = [...new Set([...previous.filter((item) => !retired.has(item)), ...next])]
  if (constraints.some((item) => retired.has(item))) throw new HandoffError("A retired constraint is still present in the handoff")
  return constraints
}

/** Validate before committing. Never repair malformed JSON by silently discarding fields. */
export function parseHandoff(raw: string, previous: WorkingMemory | undefined, users: readonly UserRow[], ids: ReadonlySet<string>): Handoff {
  const value = parseShell(raw)
  if (!validWorking(value.working)) throw new HandoffError("Compactor returned an invalid handoff schema")
  const archive = shellArchive(value, users)
  const retiredConstraints = shellRetirements(value, previous, users)
  const retired = new Set(retiredConstraints.map((item) => item.constraint))
  const working = value.working
  if (working.references.some((ref) => !ids.has(ref.id))) throw new HandoffError("Handoff references an unavailable archive")
  return { archive, working: { ...working, constraints: mergeConstraints(previous?.constraints ?? [], retired, working.constraints) }, retiredConstraints }
}

const validField = {
  objective: (value: unknown): value is string => text(value),
  constraints: (value: unknown): value is string[] => list(value),
  state: (value: unknown): value is string[] => list(value),
  next: (value: unknown): value is string[] => list(value),
  references: (value: unknown): value is WorkingMemory["references"] =>
    Array.isArray(value) && value.length <= 3 && value.every((ref) => object(ref) && keys(ref, ["id", "why"]) && text(ref.id) && text(ref.why)),
} as const

/** Patch mode: omitted working fields carry forward unchanged; each present field
 *  replaces the previous one entirely. The merged whole must then pass the same
 *  checks as a full handoff — a patch never weakens validation, it only shrinks
 *  the request. Constraint retirement keeps its exact-quote proof unchanged. */
export function parsePatchHandoff(raw: string, previous: WorkingMemory, users: readonly UserRow[], ids: ReadonlySet<string>): Handoff {
  const value = parseShell(raw)
  if (!object(value.working)) throw new HandoffError("Compactor returned an invalid patch schema")
  const fields: Record<string, unknown> = value.working
  if (!keys(fields, ["objective", "constraints", "state", "next", "references"]) ||
      Object.keys(fields).some((key) => !validField[key as keyof typeof validField](fields[key as keyof typeof validField])))
    throw new HandoffError("Compactor returned an invalid patch schema")
  const archive = shellArchive(value, users)
  const retiredConstraints = shellRetirements(value, previous, users)
  const retired = new Set(retiredConstraints.map((item) => item.constraint))
  const working: WorkingMemory = {
    objective: typeof fields.objective === "string" ? fields.objective : previous.objective,
    constraints: mergeConstraints(previous.constraints, retired, Array.isArray(fields.constraints) ? fields.constraints as string[] : []),
    state: Array.isArray(fields.state) ? fields.state as string[] : previous.state,
    next: Array.isArray(fields.next) ? fields.next as string[] : previous.next,
    references: Array.isArray(fields.references) ? fields.references as WorkingMemory["references"] : previous.references,
  }
  if (working.references.some((ref) => !ids.has(ref.id))) throw new HandoffError("Handoff references an unavailable archive")
  return { archive, working, retiredConstraints }
}

/** Count the entire rendered working state — headings, preserved constraints,
 *  references and gap notices included — in budget units. */
export function measureWorking(working: WorkingMemory, through: string, gap = false, title?: string, anchor?: Anchor): { readonly rendered: string; readonly size: number } {
  const rendered = renderWorking(working, through, gap, title, anchor)
  return { rendered, size: tokens(rendered) }
}

/** The canonical over-budget failure, carried verbatim into the repair prompt. */
export const budgetFailure = (size: number, budget: number): string =>
  `Working state exceeds its budget (${size} > ${budget} estimated tokens); active constraints were not truncated`
