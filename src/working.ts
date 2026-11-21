import { tokens } from "./tokens.ts"
import { object } from "./guards.ts"
import { userSources, type SourceRow, type UserSource } from "./user-sources.ts"

export const DEFAULT_MEMORY_BUDGET = 2_000
export class HandoffError extends Error {}
export type WorkingMemory = {
  readonly objective: string
  readonly constraints: readonly string[]
  readonly state: readonly string[]
  readonly next: readonly string[]
  readonly references: readonly { readonly id: string; readonly why: string }[]
}
export type PriorConstraints = Pick<WorkingMemory, "constraints">
type Retirement = { readonly constraint: string; readonly messageID: string; readonly quote: string }
export type Handoff = { readonly archive: string; readonly working: WorkingMemory; readonly retiredConstraints: readonly Retirement[] }
/** Compact always-on archive pointer: how many episodes, since when, and how to open them. */
export type Anchor = { readonly count: number; readonly first?: string; readonly last?: string; readonly span?: string }
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim()
const list = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).every((key) => expected.includes(key))

const FIELDS = ["objective", "constraints", "state", "next", "references"] as const

export function validWorking(value: unknown): value is WorkingMemory {
  return object(value) && keys(value, FIELDS) && text(value.objective) &&
    list(value.constraints) && list(value.state) && list(value.next) && Array.isArray(value.references) && value.references.length <= 3 &&
    value.references.every((ref) => object(ref) && keys(ref, ["id", "why"]) && text(ref.id) && text(ref.why))
}

/** The schema failure, named: a complete state carries every field, and the
 *  omission itself is the repair a model needs instead of a generic rejection. */
const workingProblem = (value: unknown): string => {
  const missing = FIELDS.filter((key) => !(key in (object(value) ? value : {})))
  return `Handoff has an invalid handoff schema: ${missing.length ? `working is missing ${missing.join(", ")}, a complete state needs all five fields (use [] for empty lists)` : "objective is text, constraints/state/next are string lists, references are {id, why} pairs"}`
}

/** Only the author's explicit Title line names an episode; the note body stays archived. */
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
    section("User constraints", working.constraints) + section("State", working.state) +
    section("Next", working.next) + section("References", working.references.map((ref) => `${ref.id}: ${ref.why}`)) +
    `\n\nArchive through ${through}${title ? ` (${title})` : ""}: older tasks and exact evidence are archived${tail}. Browse: recall catalog; search: recall(query).` +
    (gap ? " Some original history was not archived; recall reports these gaps." : "")
}

/** Detect prose drift, not an identifier or punctuation in an otherwise English
 *  note. Code spans and paths are evidence; only predominantly CJK prose counts. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const cjkProse = (value: string): boolean => {
  const prose = value.replace(/^Title:[\t ]*/, "").replace(/`[^`]*`/g, "").replace(/\S*(?:[/\\]|\.[\p{L}\p{N}_])\S*/gu, "")
  const letters = prose.match(/\p{L}/gu) ?? []
  const cjk = letters.filter((letter) => CJK.test(letter)).length
  return cjk > 0 && cjk * 2 >= letters.length
}

/** Extract the first parseable JSON object containing "archive": stateless generation
 *  has no provider JSON mode, so a compactor may frame its payload in prose or fences
 *  even when told to return only JSON. This is the standard structured-output
 *  extraction, not silent repair — the extracted object must still pass every check. */
function extractObject(raw: string): unknown {
  for (let start = raw.indexOf("{"); start >= 0;) {
    let depth = 0, inString = false, escaped = false, end = -1
    for (let at = start; at < raw.length; at++) {
      const char = raw[at]
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === "{") depth++
      else if (char === "}" && --depth === 0) { end = at; break }
    }
    if (end < 0) return undefined
    try {
      const value: unknown = JSON.parse(raw.slice(start, end + 1))
      if (object(value) && "archive" in value) return value
    } catch { /* try the next balanced object */ }
    start = raw.indexOf("{", end + 1)
  }
  return undefined
}

/** Parse a model response shell (fence-stripped): archive note, working object, retirements. */
function parseShell(raw: string): Record<string, unknown> {
  const stripped = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")
  let value: unknown
  try { value = JSON.parse(stripped) } catch { value = extractObject(stripped) }
  if (value === undefined) throw new HandoffError("Handoff did not contain valid JSON")
  if (!object(value) || !keys(value, ["archive", "working", "retiredConstraints"]) || !text(value.archive) ||
      !object(value.working) || !Array.isArray(value.retiredConstraints)) throw new HandoffError("Handoff has an invalid handoff schema")
  return value
}

/** The new episode's note: a Title line first, in the language of the user's messages. */
function shellArchive(value: Record<string, unknown>, users: readonly UserSource[], previous: PriorConstraints | undefined, priorSummary?: string): string {
  if (!text(value.archive)) throw new HandoffError("Handoff has an invalid handoff schema")
  const archive = value.archive.trim()
  if (!/^Title:[\t ]*\S/.test(archive)) throw new HandoffError("Archive note must begin with a 'Title: <episode name>' line")
  // A cut may contain only assistant/tool work. The validated prior state still
  // carries the task's language; the candidate being validated cannot authorize itself.
  const inherited = validWorking(previous) ? [previous.objective, ...previous.constraints, ...previous.state, ...previous.next, ...previous.references.map((ref) => ref.why)] : previous?.constraints ?? []
  if (cjkProse(archive) && !inherited.some(cjkProse) && !cjkProse(priorSummary ?? "") && !users.some((row) => cjkProse(row.text)))
    throw new HandoffError("Archive note must stay in the language of the user's messages")
  return archive
}

/** An omission is NOT evidence that a standing instruction stopped applying.
 *  Retirement must be explicit, auditable, and grounded in a new user message. */
function shellRetirements(value: Record<string, unknown>, previous: PriorConstraints | undefined, users: readonly UserSource[]): Retirement[] {
  const retired = new Set<string>()
  return (value.retiredConstraints as readonly unknown[]).map((item) => {
    if (!object(item) || !keys(item, ["constraint", "messageID", "quote"]) || !text(item.constraint) || !text(item.quote) ||
        item.messageID !== undefined && !text(item.messageID) ||
        !previous?.constraints.includes(item.constraint) || retired.has(item.constraint)) throw new HandoffError("Invalid constraint retirement")
    const { constraint, quote, messageID } = item
    const user = users.findLast((row) => (messageID === undefined || row.id === messageID) && row.text.includes(quote))
    if (!user) throw new HandoffError("Constraint retirement needs a verbatim quote from a new user message")
    retired.add(constraint)
    return { constraint, messageID: user.id, quote }
  })
}

/** A new protected rule is its own source quote: no second author-written proof
 *  envelope, host-instruction copies, or unchecked paraphrases that stick forever.
 *  Previously committed (including legacy/native) rules keep omission protection. */
const mergeConstraints = (previous: readonly string[], retired: ReadonlySet<string>, next: readonly string[], users: readonly UserSource[]): string[] => {
  const constraints = [...new Set([...previous.filter((item) => !retired.has(item)), ...next])]
  if (constraints.some((item) => retired.has(item))) throw new HandoffError("A retired constraint is still present in the handoff")
  const inherited = new Set(previous)
  if (next.some((item) => !inherited.has(item) && !users.some((row) => row.text.includes(item))))
    throw new HandoffError("New standing constraints must be verbatim quotes from new user messages; keep task requirements in state/next and omit host instructions")
  return constraints
}

/** Validate before committing. Never repair malformed JSON by silently discarding fields. */
export function parseHandoff(raw: string, previous: PriorConstraints | undefined, rows: readonly SourceRow[], ids: ReadonlySet<string>, priorSummary?: string): Handoff {
  const value = parseShell(raw)
  if (!validWorking(value.working)) throw new HandoffError(workingProblem(value.working))
  const users = userSources(rows)
  // An inherited native summary supplies language only, never retirement proof.
  const archive = shellArchive(value, users, previous, priorSummary)
  const retiredConstraints = shellRetirements(value, previous, users)
  const retired = new Set(retiredConstraints.map((item) => item.constraint))
  const working = value.working
  if (working.references.some((ref) => !ids.has(ref.id))) throw new HandoffError("Handoff references an unavailable archive")
  return { archive, working: { ...working, constraints: mergeConstraints(previous?.constraints ?? [], retired, working.constraints, users) }, retiredConstraints }
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
export function parsePatchHandoff(raw: string, previous: WorkingMemory, rows: readonly SourceRow[], ids: ReadonlySet<string>): Handoff {
  const value = parseShell(raw)
  if (!object(value.working)) throw new HandoffError("Handoff has an invalid patch schema")
  const fields: Record<string, unknown> = value.working
  if (!keys(fields, ["objective", "constraints", "state", "next", "references"]) ||
      Object.keys(fields).some((key) => !validField[key as keyof typeof validField](fields[key as keyof typeof validField])))
    throw new HandoffError("Handoff has an invalid patch schema")
  const users = userSources(rows)
  const archive = shellArchive(value, users, previous)
  const retiredConstraints = shellRetirements(value, previous, users)
  const retired = new Set(retiredConstraints.map((item) => item.constraint))
  const working: WorkingMemory = {
    objective: typeof fields.objective === "string" ? fields.objective : previous.objective,
    constraints: mergeConstraints(previous.constraints, retired, Array.isArray(fields.constraints) ? fields.constraints as string[] : [], users),
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
