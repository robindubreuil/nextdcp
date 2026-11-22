import { object } from "./guards.ts"

export type SourceRow = { readonly id: string; readonly type: string; readonly text?: unknown; readonly content?: readonly unknown[] }
export type UserSource = { readonly id: string; readonly text: string }

/** The built-in question tool records forms.ask's human replies here. Its input,
 *  rendered result prose, and other tools' metadata are NOT user evidence. */
export function questionSource(part: unknown): { readonly id: string; readonly answers: readonly (readonly string[])[] } | undefined {
  if (!object(part) || part.type !== "tool" || part.name !== "question" || typeof part.id !== "string" || !part.id.trim() ||
      !object(part.state) || part.state.status !== "completed" || !object(part.state.metadata)) return undefined
  const answers: unknown = part.state.metadata.answers
  if (!Array.isArray(answers) || !answers.every((answer) => Array.isArray(answer) && answer.every((item) => typeof item === "string"))) return undefined
  return { id: part.id, answers }
}

/** Callers supply only the NEW cut span. A question's call ID is a durable recall
 *  address for its replies; do not join separate answers into an invented quote. */
export function userSources(rows: readonly SourceRow[]): UserSource[] {
  return rows.flatMap((row): UserSource[] => {
    if (row.type === "user") return typeof row.text === "string" ? [{ id: row.id, text: row.text }] : []
    if (row.type !== "assistant") return []
    return (Array.isArray(row.content) ? row.content : []).flatMap((part): UserSource[] => {
      const source = questionSource(part)
      return source ? source.answers.flatMap((answer) => answer.filter((text) => text.trim()).map((text) => ({ id: source.id, text }))) : []
    })
  })
}

const TYPO: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
  "\u2013": "-", "\u2014": "-", "\u2026": "...",
}

/** Fold typography and collapse each whitespace run to one space (dropped at the
 *  edges), recording the [start, end) source span behind every folded character. */
function fold(text: string): { readonly chars: string; readonly spans: readonly (readonly [number, number])[] } {
  let chars = ""
  const spans: (readonly [number, number])[] = []
  for (let at = 0; at < text.length;) {
    const run = /\s/.test(text[at])
    let end = at + 1
    while (run && end < text.length && /\s/.test(text[end])) end++
    const folded = run ? chars === "" ? "" : " " : TYPO[text[at]] ?? text[at]
    for (const char of folded) { chars += char; spans.push([at, end]) }
    at = end
  }
  return { chars, spans }
}

/** A quote is a locator, never trusted text: resolve it to the exact span of a
 *  user source — an exact substring first, then a whitespace/typography-folded
 *  match — and return the source's own span as the pinned quote. The latest
 *  matching source wins; messageID restricts resolution to one durable row or
 *  question call. */
export function matchSource(sources: readonly UserSource[], quote: string, messageID?: string): UserSource | undefined {
  const locator = quote.trim()
  if (!locator) return undefined
  const inScope = (source: UserSource) => messageID === undefined || source.id === messageID
  for (let at = sources.length - 1; at >= 0; at--) {
    const source = sources[at]
    if (!inScope(source)) continue
    const exact = source.text.indexOf(quote)
    if (exact >= 0) return { id: source.id, text: source.text.slice(exact, exact + quote.length) }
  }
  const pattern = fold(locator)
  for (let at = sources.length - 1; at >= 0; at--) {
    const source = sources[at]
    if (!inScope(source)) continue
    const body = fold(source.text)
    const hit = body.chars.indexOf(pattern.chars)
    if (hit >= 0) return { id: source.id, text: source.text.slice(body.spans[hit][0], body.spans[hit + pattern.chars.length - 1][1]) }
  }
  return undefined
}
