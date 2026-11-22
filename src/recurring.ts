// recurring.ts — the recurring one-shot nudge. Code payloads re-created from
// scratch (python3 -c, heredocs, bash -c) are pooled from the host session
// database over a rolling window, star-clustered by word-set similarity into
// families, and gated by projected gain: only a family whose observed retyping
// clearly outweighs the notice, the one-time script write and the per-call
// wrappers that remain earns a nudge. The live side matches a session's new
// commands against those families; the first match rides the conversation tail
// once per session, advising the model to persist the payload as a script
// instead of re-typing it. Strictly read-only toward the host database.

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { object } from "./guards.ts"
import type { Row } from "./memory.ts"

/** Default host database location, mirroring OpenCode's own resolution. */
export function defaultDatabase(): string {
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "opencode", "opencode.db")
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".local", "share")
  return join(base, "opencode", "opencode.db")
}

// --- shape normalization ---------------------------------------------------------
// The masking core of scripts/recurring.mjs (the offline audit lab), reduced to
// the payload path: wrapper shapes make volatile atoms opaque so the same work
// in different clothes still matches.

/** Split a command into separator-delimited segments, quotes respected. */
function segments(command: string): string[] {
  const parts: string[] = []
  let current = "", sep = "", quoted: string | null = null
  const push = () => { parts.push(current); current = ""; sep = "" }
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!
    if (quoted) {
      current += char
      if (char === quoted && command[at - 1] !== "\\") quoted = null
      continue
    }
    if (char === "'" || char === '"') { quoted = char; current += char; continue }
    const found = command.slice(at).match(/^(\s*(?:&&|\|\||;|\||\n)\s*)/)
    if (found) {
      sep = found[1]!.trim()
      if (!sep || sep.includes("\n")) sep = ";"
      at += found[1]!.length - 1
      push()
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** Tokenize one segment on whitespace, quotes respected. */
function tokens(segment: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = []
  let current = "", quoted: string | null = null, wasQuoted = false
  for (let at = 0; at < segment.length; at++) {
    const char = segment[at]!
    if (quoted) {
      if (char === quoted && segment[at - 1] !== "\\") { quoted = null; continue }
      current += char
      continue
    }
    if (char === "'" || char === '"') { quoted = char; wasQuoted = true; continue }
    if (/\s/.test(char)) { if (current) { out.push({ text: current, quoted: wasQuoted }); current = ""; wasQuoted = false } continue }
    current += char
  }
  if (current) out.push({ text: current, quoted: wasQuoted })
  return out
}

const maskSegment = (text: string) =>
  text.replace(/[0-9a-f]{6,}/gi, "*").replace(/\d{2,}/g, (run) => (run.length >= 4 ? "*" : run))

/** One token → its stable shape. */
function shapeToken({ text, quoted }: { text: string; quoted: boolean }, roots: readonly string[]): string {
  if (quoted && /\s/.test(text) && text.length > 24) return "<s>" // long prose payload: opaque
  if (/^[A-Z_][A-Z0-9_]*=/.test(text)) return "" // env assignment prefix
  if (text.startsWith("-")) return text.split("=")[0].replace(/\d+/g, "") // flag: name only
  if (/^[0-9a-f]{8,}$/i.test(text) || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(text)) return "<id>"
  if (/^\d+$/.test(text) || /^\d+\.\d+$/.test(text)) return "N"
  if (/^\d{4}-\d{2}-\d{2}/.test(text) || /^\d{1,2}:\d{2}/.test(text)) return "<date>"
  if (/^ses_[0-9a-zA-Z]+/.test(text) || /^call_[0-9a-f]+/.test(text)) return "<id>"
  if (text.includes("/") || text.startsWith("~") || text === "." || text === "..") {
    let path = text.startsWith("~/") ? text.slice(2) : text
    for (const root of roots) if (path.startsWith(root + "/")) { path = path.slice(root.length + 1); break }
    return path.split("/").map(maskSegment).join("/")
  }
  return text
}

/** Pull <<DELIM heredoc bodies out of the command text, quote-aware. The text
 *  keeps a `<<DELIM` header plus a `«body:N»` marker standing in for the body. */
function extractHeredocs(text: string): { text: string; bodies: string[] } {
  const bodies: string[] = []
  let out = "", quoted: string | null = null, at = 0
  while (at < text.length) {
    const char = text[at]!
    if (quoted) {
      out += char
      if (char === quoted && text[at - 1] !== "\\") quoted = null
      at++
      continue
    }
    if (char === "'" || char === '"') { quoted = char; out += char; at++; continue }
    const found = char === "<" && text.slice(at).match(/^<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1(?![\w-])/)
    if (found && text[at + 2] !== "<") {
      const delim = found[2]!
      const headerEnd = text.indexOf("\n", at)
      if (headerEnd === -1) break // no body ever starts
      let lineStart = headerEnd + 1, terminator = -1
      while (lineStart <= text.length) {
        const lineEnd = text.indexOf("\n", lineStart)
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
        if ((found[0].includes("-") ? line.replace(/^\t+/, "") : line).trimEnd() === delim) { terminator = lineStart; break }
        if (lineEnd === -1) break
        lineStart = lineEnd + 1
      }
      out += `<<${delim} «body:${bodies.length}»` + text.slice(at + found[0].length, headerEnd + 1)
      bodies.push(text.slice(headerEnd + 1, terminator === -1 ? text.length : terminator))
      const after = terminator === -1 ? -1 : text.indexOf("\n", terminator)
      at = terminator === -1 || after === -1 ? text.length : after + 1
      continue
    }
    out += char
    at++
  }
  return { text: out, bodies }
}

/** Wrapper/payload pairs of one command: the wrapper is its segment's shape with
 *  payload slots opaque (`<s>`), heredoc headers and `-` stdin markers dropped. */
export function occurrences(command: string, roots: readonly string[]): { wrapper: string; payload: string }[] {
  const { text, bodies } = extractHeredocs(command)
  const found: { wrapper: string; payload: string }[] = []
  for (const segment of segments(text)) {
    const shapeWords: string[] = []
    const payloads: string[] = []
    for (const token of tokens(segment)) {
      const ref = /^«body:(\d+)»$/.exec(token.text)
      const quotedPayload = token.quoted && token.text.length > 40
      if (!ref && !quotedPayload) {
        const shape = shapeToken(token, roots)
        if (shape) shapeWords.push(shape)
        continue
      }
      shapeWords.push("<s>")
      payloads.push(ref ? bodies[+ref[1]]! : token.text)
    }
    if (!payloads.length) continue
    const wrapper = shapeWords.filter((word) => !/^<<-?/.test(word) && word !== "-").join(" ")
    for (const payload of payloads) found.push({ wrapper, payload })
  }
  return found
}

// --- payload similarity ----------------------------------------------------------
// Similar-not-identical scripts share most of their words: word-set Jaccard over
// lightly masked words (prefixes/quotes stripped, hex runs and digits collapsed).

const simWord = (word: string) => word
  .replace(/^(?:[frbFRB]{0,2})["'`\[{(]+/, "")
  .replace(/[)"'`\]},;:.]+$/, "")
  .replace(/[0-9a-f]{6,}/gi, "*")
  .replace(/\d+/g, "N")

const wordSet = (payload: string): ReadonlySet<string> => new Set(payload.split(/\s+/).map(simWord).filter((word) => word.length > 1))

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (!a.size || !b.size) return 0
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  let shared = 0
  for (const word of small) if (big.has(word)) shared++
  return shared / (a.size + b.size - shared)
}

/** Wrappers whose payloads are hand-written code; jq/grep/curl/git payloads are data plumbing. */
export const codeWrapper = (wrapper: string) =>
  /(python3?|node|perl|ruby)\s+(-[ce]\b|<s>)/.test(wrapper) ||
  /(^|[/ ])b?a?sh\s+-[xi]*c\b/.test(wrapper)

// --- families --------------------------------------------------------------------

const MIN_SESSIONS = 3, PAYLOAD_MIN = 8, SIM_THRESHOLD = 0.4
const WINDOW_MS = 90 * 86_400_000, TTL_MS = 6 * 3_600_000
// A nudge pays for itself only when the observed retyping clearly outruns its
// costs: the notice itself, the one-time script write, and the per-invocation
// wrapper that remains after the payload moves to a file.
const NUDGE_TOKENS = 80, SCRIPT_TOKENS = 60, CALL_TOKENS = 8, MIN_GAIN = 200

export type Family = {
  /** Dominant wrapper shape; `<s>` marks the payload slot. */
  readonly wrapper: string
  /** Distinct sessions that retyped a member, inside the scan window. */
  readonly sessions: number
  /** Retyped payload tokens observed in the window. */
  readonly retyped: number
  /** Member word-sets; a live command matches at Jaccard ≥ SIM_THRESHOLD against any. */
  readonly members: readonly ReadonlySet<string>[]
}

/** One nudge as it rides the conversation tail: what recurred, the observed
 *  cost, and the persistent shape to move to. Header style matches the other
 *  automated notices. */
export const renderNudge = (family: Family): string =>
  `[Recurring one-shot — automated notice, not a user message]
A ${family.wrapper.replace(" <s>", "")} payload like this has been re-created from scratch in ${family.sessions} sessions (~${family.retyped} tokens of payload retyped). Persist it now as a small script under scripts/ and call it with arguments instead of re-typing the one-shot.`

/** One model command as the pool sees it: which session retyped it, where. */
export type PoolRow = { readonly session: string; readonly directory: string; readonly command: string }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Model commands routinely prefix `rtk bypass` and `cd <dir> &&`; the pool and
 *  the live scan must strip the same prefixes or identical work won't match. */
export function normalizeCommand(command: string, directory: string): string {
  let text = command.trim().replace(/^rtk\s+bypass\s+/, "")
  if (directory) text = text.replace(new RegExp(`^cd\\s+["']?${escapeRegex(directory)}["']?\\s*(?:&&|;)\\s*`), "")
  return text
}

const rootsFor = (directory: string, home = homedir()): readonly string[] =>
  directory && directory !== home ? [home, directory] : [home]

/** Pool code one-shots, star-cluster them by similarity, and keep only families
 *  spanning enough sessions with enough projected gain. A payload retyped
 *  verbatim pools into a single vertex with no edges and is admitted too —
 *  exact recurrence is the strongest signal, not a non-match. */
export function buildFamilies(rows: readonly PoolRow[]): Family[] {
  const pool = new Map<string, { sessions: Set<string>; count: number; chars: number; wrappers: Map<string, number> }>()
  for (const row of rows) {
    const text = normalizeCommand(row.command, row.directory)
    for (const occurrence of occurrences(text, rootsFor(row.directory))) {
      if (occurrence.payload.length < PAYLOAD_MIN || !codeWrapper(occurrence.wrapper)) continue
      let entry = pool.get(occurrence.payload)
      if (!entry) { entry = { sessions: new Set(), count: 0, chars: 0, wrappers: new Map() }; pool.set(occurrence.payload, entry) }
      entry.count++, entry.chars += occurrence.payload.length
      entry.sessions.add(row.session)
      entry.wrappers.set(occurrence.wrapper, (entry.wrappers.get(occurrence.wrapper) ?? 0) + 1)
    }
  }
  const variants = [...pool.entries()].map(([payload, entry]) => ({ payload, ...entry })).sort((a, b) => b.chars - a.chars)
  const sets = variants.map((variant) => wordSet(variant.payload))
  const edges: number[][] = variants.map(() => [])
  for (let i = 0; i < variants.length; i++)
    for (let j = i + 1; j < variants.length; j++)
      if (jaccard(sets[i]!, sets[j]!) >= SIM_THRESHOLD) { edges[i]!.push(j); edges[j]!.push(i) }
  // Seeds by vertex degree, ties by payload size: stars absorb their neighbors
  // before any of them seeds a fragment of what should have been one family.
  const order = edges.map((list, at) => [at, list.length]).sort((a, b) => b[1] - a[1] || variants[b[0]!].chars - variants[a[0]!].chars)
  const taken = new Set<number>()
  const families: Family[] = []
  for (const [seed] of order) {
    if (taken.has(seed)) continue
    taken.add(seed)
    const members = [seed]
    for (const other of edges[seed]!) if (!taken.has(other)) { members.push(other); taken.add(other) }
    const sessions = new Set(members.flatMap((at) => [...variants[at]!.sessions]))
    if (sessions.size < MIN_SESSIONS) continue
    const wrappers = new Map<string, number>()
    for (const at of members) for (const [wrapper, count] of variants[at]!.wrappers) wrappers.set(wrapper, (wrappers.get(wrapper) ?? 0) + count)
    const [wrapper] = [...wrappers.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
    if (wrapper === undefined) continue
    const count = members.reduce((sum, at) => sum + variants[at]!.count, 0)
    const retyped = Math.round(members.reduce((sum, at) => sum + variants[at]!.chars, 0) / 4)
    if (retyped - count * CALL_TOKENS - NUDGE_TOKENS - SCRIPT_TOKENS < MIN_GAIN) continue
    families.push({ wrapper, sessions: sessions.size, retyped, members: members.map((at) => sets[at]!) })
  }
  return families.sort((a, b) => b.retyped - a.retyped)
}

/** Model-authored shell commands in context rows: assistant bash/shell tool
 *  calls in any state — the command exists from call start. Host `shell` rows
 *  are user-typed ! commands and never feed the nudge. */
export function commandsIn(rows: readonly Row[]): string[] {
  const commands: string[] = []
  for (const row of rows) {
    if (row.type !== "assistant") continue
    for (const part of row.content ?? []) {
      if (!object(part) || part.type !== "tool" || (part.name !== "bash" && part.name !== "shell")) continue
      const input = object(part.state) && object(part.state.input) ? part.state.input : undefined
      if (input && typeof input.command === "string" && input.command.trim()) commands.push(input.command)
    }
  }
  return commands
}

// --- live pool --------------------------------------------------------------------

export type Nudge = {
  /** The in-flight database scan, if any; resolves even when it failed. */
  settle(): Promise<void>
  /** Re-scan the database when the pool is stale; fire-and-forget and self-guarding. */
  refresh(): void
  /** The first family one of the commands matches, or undefined. */
  scan(commands: readonly string[], directory: string): Family | undefined
  /** Families currently loaded — diagnostics and tests. */
  families(): readonly Family[]
}

/** The nudge's database view: a background scan at start and every TTL after,
 *  over assistant messages of sessions touched inside the window. A missing
 *  database is a fresh host — disabled silently, rechecked per refresh. An
 *  unreadable one is abnormal: one warning per process, retried at the TTL. */
export function createNudge(report: (where: string, error?: unknown) => void, dbPath = defaultDatabase()): Nudge {
  let current: Family[] | undefined
  let loading: Promise<void> | undefined
  let scannedAt = 0
  let warned = false
  const load = async (): Promise<void> => {
    try {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const poolRows: PoolRow[] = []
      try {
        const found = db.prepare(`
          SELECT m.session_id AS session, s.directory AS directory, m.data AS data
          FROM session_message m JOIN session_v2 s ON s.id = m.session_id
          WHERE m.type = 'assistant' AND s.time_updated >= ?
          ORDER BY m.session_id, m.seq`).all(Date.now() - WINDOW_MS)
        for (const row of found) {
          if (!object(row) || typeof row.session !== "string" || typeof row.data !== "string") continue
          let data: unknown
          try { data = JSON.parse(row.data) } catch { continue }
          const content = object(data) && Array.isArray(data.content) ? data.content : undefined
          // History rows carry the same persisted shape as live context rows:
          // one extractor feeds both the pool and the scan.
          if (content === undefined) continue
          for (const command of commandsIn([{ id: "", type: "assistant", content }]))
            poolRows.push({ session: row.session, directory: typeof row.directory === "string" ? row.directory : "", command })
        }
      } finally { db.close() }
      current = buildFamilies(poolRows)
    } catch (error) {
      if (!warned) { warned = true; report("recurring payload nudge scan failed; retrying later", error) }
    }
  }
  const refresh = (): void => {
    if (loading !== undefined || Date.now() - scannedAt < TTL_MS) return
    if (!existsSync(dbPath)) return
    scannedAt = Date.now()
    loading = load()
    void loading.then(() => { loading = undefined }, () => { loading = undefined })
  }
  refresh()
  return {
    settle: () => loading ?? Promise.resolve(),
    refresh,
    scan(commands: readonly string[], directory: string): Family | undefined {
      if (!current?.length) return undefined
      const roots = rootsFor(directory)
      for (const command of commands) {
        for (const occurrence of occurrences(normalizeCommand(command, directory), roots)) {
          if (occurrence.payload.length < PAYLOAD_MIN || !codeWrapper(occurrence.wrapper)) continue
          const words = wordSet(occurrence.payload)
          for (const family of current)
            if (family.members.some((member) => jaccard(words, member) >= SIM_THRESHOLD)) return family
        }
      }
      return undefined
    },
    families: () => current ?? [],
  }
}
