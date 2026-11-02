import type { ArchivedCall } from "./mask.ts"
import type { Result } from "@opencode/plugin/promise/tool"

export type SearchDocument = { readonly id: string; readonly text: string; readonly summary?: string }
export type SearchHit = { readonly id: string; readonly page: number; readonly score: number; readonly snippet: string; readonly note?: boolean }
export const RECALL_PAGE_CHARS = 6_000
export const SEARCH_PAGE_HITS = 4
export const MAX_SEARCH_HITS = 40
export type RecallFile = { readonly offset: number; readonly file: { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string } }
export type RecallContent = NonNullable<Result["content"]>
type Fragment = { readonly text: string; readonly files?: readonly RecallFile[] }
type Word = { readonly text: string; readonly index: number }

const words = (text: string): Word[] => Array.from(text.matchAll(/[\p{L}\p{M}\p{N}_]+/gu), (match) => ({
  text: match[0].normalize("NFKC").toLowerCase(),
  index: match.index,
}))
const high = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff
const splitsPair = (text: string, index: number) => index > 0 && index < text.length && high(text.charCodeAt(index - 1)) && low(text.charCodeAt(index))

function snippet(text: string, index: number): string {
  let start = Math.max(0, index - 160)
  if (splitsPair(text, start)) start--
  let end = Math.min(text.length, start + 900)
  if (splitsPair(text, end)) end++
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < text.length ? "…" : ""}`
}

/** Rank small passages, not whole histories. Prefer a cluster covering the query over its first word. */
export function search(query: string, documents: readonly SearchDocument[], limit = 10): SearchHit[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Search limit must be a positive integer")
  const terms = [...new Set(words(query).map((word) => word.text))]
  if (!terms.length || !documents.length) return []
  const termSet = new Set(terms)
  const corpus = documents.flatMap((document) => {
    const bounds = pageBounds(document.text, RECALL_PAGE_CHARS)
    const pages = bounds.slice(1).map((_, index) => ({ id: document.id, page: index + 1, text: document.text,
      parsed: [] as Word[], counts: new Map<string, number>(), note: false }))
    let page = 0
    for (const word of words(document.text)) {
      while (page + 1 < pages.length && word.index >= bounds[page + 1]) page++
      pages[page].parsed.push(word)
    }
    if (document.summary) pages.push({ id: document.id, page: 1, text: document.summary, parsed: words(document.summary), counts: new Map(), note: true })
    for (const item of pages) for (const word of item.parsed) if (termSet.has(word.text)) item.counts.set(word.text, (item.counts.get(word.text) ?? 0) + 1)
    return pages
  })
  const average = corpus.reduce((sum, item) => sum + item.parsed.length, 0) / corpus.length || 1
  const weights = new Map(terms.map((term) => {
    const count = corpus.filter((item) => item.counts.has(term)).length
    return [term, Math.log(1 + (corpus.length - count + 0.5) / (count + 0.5))]
  }))
  const k = 1.2, b = 0.75
  const hits = corpus.flatMap(({ id, page, text, parsed, counts, note }): SearchHit[] => {
    let score = 0
    for (const term of terms) {
      const count = counts.get(term) ?? 0
      if (!count) continue
      const idf = weights.get(term)!
      score += idf * (count * (k + 1)) / (count + k * (1 - b + b * parsed.length / average))
    }
    if (score === 0) return []
    const matches = parsed.filter((word) => termSet.has(word.text))
    const window = new Map<string, number>()
    let left = 0, coverage = 0, best = -1, index = matches[0].index, span = Infinity
    for (let right = 0; right < matches.length; right++) {
      const word = matches[right]
      const count = window.get(word.text) ?? 0
      window.set(word.text, count + 1)
      if (!count) coverage += weights.get(word.text)!
      while (word.index - matches[left].index > 560) {
        const old = matches[left++].text, remaining = window.get(old)! - 1
        window.set(old, remaining)
        if (!remaining) coverage -= weights.get(old)!
      }
      const width = word.index - matches[left].index
      if (coverage > best + 1e-10 || (Math.abs(coverage - best) < 1e-10 && width < span)) {
        best = coverage; index = matches[left].index; span = width
      }
    }
    return [{ id, page, score, snippet: snippet(text, index), ...(note ? { note: true } : {}) }]
  })
  const seen = new Set<string>()
  return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.page - b.page)).filter((hit) => {
    if (seen.has(hit.snippet)) return false
    seen.add(hit.snippet)
    return true
  }).slice(0, limit)
}

function pageBounds(text: string, pageChars: number): number[] {
  const bounds = [0]
  while (bounds[bounds.length - 1] < text.length) {
    let end = Math.min(text.length, bounds[bounds.length - 1] + pageChars)
    if (splitsPair(text, end)) end--
    bounds.push(end)
  }
  if (bounds.length === 1) bounds.push(0)
  return bounds
}

/** Paginate without splitting UTF-16 surrogate pairs; joining all pages reconstructs the original. */
export function paginate(text: string, page = 1, pageChars = RECALL_PAGE_CHARS): { content: string; page: number; pages: number; nextPage?: number } {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageChars) || pageChars < 2) throw new RangeError("Invalid page or page size")
  const bounds = pageBounds(text, pageChars)
  const pages = bounds.length - 1
  if (page > pages) throw new RangeError(`Page must be between 1 and ${pages}`)
  return { content: text.slice(bounds[page - 1], bounds[page]), page, pages, ...(page < pages ? { nextPage: page + 1 } : {}) }
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "null"
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown) => typeof value === "string" ? value : ""

/** Carry exact attachment offsets through nested formatting; labels may also occur in ordinary text. */
function render(parts: readonly Fragment[], separator: string, files: RecallFile[]): string {
  let offset = 0
  const chunks: string[] = []
  for (const part of parts) {
    if (!part.text) continue
    if (chunks.length) offset += separator.length
    for (const file of part.files ?? []) files.push({ ...file, offset: offset + file.offset })
    chunks.push(part.text)
    offset += part.text.length
  }
  return chunks.join(separator)
}

export function formatCall(call: ArchivedCall, files: RecallFile[] = []): string {
  const outputFiles: RecallFile[] = []
  let output: string
  if (call.result.type === "text" && typeof call.result.value === "string") output = call.result.value
  else if (call.result.type === "content") output = toolContent(call.result.value, outputFiles)
  else if (call.result.type === "error" && object(call.result.value) && Array.isArray(call.result.value.content)) {
    const contentFiles: RecallFile[] = []
    output = render([{ text: pretty(call.result.value.error) }, { text: toolContent(call.result.value.content, contentFiles), files: contentFiles }], "\n", outputFiles)
  } else output = pretty(call.result.value)
  return render([{ text: `Tool call ${call.id}\nTool: ${call.name}\nInput:\n${pretty(call.input)}\nOutput:\n` }, { text: output, files: outputFiles }], "", files)
}

function attachment(value: unknown, files: RecallFile[]): string {
  if (!object(value)) return ""
  const source = text(value.uri) || (object(value.source) ? text(value.source.uri) : "")
  const mime = text(value.mime)
  const uri = typeof value.data === "string" && mime ? `data:${mime};base64,${value.data}` : source
  const name = text(value.name) || (source.startsWith("data:") ? "inline attachment" : source) || "inline attachment"
  const label = `[Attached ${mime || "file"}: ${name}]`
  if (typeof value.data === "string" && ["text/plain", "application/x-directory"].includes(mime)) {
    try {
      return `${label}\n${text(value.description)}\n${new TextDecoder().decode(Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0)))}`
    } catch { /* Preserve malformed text as a native attachment rather than lose bytes. */ }
  }
  if (uri && mime) files.push({ offset: 0, file: { type: "file", uri, mime, ...(text(value.name) ? { name: text(value.name) } : {}) } })
  return label
}

function toolContent(value: unknown, files: RecallFile[]): string {
  if (!Array.isArray(value)) return ""
  return render(value.map((item): Fragment => {
    const local: RecallFile[] = []
    return { text: !object(item) ? "" : item.type === "text" ? text(item.text) : attachment(item, local), files: local }
  }), "\n", files)
}

/** Render the useful contents of a stored row, without transport or provider metadata. */
function transcriptRow(row: unknown, files: RecallFile[]): string {
  if (!object(row) || typeof row.type !== "string") throw new Error("Invalid archived row")
  if (row.type === "user") {
    const skills = Array.isArray(row.skills) ? row.skills.flatMap((skill) => object(skill) && text(skill.text)
      ? [`[Skill activated: ${text(skill.name)}]\n${text(skill.text)}`] : []) : []
    const attachments = Array.isArray(row.files) ? row.files.map((file): Fragment => {
      const local: RecallFile[] = []
      return { text: attachment(file, local), files: local }
    }) : []
    return render([...skills, `[User]: ${text(row.text)}`].map((text) => ({ text })).concat(attachments), "\n", files)
  }
  if (row.type === "assistant") {
    if (!Array.isArray(row.content)) return ""
    return render(row.content.flatMap((part): Fragment[] => {
      if (!object(part)) return []
      if (part.type === "text") return [{ text: `[Assistant]: ${text(part.text)}` }]
      if (part.type !== "tool" || !object(part.state)) return []
      const state = part.state
      const input = JSON.stringify(state.input) ?? "null"
      const label = `[Tool ${text(part.name)} ${input}]:`
      const local: RecallFile[] = [], outputFiles: RecallFile[] = []
      const error = state.status === "error" ? object(state.error) ? text(state.error.message) : text(state.error) : ""
      const output = ["completed", "error"].includes(text(state.status)) ? toolContent(state.content, outputFiles) : ""
      return [{ text: render([{ text: label }, { text: error }, { text: output, files: outputFiles }], "\n", local), files: local }]
    }), "\n", files)
  }
  if (row.type === "shell") {
    const output = object(row.output) ? text(row.output.output) : ""
    return `[Shell]: ${text(row.command)}\n${output}`
  }
  if (row.type === "synthetic") return `[Synthetic]: ${text(row.text)}`
  if (row.type === "skill") return `[Skill activated: ${text(row.name)}]\n${text(row.text)}`
  if (row.type === "system") return `[System]: ${text(row.text)}`
  if (row.type === "location-switched" && object(row.location)) return `[User]: The working directory has been changed to ${text(row.location.directory)}.`
  if (row.type === "compaction") return `[Checkpoint]: ${text(row.summary)}`
  return ""
}

export function formatTranscript(id: string, rows: readonly { readonly id: string; readonly text?: string }[], gap = false, files: RecallFile[] = []): string {
  const parts: Fragment[] = [{ text: `Episode ${id}: raw transcript` }]
  if (gap) parts.push({ text: "Recall gap: some raw history was not archived." })
  for (const row of rows) {
    if (row.text === undefined) { parts.push({ text: "[Unavailable archived row; recall gap]" }); continue }
    try {
      const local: RecallFile[] = []
      parts.push({ text: transcriptRow(JSON.parse(row.text), local), files: local })
    } catch { parts.push({ text: "[Invalid archived row; recall gap]" }) }
  }
  return render(parts, "\n\n", files)
}

/** Return attachments only on the page where their label starts, never as base64 text. */
export function recallPage(id: string, text: string, page = 1, files: readonly RecallFile[] = []): RecallContent {
  const result = paginate(text, page)
  const bounds = pageBounds(text, RECALL_PAGE_CHARS)
  const attached = files.filter(({ offset }) => offset >= bounds[page - 1] && offset < bounds[page]).map(({ file }) => file)
  const content = `recall ${JSON.stringify({ id, page })} (page ${page} of ${result.pages}${result.nextPage ? `; next page: ${result.nextPage}` : ""})\n${result.content}`
  return attached.length ? [{ type: "text", text: content }, ...attached] : content
}
