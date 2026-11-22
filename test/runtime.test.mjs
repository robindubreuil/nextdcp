import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { projectHistory } from "./support/history.ts"
import { questionRow } from "./support/question.ts"
import { WORKING_PROMPT, RECALL_DESCRIPTION, CHECKPOINT_NOW_DESCRIPTION, budgetGateNotice } from "../src/prompts.ts"
import { tokens } from "../src/tokens.ts"
import { durableTokens, latestProviderUsage, requestTokens, retainedTokens, usageScale } from "../src/estimate.ts"
import { THERMOSTAT_VERSION } from "../src/thermostat.ts"
import { memoryRpc } from "../src/memory-rpc.ts"
import { CHECKPOINT_INPUT } from "../src/checkpoint.ts"
import { createController, install } from "../src/runtime.ts"
import { createProjectStore, createStore } from "../src/store.ts"

// Node's dependency-free tests replace only Plugin.define, whose v2.3.2 implementation
// returns its argument. Live-service checks exercise the real installed SDK.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@opencode/plugin") return {
      url: `data:text/javascript,${encodeURIComponent("export const Plugin = { define: (plugin) => plugin }")}`,
      shortCircuit: true,
    }
    return next(specifier, context)
  },
})
const { setup } = await import("../src/index.ts")
hook.deregister()

class MemoryStorage {
  values = new Map()
  writes = []
  reads = []
  fail = () => false
  async get(key) { this.reads.push(key); return this.values.get(key) }
  async remove(key) { this.values.delete(key) }
  async set(key, value) {
    this.writes.push({ key, value })
    if (this.fail(key, value)) throw new Error("injected storage failure")
    this.values.set(key, value)
  }
  async scan({ prefix, after, limit = 500 }) {
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
    const page = keys.slice(0, limit)
    return { entries: page.map((key) => ({ key, value: this.values.get(key) })), ...(keys.length > limit ? { next: page.at(-1) } : {}) }
  }
}

const user = (id, text) => ({ id, type: "user", text })
const running = (id) => ({ id, type: "compaction", status: "running" })
const assistant = (id, text = "") => ({ id, type: "assistant", content: text ? [{ type: "text", text }] : [] })
const model = { providerID: "provider", id: "model" }
const event = (sessionID = "s") => ({ sessionID, model, system: [], tools: {}, messages: [] })
const completed = (id, result) => ({ id, type: "compaction", status: "completed", summary: result.summary, metadata: result.metadata })
const native = (id, summary = "Native fallback summary") => ({ id, type: "compaction", status: "completed", summary })
const location = { directory: "C:/nextdcp-test" }
const owned = (info = {}) => ({ projectID: "test", location, ...info })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function harness(options = {}, storage = new MemoryStorage()) {
  const state = {
    rows: [], prompts: [], stateless: [], compact: 0, info: { model, time: { busy: 1 } }, failAdmission: false,
    failGenerate: false, failStateless: false, hooks: new Map(),
    handoff: { archive: "Title: Continue work\nWork: preserve the exact request.", working: { objective: "Continue current work", constraints: [],
      state: [], next: ["Continue the task"], references: [] }, retiredConstraints: [] },
    models: [{ ...model, enabled: true, capabilities: { input: ["text"], output: ["text"] }, variants: [], limit: { context: 100_000, output: 8_192 } }],
    configured: undefined, warnings: [], permissions: [], tools: new Map(), rpcs: new Map(),
    agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }],
  }
  const ctx = {
    options, storage, location: { ...location, project: { id: "test" } },
    model: { list: async () => ({ data: state.models }) },
    agent: {
      get: async () => ({ data: { model: state.configured } }),
      transform: async (callback) => {
        callback({ list: () => state.agents, update: (id, update) => update(state.agents.find((agent) => agent.id === id)) })
        return { dispose: async () => {} }
      },
    },
    permission: { assert: async (input) => { state.permissions.push(input) } },
    rpc: { register: async (definition, handlers) => {
      state.rpcs.set(definition.id, handlers)
      if (definition.id === "nextdcp.model") state.rpc = handlers
      return { dispose: async () => {}, events: { emit: async (name, data) => state.warnings.push({ name, data }) } }
    } },
    session: {
      context: async () => state.rows,
      get: async () => owned(state.info),
      compact: async () => { state.compact++; if (state.failAdmission) throw new Error("admission failed"); return {} },
      generate: async ({ prompt }) => {
        state.prompts.push(prompt)
        if (state.failGenerate) throw new Error("model failed")
        return { text: JSON.stringify(state.queue?.length ? state.queue.shift() : state.handoff) }
      },
      hook: async (name, callback) => { state.hooks.set(name, callback); return { dispose: async () => {} } },
    },
    experimental: { generate: { text: async (input) => {
      state.stateless.push(input)
      if (state.failStateless) throw new Error("stateless generation failed")
      return { text: JSON.stringify(state.queue?.length ? state.queue.shift() : state.handoff) }
    } } },
    tool: { transform: async (callback) => {
      callback({ add: (definition) => { state.tools.set(definition.name, definition); if (definition.name === "recall") state.tool = definition } })
      return { dispose: async () => {} }
    } },
    event: { subscribe: () => (async function* () {})() },
  }
  return { ctx, state, storage, store: createStore(storage, "s"), controller: createController(ctx) }
}

function wideHarness(options = {}) {
  const h = harness(options)
  h.state.models[0].limit = { context: 1_050_000, input: 922_000, output: 128_000 }
  return h
}
const timed = (row, created) => ({ ...row, time: { created } })
const readStep = (id, chars, created, text = "") => timed({ id, type: "assistant", content: [
  ...(text ? [{ type: "text", text }] : []),
  { type: "tool", id: `${id}-call`, name: "read", state: { status: "completed", input: { path: id }, content: [{ type: "text", text: "r".repeat(chars) }] } },
] }, created)
// Visible conclusions plus a small acknowledged action: nothing large is unseen.
const conclusionStep = (id, created) => timed({ id, type: "assistant", content: [{ type: "text", text: "c".repeat(400) },
  { type: "tool", id: `${id}-call`, name: "edit", state: { status: "completed", input: { path: "file" }, content: [{ type: "text", text: "ok" }] } },
] }, created)

// Successful turns only record growth. A subsequent prompt consumes that boundary.
async function idle(h) {
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await h.controller.onIdle("s")
  await setImmediate()
}

const prompt = () => ({ sessionID: "s", messageID: "next", metadata: {}, prompt: { text: "continue", files: [] }, delivery: "steer" })
async function resume(h) {
  await idle(h)
  await h.controller.onPrompt(prompt())
  await setImmediate()
}

async function compactRows(h, rows) {
  h.state.rows = rows
  const item = event()
  await h.controller.onCompaction(item)
  assert.ok(item.result, "custom compaction must produce a checkpoint")
  return item.result
}

const toolContext = { sessionID: "s", agent: "build", messageID: "assistant", id: "checkpoint-1" }
const edit = (working = {}) => ({ archive: "Title: Main-authored checkpoint\nCurrent work and exact next action.", working })
const publication = (input, context = toolContext) => ({ id: context.messageID, type: "assistant", content: [
  { type: "tool", id: context.id, name: "checkpoint_now", state: { status: "running", input } },
] })
async function publishCheckpoint(h, input, observe = true, context = toolContext) {
  if (observe) await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  const row = publication(input, context)
  h.state.rows.push(row)
  const output = await h.controller.checkpointNow(input, context)
  row.content[0].state = { status: "completed", input, content: [{ type: "text", text: output }] }
  return { row, output }
}
// Build N of the budget gate: a fresh crossing arms instead of compacting, with its notice.
// Tests that run through setup() pass the registered hook as run to reach its own controller.
const armGate = async (h, run = (request) => h.controller.onContext(request)) => {
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  const before = h.state.compact
  await run(request)
  await setImmediate()
  assert.equal(h.state.compact, before, "the crossing arms the gate instead of compacting")
  assert.equal(request.system.length, 0, "the notice rides the conversation tail, not the system block")
  const notice = request.messages.at(-1)
  assert.equal(notice?.role, "user", "the notice is a trailing user-role message")
  assert.match(notice?.content?.[0]?.text ?? "", /(?:Compaction budget gate|Overdue checkpoint safeguard) — automated notice/, "attributed as an automated notice")
  assert.match(notice?.content?.[0]?.text ?? "", /Decide in THIS reply when the compaction cut lands/, "the options share one axis: when the cut lands")
}

test("compaction archives every original before generation and recall retrieves episode and call", async () => {
  const h = harness()
  h.state.rows = [user("u1", "exact user wording with archiveneedle"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "tool-1", name: "read", state: { status: "completed", input: { path: "file.ts" }, content: [{ type: "text", text: "complete output" }] } },
  ] }, running("c1")]
  const generate = h.ctx.session.generate
  h.ctx.session.generate = async (input) => {
    assert.equal((await h.store.getPending("c1")).archived, true)
    for (const row of h.state.rows.slice(0, -1)) assert.deepEqual(JSON.parse(await h.store.getRow(row.id)), row)
    assert.equal((await h.store.getCall("tool-1")).result.value, "complete output")
    return generate(input)
  }
  const compact = event()
  await h.controller.onCompaction(compact)
  assert.equal(h.state.prompts.length, 1)
  assert.ok(h.state.prompts[0].startsWith(WORKING_PROMPT))
  assert.match(compact.result.summary, /^## Current working state/)
  assert.match(compact.result.summary, /Archive through E1/)
  assert.deepEqual(compact.result.metadata, { keepID: null, nextdcp: { version: 2, author: "compactor" } }, "no verbatim host tail duplicates the working state")
  assert.equal(compact.result.native, undefined)
  assert.deepEqual((await h.store.getCheckpoint("c1")).episode.rowIDs, ["u1", "a1"])

  h.state.rows = [completed("c1", compact.result), user("live", "currentcontextneedle")]
  assert.match(await h.controller.recall("s", { id: "E1" }), /exact user wording with archiveneedle/)
  assert.match(await h.controller.recall("s", { id: "tool-1" }), /file\.ts[\s\S]*complete output/)
  assert.match(await h.controller.recall("s", { query: "archiveneedle" }), /recall id=E1 page 1/)
  assert.match(await h.controller.recall("s", { query: "currentcontextneedle" }), /No matching/)
  assert.match(await h.controller.recall("s", { id: "E1", query: "x" }), /either id or query/)
  assert.match(await h.controller.recall("s", { id: "E1", page: 0 }), /positive safe integer/)
})

test("episode-scoped queries include only that episode's dialogue, notes, call and row originals", async () => {
  const h = harness()
  const rows = (suffix) => [
    { ...user(`u-${suffix}`, `episcope dialogue ${suffix} ${suffix.toUpperCase()}_SCOPE_ONLY`), skills: [{ name: "scope", text: `episcope injected ${suffix}` }] },
    { id: `a-${suffix}`, type: "assistant", content: [{ type: "tool", id: `call-${suffix}`, name: "read", state: {
      status: "completed", input: { path: `${suffix}.ts` }, content: [{ type: "text", text: `episcope tool original ${suffix}` }],
    } }] },
    { id: `shell-${suffix}`, type: "shell", command: "test", output: { output: `episcope shell original ${suffix}` } },
  ]
  h.state.handoff.archive = "Title: First scoped task\nepiscope first archive note"
  const first = await compactRows(h, [...rows("first"), running("c1")])
  h.state.handoff.archive = "Title: Second scoped task\nepiscope second archive note"
  const second = await compactRows(h, [completed("c1", first), ...rows("second"), running("c2")])
  h.state.rows = [completed("c2", second)]
  await h.store.saveCall({ id: "outside-only", name: "read", input: {}, result: { type: "text", value: "episcope orphan original" } })
  await createProjectStore(h.storage, "test").graduate(await h.store.episodeNotes(), "other-session")
  h.storage.reads.length = 0

  const conversation = await h.controller.recall("s", { query: "episcope", episode: "E1" })
  assert.match(conversation, /Historical evidence in E1, page 1 of 1 \(1 hit\)/)
  assert.match(conversation, /- recall id=E1 page 1:/)
  const tools = await h.controller.recall("s", { query: "episcope", episode: "E1", layer: "tools" })
  for (const id of ["call-first", "u-first", "shell-first"]) assert.ok(tools.includes(`recall id=${id} page 1`))
  assert.doesNotMatch(tools, /call-second|shell-second|outside-only|recall P\d/)
  const full = (await Promise.all([1, 2].map((page) => h.controller.recall("s", { query: "episcope", episode: "E1", layer: "full", page })))).join("\n")
  assert.match(full, /recall id=catalog E1 page 1 \(archive note/)
  assert.doesNotMatch(full, /call-second|shell-second|outside-only|(recall id=)?P\d page|(recall id=)?E2 page/)
  assert.ok(!h.storage.reads.some((key) => key.startsWith("projects/test/episodes")), "an episode-scoped query never loads project-wide graduated notes")
  assert.match(await h.controller.recall("s", { query: "SECOND_SCOPE_ONLY", episode: "E2" }), /recall id=E2 page 1/)
  assert.match(await h.controller.recall("s", { query: "SECOND_SCOPE_ONLY", episode: "E1" }), /No matching snippets/, "a scoped miss never widens silently")
  assert.match(await h.controller.recall("s", { query: "SECOND_SCOPE_ONLY" }), /recall id=E2 page 1/, "scoping never mutates the shared corpus")

  assert.match(await h.controller.recall("s", { id: "E1", episode: "E1" }), /episode applies only to a query/)
  for (const episode of ["", "E", "E0", "E-1", "E1 layer tools", 1]) assert.match(await h.controller.recall("s", { query: "episcope", episode }), /exact episode label/)
  assert.match(await h.controller.recall("s", { query: "episcope", episode: "E999" }), /No episode "E999" in the active archive/)
  h.state.rows = [completed("c1", first)]
  assert.match(await h.controller.recall("s", { query: "episcope", episode: "E2", layer: "full" }), /No episode "E2" in the active archive/, "a reverted episode cannot masquerade as an active scope")
})

test("catalog listings are compact and paged on demand; an entry note fetches whole like any original", async () => {
  const h = harness()
  h.state.handoff.archive = "Title: Alpha title\nalpha archive note"
  h.state.rows = [user("u1", "first work"), running("c1")]
  const first = event()
  await h.controller.onCompaction(first)
  h.state.handoff.archive = "Title: Beta title\nbeta archive note"
  h.state.rows = [completed("c1", first.result), user("u2", "second work"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  h.state.rows = [completed("c1", first.result), user("u2", "second work"), completed("c2", second.result)]

  const compact = await h.controller.recall("s", { id: "catalog" })
  assert.match(compact, /recall id=catalog page 1 \(page 1 of 1\)/, "listings return one page per call, never a whole dump")
  assert.ok(compact.includes("\nE2 — Beta title") && compact.includes("\nE1 — Alpha title"), "one labeled line per entry")
  assert.ok(compact.indexOf("\nE2") < compact.indexOf("\nE1"), "newest first")
  assert.doesNotMatch(compact, /archive note/, "compact lines carry no note bodies")
  const all = await h.controller.recall("s", { id: "catalog all" })
  assert.match(all, /alpha archive note/, "the all view carries every note")
  assert.match(all, /beta archive note/)
  const entry = await h.controller.recall("s", { id: "catalog E1" })
  assert.match(entry, /recall id=catalog E1 \(whole output\)/)
  assert.match(entry, /alpha archive note/)
  assert.doesNotMatch(entry, /beta archive note/, "an entry label is exact")
  assert.match(await h.controller.recall("s", { id: "catalog E9" }), /No catalog entry "E9"/)

  const empty = harness()
  assert.match(await empty.controller.recall("s", { id: "catalog" }), /Nothing is archived yet/)
})

test("the checkpoint summary titles the new episode from its Title line", async () => {
  const h = harness()
  h.state.handoff.archive = "Title: Recall fixes\nWork: preserve the exact request."
  const result = await compactRows(h, [user("u1", "original words"), running("c1")])
  assert.match(result.summary, /Archive through E1 \(Recall fixes\): older tasks/)
  assert.doesNotMatch(result.summary, /Work: preserve/)
})

test("repeated evidence across episodes collapses in search with fetchable locations", async () => {
  const h = harness()
  const shared = "consent then several filler words pass before the window closes"
  const first = await compactRows(h, [user("u1", `first three words ${shared} one tail here`), running("c1")])
  const second = await compactRows(h, [completed("c1", first), user("u2", `other three words ${shared} two tails there`), running("c2")])
  h.state.rows = [completed("c2", second), user("live", "x")]
  const found = await h.controller.recall("s", { query: "consent window" })
  assert.match(found, /\(also (E1|E2) page 1\)/)
  assert.equal(found.split("\n").filter((line) => line.startsWith("- recall ")).length, 1)
})

test("archived recall output never outranks the evidence it quotes", async () => {
  const h = harness()
  const echoed = "freshechoedneedle appears inside an archived recall result"
  const first = await compactRows(h, [user("u1", "session context"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "call-echo", name: "recall", state: { status: "completed", input: { query: "x" },
      content: [{ type: "text", text: `Historical evidence, page 1\n- recall {"id":"E1","page":1}: ${echoed}` }] } },
  ] }, running("c1")])
  h.state.rows = [completed("c1", first), user("live", "x")]
  assert.match(await h.controller.recall("s", { query: "freshechoedneedle" }), /No matching snippets\. Try broader keywords/)
  assert.match(await h.controller.recall("s", { query: "freshechoedneedle", layer: "full" }), /No matching snippets\. Try broader keywords/, "an echo never ranks, at any depth")
  assert.match(await h.controller.recall("s", { id: "E1", layer: "tools" }), /freshechoedneedle/, "the echo stays fetchable in the transcript")
  assert.match(await h.controller.recall("s", { id: "nope" }), /Try a query search by content instead/)
  const found = await h.controller.recall("s", { query: "session context" })
  assert.match(found, /page 1 of 1 \(1 hit\)/)
})

test("archive-note hits show the note itself, not a fetch call that cannot reproduce it", async () => {
  const h = harness()
  h.state.handoff.archive = "Title: Completed work\nnotekeyword recorded in the cold archive note."
  const first = await compactRows(h, [user("u1", "some context"), running("c1")])
  h.state.rows = [completed("c1", first), user("live", "x")]
  const found = await h.controller.recall("s", { query: "notekeyword", layer: "full" })
  assert.match(found, /- recall id=catalog E1 page 1 \(archive note, not original evidence\):/)
  assert.doesNotMatch(found, /- recall \{/, "no call that would fetch different content")
  assert.match(found, /page 1 of 1 \(1 hit\)/)
  assert.match(await h.controller.recall("s", { id: "catalog E1 page 1" }), /notekeyword recorded in the cold archive note/, "the rendered target fetches the note, not a different transcript")
})

test("injected content homes in row originals and stays out of conversation search", async () => {
  const h = harness()
  const skillBody = Array.from({ length: 80 }, (_, index) => `companion directive ${index} for the bench phone camera`).join("\n")
  const first = await compactRows(h, [
    { id: "u1", type: "user", text: "activate the skill", skills: [{ name: "companion", text: skillBody }] },
    running("c1"),
  ])
  h.state.rows = [completed("c1", first), user("live", "x")]
  assert.match(await h.controller.recall("s", { query: "directive bench camera", layer: "conversation" }), /No matching snippets/, "the dialogue home carries only the tag")
  const hit = await h.controller.recall("s", { query: "directive bench camera", layer: "tools" })
  assert.match(hit.split("\n")[1], /^- recall id=u1 page 1:/, "the skill body's search home is its row original")
  const fetched = await h.controller.recall("s", { id: "u1" })
  assert.match(fetched, /\[Skill activated: companion\]\ncompanion directive 0 /)
  assert.match(fetched, /companion directive 42/)
  assert.ok(!fetched.includes("activate the skill"), "the user's words stay in the conversation home")
  assert.match(await h.controller.recall("s", { id: "x".repeat(2_500) }), /^Use an id of at most 2,000 characters/)
})

test("a corrupt archived row and an out-of-range page return plain content, never a tool failure", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "episode wording"), running("c1")])
  h.state.rows = [completed("c1", first), user("live", "x")]
  await h.storage.set("sessions/s/rows/u1", "corrupt not json {")
  assert.equal(await h.controller.recall("s", { id: "u1" }), "recall id=u1 (whole output)\n[Invalid archived row; recall gap]")
  assert.match(await h.controller.recall("s", { id: "E1" }), /Invalid archived row; recall gap/, "the episode transcript discloses the gap the same way")
  assert.equal(await h.controller.recall("s", { id: "E1", page: 99 }), "recall id=E1 page 99 is out of range: this original has 1 page; the last page is 1.")
  assert.match(await h.controller.recall("s", { query: "wording" }), /No matching snippets/, "search skips the unreadable row without failing")
})

test("exact call and row fetches read only their originals and referenced calls, not the archive or project notes", async () => {
  const h = harness()
  await h.store.saveCall({ id: "call-good", name: "read", input: {}, result: { type: "text", value: "exact_call_needle" } })
  await h.storage.set("sessions/s/rows/msg-good", JSON.stringify({ id: "msg-good", type: "assistant", content: [{ type: "tool", id: "call-good", name: "read", state: {
    status: "completed", input: {}, content: [{ type: "text", text: "not the authoritative first original" }],
  } }] }))
  await h.storage.set("sessions/s/calls/unrelated-corrupt", "not json")
  h.ctx.session.get = async () => { throw new Error("ownership is unavailable") }
  h.ctx.session.context = async () => { throw new Error("context is unavailable") }
  h.storage.scan = async () => { throw new Error("an exact original must not scan") }
  h.storage.reads.length = 0
  assert.match(await h.controller.recall("s", { id: "call-good" }), /exact_call_needle/)
  assert.match(await h.controller.recall("s", { id: "msg-good" }), /exact_call_needle/)
  assert.ok(h.storage.reads.every((key) => ["deleted/s", "sessions/s/calls/call-good", "sessions/s/calls/msg-good", "sessions/s/rows/msg-good"].includes(key)), "only the requested originals and the deletion fence are read")
})

test("an exact graduated-note fetch reads its own project record without scanning unrelated originals", async () => {
  const h = harness()
  await createProjectStore(h.storage, "test").graduate([{ note: "direct_graduated_note_needle", end: 1_000 }], "origin")
  await h.storage.set("projects/test/episodes/P2", "not json")
  h.storage.scan = async () => { throw new Error("an exact project original must not scan") }
  assert.match(await h.controller.recall("s", { id: "P1" }), /direct_graduated_note_needle/)
})

test("corrupt calls do not poison exact, prefix, episode, query or graduated-note recall", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  const first = await compactRows(h, [user("u1", "intact_conversation_needle"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "call-good", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "intact_tool_needle" }] } },
  ] }, running("c1")])
  h.state.rows = [completed("c1", first)]
  await createProjectStore(h.storage, "test").graduate([{ note: "intact_project_needle", end: Date.now() }], "origin")
  for (const bad of ["not json", JSON.stringify({ id: "call-bad", name: "read" })]) {
    await h.storage.set("sessions/s/calls/call-bad", bad)
    const reloaded = createController(h.ctx)
    assert.match(await reloaded.recall("s", { id: "call-good" }), /intact_tool_needle/)
    assert.match(await reloaded.recall("s", { id: "call-go" }), /intact_tool_needle/)
    assert.match(await reloaded.recall("s", { id: "call-" }), /Ambiguous target/, "corrupt matching IDs still participate in ambiguity checks")
    assert.match(await reloaded.recall("s", { id: "call-bad" }), /Recall unavailable: Invalid/)
    assert.match(await reloaded.recall("s", { id: "E1" }), /intact_conversation_needle/)
    assert.match(await reloaded.recall("s", { id: "E1", layer: "tools" }), /intact_tool_needle/)
    assert.match(await reloaded.recall("s", { query: "intact_tool_needle", layer: "tools" }), /recall id=call-good page 1/)
    assert.match(await reloaded.recall("s", { id: "P1" }), /intact_project_needle/)
  }
})

test("the search corpus is cached per checkpoint: warm queries rescan nothing, a new cut rebuilds it fresh", async () => {
  const h = harness()
  let scans = 0
  const scan = h.storage.scan.bind(h.storage)
  h.storage.scan = async (options) => { scans++; return scan(options) }
  const first = await compactRows(h, [user("u1", "firstcacheneedle wording"), running("c1")])
  h.state.rows = [completed("c1", first), user("live", "x")]
  assert.match(await h.controller.recall("s", { query: "firstcacheneedle" }), /recall id=E1 page 1/)
  const cold = scans
  assert.ok(cold > 0, "the cold query scans calls and rows")
  assert.match(await h.controller.recall("s", { query: "firstcacheneedle" }), /recall id=E1 page 1/, "the warm query still answers")
  assert.equal(scans, cold, "a warm query at the same checkpoint rescans nothing")
  const second = await compactRows(h, [completed("c1", first), user("u2", "secondcacheneedle wording"), running("c2")])
  h.state.rows = [completed("c1", first), user("u2", "secondcacheneedle wording"), completed("c2", second)]
  assert.match(await h.controller.recall("s", { query: "secondcacheneedle" }), /recall id=E2 page 1/, "the rebuilt corpus sees the new episode")
  assert.ok(scans > cold, "a new checkpoint invalidates the cache and rebuilds the corpus")
})

test("deleted sessions graduate their episode notes into the project archive; a fresh session searches and fetches them", async () => {
  const h = harness()
  await compactRows(h, [user("u1", "needle wording"), running("c1")])
  await h.controller.onDeleted("s")
  const graduatedKeys = [...h.storage.values.keys()].filter((key) => key.startsWith("projects/test/episodes/"))
  assert.deepEqual(graduatedKeys, ["projects/test/episodes/P1"], "the episode note graduated exactly once")
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")), "the session archive is still cleared")
  assert.deepEqual(JSON.parse(h.storage.values.get("projects/test/episodes/P1")), { id: "P1", note: "Continue work\nWork: preserve the exact request.", session: "s", end: JSON.parse(h.storage.values.get("projects/test/episodes/P1")).end })

  const fresh = harness({}, h.storage)
  assert.match(await fresh.controller.recall("fresh", { query: "preserve the exact request", layer: "full" }),
    /- recall id=P1 page 1 \(graduated session note, s, 0s ago\): /, "the full layer surfaces the graduated note as a fetchable hit")
  assert.match(await fresh.controller.recall("fresh", { query: "preserve the exact request" }),
    /Nothing is archived to search yet/, "layer-scoped queries never load graduated notes: they have no home")
  const fetched = await fresh.controller.recall("fresh", { id: "P1" })
  assert.match(fetched, /Graduated session note P1 \(from session s\)/, "an opaque fetch returns the note with its stable provenance header")
  assert.match(fetched, /preserve the exact request/, "the whole note text is the original")
  assert.match(await fresh.controller.recall("fresh", { id: "catalog" }), /Nothing is archived yet/, "the catalog still lists episodes only, never P entries")
})

test("graduated-note search addresses fetch the same page across a changing relative age", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000 })
  const h = harness()
  await createProjectStore(h.storage, "test").graduate([{ note: `${"filler ".repeat(854)} boundary_note_needle ${"tail ".repeat(1_500)}`, end: 1_000 }], "origin")
  const hits = await h.controller.recall("s", { query: "boundary_note_needle", layer: "full" })
  const target = /- recall id=(P1 page \d+)/.exec(hits)?.[1]
  assert.ok(target)
  const before = await h.controller.recall("s", { id: target })
  assert.match(before, /boundary_note_needle/, "the search result lands on the page containing the match")
  t.mock.timers.tick(86_400_000)
  assert.equal(await h.controller.recall("s", { id: target }), before, "fetched page bytes are independent of relative age")
})

test("graduation ranks a recent note above an equally matching stale one", async () => {
  const day = 86_400_000, stale = Date.now() - 40 * day, recent = Date.now()
  const h = harness()
  h.state.queue = [
    { archive: "Title: Gauge\nWork: gauge needle one", working: h.state.handoff.working, retiredConstraints: [] },
    { archive: "Title: Gauge\nWork: gauge needle two", working: h.state.handoff.working, retiredConstraints: [] },
  ]
  const first = await compactRows(h, [{ id: "u1", type: "user", text: "task", time: { created: stale } }, running("c1")])
  await compactRows(h, [completed("c1", first), { id: "u2", type: "user", text: "task", time: { created: recent } }, running("c2")])
  await h.controller.onDeleted("s")
  const fresh = harness({}, h.storage)
  const hits = await fresh.controller.recall("fresh", { query: "gauge needle", layer: "full" })
  assert.match(hits, /- recall id=P2 page 1 \(graduated session note, s, 0s ago\)/, "the recent note outranks the equal term match")
  assert.match(hits, /- recall id=P1 page 1 \(graduated session note, s, /, "the stale note still matches, just below")
  assert.ok(hits.indexOf("recall id=P2") < hits.indexOf("recall id=P1"), "recency ordering is strict")
})

test("subagent sessions never graduate their notes into the project archive", async () => {
  const sub = harness()
  sub.state.info = { model, time: { busy: 1 }, parentID: "parent-session" }
  await compactRows(sub, [user("u1", "needle wording"), running("c1")])
  // The session is gone at deletion time: only the stashed flag can identify the subagent.
  sub.ctx.session.get = async () => { throw new Error("session deleted") }
  await sub.controller.onDeleted("s")
  assert.ok(![...sub.storage.values.keys()].some((key) => key.startsWith("projects/test/episodes/")), "a subagent's episodes never graduate")
  const parent = harness()
  await compactRows(parent, [user("u1", "needle wording"), running("c1")])
  parent.ctx.session.get = async () => { throw new Error("session deleted") }
  await parent.controller.onDeleted("s")
  assert.ok(parent.storage.values.has("projects/test/episodes/P1"), "persisted ownership survives the session disappearing")
})

test("graduation storage failures never block the deletion", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  const h = harness()
  h.storage.fail = (key) => key.startsWith("projects/test/episodes/")
  await compactRows(h, [user("u1", "needle wording"), running("c1")])
  await h.controller.onDeleted("s")
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")), "the session archive is cleared regardless")
  assert.ok(warnings.mock.calls.some((call) => String(call.arguments[0]).includes("graduate session notes")), "the failure is reported")
})

test("forks retain episode IDs and originals, branch independently, and survive parent deletion/reload", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "parent original uniqueparent"), running("c1")])
  const checkpoint = completed("c1", first)
  const sessions = new Map([["s", [checkpoint, user("future", "parent work after the fork boundary")]], ["child", [{ ...checkpoint, id: "copied-c1" }, user("child-u", "child-specific original")]]])
  const infos = new Map([["s", {}], ["child", { fork: { sessionID: "s", boundary: { type: "through", messageID: "c1" } } }]])
  h.ctx.session.context = async ({ sessionID }) => sessions.get(sessionID)
  h.ctx.session.get = async ({ sessionID }) => {
    if (!infos.has(sessionID)) throw new Error("parent deleted")
    return owned(infos.get(sessionID))
  }
  await h.controller.onFork("child")
  assert.equal((await createStore(h.storage, "child").getCheckpoint("copied-c1")).episode.id, "E1")
  assert.match(await h.controller.recall("child", { id: "E1" }), /parent original uniqueparent/)
  sessions.get("child").push(running("c2"))
  const second = event("child")
  await h.controller.onCompaction(second)
  assert.match(second.result.summary, /Archive through E2/)
  sessions.set("child", [completed("c2", second.result)])
  assert.match(await h.controller.recall("child", { id: "E2" }), /child-specific original/)
  assert.match(await h.controller.recall("s", { id: "E2" }), /No matching/)
  await h.controller.onDeleted("s")
  sessions.delete("s")
  infos.delete("s")
  const reloaded = createController(h.ctx)
  assert.match(await reloaded.recall("child", { id: "E1" }), /parent original uniqueparent/)
  infos.set("grandchild", { fork: { sessionID: "child", boundary: { type: "through", messageID: "c2" } } })
  sessions.set("grandchild", sessions.get("child").map((row) => ({ ...row, id: `grandchild-${row.id}` })))
  await reloaded.onFork("grandchild")
  assert.match(await reloaded.recall("grandchild", { id: "E1" }), /parent original uniqueparent/)
  assert.match(await reloaded.recall("grandchild", { id: "E2" }), /child-specific original/)
})

test("ordinary subagents do not inherit archives and cyclic fork ancestry fails safely", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u", "parent-only original"), running("cp")])
  h.state.rows = [completed("cp", first)]
  h.ctx.session.get = async ({ sessionID }) => owned(sessionID === "subagent" ? { parentID: "s" }
    : { fork: { sessionID: sessionID === "cycle-a" ? "cycle-b" : "cycle-a", boundary: { type: "through", messageID: "cp" } } })
  assert.match(await h.controller.recall("subagent", { id: "E1" }), /Recall gap/)
  const reloaded = createController(h.ctx)
  assert.match(await reloaded.recall("cycle-a", { id: "E1" }), /Cyclic fork ancestry/)
})

test("first use of an existing fork imports its inherited checkpoint without replacing newer native work", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u", "inherited original"), running("parent-cp")])
  const parent = completed("parent-cp", first)
  const child = [{ ...parent, id: "copied-cp" }, user("child-u", "newer child work"), native("child-native", "child's own summary")]
  h.ctx.session.get = async ({ sessionID }) => owned(sessionID === "s" ? {} : { fork: { sessionID: "s", boundary: { type: "through", messageID: "parent-cp" } } })
  h.ctx.session.context = async ({ sessionID }) => sessionID === "s" ? [parent] : child
  assert.match(await h.controller.recall("existing-child", { id: "E1" }), /inherited original/)
  const store = createStore(h.storage, "existing-child")
  const adopted = await store.getCheckpoint("child-native")
  assert.equal(adopted.parent, "copied-cp")
  assert.equal(adopted.episode.id, "E2")
  assert.equal(adopted.episode.summary, "child's own summary")
  assert.match(String(h.storage.values.get("sessions/existing-child/model/warning") ?? ""), /without a nextdcp handoff/,
    "a native row the plugin never hooked reports the possible recall gap")
})

test("historical forks recover their boundary from the archive after the parent compacts again", async () => {
  const h = harness()
  const tool = { id: "a1", type: "assistant", content: [{ type: "tool", id: "old-call", name: "read",
    state: { status: "completed", input: { path: "original.ts" }, content: [{ type: "text", text: "original tool output" }] } }] }
  const first = await compactRows(h, [user("u1", "inherited original"), tool, running("c1")])
  const c1 = completed("c1", first)
  const second = await compactRows(h, [c1, user("u2", "parent future must not leak"), running("c2")])
  const sessions = new Map([["s", [completed("c2", second)]], ["child", [{ ...c1, id: "copied-c1" }]]])
  h.ctx.session.context = async ({ sessionID }) => sessions.get(sessionID)
  h.ctx.session.get = async ({ sessionID }) => owned(sessionID === "s" ? {} : {
    fork: { sessionID: "s", boundary: { type: "before", messageID: "u2" } },
  })
  await h.controller.onFork("child")
  assert.match(await h.controller.recall("child", { id: "E1" }), /inherited original/)
  assert.match(await h.controller.recall("child", { id: "old-call" }), /original tool output/)
  assert.match(await h.controller.recall("child", { query: "future" }), /No matching/)
  sessions.get("child").push(user("new", "child work"), running("child-cp"))
  const item = event("child")
  await h.controller.onCompaction(item)
  assert.match(item.result.summary, /Archive through E3/)
  sessions.set("child", [completed("child-cp", item.result)])
  await h.controller.onDeleted("s")
  sessions.delete("s")
  assert.match(await createController(h.ctx).recall("child", { id: "E1" }), /inherited original/)
})

test("an inheritance or context failure does not hide a locally archived call", async () => {
  const h = harness()
  await h.store.saveCall({ id: "local-call", name: "read", input: {}, result: { type: "text", value: "safe local original" } })
  h.state.info = { fork: { sessionID: "missing-parent", boundary: { type: "through", messageID: "missing" } } }
  assert.match(await h.controller.recall("s", { id: "local-call" }), /safe local original/)
  h.ctx.session.context = async () => { throw new Error("context unavailable") }
  assert.match(await h.controller.recall("s", { id: "local-call" }), /safe local original/)
})

test("forking a checkpoint hidden by a revert does not require a later compaction", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "REVERTED_CHECKPOINT_ORIGINAL"), {
    id: "a1", type: "assistant", content: [{ type: "tool", id: "reverted-call", name: "read", state: {
      status: "completed", input: { path: "original" }, content: [{ type: "text", text: "REVERTED_CALL_ORIGINAL" }],
    } }],
  }, running("c1")])
  // No later cut has saved the completed native row before the host reverts.
  assert.equal(await h.store.getRow("c1"), undefined)
  h.state.rows = [user("new-branch", "unrelated branch after revert")]
  const childRows = [completed("copied-c1", first)]
  h.ctx.session.context = async ({ sessionID }) => sessionID === "child" ? childRows : h.state.rows
  h.ctx.session.get = async ({ sessionID }) => owned(sessionID === "child" ? { fork: { sessionID: "s", boundary: { type: "through", messageID: "c1" } } } : {})
  await h.controller.onFork("child")
  assert.match(await h.controller.recall("child", { id: "E1" }), /REVERTED_CHECKPOINT_ORIGINAL/)
  assert.match(await h.controller.recall("child", { id: "reverted-call" }), /REVERTED_CALL_ORIGINAL/)
})

test("native media survives archived recall, transcript caching, and the installed tool result", async () => {
  const h = harness()
  const media = { type: "file", uri: "data:image/png;base64,AAAA", mime: "image/png", name: "tool.png" }
  const first = await compactRows(h, [{ ...user("u", "image question"), files: [{ mime: "application/pdf", name: "user.pdf", data: "BBBB", source: { type: "inline" } }] },
    { id: "a", type: "assistant", content: [{ type: "tool", id: "media-call", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "image result" }, media] } }] }, running("cp")])
  h.state.rows = [completed("cp", first)]
  const call = await h.controller.recall("s", { id: "media-call" })
  assert.deepEqual(call.slice(1), [media])
  const episode = await h.controller.recall("s", { id: "E1", layer: "full" })
  assert.deepEqual(episode.slice(1).map((part) => part.mime), ["application/pdf", "image/png"])
  assert.doesNotMatch(episode[0].text, /base64|AAAA|BBBB/)
  assert.deepEqual(await h.controller.recall("s", { id: "E1", layer: "full" }), episode, "cache retains native attachments")
  const cleanup = await setup(h.ctx)
  try {
    assert.deepEqual((await h.state.tool.execute({ id: "media-call" }, { sessionID: "s" })).content, call)
  } finally { cleanup() }
})

test("failure to write the pending boundary falls back natively with a gap", async () => {
  const h = harness()
  h.state.rows = [user("u1", "important original"), running("c1")]
  h.storage.fail = (key) => key.endsWith("/pending/c1")
  const first = event()
  await h.controller.onCompaction(first)
  assert.equal(first.result, undefined)
  assert.equal(h.state.prompts.length, 0)
  h.storage.fail = () => false
  h.state.rows = [native("c1"), user("u2", "later work"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  assert.match(second.result.summary, /Some original history was not archived/)
  assert.match(second.result.summary, /Archive through E2/)
  const adopted = await h.store.getCheckpoint("c1")
  assert.equal(adopted.parent, null)
  assert.equal(adopted.episode.gap, true)
  assert.deepEqual(adopted.episode.rowIDs, ["u1"])
  h.state.rows = [completed("c2", second.result)]
  assert.match(await h.controller.recall("s", { id: "E1" }), /recall gap/)
})

test("a failed archive item records a gap but does not block the custom episode", async () => {
  const h = harness()
  h.state.rows = [user("u1", "cannot archive"), user("u2", "retained original"), running("c1")]
  h.storage.fail = (key) => key.endsWith("/rows/u1")
  const compact = event()
  await h.controller.onCompaction(compact)
  assert.match(compact.result.summary, /Some original history was not archived/)
  assert.equal(h.state.prompts.length, 1)
  assert.ok(h.state.prompts[0].startsWith(WORKING_PROMPT))
  assert.equal((await h.store.getPending("c1")).archived, false)
  assert.equal((await h.store.getCheckpoint("c1")).episode.gap, true)
  h.storage.fail = () => false
  h.state.rows = [completed("c1", compact.result)]
  const recalled = await h.controller.recall("s", { id: "E1" })
  assert.match(recalled, /Unavailable archived row; recall gap/)
  assert.match(recalled, /retained original/)
})

test("model failure leaves the native fallback fully archived and preserves the previous branch", async () => {
  const h = harness()
  h.state.rows = [user("u1", "archived first"), running("c1")]
  h.state.failGenerate = true
  const first = event()
  await h.controller.onCompaction(first)
  assert.equal(first.result, undefined)
  assert.equal((await h.store.getPending("c1")).archived, true)
  h.state.failGenerate = false
  h.state.rows = [native("c1"), user("u2", "next"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  assert.match(second.result.summary, /Current working state/)
  assert.doesNotMatch(second.result.summary, /Native fallback summary/)
  assert.doesNotMatch(second.result.summary, /recall gap/)
  assert.equal((await h.store.getCheckpoint("c1")).episode.gap, undefined)
})

test("an empty handoff leaves native compaction in control and keeps the archive", async () => {
  const h = harness()
  h.state.rows = [user("u1", "important context"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "tool-1", name: "read", state: { status: "completed", input: { path: "file.ts" }, content: [{ type: "text", text: "original output" }] } },
  ] }, running("c1")]
  h.ctx.session.generate = async () => ({ text: "  \n" })
  const compact = event()
  await h.controller.onCompaction(compact)
  assert.equal(compact.result, undefined)
  assert.equal((await h.store.getPending("c1")).archived, true)
  assert.equal(JSON.parse(await h.store.getRow("u1")).text, "important context")
  assert.equal((await h.store.getCall("tool-1")).result.value, "original output")
  assert.equal(await h.store.getCheckpoint("c1"), undefined)
})

test("revert follows only the active working-state chain; old evidence remains retrievable", async () => {
  const h = harness()
  const compact = async (rows) => { h.state.rows = rows; const item = event(); await h.controller.onCompaction(item); assert.ok(item.result); return item.result }
  const first = await compact([user("u1", "firstbranchneedle"), running("c1")])
  const c1 = completed("c1", first)
  const second = await compact([c1, user("u2", "abandonedbranchneedle"), running("c2")])
  assert.match(second.summary, /Archive through E2/)
  const c2 = completed("c2", second)
  h.state.rows = [c2]
  assert.match(await h.controller.recall("s", { id: "E1" }), /firstbranchneedle/)
  assert.match(await h.controller.recall("s", { id: "E2" }), /abandonedbranchneedle/)

  const third = await compact([c1, user("u3", "activebranchneedle"), running("c3")])
  assert.doesNotMatch(third.summary, /E2/)
  assert.equal((await h.store.getCheckpoint("c3")).parent, "c1")
  h.state.rows = [completed("c3", third)]
  assert.match(await h.controller.recall("s", { query: "abandonedbranchneedle" }), /No matching snippets/)
  assert.match(await h.controller.recall("s", { id: "E2" }), /No matching episode/)
  assert.match(await h.controller.recall("s", { query: "activebranchneedle" }), /recall id=E3 page 1/)
})

const cheap = { providerID: "memory-provider", id: "cheap/model", variant: "light" }
function addCheap(h) {
  h.state.models.push({ ...cheap, name: "Cheap", enabled: true, capabilities: { input: ["text"], output: ["text"] }, variants: [{ id: "light" }], limit: { context: 200_000, output: 8_192 } })
}
const errorContext = { error: (code, message) => ({ code, message }) }
async function saveModel(h, preference, sessionID = "s") {
  await h.controller.registerModels()
  return h.state.rpc.set({ sessionID, preference }, errorContext)
}

test("an invalid handoff is repaired once by the main model, carrying the exact failure", async () => {
  const h = harness()
  const valid = h.state.handoff
  h.state.queue = [{ ...valid, archive: "no title line" }, { ...valid, archive: "Title: Repaired\nfixed note" }]
  const result = await compactRows(h, [user("u1", "some words"), running("c1")])
  assert.match(result.summary, /Archive through E1 \(Repaired\): older tasks/)
  assert.equal(h.state.prompts.length, 2)
  assert.doesNotMatch(h.state.prompts[0], /previous attempt failed/)
  assert.match(h.state.prompts.at(-1), /previous attempt failed: Archive note must begin with a 'Title: <episode name>' line/)
})

test("a separate compaction model's drifted handoff falls back to the main model with the exact failure", async () => {
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  h.state.queue = [{ ...h.state.handoff, archive: "Title: 修复标签\n中文笔记。" }]
  const result = await compactRows(h, [user("u1", "english words"), running("c1")])
  assert.match(result.summary, /Archive through E1 \(Continue work\): older tasks/)
  assert.equal(h.state.stateless.length, 1)
  assert.equal(h.state.prompts.length, 1)
  assert.match(h.state.prompts[0], /previous attempt failed: Archive note must stay in the language/)
  assert.ok(h.state.warnings.some((item) => String(item.data?.message ?? "").includes("Cannot produce a handoff")))
})

test("a CJK task continues through generated and main-authored checkpoints with no new user row", async () => {
  const h = harness()
  h.state.handoff = { archive: "Title: 修复历史记录\n调查并修复了对话层污染问题。", working: {
    objective: "调查并修复对话层污染问题", constraints: [], state: ["已验证问题"], next: ["继续测试"], references: [],
  }, retiredConstraints: [] }
  const first = await compactRows(h, [user("u1", "请调查并修复对话层污染问题。"), running("c1")])
  h.state.handoff = { archive: "Title: 验证修复\n继续验证修复结果。", working: {}, retiredConstraints: [] }
  const second = await compactRows(h, [completed("c1", first), assistant("a2", "继续验证修复结果。"), running("c2")])
  assert.match(second.summary, /调查并修复对话层污染问题/)
  assert.equal(h.state.prompts.length, 2, "the inherited-language patch succeeds on its first attempt")
  h.state.rows = [completed("c2", second), assistant("a3", "测试已通过。")]
  const input = { archive: "Title: 测试通过\n所有测试已通过。", working: { next: ["提交修复"] } }
  assert.match((await publishCheckpoint(h, input)).output, /Prepared:/)
  h.state.rows.push(running("c3"))
  const cut = event()
  await h.controller.onCompaction(cut)
  assert.equal(cut.result?.metadata.nextdcp.author, "main")
  assert.match(cut.result.summary, /提交修复/)
  assert.equal(h.state.prompts.length, 2, "revalidation of a main-authored continuation needs no generation")
})

test("native CJK summaries support generated and main-authored full checkpoints without a new user row", async (t) => {
  t.mock.method(console, "warn", () => {})
  for (const author of ["compactor", "main"]) {
    const h = harness()
    h.state.handoff = { archive: "Title: 验证修复\n继续验证修复结果。", working: {
      objective: "调查并修复对话层污染问题", constraints: [], state: ["已验证问题"], next: ["继续测试"], references: [],
    }, retiredConstraints: [] }
    h.state.rows = [native("prior", "调查并修复对话层污染问题。"), assistant("a1", "继续验证修复结果。")]
    if (author === "main") assert.match((await publishCheckpoint(h, { archive: h.state.handoff.archive, working: h.state.handoff.working })).output, /Prepared:/)
    h.state.rows.push(running("c1"))
    const cut = event()
    await h.controller.onCompaction(cut)
    assert.equal(cut.result?.metadata.nextdcp.author, author)
    assert.match(cut.result.summary, /调查并修复对话层污染问题/)
    assert.equal(h.state.prompts.length, author === "main" ? 0 : 1, "native-language continuation never retries or falls back")
  }
})

test("an over-budget handoff commits the shortest valid artifact with a warning instead of native fallback", async () => {
  const probe = harness()
  const measured = tokens((await compactRows(probe, [user("u1", "words"), running("c1")])).summary)
  const h = harness({ memory: { budget: measured - 2 } })
  await h.controller.registerModels()
  h.state.queue = [
    h.state.handoff,
    { ...h.state.handoff, working: { ...h.state.handoff.working, state: [...h.state.handoff.working.state, "x".repeat(400)] } },
  ]
  const result = await compactRows(h, [user("u1", "words"), running("c1")])
  assert.match(result.summary, /Continue current work/)
  assert.doesNotMatch(result.summary, /x{20}/, "the shorter first attempt beats the padded repair")
  assert.equal(h.state.prompts.length, 2, "attempt 0 is strict; the repair carries the exact overage")
  assert.match(h.state.prompts[1], /previous attempt failed: Working state exceeds its budget/)
  assert.ok(h.state.warnings.some((item) => String(item.data?.message ?? "").includes("accepted the shortest valid handoff")))
})

test("a shorter over-budget repair wins the same contest", async () => {
  const probe = harness()
  const measured = tokens((await compactRows(probe, [user("u1", "words"), running("c1")])).summary)
  const h = harness({ memory: { budget: measured - 2 } })
  await h.controller.registerModels()
  h.state.queue = [
    { ...h.state.handoff, working: { ...h.state.handoff.working, state: [...h.state.handoff.working.state, "y".repeat(400)] } },
    { ...h.state.handoff, working: { ...h.state.handoff.working, state: [...h.state.handoff.working.state, "SHORTER-REPAIR-MARK"] } },
  ]
  const result = await compactRows(h, [user("u1", "words"), running("c1")])
  assert.match(result.summary, /SHORTER-REPAIR-MARK/, "the shorter repair beats the padded first attempt")
  assert.doesNotMatch(result.summary, /y{20}/)
  assert.ok(h.state.warnings.some((item) => String(item.data?.message ?? "").includes("accepted the shortest valid handoff")))
})

test("a handoff that never validates falls back to native compaction", async () => {
  const h = harness()
  await h.controller.registerModels()
  h.state.queue = [{ ...h.state.handoff, archive: "no title line" }, { ...h.state.handoff, archive: "still no title" }]
  h.state.rows = [user("u1", "words"), running("c1")]
  const item = event()
  await h.controller.onCompaction(item)
  assert.equal(item.result, undefined, "no valid handoff exists; native compaction stays in control")
  assert.equal(h.state.prompts.length, 2, "the repair also ran and failed validation")
  assert.match(h.state.prompts[1], /previous attempt failed: Archive note must begin/)
  assert.ok(h.state.warnings.some((entry) => String(entry.data?.message ?? "").includes("Working-state compaction failed")))
  h.state.rows = [native("c1", "native fallback summary")]
  await h.controller.recall("s", { id: "catalog" })
  assert.ok(await h.store.getCheckpoint("c1"), "the plugin-driven fallback row is adopted with its reserved episode")
  assert.doesNotMatch(String(h.storage.values.get("sessions/s/model/warning") ?? ""), /without a nextdcp handoff/,
    "a fallback the plugin drove itself needs no adoption warning")
})

test("a committed handoff retires the stale fallback warning while history stays auditable", async () => {
  const h = harness()
  await h.storage.set("sessions/s/model/warning", "stale fallback warning")
  await h.storage.set("sessions/s/model/warnings", JSON.stringify([{ time: 1, message: "stale fallback warning" }]))
  assert.ok(await compactRows(h, [user("u1", "words"), running("c1")]), "the handoff commits")
  assert.equal(await h.storage.get("sessions/s/model/warning"), undefined, "the success path clears the current warning")
  assert.match(String(await h.storage.get("sessions/s/model/warnings")), /stale fallback warning/, "append-only history keeps the record")
})

test("specific model replaces working state in one request without changing the main model", async () => {
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  assert.equal(h.state.prompts.length + h.state.stateless.length, 0, "saving makes no model request")
  const first = await compactRows(h, [user("u1", "PRIVATE_FIRST exact constraint 853"), running("c1")])
  const second = await compactRows(h, [completed("c1", first), user("u2", "PRIVATE_SECOND"), running("c2")])
  assert.match(second.summary, /Archive through E2/)
  assert.equal(h.state.stateless.length, 2)
  assert.equal(h.state.prompts.length, 0)
  for (const request of h.state.stateless) assert.deepEqual(request.model, cheap)
  assert.match(h.state.stateless[0].prompt, /PRIVATE_FIRST exact constraint 853/)
  assert.match(h.state.stateless[1].prompt, /"previous":\{"objective"[\s\S]*PRIVATE_SECOND/)
  assert.doesNotMatch(h.state.stateless[1].prompt, /PRIVATE_FIRST/)
  assert.deepEqual(h.state.info.model, model)
  assert.deepEqual((await h.state.rpc.get({ sessionID: "s" })).preference, { mode: "specific", model: cheap })
})

test("the selected model receives readable text only: no hidden reasoning or row metadata", async () => {
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  const rows = [
    user("u1", "VISIBLE_USER_TEXT needle"),
    { id: "a1", type: "assistant", model: { providerID: "provider", id: "model" }, providerMeta: "SECRET_PROVIDER_META", cost: { tokens: 12345 },
      content: [{ type: "reasoning", text: "SECRET_REASONING_TRACE" }, { type: "text", text: "VISIBLE_ASSISTANT_TEXT" }] },
    running("c1"),
  ]
  const result = await compactRows(h, rows)
  assert.match(result.summary, /Archive through E1/)
  const prompt = h.state.stateless[0].prompt
  assert.match(prompt, /VISIBLE_USER_TEXT/)
  assert.match(prompt, /VISIBLE_ASSISTANT_TEXT/)
  assert.doesNotMatch(prompt, /SECRET_REASONING_TRACE/, "hidden reasoning is not sent as conversation content")
  assert.doesNotMatch(prompt, /SECRET_PROVIDER_META/, "provider metadata is not sent as conversation content")
  assert.doesNotMatch(prompt, /12345/, "transport fields do not ride along")
})

test("configured compaction model is honored and explicit main ignores it across reloads", async () => {
  const h = harness()
  addCheap(h)
  h.state.configured = cheap
  const first = await compactRows(h, [user("u1", "first"), running("c1")])
  assert.deepEqual(h.state.stateless[0].model, cheap)
  await saveModel(h, { mode: "main" })
  h.controller = createController(h.ctx)
  await compactRows(h, [completed("c1", first), user("u2", "second"), running("c2")])
  assert.equal(h.state.prompts.length, 1)
  assert.equal(h.state.stateless.length, 1, "following main requires no secondary merge request")
  await h.controller.registerModels()
  const snapshot = await h.state.rpc.get({ sessionID: "s" })
  assert.deepEqual(snapshot.configured, cheap)
  assert.deepEqual(snapshot.preference, { mode: "main" })
  assert.deepEqual((await h.state.rpc.get({ sessionID: "other" })).preference, { mode: "default" })
})

test("model selection is snapshotted for the entire compaction", async () => {
  const h = harness()
  addCheap(h)
  const first = await compactRows(h, [user("u1", "first"), running("c1")])
  await saveModel(h, { mode: "specific", model: cheap })
  const original = h.ctx.experimental.generate.text
  h.ctx.experimental.generate.text = async (input) => {
    await h.state.rpc.set({ sessionID: "s", preference: { mode: "main" } }, errorContext)
    return original(input)
  }
  const second = await compactRows(h, [completed("c1", first), user("u2", "second"), running("c2")])
  assert.equal(h.state.stateless.length, 1)
  for (const request of h.state.stateless) assert.deepEqual(request.model, cheap)
  await compactRows(h, [completed("c2", second), user("u3", "third"), running("c3")])
  assert.equal(h.state.prompts.length, 2, "the next compaction follows the newly saved policy")
  assert.equal(h.state.stateless.length, 1)
})

test("standing-constraint retirement uses new user evidence and persists across reloads", async () => {
  const h = harness()
  h.state.handoff.working.constraints = ["Preserve the exact request."]
  const first = await compactRows(h, [user("u1", "Preserve the exact request."), running("c1")])
  const constraint = h.state.handoff.working.constraints[0]
  h.state.handoff.working.constraints = []
  h.state.handoff.retiredConstraints = [{ constraint, messageID: "u2", quote: "Replace that request" }]
  const second = await compactRows(h, [completed("c1", first), user("u2", "Replace that request with the current task."), running("c2")])
  assert.ok(second)
  assert.equal(second.summary.includes(constraint), false)
  const saved = await h.store.getCheckpoint("c2")
  assert.deepEqual(saved.working.constraints, [])
  assert.deepEqual(saved.retiredConstraints, h.state.handoff.retiredConstraints)
  h.state.handoff.retiredConstraints = []
  h.controller = createController(h.ctx)
  const third = await compactRows(h, [completed("c2", second), user("u3", "Continue."), running("c3")])
  assert.ok(third)
  assert.deepEqual((await h.store.getCheckpoint("c3")).working.constraints, [])
})

test("unavailable, undersized, failed and empty models visibly fall back without truncation", async (t) => {
  t.mock.method(console, "warn", () => {})
  for (const mode of ["unavailable", "small", "input", "unknown", "failed", "empty"]) {
    const h = harness()
    addCheap(h)
    await saveModel(h, { mode: "specific", model: cheap })
    if (mode === "unavailable") h.state.models.pop()
    if (mode === "small") h.state.models.at(-1).limit.context = 100
    if (mode === "input") h.state.models.at(-1).limit.input = 100
    if (mode === "unknown") h.state.models.at(-1).limit.context = 0
    if (mode === "failed") h.ctx.experimental.generate.text = async () => { throw new Error("SECRET provider request") }
    if (mode === "empty") h.ctx.experimental.generate.text = async () => ({ text: "  " })
    const result = await compactRows(h, [user("u1", "END_MARKER never truncate"), running("c1")])
    assert.match(result.summary, /Archive through E1/)
    assert.equal(h.state.prompts.length, 1)
    assert.ok(h.state.prompts[0].startsWith(WORKING_PROMPT))
    assert.equal(h.state.warnings.length, 1)
    assert.match(h.state.warnings[0].data.message, /using the main model[\s\S]*No transcript was truncated/)
    assert.doesNotMatch(h.state.warnings[0].data.message, /SECRET/)
    assert.match((await h.state.rpc.get({ sessionID: "s" })).warning, /main model/)
    h.state.rows = [completed("c1", result)]
    assert.match(await h.controller.recall("s", { id: "E1" }), /END_MARKER never truncate/)
  }
})

test("a missing experimental generate surface degrades to the main model with a clear warning", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  h.ctx.experimental = undefined
  h.controller = createController(h.ctx)
  await h.controller.registerModels()
  const result = await compactRows(h, [user("u1", "END_MARKER never truncate"), running("c1")])
  assert.match(result.summary, /Archive through E1/)
  assert.equal(h.state.stateless.length, 0, "no stateless call was attempted")
  assert.equal(h.state.prompts.length, 1, "the main model produced the handoff")
  assert.match(h.state.warnings[0].data.message, /cannot run stateless generation in this OpenCode build\); using the main model[\s\S]*No transcript was truncated/)
})

test("attachments use native projection, never a lossy text-only summary", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  await compactRows(h, [{ ...user("u1", "Read this image"), files: [{ type: "file", mediaType: "image/png", url: "data:image/png;base64,AAAA" }] }, running("c1")])
  assert.equal(h.state.stateless.length, 0)
  assert.equal(h.state.prompts.length, 1)
  assert.ok(h.state.prompts[0].startsWith(WORKING_PROMPT))
  assert.match(h.state.warnings[0].data.message, /attachments/)
})

test("RPC rejects invalid selections and unavailable variants without changing durable state", async () => {
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  for (const preference of [{ mode: "bogus" }, { mode: "main", model: cheap }, { mode: "specific", model: { ...cheap, variant: "missing" } }]) {
    const result = await h.state.rpc.set({ sessionID: "s", preference }, errorContext)
    assert.equal(result.code, "invalid_selection")
    assert.deepEqual((await h.state.rpc.get({ sessionID: "s" })).preference, { mode: "specific", model: cheap })
  }
  h.storage.fail = (key) => key.endsWith("/model")
  await assert.rejects(h.state.rpc.set({ sessionID: "s", preference: { mode: "main" } }, errorContext), /storage/)
  assert.deepEqual((await h.state.rpc.get({ sessionID: "s" })).preference, { mode: "specific", model: cheap })
  assert.equal(h.state.stateless.length + h.state.prompts.length, 0)
})

test("model catalog exposes text variants only and policies are session-isolated across reloads", async () => {
  const h = harness()
  addCheap(h)
  await h.controller.registerModels()
  h.state.models.push({ ...h.state.models[0], id: "images", capabilities: { input: ["text"], output: ["image"] } })
  h.state.models.push({ ...h.state.models[0], id: "audio-only", capabilities: { input: ["audio"], output: ["text"] } })
  const view = await h.state.rpc.get({ sessionID: "s" })
  assert.ok(view.choices.some((choice) => choice.model.id === cheap.id && choice.model.variant === cheap.variant))
  assert.ok(view.choices.every((choice) => !["images", "audio-only"].includes(choice.model.id)))
  assert.deepEqual((await h.state.rpc.get({ sessionID: "other" })).preference, { mode: "default" })
  await h.state.rpc.set({ sessionID: "s", preference: { mode: "main" } })
  h.controller = createController(h.ctx)
  await h.controller.registerModels()
  assert.deepEqual((await h.state.rpc.get({ sessionID: "s" })).preference, { mode: "main" })
  assert.deepEqual((await h.state.rpc.get({ sessionID: "other" })).preference, { mode: "default" })
})

test("selected variants are honored and catalog failures do not leak provider errors", async () => {
  const h = harness()
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  const first = await compactRows(h, [user("u1", "first"), running("c1")])
  assert.deepEqual(h.state.stateless[0].model, cheap)
  h.ctx.model.list = async () => { throw new Error("SECRET_CREDENTIAL") }
  await compactRows(h, [completed("c1", first), user("u2", "second"), running("c2")])
  assert.match(h.state.warnings.at(-1).data.message, /catalog is unavailable/)
  assert.doesNotMatch(h.state.warnings.at(-1).data.message, /SECRET/)
})

test("100 checkpoints replace working state without a growing diary, directory, or merge request", async () => {
  const h = harness({ memory: { budget: 512 } })
  h.state.handoff.working.constraints = ["Preserve the exact request."]
  let previous, firstSize
  for (let i = 1; i <= 100; i++) {
    h.state.handoff.archive = `Title: Completed topic ${i}\narchivekeyword${i}.`
    h.state.handoff.working.state = [`currentfact${i}`]
    if (i > 1) h.state.handoff.working.constraints = [] // A careless omission must not erase the old constraint.
    const result = await compactRows(h, [...(previous ? [previous] : []), user(`u${i}`, `originaltopic${i}${i === 1 ? ". Preserve the exact request." : ""}`), running(`c${i}`)])
    assert.match(result.summary, /Preserve the exact request/)
    assert.match(result.summary, new RegExp(`currentfact${i}\\b`))
    assert.doesNotMatch(result.summary, /archivekeyword|originaltopic/, "note bodies and originals stay out of the working state")
    if (i > 1) assert.doesNotMatch(result.summary, new RegExp(`currentfact${i - 1}\\b`))
    assert.ok(Math.ceil(result.summary.length / 4) <= 512)
    // Baseline from the second episode on, once the archive anchor has appeared.
    if (i > 1) firstSize ??= result.summary.length
    // The archive anchor's episode count and endpoint ids grow by digits only — never per episode.
    if (firstSize !== undefined) assert.ok(result.summary.length <= firstSize + 24)
    previous = completed(`c${i}`, result)
    if (i % 10 === 0) h.controller = createController(h.ctx)
  }
  assert.equal(h.state.prompts.length, 100)
  assert.equal(h.state.stateless.length, 0)
  h.state.rows = [previous]
  assert.match(await h.controller.recall("s", { id: "E1" }), /originaltopic1/)
  assert.match(await h.controller.recall("s", { query: "archivekeyword1", layer: "full" }), /archive note, not original evidence/)
  assert.match(await h.controller.recall("s", { query: "originaltopic1" }), /originaltopic1/)
})

test("an over-budget or malformed handoff gets one repair, not another growing episode", async () => {
  for (const mode of ["malformed", "oversized"]) {
    const h = harness({ memory: { budget: 256 } })
    const original = h.ctx.session.generate
    h.ctx.session.generate = async (input) => {
      if (input.prompt.includes("The previous attempt")) return original(input)
      h.state.prompts.push(input.prompt)
      return { text: mode === "malformed" ? "not JSON" : JSON.stringify({ ...h.state.handoff, working: { ...h.state.handoff.working, state: ["very long ".repeat(2_000)] } }) }
    }
    const result = await compactRows(h, [user("u1", "important original"), running("c1")])
    assert.ok(Math.ceil(result.summary.length / 4) <= 256)
    assert.equal(h.state.prompts.length, 2)
    assert.equal(h.state.stateless.length, 0)
  }
})

test("unrepairable state or constraint overflow commits the shortest valid artifact visibly, never truncating", async (t) => {
  t.mock.method(console, "warn", () => {})
  for (const field of ["state", "constraints"]) {
    const h = harness({ memory: { budget: 256 } })
    await h.controller.registerModels()
    h.state.handoff.working.constraints = ["Preserve the exact request."]
    const first = await compactRows(h, [user("u1", "first. Preserve the exact request."), running("c1")])
    const material = "essential long material ".repeat(1_000)
    h.state.handoff.working[field] = [material]
    h.state.rows = [completed("c1", first), user("u2", `original never discarded${field === "constraints" ? `\n${material}` : ""}`), running("c2")]
    const second = event()
    await h.controller.onCompaction(second)
    assert.ok(second.result?.summary.includes(material), "the whole state/constraint commits, never sliced to fit")
    assert.ok((await h.store.getCheckpoint("c2")).working[field].includes(material), "the durable record keeps it whole")
    assert.match(await h.store.getRow("u2"), /original never discarded/)
    // First cut, then the shared budget allows only patch + full regeneration.
    assert.equal(h.state.prompts.length, 3)
    assert.match(h.state.warnings.at(-1).data.message, /accepted the shortest valid handoff/)
    assert.equal((await h.store.getCheckpoint("c1")).working.constraints[0], "Preserve the exact request.")
  }
})

test("a structured prior invites a minimal patch; omitted fields carry forward and present fields replace", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "first task"), running("c1")])
  assert.ok(!h.state.prompts[0].includes("Patch mode"), "the first cut has no structured prior")
  h.state.queue = [{ archive: "Title: Patched episode\nSecond task completed.", working: { next: ["Run the release."] }, retiredConstraints: [] }]
  h.state.rows = [completed("c1", first), user("u2", "second task"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  assert.match(h.state.prompts.at(-1), /Patch mode/, "the second cut asks for a patch")
  assert.equal(h.state.prompts.length, 2, "a valid patch commits in one generation")
  const record = await h.store.getCheckpoint("c2")
  assert.deepEqual(record.working, { objective: "Continue current work", constraints: [], state: [], next: ["Run the release."], references: [] })
  assert.match(second.result.summary, /Run the release\./)
  assert.doesNotMatch(second.result.summary, /Patch mode/)
})

test("an invalid patch gets one full regeneration carrying its failure", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "first"), running("c1")])
  h.state.queue = [{ archive: "Title: Bad patch\nNo.", working: { objective: "" }, retiredConstraints: [] }]
  h.state.rows = [completed("c1", first), user("u2", "second"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  assert.equal(h.state.prompts.length, 3, "first cut, failed patch, full regeneration")
  assert.ok(!h.state.prompts.at(-1).includes("Patch mode"), "the fallback asks for a full replacement")
  assert.match(h.state.prompts.at(-1), /The previous attempt failed:/, "the failure is not hidden from the retry")
  assert.equal((await h.store.getCheckpoint("c2")).working.objective, "Continue current work")
})

test("an over-budget patch merge falls back to full regeneration, which prunes it", async () => {
  const h = harness({ memory: { budget: 256 } })
  const first = await compactRows(h, [user("u1", "first"), running("c1")])
  h.state.queue = [{ archive: "Title: Swollen patch\nGrew the state.", working: { state: ["swollen ".repeat(200)] }, retiredConstraints: [] }]
  h.state.rows = [completed("c1", first), user("u2", "second"), running("c2")]
  const second = event()
  await h.controller.onCompaction(second)
  assert.equal(h.state.prompts.length, 3, "the patch is not a candidate; full regeneration commits instead")
  assert.deepEqual((await h.store.getCheckpoint("c2")).working.state, [])
  assert.ok(Math.ceil(second.result.summary.length / 4) <= 256)
})

// The fire-and-forget thermostat write lands after onCompaction returns; wait for it.
const awaitThermostat = async (h, cycles) => {
  for (let tick = 0; tick < 50; tick++) {
    const raw = h.storage.values.get("projects/test/thermostat")
    if (raw && Object.values(JSON.parse(raw)).some((entry) => entry.cycles >= cycles)) return JSON.parse(raw)
    await setImmediate()
  }
  return h.storage.values.has("projects/test/thermostat") ? JSON.parse(h.storage.values.get("projects/test/thermostat")) : undefined
}

test("the thermostat adapts the auto budget per model from committed-cut turn rates", async (t) => {
  t.mock.method(console, "warn", () => {})
  t.mock.method(console, "info", () => {})
  const h = harness()
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event()) // stamps the session's main model
  let previous
  for (let cut = 1; cut <= 5; cut++) {
    previous = await compactRows(h, cut === 1
      ? [user(`u${cut}`, "x".repeat(804)), assistant(`a${cut}`), running(`c${cut}`)]
      : [completed(`c${cut - 1}`, previous), user(`u${cut}`, "x".repeat(804)), assistant(`a${cut}`), running(`c${cut}`)])
  }
  assert.deepEqual(await awaitThermostat(h, 5), { "provider/model": { version: THERMOSTAT_VERSION, growth: 201, span: 1, cycles: 5, budget: 37_500 } },
    "five lean cycles: each cut steps the budget down to its floor")
  h.state.rows = [completed("c5", previous), user("big", "go"), ...Array.from({ length: 200 }, (_, at) => assistant(`step-${at}`, "y".repeat(800)))]
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 0, "the crossing arms the gate instead of compacting")
  assert.match(request.messages.at(-1)?.content?.[0]?.text ?? "", /safeguard 37500/, "the notice prints the adapted safeguard")
})

test("an explicit options.budget wins absolutely over the learned budget", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event())
  const first = await compactRows(h, [user("u1", "task"), assistant("a1"), running("c1")])
  await h.controller.recall("s", { id: "catalog" })
  await compactRows(h, [completed("c1", first), user("u2", "task"), assistant("a2"), running("c2")])
  assert.deepEqual(await awaitThermostat(h, 2), { "provider/model": { version: THERMOSTAT_VERSION, growth: 1, span: 1, cycles: 2, budget: 37_500 } },
    "evidence still accumulates, even while the explicit budget triggers")
  h.state.rows = [user("u", "x".repeat(800))]
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.match(request.messages.at(-1)?.content?.[0]?.text ?? "", /budget 40[^0]/, "the explicit budget triggers, never the learned one")
})

test("each committed cut folds its own turn rate, and subagent sessions never feed the loop", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event())
  await h.controller.recall("s", { id: "catalog" })
  const first = await compactRows(h, [user("u1", "task"), assistant("a1", "d".repeat(1_600)), running("c1")])
  await h.controller.recall("s", { id: "catalog" })
  await h.controller.recall("s", { id: "catalog" })
  const second = await compactRows(h, [completed("c1", first), user("u2", "task"), assistant("a2", "d".repeat(3_200)), running("c2")])
  await compactRows(h, [completed("c2", second), user("u3", "task"), assistant("a3", "d".repeat(2_000)), running("c3")])
  const rates = (await awaitThermostat(h, 3))["provider/model"]
  assert.deepEqual(rates, { version: THERMOSTAT_VERSION, growth: 551, span: 1, cycles: 3, budget: 37_500 },
    "each cycle folds its own rate: recalls between cuts never enter the law")
  const sub = harness()
  sub.state.info = { model, time: { busy: 1 }, parentID: "parent-session" }
  sub.state.rows = [user("u0", "small warmup")]
  await sub.controller.onContext(event())
  await sub.controller.recall("s", { id: "E1" })
  await compactRows(sub, [user("u1", "task"), assistant("a1"), running("c1")])
  await setImmediate()
  assert.equal(sub.storage.values.get("projects/test/thermostat"), undefined, "a subagent's cycles are never folded")
})

test("an unknown window disables the thermostat alongside the auto budget", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  h.state.models = [{ ...model, enabled: true, capabilities: { input: ["text"], output: ["text"] }, variants: [], limit: {} }]
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event())
  await h.controller.recall("s", { id: "E1" })
  const result = await compactRows(h, [user("u1", "task"), running("c1")])
  assert.ok(result, "the cut itself is unaffected")
  await setImmediate()
  assert.equal(h.storage.values.get("projects/test/thermostat"), undefined, "nothing is learned without physics to clamp against")
})

test("thermostat storage failures never block a cut or the default budget", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  const h = harness()
  h.storage.fail = (key) => key === "projects/test/thermostat"
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event())
  await h.controller.recall("s", { id: "E1" })
  const result = await compactRows(h, [user("u1", "task"), assistant("a1"), running("c1")])
  assert.ok(result, "the handoff commits regardless")
  assert.ok((await h.store.getCheckpoint("c1")).working, "the checkpoint persists")
  await setImmediate()
  assert.ok(warnings.mock.calls.some((call) => String(call.arguments[0]).includes("thermostat cycle for provider/model")), "the failure is reported")
  h.state.rows = [assistant("a", "x".repeat(260_000))]
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.match(request.messages.at(-1)?.content?.[0]?.text ?? "", /safeguard 50000/, "the gate falls back to the small window's default")
})

test("a rate spike holds the round's cut automatically while physics still fits", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness({ budget: 40_000 })
  h.state.rows = [user("u0", "small warmup")]
  await h.controller.onContext(event())
  const seed = await compactRows(h, [user("u1", "x".repeat(804)), assistant("a1"), running("c1")])
  await h.controller.onCompactionFinished("s")
  await setImmediate() // the fire-and-forget cycle close must land before the spike build reads it
  h.state.rows = [completed("c1", seed), user("u2", "q".repeat(200_000)), assistant("a2", "d".repeat(2_000))]
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 0, "the spike hold replaces the gate for this build")
  assert.equal(request.messages.length, projectHistory(h.state.rows).messages.length, "no gate notice is appended")
  assert.deepEqual(await h.store.getGateStats(), { gates: 0, silent: 0, continued: 0, repaid: 0, spikeHeld: 1, checkpoints: 0, capacity: 0 })
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0, "every later build of the held round is held too")
  await h.controller.onIdle("s")
  await setImmediate()
  assert.equal((await h.store.getGateStats()).spikeHeld, 1, "the held round writes no deferred marker")
  h.state.info = { model }
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "a crossing with no live round cuts silently")
})

test("deferred admission is guarded, ignores children, does not loop after compaction, and retries rejection", async () => {
  const h = harness({ idle: 1 })
  h.state.info = { parentID: "parent" }
  h.state.rows = [user("u1", "one long enough conversation")]
  await resume(h)
  assert.equal(h.state.compact, 0)
  h.state.info = {}
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await Promise.all([h.controller.onIdle("s"), h.controller.onIdle("s"), h.controller.onIdle("s")])
  await setImmediate()
  assert.equal(h.state.compact, 0, "successful turns do not request a summary")
  await Promise.all([h.controller.onPrompt(prompt()), h.controller.onPrompt(prompt()), h.controller.onPrompt(prompt())])
  assert.equal(h.state.compact, 1)
  h.controller.onCompactionFinished("s")
  await resume(h)
  assert.equal(h.state.compact, 1)
  h.state.rows = [native("c1")]
  await resume(h)
  assert.equal(h.state.compact, 1)
  h.state.rows.push(user("u2", "new work after compaction"))
  h.state.failAdmission = true
  await resume(h)
  assert.equal(h.state.compact, 2)
  h.state.failAdmission = false
  await resume(h)
  assert.equal(h.state.compact, 3)
})

test("a success clears a stale guard only when no compaction row is running", async () => {
  const h = harness({ idle: 1 })
  const first = user("u1", "first turn")
  h.state.rows = [first]
  await resume(h)
  assert.equal(h.state.compact, 1)
  h.state.rows = [first, running("busy"), user("u2", "more work during compaction")]
  await resume(h)
  assert.equal(h.state.compact, 1)
  h.state.rows = [first, user("u2", "more work after compaction stopped")]
  await resume(h)
  assert.equal(h.state.compact, 2)
})

test("a guard times out after three minutes and permits a retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work while compaction admission is stuck")]
  await resume(h)
  assert.equal(h.state.compact, 1)
  t.mock.timers.tick(3 * 60_000)
  await resume(h)
  assert.equal(h.state.compact, 2)
})

test("the retry marker expires even if a success already cleared the guard", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "unchanged work")]
  await resume(h)
  assert.equal(h.state.compact, 1)
  await resume(h)
  assert.equal(h.state.compact, 1, "a duplicate success must not queue another request")
  t.mock.timers.tick(3 * 60_000)
  await resume(h)
  assert.equal(h.state.compact, 2)
})

test("a failed compaction blocks new requests for three minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work before a failing compaction")]
  await resume(h)
  assert.equal(h.state.compact, 1)
  h.controller.onCompactionFinished("s", true)
  await resume(h)
  assert.equal(h.state.compact, 1, "no retry storm after a failure")
  t.mock.timers.tick(3 * 60_000)
  await resume(h)
  assert.equal(h.state.compact, 2)
})

test("soft compaction waits for another prompt and its marker survives a controller reload", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "completed work with enough growth")]
  await idle(h)
  assert.equal(h.state.compact, 0)
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: null, after: "u1", tokens: 8, threshold: 1 })
  await setImmediate()
  assert.equal(h.state.compact, 0, "leaving the conversation alone costs no summary call")
  h.controller = createController(h.ctx)
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 1, "resume works without the old in-memory view")
})

const generationData = (prompt) => JSON.parse(prompt.slice(prompt.indexOf("Compaction context (data):\n") + "Compaction context (data):\n".length))

test("the queued message that resumes a marked session biases the working state", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "finished debugging runtime.ts")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: "  Now port the same fix to the TUI bundle.  ", files: [] } })
  assert.equal(h.state.compact, 1, "the marker is admitted before the queued message")
  h.state.rows = [user("u1", "finished debugging runtime.ts"), running("c1")]
  await h.controller.onCompaction(event())
  assert.equal(h.state.prompts.length, 1)
  const data = generationData(h.state.prompts[0])
  assert.equal(data.queued, "Now port the same fix to the TUI bundle.")
  assert.ok(!("users" in data), "user quotes are resolved by the validator, not a repeated source directory")
})

test("a hint is omitted without message text and capped when huge", async () => {
  const empty = harness({ idle: 1 })
  empty.state.rows = [user("u1", "resumed without words")]
  await idle(empty)
  await empty.controller.onPrompt({ ...prompt(), prompt: { text: "   ", files: [] } })
  empty.state.rows = [user("u1", "resumed without words"), running("c1")]
  await empty.controller.onCompaction(event())
  assert.ok(!("queued" in generationData(empty.state.prompts[0])))

  const capped = harness({ idle: 1 })
  capped.state.rows = [user("u1", "work before a huge queued message")]
  await idle(capped)
  await capped.controller.onPrompt({ ...prompt(), prompt: { text: "x".repeat(5_000), files: [] } })
  capped.state.rows = [user("u1", "work before a huge queued message"), running("c1")]
  await capped.controller.onCompaction(event())
  assert.equal(generationData(capped.state.prompts[0]).queued.length, 2_000)
})

test("the hint is consumed once and never appears on compactions without a queued resume", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work before resuming")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: "keep the trace comparison live", files: [] } })
  h.state.rows = [user("u1", "work before resuming"), running("c1")]
  const first = event()
  await h.controller.onCompaction(first)
  assert.ok(first.result)
  assert.equal(generationData(h.state.prompts.at(-1)).queued, "keep the trace comparison live")

  h.state.rows = [completed("c1", first.result), user("u2", "later work without a marker"), running("c2")]
  await h.controller.onCompaction(event())
  assert.ok(!("queued" in generationData(h.state.prompts.at(-1))), "the hint is read once; later compactions see none")
})

test("a hint that never reached a generation dies with its round", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work before a lost compaction")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: "keep the state diagram facts", files: [] } })
  h.controller.onRoundEnded("s")
  h.state.rows = [user("u1", "work before a lost compaction"), running("c1")]
  await h.controller.onCompaction(event())
  assert.ok(!("queued" in generationData(h.state.prompts.at(-1))), "an expired hint cannot leak into a later compaction")
})

test("the queued hint survives the one repair attempt", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work before a queued resume")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: "keep the trace alignment live", files: [] } })
  h.state.rows = [user("u1", "work before a queued resume"), running("c1")]
  const original = h.ctx.session.generate
  h.ctx.session.generate = async (input) => {
    if (input.prompt.includes("The previous attempt")) return original(input)
    h.state.prompts.push(input.prompt)
    return { text: "not JSON" }
  }
  const item = event()
  await h.controller.onCompaction(item)
  assert.ok(item.result)
  assert.equal(h.state.prompts.length, 2, "exactly one repair attempt")
  for (const attempt of h.state.prompts) {
    assert.equal(generationData(attempt).queued, "keep the trace alignment live", "the repair retry keeps the hint")
  }
})

const continuation = (id) => ({ id, type: "assistant", content: [
  { type: "tool", id: `${id}-call`, name: "read", state: { status: "completed", input: { path: "x" }, content: [{ type: "text", text: "r" }] } },
] })
const finish = (id) => ({ id, type: "assistant", content: [{ type: "text", text: "All done." }] })

test("a staged checkpoint waits for the model's next action: tool work applies it, a final reply defers it", async () => {
  const applies = harness({ idle: 1 })
  applies.state.rows = [user("u1", "work behind a staged checkpoint")]
  const staged = await publishCheckpoint(applies, {}, false)
  assert.match(staged.output, /^Prepared:/)
  assert.equal(applies.state.compact, 0, "nothing is admitted or generated before the model's next action")
  applies.state.rows.push(continuation("step-next"))
  await applies.controller.onContext({ ...event(), messages: projectHistory(applies.state.rows).messages })
  await setImmediate()
  assert.equal(applies.state.compact, 1, "tool work continues the round: the staged cut applies at its boundary")

  const defers = harness({ idle: 1 })
  defers.state.rows = [user("u1", "finished work behind a staged checkpoint")]
  await publishCheckpoint(defers, {}, false)
  defers.state.rows.push(finish("step-final"))
  await idle(defers)
  assert.equal(defers.state.compact, 0, "a final reply's round end applies nothing")
  const marker = await defers.store.getDeferredCompaction()
  assert.equal(marker.threshold, 0, "the staged cut is queued unconditionally")
  assert.equal(marker.after, "step-final")
  await defers.controller.onPrompt({ ...prompt(), prompt: { text: "Now start the next task", files: [] } })
  assert.equal(defers.state.compact, 1, "the cut lands at the next prompt")
  defers.state.rows.push(running("c1"))
  await compactRows(defers, defers.state.rows)
  assert.equal(generationData(defers.state.prompts.at(-1)).queued, "Now start the next task", "steered by the user's message")
})

test("the staged cut ends at the call: newer work rides live beside the summary", async () => {
  const h = harness()
  h.state.rows = [user("u1", "work before the staged boundary")]
  await publishCheckpoint(h, {}, false)
  h.state.rows.push(continuation("step-next"))
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  h.state.rows.push(running("c1"))
  const result = await compactRows(h, h.state.rows)
  assert.equal(result.metadata.keepID, "step-next", "the continuation rides live beside the summary")
  assert.deepEqual((await h.store.getCheckpoint("c1")).episode.rowIDs, ["u1", "assistant"], "the episode ends at the staged boundary, the call itself included")
})

test("a staged edit survives the hold: work after its boundary cannot invalidate it", async () => {
  const h = harness()
  h.state.rows = [user("u1", "work behind the main edit")]
  await publishCheckpoint(h, edit({ ...h.state.handoff.working, next: ["Verify the staged edit"] }), true)
  h.state.rows.push(continuation("step-next"))
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  h.state.rows.push(running("c1"))
  const result = await compactRows(h, h.state.rows)
  assert.ok(result)
  assert.equal(result.metadata.nextdcp.author, "main", "the edit was staged for its boundary; later work lives outside it")
})

test("a staged checkpoint on a failed or interrupted round applies at its boundary", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work behind a staged checkpoint")]
  await publishCheckpoint(h, {}, false)
  await h.controller.onRoundEnded("s")
  await setImmediate()
  assert.equal(h.state.compact, 1, "interruptions continue the same work: the staged cut applies")
  h.state.rows.push(running("c1"))
  await compactRows(h, h.state.rows)
  assert.deepEqual((await h.store.getCheckpoint("c1")).episode.rowIDs, ["u1", "assistant"], "the cut lands at the staged boundary, the call itself included")
})

test("a failed compaction keeps the hint for its next attempt; committing consumes it", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "work before a queued resume")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: "port the fix to the TUI bundle", files: [] } })
  h.state.rows = [user("u1", "work before a queued resume"), running("c1")]
  h.state.failGenerate = true
  const failed = event()
  await h.controller.onCompaction(failed)
  assert.equal(failed.result, undefined, "the failed attempt commits nothing")
  h.state.failGenerate = false
  const retry = event()
  await h.controller.onCompaction(retry)
  assert.ok(retry.result)
  assert.equal(generationData(h.state.prompts.at(-1)).queued, "port the fix to the TUI bundle", "a retried compaction keeps the hint")

  h.state.rows = [completed("c1", retry.result), user("u2", "later work without a marker"), running("c2")]
  await h.controller.onCompaction(event())
  assert.ok(!("queued" in generationData(h.state.prompts.at(-1))), "committing consumed the hint")
})

test("final retained output can cross the soft threshold; reasoning counts as durable growth", async () => {
  const h = harness({ idle: 100, budget: 1_000_000 })
  h.state.rows = [user("u1", "x".repeat(320))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  h.state.rows.push({ id: "final", type: "assistant", content: [
    { type: "reasoning", text: "r".repeat(40) }, { type: "text", text: "a".repeat(80) },
  ] }, { id: "idle", type: "idle", outcome: "succeeded" })
  await h.controller.onIdle("s")
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: null, after: "idle", tokens: 110, threshold: 100 })
  await h.controller.onIdle("s")
  assert.equal((await h.store.getDeferredCompaction()).tokens, 110)
  assert.equal(h.state.compact, 0, "the final answer must not start a summary while idle")
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 1)
})

test("completion growth adds only unseen output, including an updated retry row", async () => {
  const h = harness({ idle: 100, budget: 1_000_000 })
  h.state.rows = [user("u1", "x".repeat(280)), { id: "retry", type: "assistant", content: [{ type: "text", text: "a".repeat(80) }] }]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await h.controller.onIdle("s")
  assert.equal(await h.store.getDeferredCompaction(), undefined, "90 visible tokens must not be double counted")
  h.state.rows[1] = { id: "retry", type: "assistant", content: [{ type: "text", text: "a".repeat(160) }] }
  await h.controller.onIdle("s")
  assert.equal((await h.store.getDeferredCompaction()).tokens, 110)
})

test("a stale completion view cannot mark a reverted or newly admitted boundary", async () => {
  for (const changed of [[user("other", "different branch")], [user("u1", "x".repeat(320)), user("new", "unmeasured prompt")]]) {
    const h = harness({ idle: 100, budget: 1_000_000 })
    h.state.rows = [user("u1", "x".repeat(320))]
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    h.state.rows = [...changed, { id: "final", type: "assistant", content: [{ type: "text", text: "a".repeat(200) }] }]
    await h.controller.onIdle("s")
    assert.equal(await h.store.getDeferredCompaction(), undefined)
  }
})

test("concurrent prompt hooks await one admission without changing the new prompt", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "completed work")]
  await idle(h)
  let admit, returned = 0
  h.ctx.session.compact = async () => { h.state.compact++; await new Promise((resolve) => { admit = resolve }) }
  const next = prompt(), original = structuredClone(next)
  const hooks = Array.from({ length: 3 }, () => h.controller.onPrompt(next).then(() => { returned++ }))
  await setImmediate()
  assert.equal(h.state.compact, 1)
  assert.equal(returned, 0, "the user message must not race ahead of compaction admission")
  admit()
  await Promise.all(hooks)
  assert.deepEqual(next, original)
})

test("deferred markers never compact a different boundary, staged revert, child, or running compaction", async () => {
  const h = harness({ idle: 1 })
  const original = [user("u1", "completed work")]
  h.state.rows = original
  await idle(h)
  for (const [info, rows] of [
    [{}, []], [{}, [user("u2", "different branch")]], [{}, [...original, user("u2", "new work")]],
    [{}, [native("new-checkpoint"), ...original]], [{}, [running("busy"), ...original]],
    [{ parentID: "parent" }, original], [{ revert: { messageID: "u1" } }, original],
  ]) {
    h.state.info = info
    h.state.rows = rows
    await h.controller.onPrompt(prompt())
    assert.equal(h.state.compact, 0)
  }
  h.state.rows = original
  h.state.info = {}
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 1)
})

test("disabled or below-threshold soft compaction does not generate on resume", async () => {
  for (const idleOption of [false, 100]) {
    const h = harness({ idle: idleOption })
    h.state.rows = [user("u1", "short")]
    await idle(h)
    await h.controller.onPrompt(prompt())
    assert.equal(h.state.compact, 0)
    assert.equal(await h.store.getDeferredCompaction(), undefined)
  }
})

test("missing, corrupt or unwritable deferred state never blocks a user prompt", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "completed work")]
  h.storage.fail = (key) => key.endsWith("/deferred-compaction")
  await idle(h)
  const next = prompt(), original = structuredClone(next)
  await h.controller.onPrompt(next)
  assert.equal(h.state.compact, 0)
  h.storage.values.set("sessions/s/deferred-compaction", "{not-json")
  await h.controller.onPrompt(next)
  assert.equal(h.state.compact, 0)
  assert.deepEqual(next, original)
})

test("a plugin checkpoint without a stored record is adopted as a native episode", async () => {
  const h = harness()
  const orphan = completed("c1", { summary: "## Episode E7 — Forked work\nkept facts", metadata: { nextdcp: { version: 1 } } })
  const result = await compactRows(h, [orphan, user("u2", "work after the fork"), running("c2")])
  assert.match(result.summary, /Current working state/)
  assert.doesNotMatch(h.state.prompts[0], /kept facts/, "inline generation does not duplicate its native checkpoint")
  assert.match(projectHistory(h.state.rows).messages[0].content[0].text, /kept facts/)
  assert.match((await h.store.getCheckpoint("c1")).episode.summary, /kept facts/)
  assert.match(result.summary, /Archive through E2/)
})

test("the budget gate arms at the crossing and pays it at the next build", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  await armGate(h)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "the next build closes the gate and compacts")
})

test("the actual cut, not the gate, generates a handoff covering every later suffix", async () => {
  const h = harness({ idle: false, budget: 40 })
  // Seed one cut so the gate window has a structured prior working state to patch.
  const seed = await compactRows(h, [user("u1", "seed work"), running("c1")])
  assert.equal(h.state.prompts.length, 1, "the seed generated inline")
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  await h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c1", seed), user("u", "x".repeat(800))]
  await armGate(h)
  assert.equal(h.state.stateless.length, 0, "opening a gate never generates speculatively")
  h.state.rows.push(assistant("suffix", "NEW_FINDING_AFTER_GATE"), user("new-constraint", "NEW_USER_CONSTRAINT_AFTER_GATE"))
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "the next build closes the gate")
  h.state.rows = [...h.state.rows, running("c2")]
  const item = event()
  await h.controller.onCompaction(item)
  assert.ok(item.result, "the actual cut commits its own handoff")
  assert.equal(h.state.prompts.length, 1, "the commit added no inline generation")
  assert.equal(h.state.stateless.length, 1, "only the actual cut generates")
  assert.match(h.state.stateless[0].prompt, /NEW_FINDING_AFTER_GATE/)
  assert.match(h.state.stateless[0].prompt, /NEW_USER_CONSTRAINT_AFTER_GATE/)
  const episode = (await h.store.getCheckpoint("c2")).episode
  assert.equal(episode.id, "E2", "the episode id is allocated at the cut")
  assert.deepEqual(episode.rowIDs, ["u", "suffix", "new-constraint"], "coverage matches the supplied transcript")
  await setImmediate()
  assert.deepEqual(await h.store.getGateStats(), { gates: 1, silent: 0, continued: 1, repaid: 0, spikeHeld: 0, checkpoints: 0, capacity: 0 })
})

test("concurrent/repeated hooks for one cut reuse one durable checkpoint", async () => {
  const h = harness({ idle: false, budget: 40 })
  const seed = await compactRows(h, [user("u1", "seed work"), running("c1")])
  h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c1", seed), user("u", "x".repeat(800))]
  await armGate(h)
  assert.equal(h.state.stateless.length, 0, "the gate makes no model request")
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1)
  h.state.rows = [...h.state.rows, running("c2")]
  const item = event(), repeated = event()
  await Promise.all([h.controller.onCompaction(item), h.controller.onCompaction(repeated)])
  assert.ok(item.result, "the close still produces a handoff")
  assert.deepEqual(repeated.result, item.result)
  assert.equal(h.state.prompts.length, 2, "the seed plus one actual-cut generation")
  const reloaded = event()
  await createController(h.ctx).onCompaction(reloaded)
  assert.deepEqual(reloaded.result, item.result, "the durable checkpoint also survives reload")
  assert.equal(h.state.prompts.length, 2)
  await setImmediate()
  assert.deepEqual(await h.store.getGateStats(), { gates: 1, silent: 0, continued: 1, repaid: 0, spikeHeld: 0, checkpoints: 0, capacity: 0 })
})

test("an open gate admits checkpoint_now normally, including a direct working-state edit", async () => {
  for (const direct of [false, true]) {
    const h = harness({ idle: false, budget: 40 })
    const seed = await compactRows(h, [user("u1", "seed work"), running("c1")])
    await h.controller.onCompactionFinished("s")
    h.state.rows = [completed("c1", seed), user("u", "x".repeat(800))]
    await armGate(h)
    const { output } = await publishCheckpoint(h, direct ? edit({ ...h.state.handoff.working, next: ["Verify the new direct checkpoint"] }) : {}, false)
    assert.match(output, /Prepared:/, "a gate is not an already admitted cut")
    assert.equal(h.state.compact, 0, "staging holds the cut for the model's next action")
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    await setImmediate()
    assert.equal(h.state.compact, 0, "the consumed gate cannot request a second cut")
    const result = await compactRows(h, [...h.state.rows, running("c2")])
    assert.equal(h.state.stateless.length, 0)
    assert.equal(h.state.prompts.length, direct ? 1 : 2, "only an empty call asks the compactor to generate")
    assert.equal(result.metadata.nextdcp.author, direct ? "main" : "compactor")
    if (direct) assert.deepEqual((await h.store.getCheckpoint("c2")).working.next, ["Verify the new direct checkpoint"])
    await setImmediate()
    assert.equal((await h.store.getGateStats()).checkpoints, 1)
  }
})

test("notice: system restores the legacy system-part placement without a tail message", async () => {
  const legacy = harness({ idle: false, budget: 40, notice: "system" })
  legacy.state.rows = [user("u", "x".repeat(800))]
  const request = { ...event(), messages: projectHistory(legacy.state.rows).messages }
  await legacy.controller.onContext(request)
  await setImmediate()
  assert.equal(legacy.state.compact, 0, "the crossing still arms instead of compacting")
  assert.equal(request.messages.length, projectHistory(legacy.state.rows).messages.length, "the fallback appends no message")
  assert.match(request.system.at(-1)?.text ?? "", /Compaction budget gate/)
})

test("gate outcomes are counted per session, and telemetry failures never gate a trigger", async () => {
  const zeros = { gates: 0, silent: 0, continued: 0, repaid: 0, spikeHeld: 0, checkpoints: 0, capacity: 0 }
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  await armGate(h)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.deepEqual(await h.store.getGateStats(), { ...zeros, gates: 1, continued: 1 })
  // A failed round repays its consumed crossing.
  const repaid = harness({ idle: false, budget: 40 })
  repaid.state.rows = [user("u", "x".repeat(800))]
  await armGate(repaid)
  repaid.controller.onRoundEnded("s")
  await setImmediate()
  assert.deepEqual(await repaid.store.getGateStats(), { ...zeros, gates: 1, repaid: 1 })
  // Without a round stamp the crossing cannot arm and compacts silently.
  const silent = harness({ idle: false, budget: 40 })
  silent.state.rows = [user("u", "x".repeat(800))]
  silent.state.info = { model }
  await silent.controller.onContext({ ...event(), messages: projectHistory(silent.state.rows).messages })
  await setImmediate()
  assert.equal(silent.state.compact, 1)
  assert.deepEqual(await silent.store.getGateStats(), { ...zeros, silent: 1 })
  // A broken stats write is reported and swallowed; the silent trigger still fires.
  const broken = harness({ idle: false, budget: 40 })
  broken.state.rows = [user("u", "x".repeat(800))]
  broken.state.info = { model }
  broken.storage.fail = (key) => key.includes("gate-stats")
  await broken.controller.onContext({ ...event(), messages: projectHistory(broken.state.rows).messages })
  await setImmediate()
  assert.equal(broken.state.compact, 1, "the silent trigger fires despite the stats failure")
})

test("successive main edits update the latest canonical state in the same round without generation", async () => {
  const h = harness({ idle: false, budget: false })
  const seed = await compactRows(h, [user("u1", "work so far"), running("c0")])
  await h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c0", seed), user("u2", "continue")]
  h.state.failGenerate = h.state.failStateless = true
  const first = edit({ state: ["First verified main-model update"], next: ["First next action"] })
  assert.match((await publishCheckpoint(h, first)).output, /Prepared:.*Validated working-state edit staged/)
  assert.equal(await h.store.getCheckpoint("c1"), undefined, "admission is not a committed handoff")
  const result = await compactRows(h, [...h.state.rows, running("c1")])
  assert.equal(result.metadata.nextdcp.author, "main")
  const saved = await h.store.getCheckpoint("c1")
  assert.equal(saved.author, "main")
  assert.deepEqual(saved.working, { ...h.state.handoff.working, ...first.working })
  assert.equal(saved.episode.summary, first.archive)
  assert.deepEqual(saved.episode.rowIDs, ["u2", "assistant"])
  assert.match(await h.store.getRow("assistant"), /checkpoint_now/, "the edit publication is archived like any other original")
  assert.doesNotMatch(result.summary, /Current work and exact next action/, "the cold note is not appended to live working state")
  await h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c1", result)]
  const second = edit({ next: ["Second next action"] })
  assert.match((await publishCheckpoint(h, second, true, { ...toolContext, messageID: "assistant-2", id: "checkpoint-2" })).output, /Prepared:/)
  const next = await compactRows(h, [...h.state.rows, running("c2")])
  assert.deepEqual((await h.store.getCheckpoint("c2")).working, { ...saved.working, next: ["Second next action"] }, "the base includes the first main edit, not just the last compactor output")
  assert.equal(h.state.compact, 0, "both checkpoints applied through their staged cuts, not host admissions")
  assert.equal(h.state.prompts.length, 1, "only the original seed generated")
  assert.equal(h.state.stateless.length, 0)
  const repeated = event(), reloaded = event()
  await h.controller.onCompaction(repeated)
  await createController(h.ctx).onCompaction(reloaded)
  assert.deepEqual(repeated.result, next)
  assert.deepEqual(reloaded.result, next, "durable main authorship and rendering survive reload")
  assert.equal(h.state.prompts.length, 1)
  await setImmediate()
  assert.equal((await h.store.getGateStats()).checkpoints, 2)
})

test("checkpoint_now registers approval-free beside recall, and model-facing copy names no product", async () => {
  const h = harness({ idle: false, budget: 40 })
  const cleanup = await setup(h.ctx)
  try {
    const tool = h.state.tools.get("checkpoint_now")
    assert.equal(tool.description, CHECKPOINT_NOW_DESCRIPTION)
    assert.deepEqual(tool.options, { codemode: false })
    assert.equal(tool.input.required, undefined)
    assert.equal(tool.input.additionalProperties, false)
    assert.deepEqual(tool.input, CHECKPOINT_INPUT)
    assert.deepEqual(Object.keys(tool.input.properties), ["archive", "working", "retire"])
    assert.equal(h.state.permissions.length, 0, "registration prompts no permission")
    for (const text of [CHECKPOINT_NOW_DESCRIPTION, RECALL_DESCRIPTION, budgetGateNotice(12_345, 60_000, 200_000), budgetGateNotice(12_345, 60_000)])
      assert.ok(!text.includes("NextDCP"), "model-facing copy names no product")
    assert.doesNotMatch(RECALL_DESCRIPTION, /Compaction budget|checkpoint_now/, "recall does not repeat the checkpoint tool's scheduling instructions")
    assert.match(budgetGateNotice(12_345, 60_000, 200_000), /~6% of the 200000-token window/)
    assert.ok(!/-token window/.test(budgetGateNotice(12_345, 60_000)), "the window clause is omitted when unknown")
  } finally { cleanup() }
})

test("failed checkpoint admission is explicit, retryable, and cannot leak an unadmitted edit", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "work so far")]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  h.state.failAdmission = true
  const staged = (await publishCheckpoint(h, edit({ ...h.state.handoff.working, objective: "UNADMITTED_EDIT_MUST_NOT_COMMIT" }), false)).output
  assert.match(staged, /^Prepared:/)
  assert.doesNotMatch(staged, /conversation is archived|Checkpointing now/)
  assert.equal(h.state.compact, 0, "staging admits nothing; the failure surfaces at the apply")
  h.state.rows.push(continuation("step-next"))
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1)
  assert.equal((await h.store.getGateStats()).checkpoints, 0, "a staged cut that never landed is not counted")
  assert.match(await h.storage.get("sessions/s/model/warning"), /staged checkpoint could not be applied/, "the refused apply is explicit")
  h.state.failAdmission = false
  const retry = await h.controller.checkpointNow({}, toolContext)
  assert.match(retry, /Prepared:.*Completion is not confirmed/, "a refused apply permits re-staging")
  h.state.rows.push(running("c1"))
  const cut = event()
  await h.controller.onCompaction(cut)
  assert.equal(cut.result.metadata.nextdcp.author, "compactor")
  assert.doesNotMatch(cut.result.summary, /UNADMITTED_EDIT_MUST_NOT_COMMIT/)
  assert.ok(!("queued" in generationData(h.state.prompts.at(-1))), "a refused edit is not attached as a later relevance signal")
  await setImmediate()
  assert.equal((await h.store.getGateStats()).checkpoints, 1, "only the checkpoint that actually landed is counted")
})

test("concurrent checkpoint calls share one staging; a rejected apply is explicit and retryable", async () => {
  for (const fail of [false, true]) {
    const h = harness({ idle: false, budget: false }), entered = deferred(), release = deferred()
    h.state.rows = [user("u1", "work so far")]
    h.ctx.session.compact = async () => {
      h.state.compact++
      entered.resolve()
      await release.promise
      if (fail) throw new Error("SECRET host rejection")
    }
    const first = h.controller.checkpointNow({}, toolContext)
    const second = h.controller.checkpointNow({}, toolContext)
    const outputs = await Promise.all([first, second])
    assert.match(outputs[0], /Prepared:/)
    assert.match(outputs[1], /^Already pending: a staged checkpoint is waiting for your next action./)
    assert.ok(outputs.every((text) => !text.includes("SECRET")))
    assert.equal(h.state.compact, 0, "staging admits nothing")
    // The host records the assistant message that carried the call; the model's next
    // tool steps apply the staged cut once, and concurrent peeks share its admission.
    const boundary = publication({}, toolContext)
    boundary.content[0].state = { status: "completed", input: {}, content: [{ type: "text", text: outputs[0] }] }
    h.state.rows.push(boundary, continuation("step-a"), continuation("step-b"))
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    await entered.promise
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    await setImmediate()
    assert.equal(h.state.compact, 1, "the shared admission never double-cuts")
    release.resolve()
    await setImmediate()
    if (fail) {
      assert.match(await h.storage.get("sessions/s/model/warning"), /staged checkpoint could not be applied/, "rejection is explicit, never silent")
      assert.match(await h.controller.checkpointNow({}, toolContext), /^Prepared:/, "a rejected apply permits re-staging")
    } else assert.equal(await h.storage.get("sessions/s/model/warning"), undefined, "a clean apply warns nothing")
    assert.ok(!(await h.storage.get("sessions/s/model/warning") ?? "").includes("SECRET"), "host errors never leak verbatim")
  }
})

test("checkpoint guard, cooldown, and duplicate-boundary refusal are distinct and never claim completion", async () => {
  const pending = harness({ idle: 1, budget: false })
  pending.state.rows = [user("u1", "work before an admitted idle request")]
  await resume(pending)
  assert.match(await pending.controller.checkpointNow({}, toolContext), /^Already pending:.*guarded as pending; completion is not confirmed/)
  assert.equal(pending.state.compact, 1)
  await pending.controller.onIdle("s") // Clears a stale guard without erasing the duplicate-attempt marker.
  assert.match(await pending.controller.checkpointNow({}, toolContext), /^Not admitted: A recent request covered this same boundary/)
  assert.equal(pending.state.compact, 1)
  await pending.controller.onCompactionFinished("s", true)
  assert.match(await pending.controller.checkpointNow({}, toolContext), /^Not admitted: A failed cut is cooling down/)
  assert.equal(pending.state.compact, 1)
})

test("main edits have no payload cap and oversized merged state commits unchanged without regeneration", async () => {
  const h = harness({ idle: false, budget: false, memory: { budget: 100 } })
  h.state.rows = [user("u1", "work")]
  const input = { archive: `Title: Large edit\n${"coldnote ".repeat(600)}`, working: { ...h.state.handoff.working, state: [`${"😀".repeat(2_100)}${"verified state ".repeat(3_000)}END`] } }
  const { output } = await publishCheckpoint(h, input)
  assert.match(output, /Prepared:.*soft target 100; no truncation or size-only rewrite/)
  const result = await compactRows(h, [...h.state.rows, running("c1")])
  assert.equal(result.metadata.nextdcp.author, "main")
  assert.deepEqual((await h.store.getCheckpoint("c1")).working, input.working)
  assert.equal((await h.store.getCheckpoint("c1")).episode.summary, input.archive.trim())
  assert.match(result.summary, /END/)
  assert.equal(h.state.prompts.length + h.state.stateless.length, 0)
  assert.match(await h.storage.get("sessions/s/model/warning"), /soft budget.*accepted unchanged, without another generation or truncation/)
  assert.ok(!JSON.stringify(CHECKPOINT_INPUT).includes("maxLength"), "no arbitrary edit-string cap is advertised")
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /Admission is not completion/)
  await h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c1", result)]
  const second = await publishCheckpoint(h, edit({ next: ["Measure the whole merged state"] }), true, { ...toolContext, messageID: "second", id: "second-cut" })
  assert.match(second.output, /exceeds the soft target 100/, "a tiny patch is measured together with its carried-forward state")
  await compactRows(h, [...h.state.rows, running("c2")])
  assert.deepEqual((await h.store.getCheckpoint("c2")).working.state, input.working.state)
  assert.equal(h.state.prompts.length + h.state.stateless.length, 0)
})

test("malformed edits are refused before admission and partial seeds explicitly need a full state or {}", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "work")]
  for (const input of [{ keep: "obsolete API" }, edit({ next: ["Partial without a base"] }), { ...edit(h.state.handoff.working), archive: "Missing title" },
    edit({ ...h.state.handoff.working, references: [{ id: "E999", why: "not available" }] })]) {
    assert.match(await h.controller.checkpointNow(input, toolContext), /^Not admitted:/)
    assert.equal(h.state.compact, 0)
  }
  assert.match(await h.controller.checkpointNow({}, toolContext), /Prepared:.*compactor will generate/)
  assert.equal((await compactRows(h, [...h.state.rows, running("c1")])).metadata.nextdcp.author, "compactor")
})

test("direct edits preserve standing constraints and retire only quotes from the new user span", async () => {
  const h = harness({ idle: false, budget: false })
  const quote = "You may stop preserving the exact request."
  h.state.handoff.working.constraints = ["Preserve the exact request."]
  const seed = await compactRows(h, [user("old", `Preserve the exact request. ${quote}`), running("c0")])
  await h.controller.onCompactionFinished("s")
  h.state.rows = [completed("c0", seed)]
  const input = { ...edit({ constraints: [] }), retire: [{ constraint: "Preserve the exact request.", quote }] }
  assert.match(await h.controller.checkpointNow(input, toolContext), /^Not admitted:.*new user message/, "an archived user quote is not new retirement evidence")
  assert.equal(h.state.compact, 0)
  h.state.rows.push(user("new-user", quote))
  assert.match((await publishCheckpoint(h, input)).output, /Prepared:.*edit staged/)
  await compactRows(h, [...h.state.rows, running("c1")])
  const saved = await h.store.getCheckpoint("c1")
  assert.deepEqual(saved.working.constraints, [])
  assert.deepEqual(saved.retiredConstraints, [{ constraint: "Preserve the exact request.", quote, messageID: "new-user" }])
  assert.equal(saved.author, "main")
  assert.equal(h.state.prompts.length, 1)
})

test("new or changed evidence at the actual cut regenerates instead of committing a stale main edit", async () => {
  // Changes inside the staged span or to the publication itself invalidate the edit;
  // work after the staged boundary rides live beside the summary instead (the hold
  // design: later work cannot invalidate a staged authoring).
  for (const change of ["user", "tool-result", "changed-result", "parallel", "base", "publication-error", "queued-user"]) {
    const h = harness({ idle: false, budget: false })
    const read = { id: "read", type: "assistant", content: [{ type: "tool", id: "read-1", name: "read", state: {
      status: "completed", input: { path: "test.ts", time: 1, tokens: 2 }, content: [{ type: "text", text: "Earlier evidence" }],
    } }] }
    h.state.rows = [user("u1", "work"), read]
    const { row, output } = await publishCheckpoint(h, edit({ ...h.state.handoff.working, objective: "STALE_MAIN_EDIT" }))
    assert.match(output, /Prepared:.*edit staged/, change)
    if (change === "user") h.state.rows.push(user("late-user", "LATE_USER_CONSTRAINT"))
    if (change === "tool-result") h.state.rows.push(assistant("late-result", "LATE_TOOL_FINDING"))
    if (change === "changed-result") read.content[0].state.content[0].text = "CHANGED_TOOL_FINDING"
    if (change === "parallel") row.content.push({ type: "tool", id: "parallel", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "PARALLEL_FINDING" }] } })
    if (change === "base") h.state.rows.unshift(native("unexpected-base", "Changed checkpoint"))
    if (change === "publication-error") row.content[0].state = { ...row.content[0].state, status: "error", error: { type: "interrupted", message: "stopped" } }
    if (change === "queued-user") await h.controller.onPrompt(prompt())
    const result = await compactRows(h, [...h.state.rows, running("c1")])
    const rides = change === "user" || change === "tool-result"
    if (rides) {
      assert.equal(result.metadata.nextdcp.author, "main", `${change}: the staged edit survives; later work rides live`)
      assert.equal(h.state.prompts.length, 0, change)
      if (change === "user") assert.equal(result.metadata.keepID, "late-user", "the late user row rides live beside the summary")
    } else {
      assert.equal(result.metadata.nextdcp.author, "compactor", change)
      assert.equal(h.state.prompts.length, 1, change)
      assert.doesNotMatch(result.summary, /STALE_MAIN_EDIT/, change)
      assert.match(await h.storage.get("sessions/s/model/warning"), /compactor will regenerate from the actual cut/, change)
    }
    if (change === "changed-result") assert.match(await h.store.getRow("read"), /CHANGED_TOOL_FINDING/)
  }
})

test("stale, parallel or missing authoring evidence at admission selects explicit compactor regeneration", async () => {
  for (const kind of ["changed", "parallel", "missing"]) {
    const h = harness({ idle: false, budget: false })
    h.state.rows = [user("u1", "work")]
    if (kind !== "missing") await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    if (kind === "changed") h.state.rows.push(user("late-user", "New input before admission"))
    const input = edit(h.state.handoff.working), row = publication(input)
    if (kind === "parallel") row.content.push({ type: "tool", id: "read-parallel", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "NEW_RESULT" }] } })
    h.state.rows.push(row)
    const output = await h.controller.checkpointNow(input, toolContext)
    assert.match(output, /Prepared:.*Edit not staged:.*compactor will generate/, kind)
    row.content[0].state = { status: "completed", input, content: [{ type: "text", text: output }] }
    const result = await compactRows(h, [...h.state.rows, running("c1")])
    assert.equal(result.metadata.nextdcp.author, "compactor", kind)
    assert.equal(h.state.prompts.length, 1, kind)
  }
})

test("a reload before the cut loses the uncommitted proposal and safely regenerates", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "work")]
  await publishCheckpoint(h, edit({ ...h.state.handoff.working, objective: "Uncommitted main proposal" }))
  await h.controller.dispose()
  h.controller = createController(h.ctx)
  const result = await compactRows(h, [...h.state.rows, running("c1")])
  assert.equal(result.metadata.nextdcp.author, "compactor")
  assert.equal(h.state.prompts.length, 1)
  assert.deepEqual((await h.store.getCheckpoint("c1")).working, h.state.handoff.working)
})

test("a concurrent duplicate cannot overwrite the proposal that owns admission", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "work")]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  const input = edit({ ...h.state.handoff.working, objective: "FIRST_EDIT_OWNS_ADMISSION" }), row = publication(input)
  h.state.rows.push(row)
  const first = h.controller.checkpointNow(input, toolContext)
  const second = h.controller.checkpointNow(edit({ ...h.state.handoff.working, objective: "DUPLICATE_MUST_NOT_OVERWRITE" }), toolContext)
  const outputs = await Promise.all([first, second])
  assert.match(outputs[0], /Prepared:.*edit staged/)
  assert.match(outputs[1], /^Already pending: a staged checkpoint is waiting for your next action./)
  row.content[0].state = { status: "completed", input, content: [{ type: "text", text: outputs[0] }] }
  const result = await compactRows(h, [...h.state.rows, running("c1")])
  assert.match(result.summary, /FIRST_EDIT_OWNS_ADMISSION/)
  assert.doesNotMatch(result.summary, /DUPLICATE_MUST_NOT_OVERWRITE/)
  assert.equal(h.state.prompts.length, 0)
  assert.equal(h.state.compact, 0)
})

test("unreadable context, inactive rounds and staged reverts admit no checkpoint", async () => {
  const h = harness()
  h.ctx.session.context = async () => { throw new Error("context unavailable") }
  assert.match(await h.controller.checkpointNow({}, toolContext), /^Failed:.*no checkpoint was requested/)
  h.ctx.session.context = async () => []
  for (const info of [{ time: {} }, { time: { busy: 1 }, revert: { messageID: "u1" } }]) {
    h.state.info = info
    assert.match(await h.controller.checkpointNow({}, toolContext), /^Not admitted:/)
  }
  assert.equal(h.state.compact, 0)
})

test("memory status is strictly read-only, including first use of an unadopted native checkpoint", async () => {
  const h = harness()
  const checkpoint = { ...native("c1", "state".repeat(80)), metadata: { recent: "native tail ".repeat(300) }, time: { created: 1_000 } }
  h.state.rows = [checkpoint, user("u2", "new durable text"), { ...assistant("a2", "answer"), content: [
    { type: "text", text: "answer" }, { type: "reasoning", text: "ephemeral".repeat(100) },
  ] }]
  const before = structuredClone(h.storage.values), writes = h.storage.writes.length
  const status = await h.controller.memoryStatus("s")
  assert.equal(status.checkpoint.id, "c1")
  assert.equal(status.checkpoint.native, true)
  assert.equal(status.summary.chars, checkpoint.summary.length)
  assert.equal(status.summary.tokens, tokens(checkpoint.summary))
  assert.equal(status.recent.tokens, tokens(checkpoint.metadata.recent))
  assert.equal(status.growth.tokens, durableTokens(h.state.rows.slice(1)))
  assert.equal(status.growth.rows, 2)
  assert.equal(status.retained, status.summary.tokens + status.recent.tokens + status.growth.tokens)
  assert.equal(status.budgetScope, "retained")
  assert.equal(status.budget, 50_000)
  assert.deepEqual(status.budgetBounds, { floor: 37_500, start: 50_000, ceiling: 75_000 })
  assert.equal(status.request, undefined, "status does not synthesize a request or invent overhead")
  assert.equal(status.lastCut.action, "completed")
  assert.match(status.lastCut.reason, /trigger unavailable/)
  assert.equal(status.decision, undefined)
  assert.equal(h.storage.writes.length, writes, "no owner save, archive adoption, marker, telemetry or thermostat update")
  assert.deepEqual(h.storage.values, before)
  assert.equal(h.state.compact + h.state.prompts.length + h.state.stateless.length, 0)
})

test("memory separates current durable growth, the last hook projection, and raw provider usage", async () => {
  const h = harness({ idle: false, budget: false })
  const billed = (id, input, text) => ({ ...assistant(id, text), model,
    tokens: { input, output: 37, reasoning: 11, cache: { read: 40, write: 20 } } })
  h.state.rows = [billed("a1", 640, "x".repeat(1_200)), billed("a2", 1_000, ""), user("u1", "new work")]
  const request = { ...event(), system: [{ type: "text", text: "system".repeat(100) }],
    tools: { read: { description: "definition", input: { type: "object" } } },
    messages: projectHistory(h.state.rows).messages, options: { maxTokens: 512 } }
  await h.controller.onContext(request)
  await setImmediate()
  const writes = h.storage.writes.length, status = await h.controller.memoryStatus("s")
  assert.equal(status.scale, usageScale(h.state.rows))
  assert.equal(status.scale, 1.2)
  assert.equal(status.request.total, requestTokens(request) * status.scale)
  assert.ok(Math.abs(status.request.messages + status.request.system + status.request.tools - status.request.total) < 1e-8)
  assert.equal(status.request.outputReserve, 512)
  assert.equal(status.request.ceiling, 100_000 - 512 - 1_024)
  assert.equal(status.budgetMode, "disabled")
  assert.equal(status.budgetScope, "growth")
  assert.equal(status.budget, undefined, "Infinity is never exposed as a JSON number")
  assert.deepEqual(status.usage, { messageID: "a2", input: 1_000, output: 37, reasoning: 11, cacheRead: 40, cacheWrite: 20 })
  assert.deepEqual(status.usage, latestProviderUsage(h.state.rows), "provider counters are not multiplied by the calibration scale")
  h.state.rows.push(assistant("later", "later retained output"))
  const later = await h.controller.memoryStatus("s")
  assert.ok(later.growth.tokens > status.growth.tokens)
  assert.deepEqual(later.request, status.request, "a read never rebuilds or silently refreshes the last hook projection")
  assert.equal(h.storage.writes.length, writes)
})

test("memory accounts for the gate notice without consuming the gate or queuing a cut", async () => {
  for (const notice of ["tail", "system"]) {
    const h = harness({ idle: false, budget: 40, notice })
    h.state.rows = [user("u1", "x".repeat(800))]
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }
    await h.controller.onContext(request)
    await setImmediate()
    const writes = h.storage.writes.length
    const status = await h.controller.memoryStatus("s")
    assert.equal(status.request.total, requestTokens(request), notice)
    assert.equal(status.decision.action, "gate-open")
    assert.equal(status.budgetMode, "explicit")
    assert.equal(status.budgetScope, "growth")
    assert.equal(status.budgetBounds, undefined)
    assert.equal(status.budget, 40)
    assert.equal(h.state.compact, 0)
    await h.controller.memoryStatus("s")
    assert.equal(h.storage.writes.length, writes)
    assert.equal(h.state.compact, 0)
  }
})

test("memory reports cut completion separately from admission and a prepared handoff", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "work so far")]
  assert.match(await h.controller.checkpointNow({}, toolContext), /Prepared:/)
  let status = await h.controller.memoryStatus("s")
  assert.equal(status.compaction, "pending", "a staged cut is pending: it lands with the model's next action")
  assert.equal(status.lastCut, undefined, "an admitted inbox item is not a completed cut")
  h.state.rows.push(running("c1"))
  const cut = event()
  await h.controller.onCompaction(cut)
  status = await h.controller.memoryStatus("s")
  assert.equal(status.compaction, "running")
  assert.equal(status.lastCut, undefined, "a saved handoff is not host completion either")
  h.state.rows = [completed("c1", cut.result)]
  await h.controller.onCompactionFinished("s")
  status = await h.controller.memoryStatus("s")
  assert.deepEqual(status.checkpoint, { id: "c1", episode: "E1", native: false, author: "compactor" })
  assert.equal(status.lastCut.action, "completed")
  assert.equal(status.lastCut.id, "c1")
  assert.match(status.lastCut.reason, /staged checkpoint applied at its call-time boundary/)
  assert.equal(status.compaction, "idle")
  assert.equal(status.growth.tokens, 0)
})

test("memory exposes unknown bounds honestly and does not persist observations across reload", async () => {
  const h = harness({ idle: false })
  h.state.models[0].limit = {}
  h.state.rows = [user("u1", "work")]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  let status = await h.controller.memoryStatus("s")
  assert.equal(status.budgetMode, "unknown")
  assert.equal(status.budget, undefined)
  assert.equal(status.request.ceiling, undefined)
  assert.equal(status.request.window, undefined)
  assert.match(status.decision.reason, /window is unknown/)
  h.state.rows = [native("cp", "old native state")]
  h.controller = createController(h.ctx)
  status = await h.controller.memoryStatus("s")
  assert.equal(status.request, undefined)
  assert.equal(status.decision, undefined)
  assert.equal(status.lastCut.id, "cp")
  assert.match(status.lastCut.reason, /trigger unavailable/)
  await h.controller.dispose()
  await assert.rejects(h.controller.memoryStatus("s"), /archive is closed/)
})

test("memory RPC is read-only and the installed model-visible surface remains two tools", async () => {
  const h = harness(), controller = await install(h.ctx)
  assert.deepEqual([...h.state.rpcs.keys()], ["nextdcp.model", "nextdcp.memory"])
  assert.deepEqual([...h.state.tools.keys()], ["recall", "checkpoint_now"])
  assert.deepEqual(Object.keys(memoryRpc.methods), ["get"])
  const writes = h.storage.writes.length
  assert.equal((await h.state.rpcs.get("nextdcp.memory").get({ sessionID: "s" })).sessionID, "s")
  assert.equal(h.storage.writes.length, writes)
  await controller.onDeleted("s")
  await assert.rejects(h.state.rpcs.get("nextdcp.memory").get({ sessionID: "s" }), /archive is closed/)
})

test("a consumed crossing never re-arms while guarded or cooling down", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  await armGate(h)
  const build = async (note) => {
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }
    await h.controller.onContext(request)
    await setImmediate()
    assert.equal(h.state.compact, 1, note)
    const text = [...request.system.map((part) => part.text ?? ""), ...request.messages.flatMap((message) => (message.content ?? []).map((part) => part.text ?? ""))].join("\n")
    assert.ok(!/Compaction budget gate/.test(text), note)
  }
  await build("the next build pays the consumed crossing")
  await build("the admission guard blocks a re-arm")
  h.controller.onCompactionFinished("s", true)
  await build("a failing compaction cools the trigger down")
})

test("budget: false disables the mid-round trigger entirely", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "x".repeat(360_000))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0, "an explicit false disables the budget trigger entirely")
})

test("provider-reported usage calibrates estimates that face model window limits", async () => {
  const billed = (id, input, cache = { read: 0, write: 0 }) => ({ id, type: "assistant", model,
    tokens: { input, output: 1, reasoning: 0, cache }, content: [{ type: "text", text: "x".repeat(1_200) }] })
  // Billed growth of 360 against 300 estimated tokens of the rows in between: scale 1.2.
  const pair = (cache = { read: 0, write: 0 }) => [billed("a1", 640, cache), { ...billed("a2", 1_000, cache), content: [{ type: "text", text: "" }] }]
  const h = harness({ idle: false, budget: 600 })
  h.state.rows = [...pair(), user("u1", "z".repeat(928))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "532 estimated tokens bill like 638 and pass the 600-token budget")
})

test("the growth gate compares calibrated NEW durable growth with the whole soft budget", async () => {
  const billed = (id, input) => ({ id, type: "assistant", model,
    tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "text", text: "x".repeat(8_000) }] })
  // Billed growth of 4,000 against 2,000 estimated tokens of the row in between: scale 2.
  const calibration = [billed("a1", 640), { ...billed("a2", 4_640), content: [{ type: "text", text: "" }] }]
  const fire = harness({ idle: false, budget: 4_000 })
  fire.state.rows = [...calibration, native("c0"), user("u1", "z".repeat(8_408))]
  await fire.controller.onContext({ ...event(), messages: projectHistory(fire.state.rows).messages })
  await setImmediate()
  await fire.controller.onContext({ ...event(), messages: projectHistory(fire.state.rows).messages })
  await setImmediate()
  assert.equal(fire.state.compact, 1, "2,102 estimated tokens bill like 4,204 and cross the 4,000-token budget")
  const quiet = harness({ idle: false, budget: 4_000 })
  quiet.state.rows = [...calibration, native("c0"), user("u1", "z".repeat(7_600))]
  await quiet.controller.onContext({ ...event(), messages: projectHistory(quiet.state.rows).messages })
  await setImmediate()
  assert.equal(quiet.state.compact, 0, "1,900 estimated tokens bill like 3,800, still below the soft budget")
})

test("unusable usage data falls back to native chars/4 estimate units", async () => {
  const usage = { input: 640, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
  const billed = (id, tokens) => ({ id, type: "assistant", model, tokens, content: [{ type: "text", text: "x".repeat(1_200) }] })
  const tail = { id: "a2", type: "assistant", model, tokens: { ...usage, input: 1_000 }, content: [{ type: "text", text: "" }] }
  const variants = [
    ["a billed ratio outside the clamp", [billed("a1", usage), { ...tail, tokens: { ...usage, input: 1_540 } }]],
    ["a model change across the pair", [billed("a1", usage), { ...tail, model: { providerID: "provider", id: "other" } }]],
    ["a checkpoint across the pair", [billed("a1", usage), native("c1"), tail]],
    ["rows without provider usage", [user("a1", "x".repeat(1_200)), tail]],
  ]
  for (const [name, rows] of variants) {
    const trigger = harness({ idle: false, budget: 600 })
    trigger.state.rows = [...rows, user("u1", "z".repeat(928))]
    await trigger.controller.onContext({ ...event(), messages: projectHistory(trigger.state.rows).messages })
    await setImmediate()
    assert.equal(trigger.state.compact, 0, "unusable usage data never inflates growth past the budget line", name)
  }
})

test("an unknown window announces its disabled budget trigger instead of failing silently", async (t) => {
  const warnings = []
  t.mock.method(console, "warn", (text) => warnings.push(text))
  const h = harness({ idle: false, debug: true })
  h.state.rows = [assistant("a1", "x".repeat(360_000))]
  await armGate(h)
  // The window can vanish mid-round; only the ref's own lookup decides what is known.
  h.state.models = []
  h.state.info.model = { providerID: "provider", id: "switched" }
  await h.controller.onContext({ ...event(), model: { providerID: "provider", id: "switched" }, messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0)
  assert.ok(warnings.some((text) => text.includes("budget trigger is disabled")), "the disabled trigger is logged when debugging")
})

test("system and tool definitions are not new growth while the complete request fits", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.state.rows = [user("u1", "x".repeat(160))]
  const messages = projectHistory(h.state.rows).messages
  for (let i = 0; i < 3; i++) {
    await h.controller.onContext({ ...event(), messages, system: [{ type: "text", text: "system".repeat(10_000) }], tools: { giant: { description: "tool".repeat(10_000), input: {} } } })
    await setImmediate()
  }
  assert.equal(h.state.compact, 0)
})

test("budget compaction requires enough new growth and does not repeat on a large checkpoint", async () => {
  const h = harness({ idle: false, budget: 1_000 })
  const prior = native("prior", "checkpoint")
  const request = (id, text) => ({ ...event(), messages: [
    { id, role: "user", content: [{ type: "text", text: "large retained context ".repeat(500) }] },
    ...(text ? [{ role: "user", content: [{ type: "text", text }] }] : []),
  ] })
  h.state.rows = [prior, user("u1", "x".repeat(900))]
  await h.controller.onContext(request("prior", "x".repeat(900)))
  await setImmediate()
  assert.equal(h.state.compact, 0, "225 new tokens are below the budget; retained context is not new growth")
  h.state.rows = [prior, user("u1", "x".repeat(4_800))]
  await h.controller.onContext(request("prior", "x".repeat(4_800)))
  await setImmediate()
  // The crossing arms at build N and pays at build N+1.
  await h.controller.onContext(request("prior", "x".repeat(4_800)))
  await setImmediate()
  assert.equal(h.state.compact, 1)
  h.controller.onCompactionFinished("s")
  h.state.rows = [native("next", "large checkpoint")]
  for (let i = 0; i < 3; i++) {
    await h.controller.onContext(request("next"))
    await setImmediate()
  }
  assert.equal(h.state.compact, 1, "zero growth after compaction must not loop")
})

test("model window lookups are cached by provider and model, and missing models can retry", async () => {
  const h = harness({ idle: false })
  const models = [
    { ...model, limit: { context: 100_000 } },
    { providerID: "provider", id: "model2", limit: { context: 40_000 } },
    { providerID: "other", id: "model", limit: { context: 80_000 } },
  ]
  let lookups = 0
  h.ctx.model.list = async () => { lookups++; return { data: models } }
  h.state.rows = [user("u1", "small")]
  const check = (ref) => h.controller.onContext({ ...event(), model: ref, messages: projectHistory(h.state.rows).messages })
  await check(model)
  await check({ ...model, variant: "another" })
  assert.equal(lookups, 1)
  await check({ providerID: "provider", id: "model2" })
  await check({ providerID: "other", id: "model" })
  assert.equal(lookups, 3)
  await check({ providerID: "new", id: "late" })
  assert.equal(lookups, 4)
  models.push({ providerID: "new", id: "late", limit: { context: 20_000 } })
  await check({ providerID: "new", id: "late" })
  assert.equal(lookups, 5)
  await check({ providerID: "new", id: "late" })
  assert.equal(lookups, 5)
})

test("unsupported background preparation is refused, while encrypted fallback remains native", async () => {
  const h = harness()
  h.state.rows = [user("u1", "precomputed archive"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "tool-opaque", name: "read", state: { status: "completed", input: { path: "original.ts" }, content: [{ type: "text", text: "archived tool data" }] } },
  ] }]
  const precompute = event()
  await assert.rejects(h.controller.onCompaction(precompute), /requires compaction.background: false/)
  assert.equal(precompute.result, undefined)
  assert.match(await h.store.getRow("u1"), /precomputed archive/)
  assert.equal(h.state.prompts.length, 0)

  h.state.rows = [native("c1", ""), user("u2", "new request"), running("c2")]
  const encrypted = event()
  await h.controller.onCompaction(encrypted)
  assert.equal(encrypted.result, undefined)
  assert.equal(h.state.prompts.length, 0)
  assert.match(await h.controller.recall("s", { query: "new" }), /Native checkpoint has no textual summary/)
  assert.match(await h.controller.recall("s", { id: "tool-opaque" }), /original\.ts[\s\S]*archived tool data/)
})

test("the plugin needs no permission surface, and a broken tool registration fails fast", async (t) => {
  const warnings = []
  t.mock.method(console, "warn", (text) => warnings.push(text))
  const h = harness()
  h.ctx.permission = undefined
  await install(h.ctx)
  assert.deepEqual([...h.state.hooks.keys()], ["prompt", "context", "compaction", "fork"], "the awaited fork hook registers without any permission surface")
  assert.deepEqual([...h.state.tools.keys()], ["recall", "checkpoint_now"], "recall and checkpoint_now are the whole tool surface; the round hold is automatic, not a tool")
  assert.equal(warnings.length, 0, "nothing is optional, so nothing warns")

  const broken = harness()
  broken.ctx.tool.transform = async () => { throw new Error("tool surface changed") }
  await assert.rejects(install(broken.ctx), /tool surface changed/, "a failed registration rejects instead of half-registering")
})

test("setup registers success-only idle events and clears the subscription", async () => {
  const h = harness({ idle: 1, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  let subscribed, closed = false, wake
  const queue = []
  h.ctx.event.subscribe = ({ types, signal }) => (async function* () {
    subscribed = types
    while (!signal.aborted) {
      if (queue.length) yield queue.shift()
      else await new Promise((resolve) => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }) })
    }
    closed = true
  })()
  const push = (type) => {
    if (subscribed.includes(type)) { queue.push({ type, data: { sessionID: "s" } }); wake?.() }
  }
  const cleanup = await setup(h.ctx)
  await setImmediate()
  assert.deepEqual([...h.state.hooks.keys()], ["prompt", "context", "compaction", "fork"])
  assert.deepEqual(subscribed, ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.compaction.failed", "session.deleted"])
  assert.equal(h.state.tool.name, "recall")
  assert.equal(h.state.tool.description, RECALL_DESCRIPTION)
  assert.deepEqual(h.state.tool.options, { codemode: false })
  await h.state.hooks.get("context")({ ...event(), messages: projectHistory(h.state.rows).messages })
  await h.ctx.session.generate({ prompt: WORKING_PROMPT })
  await setImmediate()
  assert.equal(h.state.compact, 0, "Failed, interrupted and transient generation do not trigger idle compaction")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 0, "no successful turn means no deferred marker")
  push("session.execution.succeeded")
  await setImmediate()
  await setImmediate()
  assert.equal(h.state.compact, 0, "a successful round repays the armed gate as a marker, never an unsteered immediate cut")
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: null, after: "u", tokens: 200, threshold: 1 })
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1, "the repayment marker admits at the next prompt, steered by it")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1, "one prompt admits one cut; the marker never re-arms while the boundary holds")
  h.state.rows = [native("checkpoint")]
  push("session.compaction.ended")
  push("session.execution.succeeded")
  await setImmediate()
  await setImmediate()
  assert.equal(h.state.compact, 1, "A compaction-only execution does not loop")
  h.state.rows = [user("u", "an idle session with work")]
  assert.match((await h.state.tool.execute({ query: "idle" }, { sessionID: "s" })).content, /Nothing is archived to search yet/)
  push("session.deleted")
  await setImmediate()
  await setImmediate()
  assert.equal([...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")), false)
  cleanup()
  await setImmediate()
  assert.equal(closed, true)
})

test("event subscription retries after end or error, and stops after cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const warnings = t.mock.method(console, "warn", () => {})
  const h = harness({ idle: 1 })
  h.state.rows = [user("u1", "completed work")]
  let subscriptions = 0, lastSignal
  h.ctx.event.subscribe = ({ signal }) => {
    lastSignal = signal
    subscriptions++
    if (subscriptions === 1) return (async function* () {})()
    if (subscriptions === 2) return (async function* () { throw new Error("stream failure") })()
    if (subscriptions === 3) return (async function* () {
      yield { type: "session.execution.succeeded", data: { sessionID: "s" } }
    })()
    return (async function* () {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
    })()
  }
  const cleanup = await setup(h.ctx)
  await h.state.hooks.get("context")({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(subscriptions, 1)
  t.mock.timers.tick(250)
  await setImmediate()
  assert.equal(subscriptions, 2)
  t.mock.timers.tick(500) // A failed attempt doubles the gap.
  await setImmediate()
  await setImmediate()
  assert.equal(subscriptions, 3)
  t.mock.timers.tick(250) // A delivered event reset the backoff to a prompt retry.
  await setImmediate()
  await setImmediate()
  assert.equal(subscriptions, 4)
  assert.equal(h.state.compact, 0)
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1)
  cleanup()
  await setImmediate()
  t.mock.timers.tick(5_000)
  await setImmediate()
  assert.equal(lastSignal.aborted, true)
  assert.equal(subscriptions, 4)
  assert.ok(warnings.mock.calls.some((call) => String(call.arguments[0]).includes("event subscription")), "stream failures warn without debug mode")
})

test("deletion drains a blocked raw archive write before its final clear and closes reloaded controllers", { timeout: 5_000 }, async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness(), entered = deferred(), release = deferred()
  const set = h.storage.set.bind(h.storage)
  h.storage.set = async (key, value) => {
    if (key === "sessions/s/rows/u1") { entered.resolve(); await release.promise }
    return set(key, value)
  }
  h.state.rows = [user("u1", "private raw material"), running("c1")]
  const cut = event(), compacting = h.controller.onCompaction(cut)
  await entered.promise
  let deleted = false
  const deleting = h.controller.onDeleted("s").then(() => { deleted = true })
  await setImmediate()
  assert.equal(deleted, false, "non-cancellable storage must drain, not race the clear")
  release.resolve()
  await Promise.all([compacting, deleting])
  assert.equal(cut.result, undefined, "a deleted cut cannot publish a handoff")
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")))
  assert.equal(h.storage.values.get("deleted/s"), "cleared")
  const before = h.storage.writes.length
  const reloaded = createController(h.ctx)
  await reloaded.onCompaction(event())
  assert.match(await reloaded.recall("s", { id: "u1" }), /archive is closed/)
  assert.equal(h.storage.writes.length, before, "a durable tombstone prevents resurrection after reload")
})

test("transient deletion scan and remove failures leave a visible pending journal and recover on plugin reload", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {})
  for (const failure of ["scan", "remove"]) {
    const h = harness()
    await compactRows(h, [user("u1", "private raw material"), running("c1")])
    const scan = h.storage.scan.bind(h.storage), remove = h.storage.remove.bind(h.storage)
    let fail = true
    h.storage.scan = async (options) => {
      if (failure === "scan" && fail && options.prefix === "sessions/s/") { fail = false; throw new Error("transient clear scan failure") }
      return scan(options)
    }
    h.storage.remove = async (key) => {
      if (failure === "remove" && fail && key === "sessions/s/rows/u1") { fail = false; throw new Error("transient clear remove failure") }
      return remove(key)
    }
    await assert.rejects(h.controller.onDeleted("s"), /transient clear/)
    assert.equal(h.storage.values.get("deleted/s"), true, "unfinished cleanup remains durable")
    assert.ok([...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")))
    assert.match(await createController(h.ctx).recall("s", { id: "u1" }), /archive is closed/, "pending cleanup still fences stale writers and readers")
    await h.controller.dispose()
    const cleanup = await setup(h.ctx)
    await setImmediate()
    assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")), `${failure}: startup recovery finishes raw deletion`)
    assert.equal(h.storage.values.get("deleted/s"), "cleared")
    assert.equal((await createProjectStore(h.storage, "test").graduatedNotes()).length, 1, "recovery does not duplicate graduated notes")
    await cleanup()
  }
  assert.equal(warnings.mock.calls.filter((call) => String(call.arguments[0]).includes("cleanup remains pending")).length, 2, "failures warn even without debug mode")
})

test("startup deletion recovery retries after a storage outage without blocking plugin registration", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const warnings = t.mock.method(console, "warn", () => {}), h = harness()
  await h.store.archiveRows([user("u1", "raw bytes left by a previous instance")])
  await h.storage.set("deleted/s", true)
  const scan = h.storage.scan.bind(h.storage)
  let fail = true, subscriptions = 0
  h.storage.scan = async (options) => {
    if (fail && options.prefix === "deleted/") { fail = false; throw new Error("journal temporarily unavailable") }
    return scan(options)
  }
  h.ctx.event.subscribe = ({ signal }) => (async function* () {
    subscriptions++
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
  })()
  const cleanup = await setup(h.ctx)
  await setImmediate()
  assert.ok(h.state.tools.has("recall"), "recovery failure does not half-register the plugin")
  assert.equal(subscriptions, 1, "journal recovery never blocks the event stream")
  t.mock.timers.tick(250)
  await setImmediate()
  assert.equal(h.storage.values.get("deleted/s"), "cleared")
  assert.equal(await h.store.getRow("u1"), undefined)
  assert.equal(subscriptions, 1)
  assert.ok(warnings.mock.calls.some((call) => String(call.arguments[0]).includes("deletion recovery")))
  await cleanup()
})

test("one stuck deletion retries independently while other tombstones and live deletion events still clear", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(console, "warn", () => {})
  const h = harness(), remove = h.storage.remove.bind(h.storage)
  for (const id of ["stuck", "z-pending", "live"]) await createStore(h.storage, id).archiveRows([user("u1", "private bytes")])
  for (const id of ["stuck", "z-pending"]) await h.storage.set(`deleted/${id}`, true)
  let fail = true
  h.storage.remove = async (key) => {
    if (fail && key.startsWith("sessions/stuck/")) throw new Error("one namespace is temporarily unavailable")
    return remove(key)
  }
  h.ctx.event.subscribe = ({ signal }) => (async function* () {
    yield { type: "session.deleted", location, data: { sessionID: "live" } }
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
  })()
  const cleanup = await setup(h.ctx)
  await setImmediate()
  assert.equal(h.storage.values.get("deleted/stuck"), true)
  for (const id of ["z-pending", "live"]) {
    assert.equal(h.storage.values.get(`deleted/${id}`), "cleared")
    assert.equal(await createStore(h.storage, id).getRow("u1"), undefined)
  }
  fail = false
  t.mock.timers.tick(250)
  await setImmediate()
  assert.equal(h.storage.values.get("deleted/stuck"), "cleared")
  assert.equal(await createStore(h.storage, "stuck").getRow("u1"), undefined)
  await cleanup()
})

test("unload drains a pending recovery scan but does not start deletion after disposal", { timeout: 5_000 }, async () => {
  const h = harness(), entered = deferred(), release = deferred(), scan = h.storage.scan.bind(h.storage)
  await h.store.archiveRows([user("u1", "pending raw bytes")])
  await h.storage.set("deleted/s", true)
  h.storage.scan = async (options) => {
    if (options.prefix === "deleted/") { entered.resolve(); await release.promise }
    return scan(options)
  }
  const recovering = h.controller.recoverDeleted()
  await entered.promise
  const disposing = h.controller.dispose()
  release.resolve()
  await Promise.all([recovering, disposing])
  assert.match(await h.store.getRow("u1"), /pending raw bytes/)
  assert.equal(h.storage.values.get("deleted/s"), true, "the next live instance owns the remaining cleanup")
})

test("deletion cancels generation and ignores a late non-cooperative model response", { timeout: 5_000 }, async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness(), entered = deferred(), release = deferred()
  let signal
  h.ctx.session.generate = async (_input, options) => {
    signal = options.signal
    entered.resolve()
    await release.promise
    return { text: JSON.stringify(h.state.handoff) }
  }
  h.state.rows = [user("u1", "private generation input"), running("c1")]
  const cut = event(), compacting = h.controller.onCompaction(cut)
  await entered.promise
  const deleting = h.controller.onDeleted("s")
  assert.equal(signal.aborted, true)
  release.resolve()
  await Promise.all([compacting, deleting])
  assert.equal(cut.result, undefined)
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")))
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("projects/test/episodes/")), "an uncommitted generation cannot graduate")
})

test("unload drains a blocked model RPC write, then rejects further RPC work without deleting saved data", { timeout: 5_000 }, async () => {
  const h = harness(), entered = deferred(), release = deferred()
  await h.controller.registerModels()
  const rpc = h.state.rpc, set = h.storage.set.bind(h.storage)
  h.storage.set = async (key, value) => {
    if (key === "sessions/s/model") { entered.resolve(); await release.promise }
    return set(key, value)
  }
  const saving = rpc.set({ sessionID: "s", preference: { mode: "main" } }, errorContext)
  await entered.promise
  let disposed = false
  const disposing = h.controller.dispose().then(() => { disposed = true })
  await setImmediate()
  assert.equal(disposed, false)
  release.resolve()
  await Promise.all([saving, disposing])
  assert.deepEqual(h.storage.values.get("sessions/s/model"), { mode: "main" }, "unload is not session deletion")
  const before = h.storage.writes.length
  await assert.rejects(rpc.set({ sessionID: "s", preference: { mode: "default" } }, errorContext), /archive is closed/)
  assert.equal(h.storage.writes.length, before)
  assert.equal(h.storage.values.get("deleted/s"), undefined)
})

test("deletion also drains RPC writes and a stale RPC cannot recreate its namespace", { timeout: 5_000 }, async () => {
  const h = harness(), entered = deferred(), release = deferred()
  await h.controller.registerModels()
  const rpc = h.state.rpc, set = h.storage.set.bind(h.storage)
  h.storage.set = async (key, value) => {
    if (key === "sessions/s/model") { entered.resolve(); await release.promise }
    return set(key, value)
  }
  const saving = rpc.set({ sessionID: "s", preference: { mode: "main" } }, errorContext)
  await entered.promise
  const deleting = h.controller.onDeleted("s")
  release.resolve()
  await Promise.all([saving, deleting])
  await assert.rejects(rpc.get({ sessionID: "s" }), /archive is closed/)
  assert.ok(![...h.storage.values.keys()].some((key) => key.startsWith("sessions/s/")))
})

test("cleanup cannot process a deletion event that was still resolving its owner", { timeout: 5_000 }, async () => {
  const h = harness(), entered = deferred(), release = deferred()
  await h.store.archiveRows([user("u1", "must survive an unload")])
  h.ctx.session.get = async () => { entered.resolve(); await release.promise; return owned(h.state.info) }
  h.ctx.event.subscribe = () => (async function* () { yield { type: "session.deleted", data: { sessionID: "s" } } })()
  const cleanup = await setup(h.ctx)
  await entered.promise
  const cleaning = cleanup()
  release.resolve()
  await cleaning
  assert.match(await h.store.getRow("u1"), /must survive an unload/)
  assert.equal(h.storage.values.get("deleted/s"), undefined)
})

test("global lifecycle events are isolated by directory, workspace and persisted ownership", async () => {
  const h = harness(), foreign = { directory: "C:/other-project" }
  assert.equal(await h.controller.acceptsEvent("s", foreign), false)
  assert.equal(await h.controller.acceptsEvent("s", { ...location, workspaceID: "other-workspace" }), false)
  assert.equal(await h.controller.acceptsEvent("s", location), true)
  await createStore(h.storage, "foreign").saveOwner({ projectID: "other", location: foreign, subagent: false })
  h.ctx.session.get = async () => { throw new Error("session no longer exists") }
  assert.equal(await h.controller.acceptsEvent("foreign"), false)
  assert.equal(await h.controller.acceptsEvent("unknown"), false, "missing ownership is never guessed from the plugin location")
  await h.store.saveOwner({ projectID: "test", location, subagent: false })
  const reloaded = createController(h.ctx)
  assert.equal(await reloaded.acceptsEvent("s"), true, "recorded ownership survives the session and plugin instance")
})

test("graduated notes never cross actual project ownership even when plugin storage is shared", async () => {
  const a = harness()
  a.state.handoff.archive = "Title: Project A\nalpha_private_project_needle"
  await compactRows(a, [user("u1", "source in project A"), running("c1")])
  await a.controller.onDeleted("s")
  const b = harness({}, a.storage)
  b.ctx.location = { directory: "C:/project-b", project: { id: "project-b" } }
  b.state.info = { ...b.state.info, projectID: "project-b", location: { directory: "C:/project-b" } }
  b.controller = createController(b.ctx)
  assert.doesNotMatch(await b.controller.recall("session-b", { query: "alpha_private_project_needle", layer: "full" }), /(recall id=)?P1 page/)
  assert.match(await b.controller.recall("session-b", { id: "P1" }), /No matching/)
  const same = harness({}, a.storage)
  assert.match(await same.controller.recall("new-a", { query: "alpha_private_project_needle", layer: "full" }), /(recall id=)?P1 page/)
})

test("warm project-note caches observe another instance's graduation without a checkpoint change", async () => {
  const h = harness()
  assert.match(await h.controller.recall("observer", { query: "fresh_graduation_needle", layer: "full" }), /Nothing is archived/)
  await createProjectStore(h.storage, "test").graduate([{ note: "fresh_graduation_needle", end: Date.now() }], "deleted-writer")
  assert.match(await h.controller.recall("observer", { query: "fresh_graduation_needle", layer: "full" }), /(recall id=)?P1 page/)
  assert.match(await h.controller.recall("observer", { id: "P1" }), /fresh_graduation_needle/)
})

test("native fallback facts and standing constraints both reach the next stateless FULL regeneration", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  h.state.handoff.working.constraints = ["Preserve the exact request."]
  const first = await compactRows(h, [user("u1", "initial work. Preserve the exact request."), running("c1")])
  h.state.failGenerate = true
  h.state.rows = [completed("c1", first), user("u2", "native-only facts next"), running("c2")]
  await h.controller.onCompaction(event())
  h.state.failGenerate = false
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  await compactRows(h, [native("c2", "NATIVE_ONLY_FACT: the verified port is 4317"), user("u3", "follow up"), running("c3")])
  const prompt = h.state.stateless.at(-1).prompt
  assert.doesNotMatch(prompt, /Patch mode/)
  assert.match(prompt, /NATIVE_ONLY_FACT: the verified port is 4317/)
  assert.match(prompt, /Preserve the exact request\./)
  assert.equal((await h.store.getCheckpoint("c2")).working, undefined)
  assert.deepEqual((await h.store.getCheckpoint("c3")).working.constraints, ["Preserve the exact request."])
})

test("selected-model failure plus invalid main fallback exhausts exactly TWO attempts, including patch mode", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  const first = await compactRows(h, [user("u1", "seed"), running("c1")])
  addCheap(h)
  await saveModel(h, { mode: "specific", model: cheap })
  h.state.failStateless = true
  h.ctx.session.generate = async ({ prompt }) => { h.state.prompts.push(prompt); return { text: "not JSON" } }
  h.state.rows = [completed("c1", first), user("u2", "later suffix"), running("c2")]
  const cut = event()
  await h.controller.onCompaction(cut)
  assert.equal(cut.result, undefined, "native fallback remains available after the bounded pipeline")
  assert.equal(h.state.stateless.length, 1)
  assert.equal(h.state.prompts.length, 2, "one seed plus one main-model fallback, never a third repair")
  assert.match(h.state.stateless[0].prompt, /Patch mode/)
  assert.doesNotMatch(h.state.prompts.at(-1), /Patch mode/)
  assert.match(h.state.prompts.at(-1), /The previous attempt failed:.*request failed/)
})

test("capacity counts every projected request component even when soft scheduling is disabled", async () => {
  const oversized = "x".repeat(370_000)
  const cases = [
    ["system", (h, request) => { request.system.push({ type: "text", text: oversized }) }],
    ["tool definitions", (h, request) => { request.tools = { giant: { description: oversized, input: { type: "object" } } } }],
    ["checkpoint", (h) => { h.state.rows.unshift(native("prior", oversized)) }],
    ["shell output", (h) => { h.state.rows.push({ id: "shell", type: "shell", command: "build", output: { output: oversized } }) }],
    ["skill", (h) => { h.state.rows.push({ id: "skill", type: "skill", name: "giant", text: oversized }) }],
    ["user skill body", (h) => { h.state.rows[0].skills = [{ name: "giant", text: oversized }] }],
  ]
  for (const [label, prepare] of cases) {
    const h = harness({ idle: false, budget: false }), request = event()
    h.state.rows = [user("u", "some new growth")]
    prepare(h, request)
    request.messages = projectHistory(h.state.rows).messages
    await h.controller.onContext(request)
    await setImmediate()
    assert.equal(h.state.compact, 1, label)
    assert.equal((await h.store.getGateStats()).capacity, 1, label)
  }
})

test("inline compaction does not repeat the checkpoint or user snippets already in its session context", async () => {
  const h = harness()
  h.state.handoff.working.constraints = []
  const first = await compactRows(h, [user("u1", "first task"), running("c1")])
  h.state.handoff.working.state = ["Verified current fact"]
  await compactRows(h, [completed("c1", first), user("u2", "later task"), running("c2")])
  const data = generationData(h.state.prompts.at(-1))
  assert.ok(!("previous" in data), "native generation already sees the rendered canonical checkpoint")
  assert.ok(!("users" in data), "quote resolution belongs to the validator, not a duplicate user directory")
})

test("generated host-derived constraints are repaired, never silently promoted into permanent memory", async () => {
  const h = harness()
  const constraint = "Use the elevation helper for administrator tasks."
  h.state.queue = [{ ...h.state.handoff, working: { ...h.state.handoff.working, constraints: [constraint] } }]
  const result = await compactRows(h, [user("u1", "Review this plugin."), { id: "host", type: "system", text: constraint }, running("c1")])
  assert.equal(h.state.prompts.length, 2)
  assert.match(h.state.prompts[1], /previous attempt failed: New standing constraints/)
  assert.deepEqual((await h.store.getCheckpoint("c1")).working.constraints, [])
  assert.doesNotMatch(result.summary, /elevation helper/)
  assert.match(await h.store.getRow("host"), /elevation helper/, "the original evidence is still archived")
})

test("the first checkpoint recognizes a real question reply without repair or native fallback", async () => {
  const quote = "don't hesitate to search for insights online whenever useful."
  for (const stateless of [false, true]) {
    const h = harness({ idle: false, budget: false })
    if (stateless) { addCheap(h); await saveModel(h, { mode: "specific", model: cheap }) }
    h.state.handoff.working.constraints = [quote]
    const reply = questionRow([[`It seems you're acting in quite a generic way, ${quote}`]], "call_human_reply")
    reply.content[0].state.content = [{ type: "text", text: `User answered: ${quote}` }]
    h.state.rows = [user("u1", "Investigate the model-list mismatch."), reply]
    assert.match(await h.controller.checkpointNow({}, toolContext), /Prepared:/)
    const result = await compactRows(h, [...h.state.rows, running("c1")])
    assert.equal(result.metadata.nextdcp.author, "compactor")
    assert.deepEqual((await h.store.getCheckpoint("c1")).working.constraints, [quote])
    assert.equal(h.state.prompts.length, stateless ? 0 : 1)
    assert.equal(h.state.stateless.length, stateless ? 1 : 0)
    assert.equal(h.state.warnings.length, 0)
    assert.match(await h.store.getRow(reply.id), /metadata.*answers/)
    assert.ok((await h.controller.recall("s", { id: "call_human_reply" })).includes(quote), "the source call remains recallable")
    if (stateless) assert.ok(h.state.stateless[0].prompt.includes(quote), "the selected model sees the complete original reply")
  }
})

test("main-authored seeds and later retirements share structured human-answer proof at admission and cut", async () => {
  const h = harness({ idle: false, budget: false })
  const quote = "don't hesitate to search for insights online whenever useful."
  h.state.rows = [user("u1", "Investigate the model list."), questionRow([[quote]])]
  h.state.failGenerate = h.state.failStateless = true
  const input = edit({ ...h.state.handoff.working, constraints: [quote] })
  assert.match((await publishCheckpoint(h, input)).output, /Prepared:.*edit staged/)
  const first = await compactRows(h, [...h.state.rows, running("c1")])
  assert.equal(first.metadata.nextdcp.author, "main")
  assert.deepEqual((await h.store.getCheckpoint("c1")).working.constraints, [quote])
  await h.controller.onCompactionFinished("s")
  const withdrawal = "You may stop remembering my web-search preference."
  h.state.rows = [completed("c1", first), questionRow([[withdrawal]], "call_withdrawal")]
  const next = { ...edit({ constraints: [] }), retire: [{ constraint: quote, quote: withdrawal }] }
  assert.match((await publishCheckpoint(h, next, true, { ...toolContext, messageID: "assistant-2", id: "checkpoint-2" })).output, /Prepared:.*edit staged/)
  const result = await compactRows(h, [...h.state.rows, running("c2")])
  const saved = await h.store.getCheckpoint("c2")
  assert.equal(result.metadata.nextdcp.author, "main")
  assert.deepEqual(saved.working.constraints, [])
  assert.deepEqual(saved.retiredConstraints, [{ constraint: quote, quote: withdrawal, messageID: "call_withdrawal" }])
  assert.equal(h.state.prompts.length + h.state.stateless.length, 0)
})

test("archived and post-boundary question answers cannot authorize new protected constraints", async () => {
  const quote = "Always ask before publishing."
  for (const position of ["archived", "future"]) {
    const h = harness({ idle: false, budget: false }), reply = questionRow([[quote]])
    const first = await compactRows(h, [user("u1", "First task"), reply, running("c1")])
    await h.controller.onCompactionFinished("s")
    h.state.rows = [reply, completed("c1", first), user("u2", "Continue the task.")]
    assert.match(await h.controller.checkpointNow(edit({ constraints: [quote] }), toolContext), /^Not admitted: New standing constraints/)
    h.state.queue = [{ ...h.state.handoff, working: { ...h.state.handoff.working, constraints: [quote] } }]
    const rows = position === "archived" ? [...h.state.rows, running("c2")]
      : [completed("c1", first), user("u2", "Continue the task."), running("c2"), reply]
    const result = await compactRows(h, rows)
    assert.equal(result.metadata.nextdcp.author, "compactor")
    assert.deepEqual((await h.store.getCheckpoint("c2")).working.constraints, [])
    assert.equal(h.state.prompts.length, 3, "the second cut must repair the unsupported proposal")
  }
})

test("a metadata-only human-answer change selects regeneration, both before admission and at the cut", async () => {
  for (const timing of ["admission", "cut"]) {
    const h = harness({ idle: false, budget: false })
    const reply = questionRow([["Original human preference"]])
    h.state.rows = [user("u1", "Investigate this issue."), reply]
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    const change = () => { reply.content[0].state.metadata.answers[0][0] = "Changed human preference" }
    if (timing === "admission") change()
    const input = edit({ ...h.state.handoff.working, objective: "STALE_QUESTION_EDIT" })
    const { output } = await publishCheckpoint(h, input, false)
    assert.match(output, timing === "admission" ? /Prepared:.*Edit not staged:.*evidence changed/ : /Prepared:.*edit staged/)
    if (timing === "cut") change()
    const result = await compactRows(h, [...h.state.rows, running("c1")])
    assert.equal(result.metadata.nextdcp.author, "compactor")
    assert.doesNotMatch(result.summary, /STALE_QUESTION_EDIT/)
    assert.equal(h.state.prompts.length, 1)
  }
})

test("question-shaped metadata from another tool still fails strict compaction validation", async () => {
  const h = harness({ idle: false, budget: false }), quote = "Always ask before publishing."
  const reply = questionRow([[quote]])
  reply.content[0].name = "read"
  const invalid = { ...h.state.handoff, working: { ...h.state.handoff.working, constraints: [quote] } }
  h.state.queue = [invalid, invalid]
  h.state.rows = [user("u1", "Review this plugin."), reply, running("c1")]
  const cut = event()
  await h.controller.onCompaction(cut)
  assert.equal(cut.result, undefined, "unsupported rules are neither promoted nor silently demoted")
  assert.equal(await h.store.getCheckpoint("c1"), undefined)
  assert.equal(h.state.prompts.length, 2)
  assert.match(await h.storage.get("sessions/s/model/warning"), /New standing constraints.*native OpenCode compaction/)
})

test("a direct unsupported constraint is rejected before admission, without requesting another model", async () => {
  const h = harness()
  h.state.rows = [user("u1", "Review this plugin.")]
  const input = edit({ ...h.state.handoff.working, constraints: ["Only use immutable releases."] })
  assert.match((await publishCheckpoint(h, input)).output, /^Not admitted: New standing constraints/)
  assert.equal(h.state.compact, 0)
  assert.equal(h.state.prompts.length + h.state.stateless.length, 0)
})

test("native fallback's protected constraints reach inline generation without copying its summary", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  const constraint = "Always ask before publishing."
  h.state.handoff.working.constraints = [constraint]
  const first = await compactRows(h, [user("u1", constraint), running("c1")])
  h.state.failGenerate = true
  h.state.rows = [completed("c1", first), user("u2", "later work"), running("c2")]
  await h.controller.onCompaction(event())
  h.state.failGenerate = false
  h.state.handoff.working.constraints = []
  await compactRows(h, [native("c2", "NATIVE_ONLY_FACT: the verified port is 4317"), running("c3")])
  const data = generationData(h.state.prompts.at(-1))
  assert.deepEqual(data.constraints, [constraint])
  assert.ok(!("previous" in data))
  assert.doesNotMatch(h.state.prompts.at(-1), /NATIVE_ONLY_FACT/)
  assert.deepEqual((await h.store.getCheckpoint("c3")).working.constraints, [constraint])
})

test("a queued relevance hint cannot authorize a new standing constraint", async () => {
  const h = harness({ idle: 1 })
  const constraint = "Always ask before publishing."
  h.state.rows = [user("u1", "finished this task")]
  await idle(h)
  await h.controller.onPrompt({ ...prompt(), prompt: { text: constraint, files: [] } })
  h.state.queue = [{ ...h.state.handoff, working: { ...h.state.handoff.working, constraints: [constraint] } }]
  const result = await compactRows(h, [user("u1", "finished this task"), running("c1")])
  assert.equal(h.state.prompts.length, 2, "the queued text is not an admitted user source")
  assert.doesNotMatch(result.summary, /Always ask before publishing/)
  assert.deepEqual((await h.store.getCheckpoint("c1")).working.constraints, [])
})

test("the next build rechecks complete capacity before honoring an already-held round", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.storage.values.set("projects/test/thermostat", JSON.stringify({ "provider/model": {
    version: THERMOSTAT_VERSION, growth: 1, span: 28, cycles: 3, budget: 37_500,
  } }))
  h.state.rows = [user("u", "x".repeat(800)), assistant("a", "y".repeat(800))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate() // Gate telemetry is deliberately non-blocking.
  assert.equal((await h.store.getGateStats()).spikeHeld, 1)
  assert.equal(h.state.compact, 0)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages,
    system: [{ type: "text", text: "new instructions ".repeat(25_000) }] })
  await setImmediate()
  assert.equal(h.state.compact, 1, "a prior hold cannot hide later request growth")
  assert.equal((await h.store.getGateStats()).capacity, 1)
})

test("capacity reserves explicit output and honors a model's separate input limit", async () => {
  for (const separateInput of [false, true]) {
    const h = harness({ idle: false, budget: false })
    h.state.rows = [assistant("a", "x".repeat(40_000))]
    if (separateInput) h.state.models[0].limit.input = 9_000
    await h.controller.onContext({ ...event(), options: separateInput ? {} : { maxTokens: 90_000 }, messages: projectHistory(h.state.rows).messages })
    await setImmediate()
    assert.equal(h.state.compact, 1, separateInput ? "input ceiling" : "explicit output reserve")
  }
})

test("recent tool errors postpone a soft cut instead of falling through to silent compaction", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.state.rows = [user("u", "x".repeat(800)), { id: "a", type: "assistant", time: { created: Date.now() }, content: [
    { type: "tool", id: "failed-call", name: "read", state: { status: "error", input: { path: "bad" }, error: "still diagnosing" } },
  ] }]
  for (let build = 0; build < 2; build++) await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 0)
  assert.equal((await h.store.getGateStats()).gates, 0)
  h.state.rows.push(assistant("fixed", "the diagnostic is resolved"))
  await armGate(h)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1)
})

test("fresh same-round tool results get working room immediately; pasted or generated text does not", async () => {
  for (const kind of ["read", "user", "production"]) {
    const h = wideHarness({ idle: false })
    h.state.info = { model, time: { busy: 1_000 } }
    h.state.rows = kind === "read" ? [timed(user("u", "review these files"), 1_000), readStep("read", 880_000, 1_001)]
      : [timed(kind === "user" ? user("u", "x".repeat(880_000)) : assistant("a", "x".repeat(880_000)), 1_001)]
    if (kind !== "read") { await armGate(h); continue }
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }, length = request.messages.length
    await h.controller.onContext(request)
    await setImmediate()
    const status = await h.controller.memoryStatus("s")
    assert.equal(h.state.compact, 0)
    assert.equal(request.messages.length, length, "the build carrying the read gets no gate or reminder")
    assert.equal(status.budgetBaseline, 200_000)
    assert.ok(status.liveAllowance >= 300_000 && status.budget === status.budgetBaseline + status.liveAllowance)
    assert.match(status.decision.reason, /temporary working room/)
  }
})

test("complete-request capacity still wins over fresh-evidence room", async () => {
  const h = wideHarness({ idle: false })
  h.state.info = { model, time: { busy: 1_000 } }
  h.state.rows = [timed(user("u", "read everything"), 1_000), readStep("read", 3_800_000, 1_001)]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1)
  assert.equal((await h.store.getGateStats()).capacity, 1)
})

test("fresh evidence cancels a gate it made stale instead of repaying it at round end", async () => {
  const h = wideHarness({ idle: false })
  h.state.info = { model, time: { busy: 1_000 } }
  h.state.rows = [timed(user("u", "x".repeat(840_000)), 1_000)]
  await armGate(h)
  h.state.rows.push(readStep("read", 120_000, 1_001))
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  h.controller.onRoundEnded("s")
  await setImmediate()
  assert.equal(h.state.compact, 0)
  assert.deepEqual(await h.store.getGateStats(), { gates: 1, silent: 0, continued: 0, repaid: 0, spikeHeld: 0, checkpoints: 0, capacity: 0 })
})

test("evidence room ages by assistant steps and ends at a successful turn end, not an interruption", async () => {
  const aged = wideHarness({ idle: false })
  aged.state.info = { model, time: { busy: 1_000 } }
  aged.state.rows = [readStep("read", 880_000, 1_001), ...Array.from({ length: 28 }, (_, index) => timed(assistant(`step-${index}`, "short"), 1_002 + index))]
  await armGate(aged)
  const next = wideHarness({ idle: false })
  next.state.info = { model, time: { busy: 5_000 } }
  next.state.rows = [readStep("read", 880_000, 1_001), timed({ id: "idle", type: "idle", outcome: "succeeded" }, 1_002), timed(user("u2", "continue"), 5_000)]
  await armGate(next)
  const resumed = wideHarness({ idle: false })
  resumed.state.info = { model, time: { busy: 5_000 } }
  resumed.state.rows = [readStep("read", 880_000, 1_001), timed({ id: "idle", type: "idle", outcome: "interrupted" }, 1_002), timed(user("u2", "go on"), 5_000)]
  const request = { ...event(), messages: projectHistory(resumed.state.rows).messages }, length = request.messages.length
  await resumed.controller.onContext(request)
  assert.equal(request.messages.length, length, "an interruption or steering continues the same work")
  assert.match((await resumed.controller.memoryStatus("s")).decision.reason, /temporary working room/)
})

test("a pause after substantial work suggests one checkpoint; rebuilds replay it, and progress spaces repeats", async () => {
  const h = wideHarness({ idle: false })
  h.state.info = { model, time: { busy: 1_000 } }
  h.state.rows = [timed(user("u", "investigate"), 1_000), readStep("read-1", 240_000, 1_001), conclusionStep("conclude-1", 1_002)]
  const build = async () => {
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }, length = request.messages.length
    await h.controller.onContext(request)
    await setImmediate()
    return request.messages.length > length ? request.messages.at(-1).content[0].text : undefined
  }
  const first = await build()
  assert.match(first, /^\[Checkpoint opportunity — automated notice, not a user message\]/)
  assert.match(first, /Paused after ~60k tokens since the last checkpoint/)
  assert.match(first, /checkpoint_now as the ONLY tool now/)
  assert.match(first, /Else continue; nothing is queued/)
  assert.doesNotMatch(first, /safeguard/, "the safeguard is not near")
  assert.equal((await h.controller.memoryStatus("s")).decision.action, "reminded")
  assert.equal(await build(), first, "an unanswered identical rebuild replays the same guidance")
  h.state.rows.push(readStep("small-read", 400, 1_003))
  assert.equal(await build(), undefined, "work continuing is not another pause")
  h.state.rows.push(conclusionStep("conclude-2", 1_004))
  assert.equal(await build(), undefined, "a second pause needs substantial new work")
  h.state.rows.push(readStep("read-2", 240_000, 1_005), conclusionStep("conclude-3", 1_006))
  assert.match(await build(), /Paused after ~120k tokens/)
  assert.equal(h.state.compact, 0, "guidance never queues a cut")
})

test("reminders wait for unseen results, failures or human input and never rewrite the cached system prefix", async () => {
  const cases = [
    ["unseen result", (rows) => rows.push(readStep("fresh", 60_000, 1_002, "c".repeat(400)))],
    ["failed step", (rows) => rows.push({ ...conclusionStep("failed", 1_002), content: [{ type: "text", text: "c".repeat(400) },
      { type: "tool", id: "failed-call", name: "bash", state: { status: "error", input: {}, error: "failed" } }] })],
    ["steering message", (rows) => rows.push(conclusionStep("conclude", 1_002), timed(user("steer", "also handle X"), 1_003))],
    ["reply to the user", (rows) => rows.push(timed(user("steer", "also handle X"), 1_002), conclusionStep("reply", 1_003))],
    ["pending question", (rows) => rows.push({ ...conclusionStep("ask", 1_002), content: [{ type: "text", text: "c".repeat(400) },
      { type: "tool", id: "ask-call", name: "question", state: { status: "completed", input: {}, content: [{ type: "text", text: "answer" }] } }] })],
    ["system notice", (rows) => rows.push(conclusionStep("conclude", 1_002)), { notice: "system" }],
  ]
  for (const [label, prepare, options = {}] of cases) {
    const h = wideHarness({ idle: false, ...options })
    h.state.info = { model, time: { busy: 1_000 } }
    h.state.rows = [timed(user("u", "investigate"), 1_000), readStep("read", 240_000, 1_001)]
    prepare(h.state.rows)
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }, length = request.messages.length
    await h.controller.onContext(request)
    assert.equal(request.messages.length, length, label)
    assert.equal(request.system.length, 0, label)
    assert.notEqual((await h.controller.memoryStatus("s")).decision.action, "reminded", label)
  }
})

test("a finished round is left to next-prompt scheduling; a mid-round pause names a near safeguard", async () => {
  const finished = wideHarness({ idle: false })
  finished.state.info = { model, time: { busy: 5_000 } }
  finished.state.rows = [timed(user("u1", "review"), 1_000), readStep("read", 640_000, 1_001), timed(assistant("final", "c".repeat(800)), 1_002),
    timed({ id: "idle", type: "idle", outcome: "succeeded" }, 1_003), timed(user("u2", "next request"), 5_000)]
  const first = { ...event(), messages: projectHistory(finished.state.rows).messages }, length = first.messages.length
  await finished.controller.onContext(first)
  assert.equal(first.messages.length, length, "the user's next prompt steers any due compaction; no extra model step")
  const h = wideHarness({ idle: false })
  h.state.info = { model, time: { busy: 1_000 } }
  h.state.rows = [timed(user("u", "x".repeat(640_000)), 1_000), readStep("read", 80_000, 1_001), conclusionStep("conclude", 1_002)]
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  const text = request.messages.at(-1).content[0].text
  assert.match(text, /Paused after ~180k tokens/)
  assert.match(text, /; overdue safeguard ~230k is near\./)
  assert.equal(h.state.compact, 0)
})

test("near safe capacity warns once per checkpoint without queuing a cut", async () => {
  const h = harness({ idle: false })
  h.state.info = { model, time: { busy: 1_000 } }
  h.state.rows = [timed(user("u", "read"), 1_000), readStep("read", 320_000, 1_001)]
  const build = async () => {
    const request = { ...event(), messages: projectHistory(h.state.rows).messages }, length = request.messages.length
    await h.controller.onContext(request)
    return { text: request.messages.length > length ? request.messages.at(-1).content[0].text : undefined, request }
  }
  const { text, request } = await build()
  assert.match(text, /^\[Checkpoint headroom — automated notice, not a user message\]/)
  assert.match(text, /Projected input ~80k of ~91k safe tokens/)
  assert.ok(requestTokens(request) <= 90_784, "the warning itself fits safe capacity")
  h.state.rows.push(conclusionStep("conclude", 1_002))
  assert.equal((await build()).text, undefined, "capacity is warned once; a pause right after needs new work too")
  assert.equal(h.state.compact, 0)
})

test("baseline learning excludes returned evidence; temporary room handles bulk reads", async (t) => {
  t.mock.method(console, "warn", () => {})
  const h = harness()
  h.state.rows = [user("u0", "warmup")]
  await h.controller.onContext(event())
  await compactRows(h, [user("u1", "task"), readStep("read", 800_000, 1), running("c1")])
  const learned = (await awaitThermostat(h, 1))["provider/model"]
  assert.equal(learned.cycles, 1)
  assert.ok(learned.growth < 100, "200k tokens of read output did not become routine growth")
})

test("old 430k learning reseeds to 200k without any status write, while versioned learning survives reload", async () => {
  const h = wideHarness({ idle: false })
  h.storage.values.set("projects/test/thermostat", JSON.stringify({ "provider/model": {
    growth: 10_000, generated: 500, demand: 0.8, span: 20, cycles: 10, budget: 429_982,
  } }))
  h.state.rows = [user("u", "x".repeat(840_000))]
  const writes = h.storage.writes.length
  const status = await h.controller.memoryStatus("s")
  assert.equal(status.budget, 200_000)
  assert.deepEqual(status.budgetBounds, { floor: 150_000, start: 200_000, ceiling: 300_000 })
  assert.equal(h.storage.writes.length, writes, "reseed on read does not rewrite project state")
  await armGate(h)
  await h.controller.dispose()
  h.storage.values.set("projects/test/thermostat", JSON.stringify({ "provider/model": {
    version: THERMOSTAT_VERSION, growth: 10_000, span: 20, cycles: 2, budget: 250_000,
  } }))
  const reloaded = createController(h.ctx)
  try { assert.equal((await reloaded.memoryStatus("s")).budget, 250_000) }
  finally { await reloaded.dispose() }
})

test("automatic overdue cuts count the current summary and native tail, not just new growth or old archived rows", async () => {
  const h = wideHarness({ idle: false })
  h.state.rows = [user("archived", "old".repeat(400_000)), { ...native("c1", "s".repeat(40_000)), metadata: { recent: "t".repeat(600_000) } },
    user("new", "x".repeat(180_000))]
  const request = { ...event(), messages: projectHistory(h.state.rows.slice(1)).messages }
  await h.controller.onContext(request)
  const status = await h.controller.memoryStatus("s")
  assert.equal(status.growth.tokens, 45_000)
  assert.equal(status.retained, 205_000)
  assert.equal(status.retained, retainedTokens(h.state.rows))
  assert.equal(status.decision.action, "gate-open")
  assert.match(request.messages.at(-1).content[0].text, /Retained conversation ~205000.*adaptive safeguard 200000/)
})

test("neither learned rate spikes nor recent tool errors postpone an overdue automatic safeguard", async () => {
  for (const error of [false, true]) {
    const h = wideHarness({ idle: false })
    h.storage.values.set("projects/test/thermostat", JSON.stringify({ "provider/model": {
      version: THERMOSTAT_VERSION, growth: 1, span: 28, cycles: 3, budget: 200_000,
    } }))
    h.state.rows = [user("u", "x".repeat(840_000)), { id: "a", type: "assistant", time: { created: Date.now() }, content: [
      { type: "tool", id: "latest-call", name: "read", state: error
        ? { status: "error", input: {}, error: "still diagnosing" }
        : { status: "completed", input: {}, content: [{ type: "text", text: "latest result" }] } },
    ] }]
    await armGate(h)
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    await setImmediate()
    assert.equal(h.state.compact, 1)
    assert.equal((await h.store.getGateStats()).spikeHeld, 0)
  }
})

test("unchanged over-threshold summary/tail never recompacts alone; a reasoning-only row is durable growth once", async () => {
  const bare = wideHarness()
  bare.state.rows = [{ ...native("c1", "s".repeat(40_000)), metadata: { recent: "t".repeat(1_200_000) } }]
  for (let build = 0; build < 3; build++) {
    await bare.controller.onContext({ ...event(), messages: projectHistory(bare.state.rows).messages })
    await bare.controller.onIdle("s")
  }
  assert.equal((await bare.controller.memoryStatus("s")).growth.tokens, 0, "no rows after the checkpoint means no growth, however large the tail")
  assert.equal(await bare.store.getDeferredCompaction(), undefined)
  assert.equal((await bare.store.getGateStats()).gates, 0)
  assert.equal(bare.state.compact, 0)

  const h = wideHarness()
  h.state.rows = [{ ...native("c1", "s".repeat(40_000)), metadata: { recent: "t".repeat(1_200_000) } },
    { ...assistant("reasoning-only"), content: [{ type: "reasoning", text: "r".repeat(40_000) }] }]
  for (let build = 0; build < 3; build++) {
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    await h.controller.onIdle("s")
    // Repeated builds of unchanged rows must not compound: the marker keeps the
    // same values, and no compaction is ever requested without a prompt.
    assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: "c1", after: "reasoning-only", tokens: 320_000, threshold: 200_000 })
    assert.equal(h.state.compact, 0)
  }
  const status = await h.controller.memoryStatus("s")
  assert.equal(status.retained, 320_000)
  assert.equal(status.growth.tokens, 10_000, "a replayed reasoning part is retained conversation, not free")
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 1, "the overdue safeguard admits at the next prompt; the loop guard is the prompt gate, not undercounting")
})

test("automatic bounds honor model input limits and the last request's explicit output reserve", async () => {
  for (const separateInput of [false, true]) {
    const h = wideHarness({ idle: false })
    if (separateInput) h.state.models[0].limit.input = 180_000
    h.state.rows = [user("small", "current work")]
    await h.controller.onContext({ ...event(), options: separateInput ? {} : { maxTokens: 870_000 }, messages: projectHistory(h.state.rows).messages })
    const status = await h.controller.memoryStatus("s")
    assert.equal(status.budget, 178_976)
    assert.equal(status.budgetBounds.ceiling, status.request.ceiling)
  }
})

test("the default idle path shares the live soft threshold instead of imposing an independent 25k cut", async () => {
  const h = harness()
  h.state.rows = [assistant("a", "x".repeat(120_000))]
  await idle(h)
  assert.equal(await h.store.getDeferredCompaction(), undefined, "30k does not trip the old default idle threshold")
  h.state.rows.push(assistant("final", "y".repeat(100_000)))
  await h.controller.onIdle("s")
  const marker = await h.store.getDeferredCompaction()
  assert.equal(marker.tokens, 55_000)
  assert.equal(marker.threshold, 50_000)
})

test("default idle scheduling includes the native tail and final output, then defers admission until the next prompt", async () => {
  const h = wideHarness()
  h.state.rows = [{ ...native("c1", "s".repeat(40_000)), metadata: { recent: "t".repeat(600_000) } }, user("u", "x".repeat(140_000))]
  await idle(h)
  assert.equal(await h.store.getDeferredCompaction(), undefined, "195k retained is below the 200k safeguard")
  h.state.rows.push(assistant("final", "y".repeat(80_000)))
  await h.controller.onIdle("s")
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: "c1", after: "final", tokens: 215_000, threshold: 200_000 })
  assert.equal(h.state.compact, 0, "idle never requests a summary")
  await h.controller.dispose()
  const reloaded = createController(h.ctx)
  try {
    await reloaded.onPrompt(prompt())
    assert.equal(h.state.compact, 1, "the retained-scope marker survives a controller reload")
  } finally { await reloaded.dispose() }
})

test("direct row recall forwards native media, not just episode-level recall", async () => {
  const h = harness()
  const result = await compactRows(h, [{ ...user("msg_media", "inspect the diagram"), files: [
    { mime: "image/png", name: "diagram.png", data: "AAAA" },
  ] }, running("c1")])
  h.state.rows = [completed("c1", result)]
  for (const id of ["msg_media", "E1 layer tools"]) {
    const content = await h.controller.recall("s", { id })
    assert.ok(Array.isArray(content), id)
    assert.ok(content.some((part) => part.type === "file" && part.uri === "data:image/png;base64,AAAA" && part.mime === "image/png"), id)
  }
})

test("search labels retained branch originals outside the active episode chain", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u1", "active work"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "active-call", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "active_original_needle" }] } },
  ] }, running("c1")])
  await compactRows(h, [completed("c1", first), user("u2", "later reverted"), { id: "a2", type: "assistant", content: [
    { type: "tool", id: "reverted-call", name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "reverted_original_needle" }] } },
  ] }, { id: "reverted-shell", type: "shell", command: "build", output: { output: "reverted_shell_needle" } }, running("c2")])
  h.state.rows = [completed("c1", first), user("live", "continue the earlier branch")]
  assert.doesNotMatch(await h.controller.recall("s", { query: "active_original_needle", layer: "tools" }), /outside the active/)
  for (const query of ["reverted_original_needle", "reverted_shell_needle"]) {
    assert.match(await h.controller.recall("s", { query, layer: "tools" }), /outside the active episode chain; may be from a reverted branch/)
  }
  assert.match(await h.controller.recall("s", { id: "reverted-call" }), /reverted_original_needle/, "the original remains fetchable")
  for (const page of [Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    assert.match(await h.controller.recall("s", { query: "active", page }), /positive safe integer/)
  }
})
