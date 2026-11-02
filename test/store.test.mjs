import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { DEFAULT_MASK, planMask, renderMask } from "../src/mask.ts"
import { adoptNative, resolveMemory } from "../src/memory.ts"
import { createStore } from "../src/store.ts"

class MemoryStorage {
  values = new Map()
  writes = []
  scans = 0
  fail = () => false
  async get(key) { return this.values.get(key) }
  async remove(key) { this.values.delete(key) }
  async set(key, value) {
    this.writes.push({ key, value })
    if (this.fail(key, value)) throw new Error("injected storage failure")
    this.values.set(key, value)
  }
  async scan({ prefix, after, limit = 500 }) {
    this.scans++
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
    const selected = keys.slice(0, limit)
    return { entries: selected.map((key) => ({ key, value: this.values.get(key) })), ...(keys.length > limit ? { next: selected.at(-1) } : {}) }
  }
}

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/before-mask.json", import.meta.url), "utf8"))
const options = { ...DEFAULT_MASK, minTokens: 400, distance: 100, batch: 1 }
const rows = () => [
  { id: "old/checkpoint", type: "compaction", status: "completed", summary: "previous" },
  { id: "user/one", type: "user", text: "A question 🧠" },
  { id: "assistant", type: "assistant", content: [
    { type: "reasoning", text: "keep all row data" },
    { type: "tool", id: "read/1", name: "read", state: { status: "completed", input: { path: "src/x" }, content: [{ type: "text", text: "complete output\n".repeat(2_000) }] } },
    { type: "tool", id: "hosted%2", name: "search", executed: true, state: { status: "completed", input: { query: "q" }, content: [{ type: "text", text: "result" }, { type: "file", uri: "file:///x.png", mime: "image/png" }] } },
    { type: "tool", id: "failed", name: "read", state: { status: "error", input: { path: "bad" }, error: "failure", content: [{ type: "text", text: "details" }] } },
    { type: "tool", id: "running", name: "read", state: { status: "running", input: { path: "later" } } },
  ] },
  { id: "new/checkpoint", type: "compaction", status: "running" },
]

test("archive-first preparation saves the cut and completed parent and indexes complete, hosted, and failed calls", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "session/a%")
  const input = rows(), pending = await store.prepareArchive(input)
  assert.deepEqual(pending, { id: "new/checkpoint", parent: "old/checkpoint", rowIDs: ["user/one", "assistant"], archived: true })
  assert.deepEqual(await store.getPending("new/checkpoint"), pending)
  for (const row of input.slice(0, -1)) {
    assert.deepEqual(JSON.parse(await store.getRow(row.id)), row)
    assert.equal(await store.getRow(row.id), JSON.stringify(row), "rows are stored as compact JSON")
  }
  assert.deepEqual((await store.getCall("read/1")).input, { path: "src/x" })
  assert.equal((await store.getCall("read/1")).result.value, "complete output\n".repeat(2_000))
  assert.deepEqual((await store.getCall("hosted%2")).result, { type: "content", value: input[2].content[2].state.content })
  assert.deepEqual((await store.getCall("failed")).result, { type: "error", value: { error: "failure", content: [{ type: "text", text: "details" }] } })
  assert.equal(await store.getCall("running"), undefined)
  assert.equal((await store.getRows()).length, input.length - 1)
  assert.equal(await store.getRow("new/checkpoint"), undefined, "the running checkpoint is archived only once completed")
  assert.equal((await store.getCalls()).length, 3)
  const pendingWrites = kv.writes.filter(({ key }) => key.includes("/pending/"))
  assert.deepEqual(pendingWrites.map(({ value }) => JSON.parse(value).archived), [false, true])
  assert.equal(kv.writes.at(-1).key, pendingWrites[1].key)
  assert.equal(await createStore(kv, "session/a").getRow("user/one"), undefined)
  assert.equal(await createStore(kv, "session/a%").getCall("read/1").then((call) => call.name), "read")
})

test("an individual row failure leaves a gap but archives the other rows and calls", async () => {
  const kv = new MemoryStorage(), reports = [], store = createStore(kv, "s", (message) => reports.push(message))
  kv.fail = (key) => key.endsWith("/rows/assistant")
  const pending = await store.prepareArchive(rows())
  assert.equal(pending.archived, false)
  assert.deepEqual(await store.getPending("new/checkpoint"), pending)
  assert.equal(await store.getRow("assistant"), undefined)
  assert.ok(await store.getRow("user/one"))
  assert.ok(await store.getRow("old/checkpoint"))
  assert.equal((await store.getCall("read/1")).result.value, "complete output\n".repeat(2_000))
  assert.ok(reports.some((message) => message.includes("Unable to archive row assistant")))
  const adopted = adoptNative({ id: pending.id, type: "compaction", status: "completed", summary: "native summary" }, "E2", pending)
  assert.equal(adopted.parent, "old/checkpoint")
  assert.equal(adopted.episode.gap, true)
  assert.deepEqual(adopted.episode.rowIDs, ["user/one", "assistant"])
})

test("200 cumulative compactions write each historical raw row only once", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "linear"), history = []
  for (let i = 1; i <= 200; i++) {
    history.push({ id: `u${i}`, type: "user", text: "original ".repeat(1_250) }, { id: `c${i}`, type: "compaction", status: "running" })
    const pending = await store.prepareArchive(history)
    assert.deepEqual(pending.rowIDs, [`u${i}`])
    history[history.length - 1] = { ...history.at(-1), status: "completed", summary: `summary ${i}` }
  }
  const writes = kv.writes.filter(({ key }) => key.includes("/rows/"))
  assert.equal(writes.length, 399)
  assert.equal(new Set(writes.map(({ key }) => key)).size, writes.length)
  const writtenBytes = writes.reduce((sum, { value }) => sum + Buffer.byteLength(value), 0)
  const storedBytes = [...kv.values].filter(([key]) => key.includes("/rows/")).reduce((sum, [, value]) => sum + Buffer.byteLength(value), 0)
  assert.equal(writtenBytes, storedBytes, "no cumulative raw-archive write amplification")
})

test("fork import copies only its branch and live masks, reserves IDs, and survives parent deletion", async () => {
  const kv = new MemoryStorage(), parent = createStore(kv, "parent"), child = createStore(kv, "child")
  const c1 = { id: "c1", type: "compaction", status: "completed", summary: "first" }
  const c2 = { id: "c2", type: "compaction", status: "completed", summary: "second" }
  const live = { id: "live", type: "assistant", content: [{ type: "tool", id: "live-call", name: "read", state: { status: "completed", input: { path: "original" }, content: [{ type: "text", text: "full output" }] } }] }
  await parent.archiveRows([{ id: "u1", type: "user", text: "first original" }, c1, { id: "u2", type: "user", text: "second original" }, c2, live, { id: "other", type: "user", text: "unrelated branch" }])
  await parent.saveCheckpoint({ id: "c1", parent: null, episode: { id: "E7", summary: "first", rowIDs: ["u1"] } })
  await parent.saveCheckpoint({ id: "c2", parent: "c1", episode: { id: "E8", summary: "second", rowIDs: ["u2"] } })
  await parent.saveCheckpoint({ id: "other-cp", parent: "c1", episode: { id: "E9", summary: "unrelated", rowIDs: ["other"] } })
  const call = await parent.getCall("live-call")
  const mask = { id: "live-call", name: "read", output: "[elided]" }
  await parent.commitMask({ commit: true, base: [], masks: [mask, { id: "future-call", name: "read", output: "future" }], calls: [call, { ...call, id: "future-call" }], savedTokens: 100 }, "c2")
  await child.inherit("parent", [c2, live])
  const memory = resolveMemory("c2", await child.chain("c2"))
  assert.deepEqual(memory.episodes.map((episode) => episode.id), ["E7", "E8"])
  assert.ok(memory.catalog.has("E7") && memory.catalog.has("E8"))
  assert.equal(JSON.parse(await child.getRow("u1")).text, "first original")
  assert.equal(await child.getRow("other"), undefined)
  assert.equal(await child.getCheckpoint("other-cp"), undefined)
  assert.equal(await child.getCall("future-call"), undefined)
  assert.deepEqual(await child.getMasks("c2"), [mask])
  assert.deepEqual(await child.getCall("live-call"), call)
  assert.equal(await child.nextEpisode(), "E9", "seed from imported IDs even without an existing counter")
  const writes = kv.writes.length
  await child.inherit("parent", [c2, live])
  assert.equal(kv.writes.length, writes, "completed imports are not repeated")
  await parent.clear()
  const reloaded = createStore(kv, "child")
  assert.equal(await reloaded.hasInherited(), true)
  assert.equal(JSON.parse(await reloaded.getRow("u2")).text, "second original")
  const grandchild = createStore(kv, "grandchild")
  await grandchild.inherit("child", [c2, live])
  assert.equal(JSON.parse(await grandchild.getRow("u1")).text, "first original")
  assert.equal(await grandchild.nextEpisode(), "E10")
})

test("fork imports are retryable, serialized, and do not commit after a failed copy", async () => {
  const kv = new MemoryStorage(), parent = createStore(kv, "p"), child = createStore(kv, "c")
  const cp = { id: "cp", type: "compaction", status: "completed", summary: "summary" }
  await parent.archiveRows([{ id: "u", type: "user", text: "original" }, cp])
  await parent.saveCheckpoint({ id: "cp", parent: null, episode: { id: "E1", summary: "summary", rowIDs: ["u"] } })
  kv.fail = (key) => key === "sessions/c/rows/u"
  await assert.rejects(child.inherit("p", [cp]), /injected/)
  assert.equal(await child.hasInherited(), false)
  kv.fail = () => false
  await Promise.all([child.inherit("p", [cp]), child.inherit("p", [cp])])
  assert.equal(await child.hasInherited(), true)
  assert.equal(JSON.parse(await child.getRow("u")).text, "original")
  assert.equal(await child.nextEpisode(), "E2")
})

test("fork snapshots use ordered archive cuts, not the parent's latest checkpoint or row-ID order", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "snapshots")
  const u1 = { id: "z-first", type: "user", text: "first" }, u2 = { id: "a-next", type: "user", text: "next" }
  const c1 = { id: "c1", type: "compaction", status: "completed", summary: "first" }
  await store.prepareArchive([u1, { id: "c1", type: "compaction", status: "running" }])
  await store.prepareArchive([c1, u2, { id: "c2", type: "compaction", status: "running" }])
  const live = [{ id: "c2", type: "compaction", status: "completed", summary: "second" }]
  for (const [messageID, type, ids] of [
    ["z-first", "before", []], ["z-first", "through", ["z-first"]],
    ["c1", "before", ["z-first"]], ["c1", "through", ["z-first", "c1"]],
    ["a-next", "before", ["c1"]], ["a-next", "through", ["c1", "a-next"]],
    ["c2", "through", ["c2"]],
  ]) assert.deepEqual((await store.forkSnapshot({ messageID, type }, live)).map((row) => row.id), ids)
  await assert.rejects(store.forkSnapshot({ messageID: "unknown", type: "through" }, live), /Fork boundary/)
})

test("a hidden native checkpoint retains its original summary without fabricating raw rows", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "hidden-native")
  const pending = await store.prepareArchive([{ id: "u1", type: "user", text: "original" }, { id: "c1", type: "compaction", status: "running" }])
  const row = { id: "c1", type: "compaction", status: "completed", summary: "Unadorned native summary" }
  await store.saveCheckpoint(adoptNative(row, "E1", pending))
  const snapshot = await store.forkSnapshot({ messageID: "c1", type: "through" }, [])
  assert.equal(snapshot.at(-1).summary, row.summary)
  assert.equal(await store.getRow("c1"), undefined, "Matching metadata is not an original transcript row")
})

test("mask batches archive successful originals first and skip failed calls", async () => {
  const messages = await fixture(), plan = planMask(messages, [], { ...options, distance: 0 })
  assert.equal(plan.calls.length, 2)
  const kv = new MemoryStorage(), reports = [], store = createStore(kv, "s", (message) => reports.push(message))
  kv.fail = (key) => key.endsWith(`/calls/${encodeURIComponent(plan.calls[1].id)}`)
  const partial = await store.commitMask(plan)
  assert.equal(partial.committed, true)
  assert.deepEqual(partial.masks.map((mask) => mask.id), [plan.calls[0].id])
  assert.deepEqual(await store.getMasks(), partial.masks)
  assert.deepEqual(await store.getCall(plan.calls[0].id), plan.calls[0])
  assert.equal(await store.getCall(plan.calls[1].id), undefined)
  assert.ok(reports.some((message) => message.includes(plan.calls[1].id)))
  kv.fail = () => false
  const retry = planMask(messages, partial.masks, { ...options, distance: 0 })
  assert.equal((await store.commitMask(retry)).committed, true)
  assert.deepEqual(await store.getMasks(), plan.masks)
  assert.deepEqual(await store.getCall(plan.calls[1].id), plan.calls[1])
  const callWrite = kv.writes.findLastIndex(({ key }) => key.includes("/calls/"))
  const maskWrite = kv.writes.findLastIndex(({ key }) => key.endsWith("/masks/root"))
  assert.ok(callWrite < maskWrite)

  const otherKV = new MemoryStorage(), other = createStore(otherKV, "s")
  otherKV.fail = (key) => key.endsWith("/masks/root")
  await assert.rejects(other.commitMask(plan), /injected storage failure/)
  assert.deepEqual(await other.getMasks(), [])
  assert.equal((await other.getCalls()).length, 2)
  otherKV.fail = () => false
  assert.equal((await other.commitMask(plan)).committed, true)
})

test("concurrent stale mask plans cannot erase committed stubs or start an undersized batch", async () => {
  const original = await fixture()
  const extended = [...original, { role: "user", content: [{ type: "text", text: "x".repeat(8_000) }] }]
  const first = planMask(original, [], options), stale = planMask(extended, [], options)
  assert.equal(first.masks.length, 1)
  assert.equal(stale.masks.length, 2)
  const kv = new MemoryStorage(), a = createStore(kv, "s"), b = createStore(kv, "s")
  assert.deepEqual((await Promise.all([a.commitMask(first), b.commitMask(stale)])).map((result) => result.committed), [true, false])
  const committed = await b.getMasks()
  assert.deepEqual(committed, first.masks)
  const fresh = planMask(extended, committed, options)
  assert.equal((await b.commitMask(fresh)).committed, true)
  const final = await a.getMasks()
  assert.equal(final.length, 2)
  assert.deepEqual(final[0], first.masks[0])
})

test("first complete call wins; conflicts are logged and only exact elisions are accepted", async () => {
  const kv = new MemoryStorage(), reports = []
  const report = (message) => reports.push(message)
  const a = createStore(kv, "s", report), b = createStore(kv, "s", report)
  const original = { id: "call/1", name: "read", input: { path: "x", content: "i".repeat(4_000) }, result: { type: "text", value: "o".repeat(20_000) } }
  const messages = [
    { role: "assistant", content: [{ type: "tool-call", id: original.id, name: original.name, input: original.input }] },
    { role: "tool", content: [{ type: "tool-result", id: original.id, name: original.name, result: original.result }] },
    { role: "user", content: [{ type: "text", text: "later" }] },
  ]
  await Promise.all([a.saveCall(original), b.saveCall(original)])
  const plan = planMask(messages, [], { ...options, minTokens: 10, distance: 0 })
  assert.equal((await a.commitMask(plan)).committed, true)
  const rendered = renderMask(messages, plan.masks)
  const elided = { ...original, input: rendered[0].content[0].input, result: rendered[1].content[0].result }
  assert.equal(await b.saveCall(elided), true)
  assert.deepEqual(await a.getCall("call/1"), original)
  assert.deepEqual(await b.getCalls(), [original])
  assert.equal(await a.saveCall({ ...original, name: "write" }), false)
  assert.equal(await a.saveCall({ ...original, input: { path: "other" } }), false)
  assert.equal(await a.saveCall({ ...original, result: { type: "text", value: "different original" } }), false)
  assert.equal(await a.saveCall({ ...elided, input: { ...elided.input, path: "other" } }), false)
  assert.equal(await a.saveCall({ ...elided, result: { type: "text", value: "[Output elided to save context: counterfeit]" } }), false)
  assert.equal(reports.filter((message) => message.includes("Conflicting archived tool call id")).length, 5)
  assert.deepEqual(await a.getCall("call/1"), original)
  kv.values.delete("sessions/s/calls/call%2F1")
  assert.equal(await a.saveCall(elided), false)
  assert.ok(reports.some((message) => message.includes("Missing original for committed mask")))
  assert.equal(await a.getCall(original.id), undefined)
})

test("empty tool content and bad calls do not block later calls or rows", async () => {
  const kv = new MemoryStorage(), reports = [], store = createStore(kv, "s", (message) => reports.push(message))
  const tool = (id, input, content) => ({ type: "tool", id, name: "read", state: { status: "completed", input, content } })
  const items = [
    { id: "first", type: "assistant", content: [tool("empty", {}, []), tool("bad", { value: 1n }, []), tool("later", {}, [{ type: "text", text: "still saved" }])] },
    { id: "second", type: "assistant", content: [tool("empty", { conflict: true }, [{ type: "text", text: "wrong" }]), tool("last", {}, [])] },
    { id: "after", type: "user", text: "after the bad items" },
  ]
  assert.equal(await store.archiveRows(items), false)
  assert.deepEqual((await store.getCall("empty")).result, { type: "text", value: "" })
  assert.equal((await store.getCall("later")).result.value, "still saved")
  assert.deepEqual((await store.getCall("last")).result, { type: "text", value: "" })
  assert.ok(await store.getRow("after"))
  assert.ok(reports.some((message) => message.includes("Unable to archive tool call bad")))
  assert.ok(reports.some((message) => message.includes("Conflicting archived tool call id empty")))
})

test("mask state is isolated per checkpoint and survives switching branches", async () => {
  const messages = await fixture(), plan = planMask(messages, [], { ...options, distance: 0 })
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  assert.equal((await store.commitMask(plan, "checkpoint/one")).committed, true)
  assert.deepEqual(await store.getMasks("checkpoint/one"), plan.masks)
  assert.deepEqual(await store.getMasks("checkpoint/two"), [])
  assert.deepEqual(await store.getMasks(), [])
  assert.equal((await store.commitMask(plan, "checkpoint/two")).committed, true)
  assert.deepEqual(await store.getMasks("checkpoint/two"), plan.masks)
  assert.deepEqual(await store.getMasks("checkpoint/one"), plan.masks)
  assert.ok(kv.values.has("sessions/s/masks/checkpoint%2Fone"))
  assert.ok(kv.values.has("sessions/s/masks/checkpoint%2Ftwo"))
})

test("episode IDs are monotonic under concurrent callers, isolated by session, and retryable", async () => {
  const kv = new MemoryStorage(), a = createStore(kv, "same"), b = createStore(kv, "same")
  let fail = true
  kv.fail = (key) => key.endsWith("/episode-counter") && fail
  await assert.rejects(a.nextEpisode(), /injected storage failure/)
  fail = false
  const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).nextEpisode()))
  assert.equal(new Set(ids).size, 30)
  assert.deepEqual(ids, Array.from({ length: 30 }, (_, i) => `E${i + 1}`))
  assert.equal(await createStore(kv, "other").nextEpisode(), "E1")
  assert.equal(await a.nextEpisode(), "E31")
})

test("write serialization spans host storage wrappers and reloaded modules", async () => {
  const kv = new MemoryStorage(), reports = []
  const wrapper = () => ({ get: kv.get.bind(kv), set: kv.set.bind(kv), remove: kv.remove.bind(kv), scan: kv.scan.bind(kv) })
  const reloaded = await import(`../src/store.ts?reload=${Date.now()}`)
  const a = createStore(wrapper(), "shared"), b = reloaded.createStore(wrapper(), "shared", (message) => reports.push(message))
  const ids = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).nextEpisode()))
  assert.equal(new Set(ids).size, 30)
  const call = { id: "call", name: "read", input: {}, result: { type: "text", value: "first original" } }
  assert.deepEqual(await Promise.all([a.saveCall(call), b.saveCall({ ...call, result: { type: "text", value: "conflicting" } })]), [true, false])
  assert.equal((await b.getCall("call")).result.value, "first original")
  assert.equal(reports.length, 1)
})

test("checkpoint storage resolves only the selected branch and detects missing or cyclic chains", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  const record = (id, parent, episode) => ({ id, parent, episode: { id: episode, summary: episode, rowIDs: [id] } })
  await store.saveCheckpoint(record("c1", null, "E1"))
  await store.saveCheckpoint(record("c2", "c1", "E2"))
  await store.saveCheckpoint(record("c3", "c1", "E3"))
  assert.deepEqual(resolveMemory("c3", await store.chain("c3")).episodes.map((episode) => episode.id), ["E1", "E3"])
  await assert.rejects(store.chain("missing"), /Missing checkpoint/)
  await store.saveCheckpoint(record("loop", "loop", "E4"))
  await assert.rejects(store.chain("loop"), /Cyclic checkpoint/)
})

test("search scans all storage pages without crossing session boundaries", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  const bulk = Array.from({ length: 1_003 }, (_, i) => ({ id: `row-${String(i).padStart(4, "0")}`, type: "user", text: `content ${i}` }))
  await store.archiveRows(bulk)
  await createStore(kv, "s/other").archiveRows([{ id: "secret", type: "user", text: "other session" }])
  const archived = await store.getRows()
  assert.equal(archived.length, bulk.length)
  assert.equal(kv.scans, 3)
  assert.deepEqual(archived.map(({ id }) => id), bulk.map(({ id }) => id))
  assert.deepEqual(JSON.parse(archived.at(-1).text), bulk.at(-1))
})

test("corrupt storage is an error rather than silently discarding previous state", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  kv.values.set("sessions/s/masks/root", "not json")
  await assert.rejects(store.getMasks(), /Invalid stored JSON/)
  await assert.rejects(store.commitMask(planMask(await fixture(), [], options)), /Invalid stored JSON/)
  assert.equal(kv.writes.length, 0)
  kv.values.set("sessions/s/masks/root", JSON.stringify([{ id: "x", name: "read", input: [{ path: "invalid", stub: "x" }] }]))
  await assert.rejects(store.getMasks(), /Invalid stored masks/)
  kv.values.set("sessions/s/calls/x", JSON.stringify({ id: "x", name: "read" }))
  await assert.rejects(store.getCall("x"), /Invalid archived call/)
  await assert.rejects(store.getCalls(), /Invalid archived call/)
})

test("deferred compaction is durable, session-scoped, validated and removed with its session", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  const value = { checkpoint: null, after: "last-message", tokens: 25_001 }
  assert.equal(await store.getDeferredCompaction(), undefined)
  await store.saveDeferredCompaction(value)
  assert.deepEqual(await createStore(kv, "s").getDeferredCompaction(), value)
  assert.equal(await createStore(kv, "other").getDeferredCompaction(), undefined)
  await store.clear()
  assert.equal(await store.getDeferredCompaction(), undefined)
  for (const invalid of [{}, { ...value, checkpoint: 1 }, { ...value, after: null }, { ...value, tokens: -1 }, { ...value, tokens: "25000" }]) {
    kv.values.set("sessions/s/deferred-compaction", JSON.stringify(invalid))
    await assert.rejects(store.getDeferredCompaction(), /Invalid deferred compaction/)
  }
})
