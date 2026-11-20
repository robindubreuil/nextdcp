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
