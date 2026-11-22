#!/usr/bin/env node
// ocq — read-only inspector for the local OpenCode session database.
//
//   ocq sessions [--sort date|tokens|cost] [--grep TEXT] [--limit N | --all] [--json]
//   ocq messages <session> [--type user,assistant,...] [--seq A[:B]] [--limit N | --all] [--json]
//   ocq show <session> [seq] [--part N] [--max-chars N] [--json]
//
// Complements nextdcp's curated recall archive with raw facts straight from
// the live database. Strictly read-only: sqlite opens the file with
// readOnly and no code path here writes, creates or moves anything.

import { existsSync } from "node:fs"
import { object } from "./guards.ts"
import { durableTokens } from "./estimate.ts"
import { tokens } from "./tokens.ts"
import { defaultDatabase } from "./host.ts"
import type { Row } from "./memory.ts"

const PROGRAM = "ocq"

const USAGE = `ocq — read-only inspector for the local OpenCode session database

usage:
  ocq sessions  [--sort date|tokens|cost] [--grep TEXT] [--limit N | --all] [--json]
  ocq messages  <session> [--type user,assistant,...] [--seq A[:B]] [--limit N | --all] [--json]
  ocq show      <session> [seq] [--part N] [--max-chars N] [--json]

  <session>  a full or shortened ses_ id, or a slug prefix
  --db PATH  database to inspect (default: the live opencode.db)

The database is only ever opened read-only. EST figures are nextdcp's
chars/4 estimator, not provider counts — providers do not store
per-message usage in the database.`

function fail(message: string): never {
  console.error(`${PROGRAM}: ${message}`)
  process.exit(1)
}

// --- arguments -----------------------------------------------------------------

const VALUE_OPTIONS = new Set(["db", "sort", "grep", "limit", "type", "seq", "part", "max-chars"])
const FLAG_OPTIONS = new Set(["all", "json", "help"])

type Options = Record<string, string | true>

function parseArgs(argv: readonly string[]) {
  const options: Options = {}, positionals: string[] = []
  for (let at = 0; at < argv.length; at++) {
    const argument = argv[at]!
    if (!argument.startsWith("--")) { positionals.push(argument); continue }
    const equals = argument.indexOf("=")
    const name = (equals === -1 ? argument : argument.slice(0, equals)).slice(2)
    if (FLAG_OPTIONS.has(name)) {
      if (equals !== -1) fail(`--${name} takes no value`)
      options[name] = true
      continue
    }
    if (!VALUE_OPTIONS.has(name)) fail(`unknown option ${argument} (see ${PROGRAM} --help)`)
    if (equals !== -1) { options[name] = argument.slice(equals + 1); continue }
    const next = argv[at + 1]
    if (next === undefined || next.startsWith("--")) fail(`--${name} needs a value`)
    options[name] = next
    at++
  }
  return { options, positionals }
}

function value(options: Options, name: string): string | undefined {
  const raw = options[name]
  return typeof raw === "string" ? raw : undefined
}

function count(options: Options, name: string): number | undefined {
  const raw = value(options, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) fail(`--${name} expects a non-negative integer, got "${raw}"`)
  return parsed
}

/** Applies --limit (default 30) unless --all; reports truncation on stderr. */
function bounded<T>(rows: readonly T[], total: number, options: Options): readonly T[] {
  if (options.all === true) {
    if (options.limit !== undefined) fail("--all and --limit are mutually exclusive")
    return rows
  }
  const limit = count(options, "limit") ?? 30
  if (limit < 1) fail("--limit expects a positive integer")
  if (rows.length > limit) console.error(`${PROGRAM}: showing ${limit} of ${total} — pass --all or --limit N`)
  return rows.slice(0, limit)
}

// --- formatting ----------------------------------------------------------------

const numeric = (input: unknown): number | undefined => (typeof input === "number" && Number.isFinite(input) ? input : undefined)
const trimmed = (ratio: number) => String(Math.round(ratio * 10) / 10)

/** 12 345 → "12k", 1 234 567 → "1.2M" */
function compact(value: number): string {
  if (value >= 1e6) return `${trimmed(value / 1e6)}M`
  if (value >= 1e3) return `${trimmed(value / 1e3)}k`
  return String(Math.round(value))
}

function money(value: number): string {
  if (value === 0) return "0"
  if (value < 0.01) return value.toFixed(3)
  if (value < 10) return value.toFixed(2)
  return String(Math.round(value))
}

function since(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return "-"
  const seconds = Math.max(0, (now - timestamp) / 1000)
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)}h`
  if (seconds < 1_209_600) return `${Math.floor(seconds / 86_400)}d`
  return new Date(timestamp).toISOString().slice(0, 10)
}

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "-"
  return milliseconds < 1_000 ? `${Math.round(milliseconds)}ms` : `${trimmed(milliseconds / 1_000)}s`
}

const oneline = (input: unknown): string => (typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "")

function clip(input: string, max: number): { body: string; more: number } {
  return input.length <= max ? { body: input, more: 0 } : { body: input.slice(0, max), more: input.length - max }
}

function printTable(head: readonly string[], rows: readonly (readonly string[])[], right: readonly boolean[]) {
  const widths = head.map((label, column) => Math.max(label.length, ...rows.map((row) => row[column]!.length)))
  const line = (row: readonly string[]) =>
    row.map((cell, column) => (right[column] ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!))).join("  ")
  console.log(line(head))
  for (const row of rows) console.log(line(row))
}

// --- database ------------------------------------------------------------------

type Database = import("node:sqlite").DatabaseSync
type SQLInputValue = import("node:sqlite").SQLInputValue

function openDatabase(path: string): Database {
  if (!existsSync(path)) fail(`no database at ${path} — start OpenCode first, or pass --db PATH`)
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return fail(`cannot open ${path} read-only: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const escapeLike = (input: string) => input.replace(/[\\%_]/g, (char) => `\\${char}`)

type SessionRef = { id: string; slug: string | null; title: string | null }

/** Full id or slug, else a unique id or slug prefix. Ambiguity lists candidates. */
function resolveSession(database: Database, ref: string): string {
  const exact = database.prepare("SELECT id FROM session_v2 WHERE id = ?1 OR slug = ?1 ORDER BY time_updated DESC").get(ref)
  if (object(exact) && typeof exact.id === "string") return exact.id
  const rows = database
    .prepare(`SELECT id, slug, title FROM session_v2
              WHERE id LIKE ?1 ESCAPE '\\' OR slug LIKE ?2 ESCAPE '\\'
              ORDER BY time_updated DESC`)
    .all(`${escapeLike(ref.startsWith("ses_") ? ref : `ses_${ref}`)}%`, `${escapeLike(ref)}%`) as SessionRef[]
  if (rows.length === 1) return rows[0]!.id
  if (!rows.length) fail(`no session matches "${ref}" (tried exact id/slug, id prefix and slug prefix)`)
  const listing = rows.slice(0, 8).map((row) => `  ${row.id}  ${oneline(row.title) || row.slug || ""}`)
  fail(`"${ref}" is ambiguous across ${rows.length} sessions:\n${listing.join("\n")}${rows.length > 8 ? `\n  … and ${rows.length - 8} more` : ""}`)
}

interface SessionRow {
  id: string; slug: string | null; title: string | null; directory: string | null
  cost: unknown; tokens_input: unknown; tokens_output: unknown; tokens_reasoning: unknown
  tokens_cache_read: unknown; tokens_cache_write: unknown; time_created: unknown; time_updated: unknown; msgs: number
}

const ORDERS = {
  date: "time_updated DESC",
  tokens: "(IFNULL(tokens_input,0) + IFNULL(tokens_output,0) + IFNULL(tokens_reasoning,0) + IFNULL(tokens_cache_read,0) + IFNULL(tokens_cache_write,0)) DESC",
  cost: "IFNULL(cost,0) DESC",
} as const

function sessionsCommand(args: readonly string[], options: Options, database: Database) {
  if (args.length) fail(`sessions takes no arguments (got ${args.map((a) => `"${a}"`).join(", ")})`)
  const sort = value(options, "sort") ?? "date"
  if (!Object.hasOwn(ORDERS, sort)) fail(`--sort expects date, tokens or cost, got "${sort}"`)
  const grep = value(options, "grep")
  const where = grep === undefined ? "" : "WHERE title LIKE ?1 ESCAPE '\\' OR slug LIKE ?1 ESCAPE '\\'"
  const params = grep === undefined ? [] : [`%${escapeLike(grep)}%`]
  const rows = database
    .prepare(`SELECT id, slug, title, directory, cost, tokens_input, tokens_output, tokens_reasoning,
                     tokens_cache_read, tokens_cache_write, time_created, time_updated,
                     (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS msgs
              FROM session_v2 s ${where} ORDER BY ${ORDERS[sort as keyof typeof ORDERS]}`)
    .all(...params) as unknown as SessionRow[]
  const total = rows.length
  const limited = bounded(rows, total, options)
  const now = Date.now()
  if (options.json === true) {
    console.log(JSON.stringify(limited.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      directory: row.directory,
      messages: row.msgs,
      cost: numeric(row.cost) ?? null,
      tokens: {
        input: numeric(row.tokens_input) ?? null, output: numeric(row.tokens_output) ?? null,
        reasoning: numeric(row.tokens_reasoning) ?? null, cacheRead: numeric(row.tokens_cache_read) ?? null,
        cacheWrite: numeric(row.tokens_cache_write) ?? null,
        total: [row.tokens_input, row.tokens_output, row.tokens_reasoning, row.tokens_cache_read, row.tokens_cache_write]
          .reduce((sum: number, field) => sum + (numeric(field) ?? 0), 0),
      },
      timeCreated: numeric(row.time_created) ?? null, timeUpdated: numeric(row.time_updated) ?? null,
    })), null, 2))
    return
  }
  printTable(
    ["ID", "TITLE", "MSGS", "IN", "OUT", "RSN", "RD", "COST", "UPDATED"],
    limited.map((row) => [
      row.id.slice(0, 13),
      clip(oneline(row.title) || row.slug || row.id, 40).body,
      String(row.msgs),
      compact(numeric(row.tokens_input) ?? 0),
      compact(numeric(row.tokens_output) ?? 0),
      compact(numeric(row.tokens_reasoning) ?? 0),
      compact(numeric(row.tokens_cache_read) ?? 0),
      money(numeric(row.cost) ?? 0),
      since(numeric(row.time_updated), now),
    ]),
    [false, false, true, true, true, true, true, true, true],
  )
}

// --- messages -------------------------------------------------------------------

const compactJson = (input: unknown) => JSON.stringify(input) ?? "undefined"

type MessageRow = { seq: number; type: string; time_created: unknown; data: unknown }

type MessageData = {
  time?: { created?: unknown; firstToken?: unknown; streamed?: unknown; completed?: unknown }
  agent?: unknown
  model?: { id?: unknown; providerID?: unknown; variant?: unknown }
  content?: unknown
  text?: unknown
}

const rawJson = (input: unknown): unknown => {
  if (typeof input !== "string") return input
  try { return JSON.parse(input) } catch { return undefined }
}

function parseData(raw: unknown): MessageData {
  const source = rawJson(raw)
  if (!object(source)) return {}
  const time = object(source.time) ? source.time : {}
  return {
    time: { created: time.created, firstToken: time.firstToken, streamed: time.streamed, completed: time.completed },
    agent: source.agent, model: object(source.model) ? source.model : undefined, content: source.content, text: source.text,
  }
}

function modelLabel(model: MessageData["model"]): string | null {
  if (!model || typeof model.id !== "string") return null
  return model.variant === undefined || typeof model.variant !== "string" || model.variant === "" ? model.id : `${model.id}#${model.variant}`
}

/** The plugin's own estimator over the stored row shape, for parity with live metering. */
function estimate(type: string, raw: unknown): number {
  const source = rawJson(raw)
  const data = parseData(source)
  let total = durableTokens([{ type, content: data.content, text: data.text } as unknown as Row])
  if (type === "compaction" && object(source)) {
    if (typeof source.summary === "string") total += tokens(source.summary)
    const metadata = object(source.metadata) && typeof source.metadata.recent === "string" ? source.metadata.recent : undefined
    if (metadata !== undefined) total += tokens(metadata)
  }
  return total
}

function timings(data: MessageData): { ttft: number | undefined; stream: number | undefined } {
  const time = data.time ?? {}
  const created = numeric(time.created), first = numeric(time.firstToken)
  const end = numeric(time.completed) ?? numeric(time.streamed)
  return {
    ttft: created !== undefined && first !== undefined ? first - created : undefined,
    stream: first !== undefined && end !== undefined ? end - first : undefined,
  }
}

function messagesCommand(args: readonly string[], options: Options, database: Database) {
  if (args.length !== 1) fail(`messages takes exactly one session reference`)
  const id = resolveSession(database, args[0]!)
  const where = ["session_id = ?1"], params: SQLInputValue[] = [id]
  const types = value(options, "type")?.split(",").map((entry) => entry.trim()).filter(Boolean)
  if (types !== undefined) {
    if (!types.length) fail(`--type expects a comma-separated list, got "${value(options, "type")}"`)
    where.push(`type IN (${types.map(() => "?").join(",")})`)
    params.push(...types)
  }
  const range = value(options, "seq")
  if (range !== undefined && !/^\d*(?::\d*)?$/.test(range)) fail(`--seq expects A, A:B, :B or A:, got "${range}"`)
  const [from, to] = (range?.split(":") ?? []).map((part) => (part === "" || part === undefined ? undefined : Number(part)))
  if (from !== undefined) { where.push("seq >= ?"); params.push(from) }
  if (to !== undefined) { where.push("seq <= ?"); params.push(to) }
  const rows = database
    .prepare(`SELECT seq, type, time_created, data FROM session_message WHERE ${where.join(" AND ")} ORDER BY seq`)
    .all(...params) as MessageRow[]
  const limited = bounded(rows, rows.length, options)
  const view = limited.map((row) => {
    const data = parseData(row.data)
    return { row, data, parts: Array.isArray(data.content) ? data.content.length : null, timings: timings(data), est: estimate(row.type, row.data) }
  })
  if (options.json === true) {
    console.log(JSON.stringify(view.map(({ row, data, parts, timings: timing, est }) => ({
      seq: row.seq, type: row.type,
      agent: typeof data.agent === "string" ? data.agent : null,
      model: data.model ?? null,
      parts, estTokens: est,
      ttftMs: timing.ttft ?? null, streamMs: timing.stream ?? null,
      created: numeric(row.time_created) ?? null,
    })), null, 2))
    return
  }
  printTable(
    ["SEQ", "TYPE", "AGENT", "MODEL", "PARTS", "EST", "TTFT", "STREAM"],
    view.map(({ row, data, parts, timings: timing, est }) => [
      String(row.seq), row.type,
      typeof data.agent === "string" ? data.agent : "-",
      modelLabel(data.model) ?? "-",
      parts === null ? "-" : String(parts),
      compact(est), duration(timing.ttft), duration(timing.stream),
    ]),
    [true, false, false, false, true, true, true, true],
  )
}

// --- show ------------------------------------------------------------------------

type Block = { label: string; body: string }

const itemText = (item: unknown): string => {
  if (!object(item)) return compactJson(item)
  if (item.type === "text") return typeof item.text === "string" ? item.text : ""
  if (item.type === "media") return `[media ${object(item.media) && typeof item.media.mediaType === "string" ? item.media.mediaType : "?"}]`
  return compactJson(item)
}

function partBlock(part: unknown, index: number): Block {
  if (!object(part)) return { label: `#${index} ?`, body: compactJson(part) }
  if (part.type === "text" || part.type === "reasoning") {
    return { label: `#${index} ${part.type}`, body: typeof part.text === "string" ? part.text : "" }
  }
  if (part.type === "tool" && typeof part.name === "string" && object(part.state)) {
    const state = part.state, lines = [`in:  ${compactJson(state.input)}`]
    if (Array.isArray(state.content)) lines.push(`out: ${state.content.map(itemText).join("\n")}`)
    if (state.error !== undefined) lines.push(`err: ${compactJson(state.error)}`)
    return { label: `#${index} tool ${part.name}${typeof state.status === "string" ? ` (${state.status})` : ""}`, body: lines.join("\n") }
  }
  return { label: `#${index} ${typeof part.type === "string" ? part.type : "?"}`, body: compactJson(part) }
}

/** Blocks over the raw stored object — summary and compaction metadata included. */
function blocksFor(source: Record<string, unknown>): Block[] {
  const blocks: Block[] = []
  if (Array.isArray(source.content)) source.content.forEach((part, index) => blocks.push(partBlock(part, index)))
  else if (typeof source.text === "string") blocks.push({ label: "text", body: source.text })
  if (typeof source.summary === "string") blocks.push({ label: "summary", body: source.summary })
  const metadata = object(source.metadata) ? source.metadata : undefined
  if (metadata !== undefined && typeof metadata.recent === "string") blocks.push({ label: "recent", body: metadata.recent })
  if (!blocks.length) blocks.push({ label: "data", body: compactJson(source) })
  return blocks
}

function showCommand(args: readonly string[], options: Options, database: Database) {
  if (args.length < 1 || args.length > 2) fail("show takes a session reference and an optional message seq")
  const [reference, seq] = args
  if (seq !== undefined && !/^\d+$/.test(seq)) fail(`seq must be a non-negative integer, got "${seq}"`)
  const id = resolveSession(database, reference!)
  const selector = "SELECT seq, type, time_created, data FROM session_message WHERE session_id = ?1"
  const row = seq !== undefined
    ? database.prepare(`${selector} AND seq = ?2`).get(id, Number(seq)) as MessageRow | undefined
    : database.prepare(`${selector} ORDER BY seq DESC LIMIT 1`).get(id) as MessageRow | undefined
  if (!row) fail(`no ${seq !== undefined ? `message ${seq} ` : "messages "}in ${id}`)
  const source = rawJson(row.data)
  const data = parseData(source)
  const part = count(options, "part")
  if (options.json === true) {
    // Raw fidelity: the stored JSON exactly as it lies in the database.
    const content = object(source) && Array.isArray(source.content) ? source.content : undefined
    const output = part === undefined ? source
      : content === undefined ? fail(`--part ${part}: this message has no parts array (its text is shown directly)`)
        : part < content.length ? content[part] : fail(`--part ${part}: this message has ${content.length} parts`)
    console.log(JSON.stringify(output ?? row.data, null, 2))
    return
  }
  const maxChars = count(options, "max-chars") ?? 600
  if (maxChars < 1) fail("--max-chars expects a positive integer")
  const timing = timings(data), model = modelLabel(data.model)
  const created = numeric(row.time_created) ?? numeric(data.time?.created)
  console.log([
    id, `#${row.seq}`, row.type,
    typeof data.agent === "string" ? data.agent : "-",
    model ?? "-",
    created === undefined ? "-" : new Date(created).toISOString().slice(0, 19) + "Z",
    `ttft ${duration(timing.ttft)}`,
    `stream ${duration(timing.stream)}`,
    `est ${compact(estimate(row.type, row.data))}`,
  ].join("  "))
  const blocks = blocksFor(object(source) ? source : {})
  if (part !== undefined) {
    if (!Array.isArray(data.content)) fail(`--part ${part}: this message has no parts array (its text is shown directly)`)
    if (part >= blocks.length) fail(`--part ${part}: this message has ${blocks.length} parts`)
  }
  for (const block of part === undefined ? blocks : [blocks[part]!]) {
    console.log(block.label)
    const clipped = clip(block.body, maxChars)
    for (const line of clipped.body.split("\n")) console.log(`  ${line}`)
    if (clipped.more > 0) console.log(`  … +${clipped.more} more chars`)
  }
}

// --- dispatch --------------------------------------------------------------------

const [major, minor] = process.versions.node.split(".").map(Number)
if (!(major > 22 || major === 22 && minor >= 13)) {
  fail(`needs Node >= 22.13 for node:sqlite; this is Node ${process.versions.node}. The nextdcp plugin itself is unaffected.`)
}
const { DatabaseSync } = await import("node:sqlite")

const { options, positionals } = parseArgs(process.argv.slice(2))
if (options.help === true) { console.log(USAGE); process.exit(0) }
const [command = "", ...args] = positionals
const commands: Record<string, (args: readonly string[], options: Options, database: Database) => void> = {
  sessions: sessionsCommand, messages: messagesCommand, show: showCommand,
}
const run = Object.hasOwn(commands, command) ? commands[command] : undefined
if (run === undefined) fail(`${command ? `unknown command "${command}"` : "missing a command"}\n\n${USAGE}`)
const specific: readonly string[] = { sessions: ["sort", "grep"], messages: ["type", "seq"], show: ["part", "max-chars"] }[command]!
for (const name of Object.keys(options)) {
  if (name !== "db" && name !== "limit" && name !== "all" && name !== "json" && !specific.includes(name)) {
    fail(`--${name} is not valid for ${command} (see ${PROGRAM} --help)`)
  }
}
const database = openDatabase(value(options, "db") ?? defaultDatabase())
try {
  run(args, options, database)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

