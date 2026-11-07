import type { ArchivedCall } from "./tokens.ts"
import type { Result } from "@opencode/plugin/promise/tool"
import { formatSpan } from "./time.ts"
import { object } from "./guards.ts"

/** The depth within a chapter (episode) to read or search. `conversation` is the default everywhere. */
export type Layer = "conversation" | "tools" | "full"
export const LAYERS: readonly Layer[] = ["conversation", "tools", "full"]
export type SearchDocument = {
  readonly id: string
  readonly text: string
  /** The fact's home; selects which layer a search covers. Notes carry no home. */
  readonly layer?: "conversation" | "tools"
  /** An archive-note doc (a label, not content): a pointer hit surfaced only in unfiltered search. */
  readonly note?: boolean
  readonly echoes?: readonly (readonly [number, number])[]
}
type Location = { readonly id: string; readonly page: number }
export type SearchHit = { readonly id: string; readonly page: number; readonly score: number; readonly snippet: string; readonly note?: boolean; readonly also?: readonly Location[] }
export const RECALL_PAGE_CHARS = 6_000
/** Whole-original recall returns up to five pages in one call; only larger originals page. */
export const RECALL_ALL_CHARS = 5 * RECALL_PAGE_CHARS
export const SEARCH_PAGE_HITS = 4
export const MAX_SEARCH_HITS = 40
export const SHORT_ID_CHARS = 12
export type RecallFile = { readonly offset: number; readonly file: { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string } }
export type RecallContent = NonNullable<Result["content"]>
type Fragment = { readonly text: string; readonly files?: readonly RecallFile[]; readonly echoes?: readonly (readonly [number, number])[] }
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
  // Cut on word boundaries: a snippet never opens or closes on a word fragment.
  // Whitespace is never half a surrogate pair, so these adjustments cannot split one.
  if (start > 0 && !/\s/u.test(text[start - 1]) && !/\s/u.test(text[start])) {
    const gap = text.slice(start, end).search(/\s/u)
    if (gap !== -1 && start + gap + 1 < end) start += gap + 1
  }
  if (end < text.length && !/\s/u.test(text[end]) && !/\s/u.test(text[end - 1])) {
    const gap = text.slice(start, end).search(/\s\S*$/u)
    if (gap > 0) end = start + gap
  }
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/gu, " ").trim()}${end < text.length ? "…" : ""}`
}

/** Rank small passages, not whole histories. Prefer a cluster covering the query over its first word.
 *  `layer` selects which fact homes a search covers; `full` (default) covers every home plus notes. */
export function search(query: string, documents: readonly SearchDocument[], limit = 10, layer: Layer = "full"): SearchHit[] {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Search limit must be a positive integer")
  const terms = [...new Set(words(query).map((word) => word.text))]
  const homes = documents.filter((document) => layer === "full" ? true : document.layer === layer && !document.note)
  if (!terms.length || !homes.length) return []
  const termSet = new Set(terms)
  const corpus = homes.flatMap((document) => {
    const bounds = pageBounds(document.text, RECALL_PAGE_CHARS)
    const pages = bounds.slice(1).map((_, index) => ({ id: document.id, page: index + 1, text: document.text,
      parsed: [] as Word[], counts: new Map<string, number>(), note: !!document.note }))
    let page = 0
    const echoes = document.echoes ?? []
    let echo = 0
    for (const word of words(document.text)) {
      while (page + 1 < pages.length && word.index >= bounds[page + 1]) page++
      while (echo < echoes.length && echoes[echo][1] <= word.index) echo++
      // Echoes of recall output are excluded from scoring only: pages and snippets stay
      // byte-aligned with the fetchable text, so hit pages always fetch what they name.
      if (echo < echoes.length && word.index >= echoes[echo][0]) continue
      pages[page].parsed.push(word)
    }
    for (const item of pages) for (const word of item.parsed) if (termSet.has(word.text)) item.counts.set(word.text, (item.counts.get(word.text) ?? 0) + 1)
    return pages
  })
  const average = corpus.reduce((sum, item) => sum + item.parsed.length, 0) / corpus.length || 1
  const weights = new Map(terms.map((term) => {
    const count = corpus.filter((item) => item.counts.has(term)).length
    return [term, Math.log(1 + (corpus.length - count + 0.5) / (count + 0.5))]
  }))
  const k = 1.2, b = 0.75
  type Draft = { readonly hit: SearchHit; readonly core: string; readonly size: number }
  const drafts = corpus.flatMap(({ id, page, text, parsed, counts, note }): Draft[] => {
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
    let left = 0, coverage = 0, best = -1, index = matches[0].index, end = index, span = Infinity
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
      // Shrink to the tightest window for this coverage: the core must be canonical, so
      // copies of one region match even when their surroundings carry stray term echoes.
      while (left < right && window.get(matches[left].text)! > 1) {
        const old = matches[left++].text
        window.set(old, window.get(old)! - 1)
      }
      const width = word.index - matches[left].index
      if (coverage > best + 1e-10 || (Math.abs(coverage - best) < 1e-10 && width < span)) {
        best = coverage; index = matches[left].index; end = word.index + word.text.length; span = width
      }
    }
    // The matched core is what identifies the evidence; its surroundings differ per transcript.
    const core = words(text.slice(index, end)).map((word) => word.text)
    return [{ hit: { id, page, score, snippet: snippet(text, index), ...(note ? { note: true } : {}) }, core: core.join(" "), size: core.length }]
  })
  drafts.sort((a, b) => b.hit.score - a.hit.score || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : a.hit.page - b.hit.page))
  // Repeated reads of one region come back as near-identical excerpts across episodes. Collapse
  // them into one hit and list the duplicates as fetchable locations, so the hit budget buys
  // distinct evidence. A short core is not distinctive enough to merge distinct snippets.
  const kept: (Draft & { also: Location[] })[] = []
  for (const draft of drafts) {
    const twin = kept.find((other) => draft.hit.note === other.hit.note &&
      (draft.hit.snippet === other.hit.snippet || (draft.size >= 8 && draft.core === other.core)))
    if (twin) twin.also.push({ id: draft.hit.id, page: draft.hit.page })
    else kept.push({ ...draft, also: [] })
  }
  return kept.map(({ hit, also }) => (also.length ? { ...hit, also } : hit)).slice(0, limit)
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
const text = (value: unknown) => typeof value === "string" ? value : ""

/** Carry exact attachment and echo offsets through nested formatting; labels may also occur in ordinary text. */
function render(parts: readonly Fragment[], separator: string, files: RecallFile[], echoes: [number, number][] = []): string {
  let offset = 0
  const chunks: string[] = []
  for (const part of parts) {
    if (!part.text) continue
    if (chunks.length) offset += separator.length
    for (const file of part.files ?? []) files.push({ ...file, offset: offset + file.offset })
    for (const range of part.echoes ?? []) echoes.push([offset + range[0], offset + range[1]])
    chunks.push(part.text)
    offset += part.text.length
  }
  return chunks.join(separator)
}

function callOutput(call: ArchivedCall, files: RecallFile[]): string {
  if (call.result.type === "text" && typeof call.result.value === "string") return call.result.value
  if (call.result.type === "content") return toolContent(call.result.value, files)
  if (call.result.type === "error" && object(call.result.value) && Array.isArray(call.result.value.content)) {
    const contentFiles: RecallFile[] = []
    return render([{ text: pretty(call.result.value.error) }, { text: toolContent(call.result.value.content, contentFiles), files: contentFiles }], "\n", files)
  }
  return pretty(call.result.value)
}

export function formatCall(call: ArchivedCall, files: RecallFile[] = [], echoes: [number, number][] = []): string {
  const outputFiles: RecallFile[] = []
  const output = callOutput(call, outputFiles)
  // A recall output re-presents evidence archived elsewhere: marked as echo so search never
  // ranks it against the original it quotes, while pages stay byte-aligned with the fetch.
  const mark = call.name === "recall" && output ? { echoes: [[0, output.length]] as [number, number][] } : {}
  return render([{ text: `Tool call ${call.id}\nTool: ${call.name}\nInput:\n${pretty(call.input)}\nOutput:\n` }, { text: output, files: outputFiles, ...mark }], "", files, echoes)
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

type Resolve = (id: string) => ArchivedCall | undefined

/** Render one tool call inline as a fragment. The output is sourced from the stored `calls/`
 *  original when a resolver is supplied (the authoritative first original), else from row state. */
function toolPart(part: Record<string, unknown>, layer: Layer, resolve: Resolve | undefined): Fragment {
  const state = object(part.state) ? part.state : {}
  const id = text(part.id), name = text(part.name)
  const input = JSON.stringify(state.input) ?? "null"
  // In the conversation layer a call is only a runnable tag: its output is one hop away, never inline.
  if (layer === "conversation") return { text: `[Tool ${name} ${input} → recall ${shortId(id)}]` }
  const outputFiles: RecallFile[] = []
  const original = resolve?.(id)
  let body: string
  if (original) body = callOutput(original, outputFiles)
  else {
    const error = state.status === "error" ? object(state.error) ? text(state.error.message) : text(state.error) : ""
    const output = ["completed", "error"].includes(text(state.status)) ? toolContent(state.content, outputFiles) : ""
    body = render([{ text: error }, { text: output }], "\n", outputFiles)
  }
  const files: RecallFile[] = []
  const tool = render([{ text: `[Tool ${name} ${input}]:` }, { text: body, files: outputFiles }], "\n", files)
  // A recall rendering is a re-presentation of evidence archived elsewhere: marked as echo so
  // search never ranks it against the original it quotes.
  return { text: tool, files, ...(name === "recall" ? { echoes: [[0, tool.length]] as [number, number][] } : {}) }
}

/** Render the useful contents of a stored row at a given layer, without transport or provider metadata. */
function transcriptRow(row: unknown, layer: Layer, resolve: Resolve | undefined, files: RecallFile[], echoes: [number, number][] = []): string {
  if (!object(row) || typeof row.type !== "string") throw new Error("Invalid archived row")
  const dialogue = layer !== "tools"
  if (row.type === "user") {
    if (!dialogue) return ""
    const skills = Array.isArray(row.skills) ? row.skills.flatMap((skill) => object(skill) && text(skill.text)
      ? [`[Skill activated: ${text(skill.name)}]\n${text(skill.text)}`] : []) : []
    const attachments = Array.isArray(row.files) ? row.files.map((file): Fragment => {
      const local: RecallFile[] = []
      return { text: attachment(file, local), files: local }
    }) : []
    return render([...skills, `[User]: ${text(row.text)}`].map((value) => ({ text: value })).concat(attachments), "\n", files)
  }
  if (row.type === "assistant") {
    if (!Array.isArray(row.content)) return ""
    return render(row.content.flatMap((part): Fragment[] => {
      if (!object(part)) return []
      if (part.type === "text") return dialogue ? [{ text: `[Assistant]: ${text(part.text)}` }] : []
      if (part.type !== "tool" || !object(part.state)) return []
      return [toolPart(part, layer, resolve)]
    }), "\n", files, echoes)
  }
  if (row.type === "shell") {
    const output = object(row.output) ? text(row.output.output) : ""
    if (layer === "conversation") return `[Shell ${text(row.command)} → recall ${shortId(text(row.id))}]`
    return `[Shell]: ${text(row.command)}\n${output}`
  }
  if (row.type === "synthetic") return dialogue ? `[Synthetic]: ${text(row.text)}` : ""
  if (row.type === "skill") return dialogue ? `[Skill activated: ${text(row.name)}]\n${text(row.text)}` : ""
  if (row.type === "system") return dialogue ? `[System]: ${text(row.text)}` : ""
  if (row.type === "location-switched" && object(row.location)) return dialogue ? `[User]: The working directory has been changed to ${text(row.location.directory)}.` : ""
  if (row.type === "compaction") return dialogue ? `[Checkpoint]: ${text(row.summary)}` : ""
  return ""
}

export type TranscriptOptions = {
  readonly layer?: Layer
  readonly gap?: boolean
  readonly title?: string
  readonly files?: RecallFile[]
  readonly echoes?: [number, number][]
  readonly call?: Resolve
}

/** Render a stored episode. `options` selects the layer, gap disclosure, title, and
 *  the collectors for attachments, echoes, and call originals. */
export function formatTranscript(id: string, rows: readonly { readonly id: string; readonly text?: string }[], options: TranscriptOptions = {}): string {
  const { layer = "full", gap = false, title, files = [], echoes = [], call } = options
  const head = `Episode ${id}${title ? ` — ${title}` : ""}`
  const parts: Fragment[] = [{ text: layer === "tools" ? `${head} — tool output` : layer === "conversation" ? `${head} — conversation` : `${head}: raw transcript` }]
  if (gap) parts.push({ text: "Recall gap: some raw history was not archived." })
  for (const row of rows) {
    if (row.text === undefined) { parts.push({ text: "[Unavailable archived row; recall gap]" }); continue }
    try {
      const local: RecallFile[] = [], rowEchoes: [number, number][] = []
      parts.push({ text: transcriptRow(JSON.parse(row.text), layer, call, local, rowEchoes), files: local, echoes: rowEchoes })
    } catch { parts.push({ text: "[Invalid archived row; recall gap]" }) }
  }
  return render(parts, "\n\n", files, echoes)
}

/** Render one stored row (its raw JSON) as a standalone tools-layer document:
    the exact text an opaque `recall msg_…` fetch returns, so search pages align.
    A row that cannot be parsed or rendered degrades to the transcript's gap
    marker, the same way episodes disclose unreadable rows. */
export function formatRow(raw: string, resolve?: Resolve): string {
  try {
    return transcriptRow(JSON.parse(raw), "tools", resolve, [], [])
  } catch {
    return "[Invalid archived row; recall gap]"
  }
}

export type CatalogEntry = { readonly id: string; readonly title?: string; readonly start?: number; readonly end?: number; readonly note: string }

const catalogLine = (entry: CatalogEntry): string =>
  `${entry.id}${entry.title ? ` — ${entry.title}` : ""}${entry.start !== undefined && entry.end !== undefined ? ` (${formatSpan(entry.start, entry.end)})` : ""}`

/** One entry's label and whole note: the fetchable original behind a catalog line. */
export function formatCatalogEntry(entry: CatalogEntry): string {
  return `${catalogLine(entry)}\n${entry.note}`
}

/** The sole summary surface: episode labels newest-first (numeric ID). Compact by default —
    one line per entry — with `all` as the whole-note view. Both are plain text that
    recallPage pages like any other target; nothing ever drops silently. */
export function formatCatalog(entries: readonly CatalogEntry[], view: "compact" | "all" = "compact"): string {
  const ordered = [...entries].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)) || (a.id < b.id ? -1 : 1))
  const header = "Archive catalog (newest first) — one entry's note: recall id=catalog E<n>; every note: recall id=catalog all"
  return [header, ...ordered.map((entry) => (view === "all" ? formatCatalogEntry(entry) : catalogLine(entry)))].join(view === "all" ? "\n\n" : "\n")
}

/** A rendered ID is its unique 12-character prefix; recall resolves any unambiguous prefix. */
export function shortId(id: string): string {
  return id.length <= SHORT_ID_CHARS ? id : id.slice(0, SHORT_ID_CHARS)
}

/** The lean, copy-paste-runnable target the system renders everywhere: `E57 layer tools page 2`. */
export function address(id: string, page?: number, layer?: Layer): string {
  let out = shortId(id)
  if (layer && layer !== "conversation") out += ` layer ${layer}`
  if (page !== undefined) out += ` page ${page}`
  return out
}

export type ParsedTarget =
  | { readonly kind: "catalog"; readonly entry?: string; readonly all?: boolean; readonly page?: number }
  | { readonly kind: "episode"; readonly handle: string; readonly layer?: Layer; readonly page?: number }
  | { readonly kind: "opaque"; readonly handle: string; readonly page?: number }
  | { readonly kind: "error"; readonly message: string }

/** Parse a lean target address: a handle plus optional `layer <L>` and `page <n>` pairs.
    `catalog` instead takes an optional view: `all` or one exact entry label (E<n>). */
export function parseTarget(input: string): ParsedTarget {
  const tokens = input.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { kind: "error", message: "Provide a target: catalog, an episode (E57), a tool call, or an archived row." }
  const handle = tokens[0]
  if (handle === "catalog") {
    let entry: string | undefined, all = false, page: number | undefined
    for (let i = 1; i < tokens.length; i++) {
      const key = tokens[i], value = tokens[i + 1]
      if (key === "page" && value !== undefined && /^\d+$/.test(value)) { page = Number(value); i++ }
      else if (key === "all") all = true
      else if (/^E\d+$/.test(key) && entry === undefined) entry = key
      else return { kind: "error", message: `Cannot parse catalog target near "${key}". Use: catalog [all | E<n>] [page N].` }
    }
    if (all && entry !== undefined) return { kind: "error", message: "catalog takes one view: all, or one entry label (E<n>)." }
    return { kind: "catalog", ...(all ? { all: true } : {}), ...(entry !== undefined ? { entry } : {}), ...(page !== undefined ? { page } : {}) }
  }
  let layer: Layer | undefined, page: number | undefined
  for (let i = 1; i < tokens.length; i++) {
    const key = tokens[i], value = tokens[i + 1]
    if (key === "layer" && value !== undefined && (LAYERS as readonly string[]).includes(value)) { layer = value as Layer; i++ }
    else if (key === "page" && value !== undefined && /^\d+$/.test(value)) { page = Number(value); i++ }
    else return { kind: "error", message: `Cannot parse target near "${key}". Use: <target> [layer conversation|tools|full] [page N].` }
  }
  if (/^E\d/.test(handle)) return { kind: "episode", handle, ...(layer !== undefined ? { layer } : {}), ...(page !== undefined ? { page } : {}) }
  if (layer !== undefined) return { kind: "error", message: "layer applies only to an episode (E57)." }
  return { kind: "opaque", handle, ...(page !== undefined ? { page } : {}) }
}

/** git-style resolution: an exact ID wins, a unique prefix resolves, an ambiguous one lists candidates. */
export function resolveHandle(handle: string, ids: readonly string[]): { readonly id: string } | { readonly error: string } {
  const exact = ids.find((id) => id === handle)
  if (exact) return { id: exact }
  const matches = ids.filter((id) => id.startsWith(handle))
  if (matches.length === 1) return { id: matches[0] }
  if (matches.length > 1) return { error: `Ambiguous target "${handle}"; candidates: ${matches.slice(0, 5).map(shortId).join(", ")}${matches.length > 5 ? ", …" : ""}` }
  return { error: `No matching episode, tool call, or archived row for "${handle}". Try a query search by content instead.` }
}

/** Return attachments only on the page where their label starts, never as base64 text.
    Without page, return the whole original up to RECALL_ALL_CHARS in one call; an explicit
    page steps through larger originals in RECALL_PAGE_CHARS pages. A page beyond the last
    is reported as content naming the last page — a range hint, not a failure. `base` is
    the lean target (handle plus any layer), without the page. */
export function recallPage(base: string, text: string, page?: number, files: readonly RecallFile[] = []): RecallContent {
  const bounds = pageBounds(text, RECALL_PAGE_CHARS)
  const pages = bounds.length - 1
  const attach = (from: number, to: number) => files.filter(({ offset }) => offset >= from && offset < to).map(({ file }) => file)
  if (page === undefined) {
    const shown = Math.min(pages, RECALL_ALL_CHARS / RECALL_PAGE_CHARS)
    const end = bounds[shown]
    const attached = attach(0, end)
    // The label reports the call that was made; paging advice stays in the parenthetical,
    // and originals beyond the cap point at query-first retrieval before raw paging.
    const label = shown < pages
      ? `recall ${base} (whole output too large: first ${end} of ${text.length} characters; use a query to locate the relevant page first, or continue at page ${shown + 1})`
      : `recall ${base} (whole output)`
    const whole = `${label}\n${text.slice(0, end)}`
    return attached.length ? [{ type: "text", text: whole }, ...attached] : whole
  }
  if (!Number.isInteger(page) || page < 1) throw new RangeError("Invalid page")
  if (page > pages) return `recall ${base} page ${page} is out of range: this original has ${pages} page${pages === 1 ? "" : "s"}; the last page is ${pages}.`
  const attached = attach(bounds[page - 1], bounds[page])
  const result = paginate(text, page)
  const content = `recall ${base} page ${page} (page ${page} of ${result.pages}${result.nextPage ? `; next page: ${result.nextPage}` : ""})\n${result.content}`
  return attached.length ? [{ type: "text", text: content }, ...attached] : content
}
