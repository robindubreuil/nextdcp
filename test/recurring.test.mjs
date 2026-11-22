import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { buildFamilies, commandsIn, createNudge, defaultDatabase, normalizeCommand, occurrences, renderNudge } from "../src/recurring.ts"
import { tokens } from "../src/tokens.ts"
import { csvSorter, fixtureDatabase, jsonSummary, jsonSummaryVariant, liveJsonSummary, pooledSessions } from "./support/pool.ts"

const python = (payload) => `python3 -c '${payload}'`
const rows = (sessions, command, each = 1) => sessions.flatMap((session) =>
  Array.from({ length: each }, () => ({ session, directory: "C:/nextdcp-test", command })))

test("occurrences extracts quoted code payloads and heredoc bodies", () => {
  assert.deepEqual(occurrences(python(jsonSummary), ["/home/u"]), [{ wrapper: "python3 -c <s>", payload: jsonSummary }])
  assert.deepEqual(occurrences(`python3 - <<'PY'\n${jsonSummary}\nPY`, ["/home/u"]), [{ wrapper: "python3 <s>", payload: `${jsonSummary}\n` }])
  assert.deepEqual(occurrences("echo 'hi there friend'", ["/home/u"]), [], "short quotes are arguments, not payloads")
})

test("normalizeCommand strips the host's prefixes identically for pool and scan", () => {
  assert.equal(normalizeCommand("rtk bypass python3 -c 'pass'", ""), "python3 -c 'pass'")
  assert.equal(normalizeCommand(`cd "C:/nextdcp-test" && python3 -c 'pass'`, "C:/nextdcp-test"), "python3 -c 'pass'")
  assert.equal(normalizeCommand(`cd /somewhere && python3 -c 'pass'`, "C:/nextdcp-test"), `cd /somewhere && python3 -c 'pass'`, "another directory's cd stays")
})

test("a payload retyped verbatim across sessions is a singleton family", () => {
  const families = buildFamilies(rows(["s1", "s2", "s3"], python(jsonSummary), 3))
  assert.equal(families.length, 1)
  assert.equal(families[0].wrapper, "python3 -c <s>")
  assert.equal(families[0].sessions, 3)
  assert.equal(families[0].retyped, Math.round(jsonSummary.length * 9 / 4))
})

test("similar variants cluster into one family spanning their sessions", () => {
  const families = buildFamilies([
    ...rows(["s1"], python(jsonSummary), 3),
    ...rows(["s2", "s3"], python(jsonSummaryVariant), 3),
    ...rows(["s4", "s5"], python(liveJsonSummary), 3),
  ])
  assert.equal(families.length, 1)
  assert.equal(families[0].wrapper, "python3 -c <s>")
  assert.equal(families[0].sessions, 5)
})

test("a high-degree variant seeds the star and absorbs its neighbors", () => {
  const words = (list) => Array.from({ length: 4 }, () => list.join(" ")).join(" ")
  const base = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet",
    "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango",
    "uniform", "victor", "whiskey", "xray", "yankee", "zulu", "apple", "banana", "cherry", "date"]
  const families = buildFamilies([
    ...rows(["s1"], python(words(base))),
    ...rows(["s2"], python(words([...base.slice(0, 15), "aspen", "birch", "cedar", "denali", "elm"]))),
    ...rows(["s3"], python(words([...base.slice(15), "fjord", "glacier", "harbor", "inlet", "jungle"]))),
  ])
  assert.equal(families.length, 1)
  assert.equal(families[0].sessions, 3, "both sparse variants join the hub instead of fragmenting into dropped families")
})

test("two sessions never make a family", () => {
  assert.deepEqual(buildFamilies(rows(["s1", "s2"], python(jsonSummary), 3)), [])
})

test("families below the gain line stay silent", () => {
  assert.deepEqual(buildFamilies(rows(["s1", "s2", "s3"], python(jsonSummary), 1)), [])
})

test("jq payloads are data plumbing, not code one-shots", () => {
  const filter = '.items[] | select(.status == "active") | {name: .name, count: .count}'
  assert.deepEqual(buildFamilies(rows(["s1", "s2", "s3"], `jq -c '${filter}'`, 3)), [])
})

test("commandsIn sees only assistant bash/shell tool calls", () => {
  const found = commandsIn([
    { id: "h1", type: "shell", command: "user typed ! command" },
    { id: "a1", type: "assistant", content: [{ type: "text", text: "hello" }] },
    { id: "a2", type: "assistant", content: [{ type: "tool", id: "t1", name: "read", state: { input: { command: "cat notes" } } }] },
    { id: "a3", type: "assistant", content: [{ type: "tool", id: "t2", name: "bash", state: { status: "pending", input: { command: "echo pending" } } }] },
    { id: "a4", type: "assistant", content: [{ type: "tool", id: "t3", name: "shell", state: { input: { command: "  " } } }] },
  ])
  assert.deepEqual(found, ["echo pending"])
})

test("defaultDatabase follows XDG_DATA_HOME", () => {
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = "/xdg-root"
  try { assert.equal(defaultDatabase(), join("/xdg-root", "opencode", "opencode.db")) }
  finally { if (prior === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prior }
})

test("a missing database is a fresh host and stays silent", async (t) => {
  const reports = []
  const nudge = createNudge((where, error) => reports.push([where, error]), join(tmpdir(), "nextdcp-absent", "opencode.db"))
  await nudge.settle()
  nudge.refresh()
  await nudge.settle()
  assert.deepEqual(reports, [])
  assert.deepEqual(nudge.families(), [])
})

const sqlite = await import("node:sqlite").then(() => true, () => false)
const requireSqlite = { skip: sqlite ? false : "node:sqlite is unavailable on this node" }

test("the nudge pools a host database window into gated families", requireSqlite, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "nextdcp-recurring-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const path = join(tmp, "opencode.db")
  await fixtureDatabase(path, pooledSessions)
  const reports = []
  const nudge = createNudge((where, error) => reports.push([where, error]), path)
  await nudge.settle()
  const families = nudge.families()
  assert.deepEqual(reports, [])
  assert.equal(families.length, 1, "the two-session csv work and the out-of-window session never make a family")
  assert.equal(families[0].wrapper, "python3 -c <s>")
  assert.equal(families[0].sessions, 4)
  assert.equal(families[0].retyped, Math.round((6 * jsonSummary.length + 6 * jsonSummaryVariant.length) / 4))
  assert.ok(nudge.scan([python(liveJsonSummary)], "C:/nextdcp-test"), "similar-not-identical live work matches")
  assert.equal(nudge.scan([python(csvSorter)], "C:/nextdcp-test"), undefined)
  assert.equal(nudge.scan([], "C:/nextdcp-test"), undefined)
  const notice = renderNudge(families[0])
  assert.equal(notice, `[Recurring one-shot — automated notice, not a user message]
A python3 -c payload like this has been re-created from scratch in 4 sessions (~${families[0].retyped} tokens of payload retyped). Persist it now as a small script under scripts/ and call it with arguments instead of re-typing the one-shot.`)
  assert.ok(tokens(notice) <= 130, `the notice stays small (${tokens(notice)} tokens)`)
})

test("an unreadable database warns once and backs off to the TTL", requireSqlite, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "nextdcp-recurring-"))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  writeFileSync(join(tmp, "opencode.db"), "definitely not a sqlite database")
  const reports = []
  const nudge = createNudge((where, error) => reports.push(where), join(tmp, "opencode.db"))
  await nudge.settle()
  nudge.refresh()
  await nudge.settle()
  assert.deepEqual(reports, ["recurring payload nudge scan failed; retrying later"])
  assert.deepEqual(nudge.families(), [])
})
