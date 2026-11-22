import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const [major, minor] = process.versions.node.split(".").map(Number)
const skip = major > 22 || (major === 22 && minor >= 13) ? false : "node:sqlite needs Node >= 22.13"
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))

// Two sessions share an id prefix (ses_alpha0…) so ambiguity is reachable;
// one session has no messages; token and cost orders intentionally disagree.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nextdcp-ocq-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(join(root, "test.db"))
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT, cost REAL,
    tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER,
    tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)`)
  db.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)")
  const session = db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  session.run("ses_alpha0001", "alpha-one", "Alpha first", "/w", 2.0, 100, 50, 0, 0, 0, 1000, 5000)
  session.run("ses_beta0002", "beta-two", "Beta second", "/w", 0.5, 500, 0, 0, 0, 0, 1000, 4000)
  session.run("ses_alpha0002", "alpha-two", "Alpha sibling", "/w", 0, 10, 10, 0, 0, 0, 1000, 3000)
  session.run("ses_empty0003", "empty", "Empty", null, null, null, null, null, null, null, 1000, 2000)
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)")
  message.run("ses_alpha0001", 0, "user", 1000, JSON.stringify({ text: "hello world", time: { created: 1000 } }))
  message.run("ses_alpha0001", 1, "assistant", 2000, JSON.stringify({
    agent: "build", model: { id: "m", providerID: "p" },
    time: { created: 2000, firstToken: 2500, streamed: 3000, completed: 3100 },
    content: [{ type: "text", text: "answer body" }, { type: "reasoning", text: "think" }],
  }))
  message.run("ses_alpha0001", 2, "compaction", 4000, JSON.stringify({
    summary: "sum", metadata: { recent: "rec" }, time: { created: 4000 },
  }))
  db.close()
  return { root, db: join(root, "test.db") }
}

const run = (db, ...args) => {
  const result = spawnSync(process.execPath, [CLI, "--db", db, ...args], { encoding: "utf8" })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

test("sessions lists, sorts, greps and truncates", { skip }, async (t) => {
  const { db } = await fixture(t)
  const byDate = run(db, "sessions", "--all")
  assert.equal(byDate.status, 0)
  assert.match(byDate.out, /ID\s+TITLE\s+MSGS\s+IN\s+OUT\s+RSN\s+RD\s+COST\s+UPDATED/)
  for (const id of ["ses_alpha0001", "ses_beta0002", "ses_alpha0002", "ses_empty0003"]) assert.ok(byDate.out.includes(id))
  assert.ok(byDate.out.indexOf("ses_alpha0001") < byDate.out.indexOf("ses_beta0002"), "date order")
  assert.ok(run(db, "sessions", "--sort", "tokens", "--all").out.indexOf("ses_beta0002")
    < run(db, "sessions", "--sort", "tokens", "--all").out.indexOf("ses_alpha0001"), "token order")
  assert.ok(run(db, "sessions", "--sort", "cost", "--all").out.indexOf("ses_alpha0001")
    < run(db, "sessions", "--sort", "cost", "--all").out.indexOf("ses_beta0002"), "cost order")
  const grep = run(db, "sessions", "--grep", "Beta", "--all")
  assert.ok(grep.out.includes("ses_beta0002") && !grep.out.includes("ses_alpha0001"))
  const truncated = run(db, "sessions", "--limit", "2")
  assert.match(truncated.err, /showing 2 of 4/)
  assert.equal(truncated.out.trim().split("\n").length, 3, "header plus two rows")
})

test("sessions --json exposes raw column values", { skip }, async (t) => {
  const { db } = await fixture(t)
  const rows = JSON.parse(run(db, "sessions", "--json", "--all").out)
  assert.equal(rows.length, 4)
  const alpha = rows.find((row) => row.id === "ses_alpha0001")
  assert.equal(alpha.slug, "alpha-one")
  assert.equal(alpha.messages, 3)
  assert.equal(alpha.cost, 2.0)
  assert.equal(alpha.tokens.total, 150)
  assert.equal(alpha.timeUpdated, 5000)
  const empty = rows.find((row) => row.id === "ses_empty0003")
  assert.equal(empty.cost, null)
  assert.equal(empty.tokens.total, 0)
})

test("messages filter, meter and time exactly as the plugin would", { skip }, async (t) => {
  const { db } = await fixture(t)
  const all = run(db, "messages", "alpha-one", "--all")
  assert.equal(all.status, 0)
  assert.equal(all.out.trim().split("\n").length, 4, "header plus three rows")
  const assistant = all.out.split("\n").find((line) => line.includes("assistant"))
  assert.match(assistant, /\sm\s+2\s+4\s+500ms\s+600ms/, "model, parts, est, ttft, stream")
  assert.match(all.out.split("\n").find((line) => line.includes("user")), /\s-\s+3\s+-\s+-$/, "text meter, no timing")
  const typed = run(db, "messages", "alpha-one", "--type", "user,compaction", "--all")
  assert.ok(typed.out.includes("user") && typed.out.includes("compaction") && !typed.out.includes("assistant"))
  assert.ok(run(db, "messages", "alpha-one", "--seq", "1", "--all").out.includes("assistant"))
  assert.ok(!run(db, "messages", "alpha-one", "--seq", "2:", "--all").out.includes("user"))
  const json = JSON.parse(run(db, "messages", "alpha-one", "--json", "--all").out)
  assert.deepEqual(json.map((row) => row.estTokens), [3, 4, 2], "chars/4 estimates including compaction summary+recent")
  assert.deepEqual(json.map((row) => row.ttftMs), [null, 500, null])
  assert.deepEqual(json.map((row) => row.streamMs), [null, 600, null])
  assert.deepEqual(json.map((row) => row.parts), [null, 2, null])
  assert.deepEqual(json.map((row) => row.model), [null, { id: "m", providerID: "p" }, null])
  assert.deepEqual(json.map((row) => row.created), [1000, 2000, 4000])
})

test("show renders parts, clips, and prints raw JSON on demand", { skip }, async (t) => {
  const { db } = await fixture(t)
  const last = run(db, "show", "alpha-one")
  assert.equal(last.status, 0)
  assert.match(last.out.split("\n")[0], /ses_alpha0001\s+#2\s+compaction.*est 2/)
  assert.ok(last.out.includes("summary") && last.out.includes("recent"), "compaction blocks")
  const picked = run(db, "show", "alpha-one", "1")
  assert.match(picked.out.split("\n")[0], /#1\s+assistant\s+build\s+m\s/)
  assert.ok(picked.out.includes("#0 text") && picked.out.includes("#1 reasoning"))
  const clipped = run(db, "show", "alpha-one", "1", "--max-chars", "4")
  assert.match(clipped.out, /… \+7 more chars/)
  const part = run(db, "show", "alpha-one", "1", "--part", "1")
  assert.ok(part.out.includes("#1 reasoning") && !part.out.includes("#0 text"))
  assert.match(run(db, "show", "alpha-one", "1", "--part", "5").err, /--part 5: this message has 2 parts/)
  assert.deepEqual(JSON.parse(run(db, "show", "alpha-one", "1", "--json").out), {
    agent: "build", model: { id: "m", providerID: "p" },
    time: { created: 2000, firstToken: 2500, streamed: 3000, completed: 3100 },
    content: [{ type: "text", text: "answer body" }, { type: "reasoning", text: "think" }],
  })
  assert.deepEqual(JSON.parse(run(db, "show", "alpha-one", "1", "--json", "--part", "1").out), { type: "reasoning", text: "think" })
  assert.match(run(db, "show", "alpha-one", "99").err, /no message 99 in ses_alpha0001/)
  assert.match(run(db, "show", "empty").err, /no messages in ses_empty0003/)
})

test("session references resolve by id, prefix and slug, or name the ambiguity", { skip }, async (t) => {
  const { db } = await fixture(t)
  assert.equal(run(db, "messages", "ses_alpha0001", "--all").status, 0)
  assert.equal(run(db, "messages", "alpha-one", "--all").out.trim().split("\n").length, 4, "exact slug")
  assert.match(run(db, "show", "beta").err, /no messages in ses_beta0002/, "unique id prefix")
  const ambiguous = run(db, "messages", "alpha0", "--all")
  assert.match(ambiguous.err, /ambiguous across 2 sessions/)
  assert.ok(ambiguous.err.includes("ses_alpha0001") && ambiguous.err.includes("ses_alpha0002"))
  assert.match(run(db, "messages", "nope").err, /no session matches "nope"/)
})

test("the database is only ever read, and bad invocations fail loudly", { skip }, async (t) => {
  const { root, db } = await fixture(t)
  const before = createHash("sha256").update(await readFile(db)).digest("hex")
  for (const args of [["sessions", "--all"], ["messages", "ses_alpha0001", "--all"], ["show", "ses_alpha0001", "--json"]]) {
    assert.equal(run(db, ...args).status, 0)
  }
  assert.equal(createHash("sha256").update(await readFile(db)).digest("hex"), before, "byte-identical after reads")
  assert.deepEqual(await readdir(root), ["test.db"], "no journal or wal side files appear")
  assert.match(run(join(root, "missing.db"), "sessions").err, /no database at/)
  const usage = run(db)
  assert.equal(usage.status, 1)
  assert.match(usage.err, /missing a command/)
  assert.match(run(db, "sessions", "--bogus").err, /unknown option/)
  assert.match(run(db, "sessions", "--sort", "constructor").err, /--sort expects/)
  assert.match(run(db, "sessions", "--type", "user").err, /--type is not valid for sessions/)
  assert.match(run(join(root, "missing.db"), "show", "x", "--seq", "1").err, /--seq is not valid for show/, "before any database access")
  assert.match(run(db, "sessions", "--limit", "abc").err, /--limit expects/)
  assert.match(run(db, "sessions", "--all", "--limit", "3").err, /mutually exclusive/)
  assert.match(run(db, "show", "alpha-one", "abc").err, /seq must be a non-negative integer/)
  assert.equal(run(db, "--help").status, 0)
  assert.ok(!existsSync(join(root, "missing.db")), "failures never create the database")
})
