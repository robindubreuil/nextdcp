import assert from "node:assert/strict"
import { registerHooks } from "node:module"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { projectHistory } from "./support/history.ts"
import { WORKING_PROMPT, RECALL_DESCRIPTION, DEFER_COMPACTION_DESCRIPTION } from "../src/prompts.ts"
import { createController } from "../src/runtime.ts"
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
    handoff: { archive: "Work: preserve the exact request.", working: { objective: "Continue current work", constraints: ["Preserve the exact request."],
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
        return { text: JSON.stringify(state.handoff) }
      },
      hook: async (name, callback) => { state.hooks.set(name, callback); return { dispose: async () => {} } },
    },
    experimental: { generate: { text: async (input) => {
      state.stateless.push(input)
      if (state.failStateless) throw new Error("stateless generation failed")
      return { text: JSON.stringify(state.handoff) }
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
  assert.match(await h.controller.recall("s", { query: "archiveneedle" }), /recall \{"id":"E1","page":1\}/)
  assert.match(await h.controller.recall("s", { query: "currentcontextneedle" }), /No matching/)
  assert.match(await h.controller.recall("s", { id: "E1", query: "x" }), /either id or query/)
  assert.match(await h.controller.recall("s", { id: "E1", page: 0 }), /positive integer/)
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
  const episode = await h.controller.recall("s", { id: "E1" })
  assert.deepEqual(episode.slice(1).map((part) => part.mime), ["application/pdf", "image/png"])
  assert.doesNotMatch(episode[0].text, /base64|AAAA|BBBB/)
  assert.deepEqual(await h.controller.recall("s", { id: "E1" }), episode, "cache retains native attachments")
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
  assert.match(await h.controller.recall("s", { query: "activebranchneedle" }), /"id":"E3"/)
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
    h.state.handoff.archive = `Completed topic ${i}; archivekeyword${i}.`
    h.state.handoff.working.state = [`currentfact${i}`]
    if (i > 1) h.state.handoff.working.constraints = [] // A careless omission must not erase the old constraint.
    const result = await compactRows(h, [...(previous ? [previous] : []), user(`u${i}`, `originaltopic${i}`), running(`c${i}`)])
    assert.match(result.summary, /Preserve the exact request/)
    assert.match(result.summary, new RegExp(`currentfact${i}\\b`))
    assert.doesNotMatch(result.summary, /Completed topic|archivekeyword|originaltopic/)
    if (i > 1) assert.doesNotMatch(result.summary, new RegExp(`currentfact${i - 1}\\b`))
    assert.ok(Math.ceil(result.summary.length / 4) <= 512)
    firstSize ??= result.summary.length
    assert.ok(result.summary.length <= firstSize + 12)
    previous = completed(`c${i}`, result)
    if (i % 10 === 0) h.controller = createController(h.ctx)
  }
  assert.equal(h.state.prompts.length, 100)
  assert.equal(h.state.stateless.length, 0)
  h.state.rows = [previous]
  assert.match(await h.controller.recall("s", { id: "E1" }), /originaltopic1/)
  assert.match(await h.controller.recall("s", { query: "archivekeyword1" }), /archive note, not original evidence/)
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

test("unrepairable state or constraint overflow fails visibly to native without committing or truncating", async (t) => {
  t.mock.method(console, "warn", () => {})
  for (const field of ["state", "constraints"]) {
    const h = harness({ memory: { budget: 256 } })
    await h.controller.registerModels()
    const first = await compactRows(h, [user("u1", "first"), running("c1")])
    h.state.handoff.working[field] = ["essential long material ".repeat(1_000)]
    h.state.rows = [completed("c1", first), user("u2", "original never discarded"), running("c2")]
    const second = event()
    await h.controller.onCompaction(second)
    assert.equal(second.result, undefined)
    assert.equal(await h.store.getCheckpoint("c2"), undefined)
    assert.equal((await h.store.getPending("c2")).archived, true)
    assert.match(await h.store.getRow("u2"), /original never discarded/)
    assert.equal(h.state.prompts.length, 3)
    assert.match(h.state.warnings.at(-1).data.message, /safety fallback is not size-bounded/)
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
  const h = harness()
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

test("approved deferral preserves masking and normal next-prompt compaction", async () => {
  const h = harness({ idle: 20, budget: 40, mask: { minTokens: 1, distance: 0, batch: 1 } })
  const original = "trace evidence ".repeat(100)
  h.state.rows = [user("u1", "compare traces"), { id: "a1", type: "assistant", content: [
    { type: "tool", id: "trace", name: "read", state: { status: "completed", input: { path: "trace.log" }, content: [{ type: "text", text: original }] } },
  ] }, user("u2", "x".repeat(800))]
  assert.match(await defer(h), /deferred for this round only/)
  const context = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(context)
  assert.equal(h.state.compact, 0)
  assert.match(JSON.stringify(context.messages), /Output elided/)
  assert.equal((await h.store.getCall("trace")).result.value, original)
  const generate = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onGenerate(generate)
  assert.deepEqual(generate.messages, context.messages)

  h.state.rows.push({ id: "final", type: "assistant", content: [{ type: "text", text: "comparison complete" }] })
  await h.controller.onIdle("s")
  assert.ok(await h.store.getDeferredCompaction())
  assert.equal(h.state.compact, 0)
  await h.controller.onPrompt(prompt())
  assert.equal(h.state.compact, 1)
})

test("pending approval does not defer a trigger or cancel already-admitted compaction", async () => {
  const h = harness({ idle: false, budget: 40 })
  h.state.rows = [user("u", "x".repeat(800))]
  let approve
  h.ctx.permission.assert = async (input) => {
    h.state.permissions.push(input)
    await new Promise((resolve) => { approve = resolve })
  }
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
  await assert.rejects(defer(h), (error) => error === rejection)
  assert.match(await defer(h), /Do not ask again/)
  assert.equal(h.state.permissions.length, 1)
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 1)
  h.controller.onRoundEnded("s")
  h.ctx.permission.assert = async (input) => { h.state.permissions.push(input) }
  assert.match(await defer(h), /deferred for this round only/)
  assert.equal(h.state.permissions.length, 2)
})

test("late approval cannot exempt an ended round or overwrite a later round's decision", async () => {
  for (const end of ["event", "idle", "busy", "delete"]) {
    const h = harness({ idle: false, budget: 40 })
    h.state.rows = [user("u", "x".repeat(800))]
    let approve
    h.ctx.permission.assert = () => new Promise((resolve) => { approve = resolve })
    const pending = defer(h)
    await setImmediate()
    if (end === "event") h.controller.onRoundEnded("s")
    if (end === "idle") h.state.info.time.idle = 2
    if (end === "busy") h.state.info.time.busy = 2
    if (end === "delete") await h.controller.onDeleted("s")
    approve()
    assert.match(await pending, /round ended/, end)
    await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
    assert.equal(h.state.compact, 1, end)
  }

  const h = harness({ idle: false, budget: 40 })
  let approve
  h.ctx.permission.assert = () => new Promise((resolve) => { approve = resolve })
  const old = defer(h)
  await setImmediate()
  h.state.info.time.busy = 2
  h.ctx.permission.assert = async () => {}
  await defer(h)
  approve()
  assert.match(await old, /round ended/)
  h.state.rows = [user("u", "x".repeat(800))]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 0, "late approval leaves the later round's own approval intact")
})

test("approved deferrals cannot leak across execution boundaries, sessions, or reloads", async () => {
  for (const change of ["busy", "idle", "child", "fork", "reload", "unavailable"]) {
    const h = harness({ idle: false, budget: 40 })
    h.state.rows = [user("u", "x".repeat(800))]
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
    assert.equal(h.state.compact, 1, change)
  }
})

test("steering messages within the same execution keep the current approval", async () => {
  const h = harness({ idle: false, budget: 40 })
  await defer(h)
  h.state.rows = [user("u1", "x".repeat(800)), user("u2", "A correction within the active round.")]
  await h.controller.onContext({ ...event(), messages: projectHistory(h.state.rows).messages })
  assert.equal(h.state.compact, 0)
  assert.match(await defer(h), /deferred for this round only/)
  assert.equal(h.state.permissions.length, 1)
})

test("empty reasons, disabled budgets, staged reverts, and sessions without a round never request permission", async () => {
  const h = harness()
  assert.match(await h.controller.deferCompaction({ reason: "  " }, toolContext), /concrete current need/)
  h.state.info.revert = { messageID: "old" }
  assert.match(await defer(h), /staged revert/)
  delete h.state.info.revert
  delete h.state.info.time.busy
  assert.match(await defer(h), /active round/)
  assert.equal(h.state.permissions.length, 0)
  const disabled = harness({ budget: false })
  assert.match(await defer(disabled), /already disabled/)
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

test("one unarchivable call does not prevent other masks from being committed", async (t) => {
  const warnings = []
  t.mock.method(console, "warn", (message) => warnings.push(message))
  const h = harness({ idle: false, budget: 1_000_000, mask: { minTokens: 1, distance: 0, batch: 1 } })
  const tool = (id) => ({
    id: `row-${id}`, type: "assistant", content: [{
      type: "tool", id, name: "read", state: { status: "completed", input: { path: id }, content: [{ type: "text", text: `original ${id} `.repeat(1_000) }] },
    }],
  })
  h.state.rows = [tool("good"), tool("bad"), user("tail", "next")]
  h.storage.fail = (key) => key.endsWith("/calls/bad")
  const request = { ...event(), messages: projectHistory(h.state.rows).messages }
  await h.controller.onContext(request)
  const results = request.messages.flatMap((message) => message.content).filter((part) => part.type === "tool-result")
  assert.match(results.find((part) => part.id === "good").result.value, /Output elided/)
  assert.match(results.find((part) => part.id === "bad").result.value, /^original bad /)
  assert.deepEqual((await h.store.getMasks()).map((mask) => mask.id), ["good"])
  assert.ok(await h.store.getCall("good"))
  assert.equal(await h.store.getCall("bad"), undefined)
  assert.ok(warnings.some((message) => message.includes("bad")))
})

test("mask cache follows checkpoints and restores earlier masks after revert", async () => {
  const h = harness({ idle: false, budget: 1_000_000, mask: { minTokens: 1, distance: 0, batch: 1 } })
  const tool = (id) => ({
    id: `row-${id}`, type: "assistant", content: [{
      type: "tool", id, name: "read", state: { status: "completed", input: { path: id }, content: [{ type: "text", text: `content ${id} `.repeat(1_000) }] },
    }],
  })
  h.state.rows = [tool("root-call"), user("root-tail", "next")]
  const rootRaw = projectHistory(h.state.rows).messages
  const rootRequest = { ...event(), messages: structuredClone(rootRaw) }
  await h.controller.onContext(rootRequest)
  const rootView = JSON.stringify(rootRequest.messages)
  assert.match(rootView, /Output elided/)
  const rootReads = h.storage.reads.filter((key) => key.endsWith("/masks/root")).length
  for (let i = 0; i < 2; i++) {
    const generate = { ...event(), messages: structuredClone(rootRaw) }
    await h.controller.onGenerate(generate)
    assert.equal(JSON.stringify(generate.messages), rootView)
  }
  assert.equal(h.storage.reads.filter((key) => key.endsWith("/masks/root")).length, rootReads)

  h.state.rows = [native("c1"), tool("checkpoint-call"), user("checkpoint-tail", "next")]
  const checkpointRaw = projectHistory(h.state.rows).messages
  const checkpointRequest = { ...event(), messages: structuredClone(checkpointRaw) }
  await h.controller.onContext(checkpointRequest)
  const checkpointView = JSON.stringify(checkpointRequest.messages)
  assert.match(checkpointView, /Output elided/)
  assert.deepEqual((await h.store.getMasks("c1")).map((mask) => mask.id), ["checkpoint-call"])
  assert.deepEqual((await h.store.getMasks()).map((mask) => mask.id), ["root-call"])

  h.state.rows = [native("c2")]
  const after = { ...event(), messages: structuredClone(checkpointRaw) }
  await h.controller.onGenerate(after)
  assert.equal(JSON.stringify(after.messages), JSON.stringify(checkpointRaw))
  h.state.rows = [native("c1"), tool("checkpoint-call"), user("checkpoint-tail", "next")]
  const reverted = { ...event(), messages: structuredClone(checkpointRaw) }
  await h.controller.onGenerate(reverted)
  assert.equal(JSON.stringify(reverted.messages), checkpointView)
  h.state.rows = [tool("root-call"), user("root-tail", "next")]
  const rootRevert = { ...event(), messages: structuredClone(rootRaw) }
  await h.controller.onGenerate(rootRevert)
  assert.equal(JSON.stringify(rootRevert.messages), rootView)
})

test("context archives and commits masks before rendering; generate reuses the same bytes", async () => {
  const h = harness({ budget: 1, mask: { minTokens: 10, distance: 0, batch: 1 } })
  const output = "hiddenoutputneedle " + "output ".repeat(4_000)
  const input = { path: "visiblepath", content: "hiddeninputneedle " + "input ".repeat(4_000) }
  h.state.rows = [{ id: "a1", type: "assistant", content: [
    { type: "reasoning", text: "reasoning stays" },
    { type: "tool", id: "call-1", name: "write", state: { status: "completed", input, content: [{ type: "text", text: output }] } },
  ] }, user("u1", "a later message")]
  const raw = projectHistory(h.state.rows).messages, context = { ...event(), messages: raw }
  await h.controller.onContext(context)
  await setImmediate()
  assert.equal(h.state.compact, 1)
  assert.match(JSON.stringify(context.messages), /Input elided to save context/)
  assert.match(JSON.stringify(context.messages), /Output elided to save context/)
  assert.deepEqual((await h.store.getCall("call-1")).input, input)
  assert.equal((await h.store.getCall("call-1")).result.value, output)
  assert.ok(h.storage.writes.findIndex(({ key }) => key.endsWith("/calls/call-1")) < h.storage.writes.findIndex(({ key }) => key.endsWith("/masks/root")))
  const count = h.storage.writes.length, generation = { ...event(), messages: raw }
  await h.controller.onGenerate(generation)
  assert.equal(JSON.stringify(generation.messages), JSON.stringify(context.messages))
  assert.equal(h.storage.writes.length, count)
  const hit = await h.controller.recall("s", { query: "hiddenoutputneedle" })
  assert.match(hit, /recall \{"id":"call-1","page":\d+\}/)
  assert.match(await h.controller.recall("s", { id: "call-1" }), /hiddeninputneedle/)
  assert.match(await h.controller.recall("s", { query: "later" }), /No matching/)
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

test("setup registers success-only idle events and clears the subscription", async () => {
  const h = harness({ idle: 1 })
  h.state.rows = [user("u", "an idle session with work")]
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
  assert.deepEqual([...h.state.hooks.keys()], ["prompt", "context", "generate", "compaction"])
  assert.deepEqual(subscribed, ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.compaction.failed", "session.deleted", "session.forked"])
  assert.equal(h.state.tool.name, "recall")
  assert.equal(h.state.tool.description, RECALL_DESCRIPTION)
  assert.deepEqual(h.state.tool.options, { codemode: false })
  const deferral = h.state.tools.get("defer_compaction")
  await deferral.execute(deferralInput, toolContext)
  await h.state.hooks.get("context")({ ...event(), messages: projectHistory(h.state.rows).messages })
  for (const type of ["session.execution.failed", "session.execution.interrupted"]) {
    const before = h.state.permissions.length
    push(type)
    await setImmediate()
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
  assert.equal(h.state.compact, 0, "success records a marker without calling the model")
  const before = h.state.permissions.length
  await deferral.execute(deferralInput, toolContext)
  assert.equal(h.state.permissions.length, before + 1, "success expires the round's exemption")
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1)
  h.state.rows = [native("checkpoint")]
  push("session.compaction.ended")
  push("session.execution.succeeded")
  await setImmediate()
  await setImmediate()
  assert.equal(h.state.compact, 1, "A compaction-only execution does not loop")
  h.state.rows = [user("u", "an idle session with work")]
  assert.match((await h.state.tool.execute({ query: "idle" }, { sessionID: "s" })).content, /No matching/)
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
    return (async function* () {
      yield { type: "session.execution.succeeded", data: { sessionID: "s" } }
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
  t.mock.timers.tick(250)
  await setImmediate()
  await setImmediate()
  assert.equal(subscriptions, 3)
  assert.equal(h.state.compact, 0)
  await h.state.hooks.get("prompt")(prompt())
  assert.equal(h.state.compact, 1)
  cleanup()
  await setImmediate()
  t.mock.timers.tick(5_000)
  await setImmediate()
  assert.equal(lastSignal.aborted, true)
  assert.equal(subscriptions, 3)
})
