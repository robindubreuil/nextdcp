import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { projectHistory } from "./support/history.ts"
import { WORKING_PROMPT, RECALL_DESCRIPTION, DEFER_COMPACTION_DESCRIPTION } from "../src/prompts.ts"
import { tokens } from "../src/tokens.ts"
import { createController, install } from "../src/runtime.ts"
import { createStore } from "../src/store.ts"

// Node's dependency-free tests replace only Plugin.define, whose v2.2.0 implementation
// returns its argument. The isolated-server test uses the real installed SDK.
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
const model = { providerID: "provider", id: "model" }
const event = (sessionID = "s") => ({ sessionID, model, system: [], tools: {}, messages: [] })
const completed = (id, result) => ({ id, type: "compaction", status: "completed", summary: result.summary, metadata: result.metadata })
const native = (id, summary = "Native fallback summary") => ({ id, type: "compaction", status: "completed", summary })

function harness(options = {}) {
  const storage = new MemoryStorage()
  const state = {
    rows: [], prompts: [], stateless: [], compact: 0, info: { model, time: { busy: 1 } }, failAdmission: false,
    failGenerate: false, failStateless: false, hooks: new Map(),
    handoff: { archive: "Title: Continue work\nWork: preserve the exact request.", working: { objective: "Continue current work", constraints: ["Preserve the exact request."],
      state: [], next: ["Continue the task"], references: [] }, retiredConstraints: [] },
    models: [{ ...model, enabled: true, capabilities: { input: ["text"], output: ["text"] }, variants: [], limit: { context: 100_000, output: 8_192 } }],
    configured: undefined, warnings: [], permissions: [], tools: new Map(),
    agents: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }],
  }
  const ctx = {
    options, storage,
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
      state.rpc = handlers
      return { dispose: async () => {}, events: { emit: async (name, data) => state.warnings.push({ name, data }) } }
    } },
    session: {
      context: async () => state.rows,
      get: async () => state.info,
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

const deferralInput = { reason: "Compare the active traces simultaneously; checkpointing plus recall would lose the cross-trace alignment." }
const toolContext = { sessionID: "s", agent: "build", messageID: "assistant", id: "defer-1" }
const defer = (h) => h.controller.deferCompaction(deferralInput, toolContext)
// Build N of the budget gate: a fresh crossing arms instead of compacting, with its notice.
// Tests that run through setup() pass the registered hook as run to reach its own controller.
const armGate = async (h, run = (request) => h.controller.onContext(request)) => {
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  const before = h.state.compact
  await run(request)
  await setImmediate()
  assert.equal(h.state.compact, before, "the crossing arms the gate instead of compacting")
  assert.match(request.system.at(-1)?.text ?? "", /NextDCP budget gate/)
  assert.match(request.system.at(-1)?.text ?? "", /next reply is the compactor's primary input/, "the gate tells the model its reply steers the checkpoint")
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
  assert.deepEqual(compact.result.metadata, { nextdcp: { version: 2 } })
  assert.equal(compact.result.native, undefined)
  assert.deepEqual((await h.store.getCheckpoint("c1")).episode.rowIDs, ["u1", "a1"])

  h.state.rows = [completed("c1", compact.result), user("live", "currentcontextneedle")]
  assert.match(await h.controller.recall("s", { id: "E1" }), /exact user wording with archiveneedle/)
  assert.match(await h.controller.recall("s", { id: "tool-1" }), /file\.ts[\s\S]*complete output/)
  assert.match(await h.controller.recall("s", { query: "archiveneedle" }), /recall E1 page 1/)
  assert.match(await h.controller.recall("s", { query: "currentcontextneedle" }), /No matching/)
  assert.match(await h.controller.recall("s", { id: "E1", query: "x" }), /either id or query/)
  assert.match(await h.controller.recall("s", { id: "E1", page: 0 }), /positive integer/)
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
  assert.match(compact, /recall catalog page 1 \(page 1 of 1\)/, "listings return one page per call, never a whole dump")
  assert.ok(compact.includes("\nE2 — Beta title") && compact.includes("\nE1 — Alpha title"), "one labeled line per entry")
  assert.ok(compact.indexOf("\nE2") < compact.indexOf("\nE1"), "newest first")
  assert.doesNotMatch(compact, /archive note/, "compact lines carry no note bodies")
  const all = await h.controller.recall("s", { id: "catalog all" })
  assert.match(all, /alpha archive note/, "the all view carries every note")
  assert.match(all, /beta archive note/)
  const entry = await h.controller.recall("s", { id: "catalog E1" })
  assert.match(entry, /recall catalog E1 \(whole output\)/)
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
  assert.match(found, /- recall E1 \(archive note, not original evidence\):/)
  assert.doesNotMatch(found, /- recall \{/, "no call that would fetch different content")
  assert.match(found, /page 1 of 1 \(1 hit\)/)
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
  assert.match(hit.split("\n")[1], /^- recall u1 page 1:/, "the skill body's search home is its row original")
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
  assert.equal(await h.controller.recall("s", { id: "u1" }), "recall u1 (whole output)\n[Invalid archived row; recall gap]")
  assert.match(await h.controller.recall("s", { id: "E1" }), /Invalid archived row; recall gap/, "the episode transcript discloses the gap the same way")
  assert.equal(await h.controller.recall("s", { id: "E1", page: 99 }), "recall E1 page 99 is out of range: this original has 1 page; the last page is 1.")
  assert.match(await h.controller.recall("s", { query: "wording" }), /No matching snippets/, "search skips the unreadable row without failing")
})

test("the search corpus is cached per checkpoint: warm queries rescan nothing, a new cut rebuilds it fresh", async () => {
  const h = harness()
  let scans = 0
  const scan = h.storage.scan.bind(h.storage)
  h.storage.scan = async (options) => { scans++; return scan(options) }
  const first = await compactRows(h, [user("u1", "firstcacheneedle wording"), running("c1")])
  h.state.rows = [completed("c1", first), user("live", "x")]
  assert.match(await h.controller.recall("s", { query: "firstcacheneedle" }), /recall E1 page 1/)
  const cold = scans
  assert.ok(cold > 0, "the cold query scans calls and rows")
  assert.match(await h.controller.recall("s", { query: "firstcacheneedle" }), /recall E1 page 1/, "the warm query still answers")
  assert.equal(scans, cold, "a warm query at the same checkpoint rescans nothing")
  const second = await compactRows(h, [completed("c1", first), user("u2", "secondcacheneedle wording"), running("c2")])
  h.state.rows = [completed("c1", first), user("u2", "secondcacheneedle wording"), completed("c2", second)]
  assert.match(await h.controller.recall("s", { query: "secondcacheneedle" }), /recall E2 page 1/, "the rebuilt corpus sees the new episode")
  assert.ok(scans > cold, "a new checkpoint invalidates the cache and rebuilds the corpus")
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
    return infos.get(sessionID)
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
  h.ctx.session.get = async ({ sessionID }) => sessionID === "subagent" ? { parentID: "s" }
    : { fork: { sessionID: sessionID === "cycle-a" ? "cycle-b" : "cycle-a", boundary: { type: "through", messageID: "cp" } } }
  assert.match(await h.controller.recall("subagent", { id: "E1" }), /Recall gap/)
  const reloaded = createController(h.ctx)
  assert.match(await reloaded.recall("cycle-a", { id: "E1" }), /Cyclic fork ancestry/)
})

test("first use of an existing fork imports its inherited checkpoint without replacing newer native work", async () => {
  const h = harness()
  const first = await compactRows(h, [user("u", "inherited original"), running("parent-cp")])
  const parent = completed("parent-cp", first)
  const child = [{ ...parent, id: "copied-cp" }, user("child-u", "newer child work"), native("child-native", "child's own summary")]
  h.ctx.session.get = async ({ sessionID }) => sessionID === "s" ? {} : { fork: { sessionID: "s", boundary: { type: "through", messageID: "parent-cp" } } }
  h.ctx.session.context = async ({ sessionID }) => sessionID === "s" ? [parent] : child
  assert.match(await h.controller.recall("existing-child", { id: "E1" }), /inherited original/)
  const store = createStore(h.storage, "existing-child")
  const adopted = await store.getCheckpoint("child-native")
  assert.equal(adopted.parent, "copied-cp")
  assert.equal(adopted.episode.id, "E2")
  assert.equal(adopted.episode.summary, "child's own summary")
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
  h.ctx.session.get = async ({ sessionID }) => sessionID === "s" ? {} : {
    fork: { sessionID: "s", boundary: { type: "before", messageID: "u2" } },
  }
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
  h.ctx.session.get = async ({ sessionID }) => sessionID === "child" ? { fork: { sessionID: "s", boundary: { type: "through", messageID: "c1" } } } : {}
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
  assert.match(await h.controller.recall("s", { query: "activebranchneedle" }), /recall E3 page 1/)
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
  assert.ok(h.state.warnings.some((item) => String(item.data?.message ?? "").includes("Cannot produce a bounded handoff")))
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
  let previous, firstSize
  for (let i = 1; i <= 100; i++) {
    h.state.handoff.archive = `Title: Completed topic ${i}\narchivekeyword${i}.`
    h.state.handoff.working.state = [`currentfact${i}`]
    if (i > 1) h.state.handoff.working.constraints = [] // A careless omission must not erase the old constraint.
    const result = await compactRows(h, [...(previous ? [previous] : []), user(`u${i}`, `originaltopic${i}`), running(`c${i}`)])
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
    const first = await compactRows(h, [user("u1", "first"), running("c1")])
    const material = "essential long material ".repeat(1_000)
    h.state.handoff.working[field] = [material]
    h.state.rows = [completed("c1", first), user("u2", "original never discarded"), running("c2")]
    const second = event()
    await h.controller.onCompaction(second)
    assert.ok(second.result?.summary.includes(material), "the whole state/constraint commits, never sliced to fit")
    assert.ok((await h.store.getCheckpoint("c2")).working[field].includes(material), "the durable record keeps it whole")
    assert.match(await h.store.getRow("u2"), /original never discarded/)
    assert.equal(h.state.prompts.length, 3)
    assert.match(h.state.warnings.at(-1).data.message, /accepted the shortest valid handoff/)
    assert.equal((await h.store.getCheckpoint("c1")).working.constraints[0], "Preserve the exact request.")
  }
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
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: null, after: "u1", tokens: 8 })
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
  assert.deepEqual(data.users, [{ id: "u1", start: "finished debugging runtime.ts" }], "constraint retirement only ever quotes real user rows, never the queued text")
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

test("the final assistant reply and reasoning can cross the soft threshold without being counted twice", async () => {
  const h = harness({ idle: 100, budget: 1_000_000 })
  h.state.rows = [user("u1", "x".repeat(320))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  h.state.rows.push({ id: "final", type: "assistant", content: [
    { type: "reasoning", text: "r".repeat(40) }, { type: "text", text: "a".repeat(80) },
  ] }, { id: "idle", type: "idle", outcome: "succeeded" })
  await h.controller.onIdle("s")
  assert.deepEqual(await h.store.getDeferredCompaction(), { checkpoint: null, after: "idle", tokens: 110 })
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
  assert.match(h.state.prompts[0], /kept facts/)
  assert.match((await h.store.getCheckpoint("c1")).episode.summary, /kept facts/)
  assert.match(result.summary, /Archive through E2/)
})

test("deferral defaults to native ask without overriding configured permission rules", async () => {
  const h = harness({ idle: false, budget: 40 })
  const allow = { action: "*", resource: "*", effect: "allow" }
  const ask = { action: "defer_compaction", resource: "*", effect: "ask" }
  const deny = { action: "defer_compaction", resource: "*", effect: "deny" }
  const denyAll = { action: "*", resource: "*", effect: "deny" }
  h.state.agents.push(
    { id: "configured", permissions: [allow, deny] },
    { id: "deny-all", permissions: [denyAll] },
    { id: "explicit-allow", permissions: [allow, allow] },
    { id: "empty", permissions: [] },
  )
  const cleanup = await setup(h.ctx)
  try {
    assert.deepEqual(h.state.agents.map((agent) => agent.permissions), [
      [allow, ask], [allow, ask, deny], [ask, denyAll], [allow, ask, allow], [ask],
    ])
    const tool = h.state.tools.get("defer_compaction")
    assert.equal(tool.description, DEFER_COMPACTION_DESCRIPTION)
    assert.deepEqual(tool.options, { permission: "defer_compaction", codemode: false })
    assert.deepEqual(tool.input.required, ["reason"])
    assert.equal(tool.input.additionalProperties, false)
    h.state.rows = [user("u", "x".repeat(800))]
    await armGate(h, (request) => h.state.hooks.get("context")(request))
    assert.match((await tool.execute({ reason: `  ${deferralInput.reason}  ` }, toolContext)).content, /deferred for this round only/)
    assert.deepEqual(h.state.permissions, [{
      sessionID: "s", agent: "build", action: "defer_compaction", resources: [deferralInput.reason], save: ["*"],
      source: { type: "tool", messageID: "assistant", id: "defer-1" },
    }])
    await tool.execute(deferralInput, toolContext)
    assert.equal(h.state.permissions.length, 1, "an already-approved round needs no second permission request")
    assert.equal(h.storage.writes.length, 0, "exemptions are not persisted")
  } finally { cleanup() }
})

test("a granted deferral stops the budget trigger, then catches up after the round", async () => {
  const h = harness({ idle: false, budget: 6_000 })
  const tool = (id) => ({ id: `row-${id}`, type: "assistant", content: [{
    type: "tool", id, name: "read", state: { status: "completed", input: { path: id }, content: [{ type: "text", text: `original ${id} `.repeat(1_000) }] },
  }] })
  h.state.rows = [tool("cold"), user("tail", "y".repeat(8_000))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0, "the first request is still under the budget")
  h.state.rows = [tool("cold"), user("tail", "y".repeat(8_000)), tool("hot"), user("tail2", "z".repeat(24_000))]
  await armGate(h)
  assert.match(await defer(h), /deferred for this round only/)
  assert.equal(h.state.permissions.length, 1)
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 0, "the budget trigger is deferred")
  assert.match(await defer(h), /deferred for this round only/, "the held round's approval is idempotent")
  assert.equal(h.state.permissions.length, 1)
  await h.controller.onIdle("s")
  await armGate(h)
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 1, "the round ended; the next context pays the trigger")
})

test("the budget gate arms at the crossing and pays it at the next build", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  await armGate(h)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "the next build closes the gate and compacts")
})

test("deferral outside an open gate never prompts, even when the budget trigger is off", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  assert.match(await defer(h), /outside one/)
  assert.equal(h.state.permissions.length, 0)
  const disabled = harness({ budget: false })
  assert.match(await defer(disabled), /outside one/, "without a crossing there is no gate to defer behind")
  assert.equal(disabled.state.permissions.length, 0)
})

test("an approved deferral holds its gate while a rejected request leaves the crossing to pay", async () => {
  const held = harness({ idle: false, budget: 40 })
  held.state.rows = [user("u", "x".repeat(800))]
  await armGate(held)
  assert.match(await defer(held), /deferred for this round only/)
  await held.controller.onContext({ ...event(), messages: projectHistory(held.state.rows).messages })
  await setImmediate()
  assert.equal(held.state.compact, 0, "the grant holds the gate open for its round")
  const refused = harness({ idle: false, budget: 40 })
  refused.state.rows = [user("u", "x".repeat(800))]
  await armGate(refused)
  refused.ctx.permission.assert = async () => { throw new Error("denied") }
  await assert.rejects(defer(refused))
  await refused.controller.onContext({ ...event(), messages: projectHistory(refused.state.rows).messages })
  await setImmediate()
  assert.equal(refused.state.compact, 1, "a rejected request leaves the next build to compact")
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
    assert.ok(!request.system.some((part) => /NextDCP budget gate/.test(part.text ?? "")), note)
  }
  await build("the next build pays the consumed crossing")
  await build("the admission guard blocks a re-arm")
  h.controller.onCompactionFinished("s", true)
  await build("a failing compaction cools the trigger down")
})

test("budget: false disables the mid-round trigger, matching idle: false and the deferral notice", async () => {
  const h = harness({ idle: false, budget: false })
  h.state.rows = [user("u1", "x".repeat(360_000))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0, "an explicit false disables the budget trigger entirely")
  assert.match(await defer(h), /outside one/, "without a crossing there is no gate to defer behind")
})

test("deferral is refused when physics cannot guarantee the window, and triggers stay active", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.state.rows = [user("u1", "x".repeat(360_000))]
  await armGate(h)
  assert.match(await defer(h), /about 90000 estimated tokens, above the grant ceiling of 73446 of the 100000-token window/)
  assert.equal(h.state.permissions.length, 0, "physics refuses before spending the user's attention")
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 1, "a refused grant leaves the budget trigger active")
  const attached = harness({ idle: false, budget: 100 })
  attached.state.rows = [{ ...user("u1", "small"), files: [{ mime: "image/png" }, { mime: "text/plain", data: Buffer.from("x".repeat(300_000)).toString("base64") }] }]
  await armGate(attached)
  assert.match(await defer(attached), /about 76501 estimated tokens/, "attachments count at their media rate or decoded text size")
  assert.equal(attached.state.permissions.length, 0)
  const unknown = harness({ idle: false, budget: 100 })
  unknown.state.models = []
  unknown.state.rows = [user("u1", "x".repeat(360_000))]
  await armGate(unknown)
  assert.match(await defer(unknown), /window is unknown/)
  assert.equal(unknown.state.permissions.length, 0)
})

test("the deferral estimate counts hidden reasoning the same way the response side does", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.state.rows = [user("u1", "y".repeat(4_000)), { id: "a1", type: "assistant", content: [
    { type: "reasoning", text: "r".repeat(280_000) }, { type: "text", text: "t".repeat(12_000) },
  ] }]
  // 1_000 user + 70_000 reasoning + 3_000 text = 74_000: hidden reasoning alone pushes it past 73_446.
  await armGate(h)
  assert.match(await defer(h), /about 74000 estimated tokens, above the grant ceiling of 73446 of the 100000-token window/)
  assert.equal(h.state.permissions.length, 0)
  const visible = harness({ idle: false, budget: 100 })
  visible.state.rows = [user("u1", "y".repeat(4_000)), { id: "a1", type: "assistant", content: [
    { type: "text", text: "t".repeat(12_000) },
  ] }]
  await armGate(visible)
  assert.match(await defer(visible), /deferred for this round only/, "the same conversation without hidden reasoning fits")
  assert.equal(visible.state.permissions.length, 1)
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
  const denied = harness({ idle: false, budget: 100 })
  denied.state.rows = [...pair(), user("u1", "x".repeat(360_000))]
  await armGate(denied)
  assert.match(await defer(denied), /about 108360 estimated tokens, above the grant ceiling of 73446 of the 100000-token window/)
  assert.equal(denied.state.permissions.length, 0)
  const flat = harness({ idle: false, budget: 100 })
  flat.state.rows = [...pair({ read: 260 }), user("u1", "x".repeat(360_000))]
  await armGate(flat)
  assert.match(await defer(flat), /about 108360 estimated tokens/, "cache fields count toward billed growth whether nested or flat")
  const median = harness({ idle: false, budget: 100 })
  median.state.rows = [billed("a1", 640), billed("a2", 1_000),
    { ...billed("a3", 1_420), content: [{ type: "text", text: "" }] }, user("u1", "x".repeat(360_000))]
  await armGate(median)
  assert.match(await defer(median), /about 126840 estimated tokens/, "two pairs of 1.2 and 1.4 calibrate to the upper median of 1.4")
})

test("the growth gate converts the budget quarter into the estimator's own units", async () => {
  const billed = (id, input) => ({ id, type: "assistant", model,
    tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, content: [{ type: "text", text: "x".repeat(8_000) }] })
  // Billed growth of 4,000 against 2,000 estimated tokens of the row in between: scale 2.
  const calibration = [billed("a1", 640), { ...billed("a2", 4_640), content: [{ type: "text", text: "" }] }]
  const fire = harness({ idle: false, budget: 4_000 })
  fire.state.rows = [...calibration, native("c0"), user("u1", "z".repeat(2_408))]
  await fire.controller.onContext({ ...event(), messages: projectHistory(fire.state.rows).messages })
  await setImmediate()
  await fire.controller.onContext({ ...event(), messages: projectHistory(fire.state.rows).messages })
  await setImmediate()
  assert.equal(fire.state.compact, 1, "602 estimated tokens bill like 1,204 and reach the gate at 1,000 real tokens of growth")
  const quiet = harness({ idle: false, budget: 4_000 })
  quiet.state.rows = [...calibration, native("c0"), user("u1", "z".repeat(1_600))]
  await quiet.controller.onContext({ ...event(), messages: projectHistory(quiet.state.rows).messages })
  await setImmediate()
  assert.equal(quiet.state.compact, 0, "400 estimated tokens bill like 800, under the gate although both cases already pass the budget line")
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
    const h = harness({ idle: false, budget: 100 })
    h.state.rows = [...rows, user("u1", "x".repeat(360_000))]
    await armGate(h)
    assert.match(await defer(h), /about 90300 estimated tokens, above the grant ceiling of 73446/, name)
    assert.equal(h.state.permissions.length, 0, name)
    const trigger = harness({ idle: false, budget: 600 })
    trigger.state.rows = [...rows, user("u1", "z".repeat(928))]
    await trigger.controller.onContext({ ...event(), messages: projectHistory(trigger.state.rows).messages })
    await setImmediate()
    assert.equal(trigger.state.compact, 0, name)
  }
})

test("an unknown window announces its disabled budget trigger instead of failing silently", async (t) => {
  const warnings = []
  t.mock.method(console, "warn", (text) => warnings.push(text))
  const h = harness({ idle: false, debug: true })
  h.state.rows = [user("u1", "x".repeat(360_000))]
  await armGate(h)
  // The window can vanish mid-round; only the ref's own lookup decides what is known.
  h.state.models = []
  h.state.info.model = { providerID: "provider", id: "switched" }
  await h.controller.onContext({ ...event(), model: { providerID: "provider", id: "switched" }, messages: projectHistory(h.state.rows).messages })
  await setImmediate()
  assert.equal(h.state.compact, 0)
  assert.ok(warnings.some((text) => text.includes("budget trigger is disabled")), "the disabled trigger is logged when debugging")
  assert.match(await defer(h), /The automatic mid-round budget trigger is likewise disabled while the window is unknown; set options\.budget to an explicit token count to enable it\./)

  const explicit = harness({ idle: false, budget: 100_000 })
  explicit.state.models = []
  explicit.state.rows = [user("u1", "x".repeat(600_000))]
  await armGate(explicit)
  assert.match(await defer(explicit), /window is unknown/)
  assert.doesNotMatch(await defer(explicit), /likewise disabled/, "an explicit budget is a deliberate choice, not a silent default")
})

test("a deferred round writes no catch-up marker; the next round pays the budget trigger instead", async () => {
  const h = harness({ idle: 100, budget: 1_000 })
  h.state.rows = [user("u1", "x".repeat(5_000))]
  await armGate(h)
  assert.match(await defer(h), /deferred for this round only/)
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 0)
  await h.controller.onIdle("s")
  assert.equal(await h.store.getDeferredCompaction(), undefined, "the held round owes no marker")
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 0, "the next prompt is admitted without a catch-up compaction")
  await armGate(h)
  await h.controller.onContext(request)
  await setImmediate()
  assert.equal(h.state.compact, 1, "without re-affirmation the mid-turn trigger catches up")
})

test("pending approval does not defer a trigger or cancel already-admitted compaction", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  let approve
  h.ctx.permission.assert = async (input) => {
    h.state.permissions.push(input)
    await new Promise((resolve) => { approve = resolve })
  }
  await armGate(h)
  const pending = defer(h)
  await setImmediate()
  assert.match(await defer(h), /already been requested/)
  assert.equal(h.state.permissions.length, 1)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 1, "an unapproved request does not suppress compaction")
  approve()
  assert.match(await pending, /Already-queued compaction is not canceled/)
  h.state.rows.push(running("manual-or-overflow"))
  const compaction = event()
  await h.controller.onCompaction(compaction)
  assert.ok(compaction.result, "approved deferral still allows manual, overflow, or previously admitted compaction")
})

test("native permission rejection is rethrown and cannot be retried in that round", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  const rejection = new Error("native permission rejection")
  h.ctx.permission.assert = async (input) => { h.state.permissions.push(input); throw rejection }
  await armGate(h)
  await assert.rejects(defer(h), (error) => error === rejection)
  assert.match(await defer(h), /Do not ask again/)
  assert.equal(h.state.permissions.length, 1)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 1)
  h.controller.onRoundEnded("s")
  h.controller.onCompactionFinished("s")
  h.ctx.permission.assert = async (input) => { h.state.permissions.push(input) }
  await armGate(h)
  assert.match(await defer(h), /deferred for this round only/)
  assert.equal(h.state.permissions.length, 2)
})

test("late approval cannot exempt an ended round or overwrite a later round's decision", async () => {
  for (const end of ["event", "idle", "busy", "delete"]) {
    const h = harness({ idle: false, budget: 40 })
    h.state.rows = [user("u", "x".repeat(800))]
    let approve
    h.ctx.permission.assert = () => new Promise((resolve) => { approve = resolve })
    await armGate(h)
    const pending = defer(h)
    await setImmediate()
    if (end === "event") h.controller.onRoundEnded("s")
    if (end === "idle") h.state.info.time.idle = 2
    if (end === "busy") h.state.info.time.busy = 2
    if (end === "delete") await h.controller.onDeleted("s")
    approve()
    assert.match(await pending, /round ended/, end)
    // A stale gate re-arms at the first build and pays on the next; a repaid or
    // cleared crossing is already compacting, so its build stays guard-blocked.
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    if (end !== "event") await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    assert.equal(h.state.compact, 1, end)
  }

  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  let approve
  h.ctx.permission.assert = () => new Promise((resolve) => { approve = resolve })
  await armGate(h)
  const old = defer(h)
  await setImmediate()
  h.state.info.time.busy = 2
  h.ctx.permission.assert = async () => {}
  await armGate(h)
  await defer(h)
  approve()
  assert.match(await old, /round ended/)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 0, "late approval leaves the later round's own approval intact")
})

test("approved deferrals cannot leak across execution boundaries, sessions, or reloads", async () => {
  for (const change of ["busy", "idle", "child", "fork", "reload", "unavailable"]) {
    const h = harness({ idle: false, budget: 40 })
    h.state.rows = [user("u", "x".repeat(800))]
    await armGate(h)
    await defer(h)
    if (change === "busy") h.state.info.time.busy = 2
    if (change === "idle") h.state.info.time.idle = 2
    if (change === "reload") h.controller = createController(h.ctx)
    if (change === "unavailable") {
      await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
      h.ctx.session.get = async () => { throw new Error("session unavailable") }
    }
    const sessionID = change === "child" || change === "fork" ? change : "s"
    await h.controller.onContext({ ...event(sessionID), messages: projectHistory(h.state.rows).messages })
    // A stale boundary re-arms at the first build and pays at the second; when the round
    // stamp cannot be read at all, the first build already degrades to the plain cut.
    if (change !== "unavailable") await h.controller.onContext({ ...event(sessionID), messages: projectHistory(h.state.rows).messages })
    assert.equal(h.state.compact, 1, change)
  }
})

test("steering messages within the same execution keep the current approval", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u1", "x".repeat(800))]
  await armGate(h)
  await defer(h)
  h.state.rows = [user("u1", "x".repeat(800)), user("u2", "A correction within the active round.")]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 0)
  assert.match(await defer(h), /deferred for this round only/)
  assert.equal(h.state.permissions.length, 1)
})

test("empty reasons, disabled budgets, staged reverts, and sessions without a round never request permission", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  await armGate(h)
  assert.match(await h.controller.deferCompaction({ reason: "  " }, toolContext), /concrete current need/)
  assert.match(await h.controller.deferCompaction({ reason: "y".repeat(501) }, toolContext), /1 to 500 characters/)
  h.state.info.revert = { messageID: "old" }
  assert.match(await defer(h), /staged revert/)
  delete h.state.info.revert
  delete h.state.info.time.busy
  assert.match(await defer(h), /outside one/, "a session without a round has no open gate to defer")
  assert.equal(h.state.permissions.length, 0)
  const disabled = harness({ budget: false })
  assert.match(await defer(disabled), /outside one/, "a disabled budget never opens a gate")
  assert.equal(disabled.state.permissions.length, 0)
})

test("system and tool definitions above the budget never trigger compaction", async () => {
  const h = harness({ idle: false, budget: 100 })
  h.state.rows = [user("u1", "x".repeat(160))]
  const messages = projectHistory(h.state.rows).messages
  for (let i = 0; i < 3; i++) {
    await h.controller.onContext({ ...event(), messages, system: [{ text: "system".repeat(10_000) }], tools: { giant: { description: "tool".repeat(10_000), input: {} } } })
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
  assert.equal(h.state.compact, 0, "225 new tokens are less than one quarter of the budget")
  h.state.rows = [prior, user("u1", "x".repeat(1_200))]
  await h.controller.onContext(request("prior", "x".repeat(1_200)))
  await setImmediate()
  // The crossing arms at build N and pays at build N+1.
  await h.controller.onContext(request("prior", "x".repeat(1_200)))
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

test("native precompute and encrypted fallback leave native in control", async () => {
  const h = harness()
  h.state.rows = [user("u1", "precomputed archive"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "tool-opaque", name: "read", state: { status: "completed", input: { path: "original.ts" }, content: [{ type: "text", text: "archived tool data" }] } },
  ] }]
  const precompute = event()
  await h.controller.onCompaction(precompute)
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

test("a host without the permission surface keeps recall and core hooks alive", async (t) => {
  const warnings = []
  t.mock.method(console, "warn", (text) => warnings.push(text))
  const h = harness()
  h.ctx.permission = undefined
  await install(h.ctx)
  assert.deepEqual([...h.state.hooks.keys()], ["prompt", "context", "compaction"], "core hooks register regardless of the experimental surface")
  assert.ok(h.state.tools.has("recall"))
  assert.ok(!h.state.tools.has("defer_compaction"), "the deferral gate is omitted instead of half-registered")
  assert.ok(warnings.some((text) => text.includes("lacks the permission surface")), "the omission is announced")

  const broken = harness()
  broken.ctx.agent.transform = async () => { throw new Error("experimental surface changed") }
  await install(broken.ctx)
  assert.deepEqual([...broken.state.hooks.keys()], ["prompt", "context", "compaction"])
  assert.ok(broken.state.tools.has("recall"))
  assert.ok(!broken.state.tools.has("defer_compaction"))
  assert.ok(warnings.some((text) => text.includes("defer_compaction registration failed")), "a broken experimental registration cannot take the core down")
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
  assert.deepEqual([...h.state.hooks.keys()], ["prompt", "context", "compaction"])
  assert.deepEqual(subscribed, ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.compaction.failed", "session.deleted", "session.forked"])
  assert.equal(h.state.tool.name, "recall")
  assert.equal(h.state.tool.description, RECALL_DESCRIPTION)
  assert.deepEqual(h.state.tool.options, { codemode: false })
  const deferral = h.state.tools.get("defer_compaction")
  // Each round's exemption expiring leaves no open gate behind; arm a fresh one before
  // every call or the tool refuses without prompting.
  const arm = () => armGate(h, (request) => h.state.hooks.get("context")(request))
  await arm()
  await deferral.execute(deferralInput, toolContext)
  await h.state.hooks.get("context")({ ...event(), messages: projectHistory(h.state.rows).messages })
  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    const before = h.state.permissions.length
    push(type)
    await setImmediate()
    await arm()
    await deferral.execute(deferralInput, toolContext)
    assert.equal(h.state.permissions.length, before + 1, `${type} expires the round's exemption`)
  }
  await h.ctx.session.generate({ prompt: WORKING_PROMPT })
  await setImmediate()
  assert.equal(h.state.compact, 0, "Failed, interrupted and transient generation do not trigger idle compaction")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 0, "no successful turn means no deferred marker")
  push("session.execution.succeeded")
  await setImmediate()
  await setImmediate()
  assert.equal(h.state.compact, 0, "a granted round ends without a marker or a model call")
  const before = h.state.permissions.length
  await arm()
  await deferral.execute(deferralInput, toolContext)
  assert.equal(h.state.permissions.length, before + 1, "success expires the round's exemption")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 0, "the next prompt admits without a catch-up compaction")
  push("session.execution.failed")
  push("session.execution.succeeded")
  await setImmediate()
  await setImmediate()
  assert.equal(h.state.compact, 0, "an ungranted round records a marker without calling the model")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1)
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
})
