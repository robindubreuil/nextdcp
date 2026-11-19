import assert from "node:assert/strict"
import test from "node:test"
import { adoptNative, resolveMemory } from "../src/memory.ts"
import { createProjectStore, createStore } from "../src/store.ts"

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

test("fork import copies only its branch, reserves IDs, and survives parent deletion", async () => {
  const kv = new MemoryStorage(), parent = createStore(kv, "parent"), child = createStore(kv, "child")
  const c1 = { id: "c1", type: "compaction", status: "completed", summary: "first" }
  const c2 = { id: "c2", type: "compaction", status: "completed", summary: "second" }
  const live = { id: "live", type: "assistant", content: [{ type: "tool", id: "live-call", name: "read", state: { status: "completed", input: { path: "original" }, content: [{ type: "text", text: "full output" }] } }] }
  await parent.archiveRows([{ id: "u1", type: "user", text: "first original" }, c1, { id: "u2", type: "user", text: "second original" }, c2, live, { id: "other", type: "user", text: "unrelated branch" }])
  await parent.saveCheckpoint({ id: "c1", parent: null, episode: { id: "E7", summary: "first", rowIDs: ["u1"] } })
  await parent.saveCheckpoint({ id: "c2", parent: "c1", episode: { id: "E8", summary: "second", rowIDs: ["u2"] } })
  await parent.saveCheckpoint({ id: "other-cp", parent: "c1", episode: { id: "E9", summary: "unrelated", rowIDs: ["other"] } })
  const call = await parent.getCall("live-call")
  await parent.saveCall({ id: "unreferenced", name: "read", input: { path: "no" }, result: { type: "text", value: "no" } })
  await child.inherit("parent", [c2, live])
  const memory = resolveMemory("c2", await child.chain("c2"))
  assert.deepEqual(memory.episodes.map((episode) => episode.id), ["E7", "E8"])
  assert.ok(memory.catalog.has("E7") && memory.catalog.has("E8"))
  assert.equal(JSON.parse(await child.getRow("u1")).text, "first original")
  assert.equal(await child.getRow("other"), undefined)
  assert.equal(await child.getCheckpoint("other-cp"), undefined)
  assert.equal(await child.getCall("unreferenced"), undefined, "calls outside the branch are not copied")
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

test("the first complete original wins; conflicting rewrites are logged and rejected", async () => {
  const kv = new MemoryStorage(), reports = []
  const report = (message) => reports.push(message)
  const a = createStore(kv, "s", report), b = createStore(kv, "s", report)
  const original = { id: "call/1", name: "read", input: { path: "x", content: "i".repeat(4_000) }, result: { type: "text", value: "o".repeat(20_000) } }
  await Promise.all([a.saveCall(original), b.saveCall(original)])
  assert.equal(await a.saveCall(original), true, "an identical rewrite is idempotent")
  assert.deepEqual(await a.getCall("call/1"), original)
  assert.deepEqual(await b.getCalls(), [original])
  assert.equal(await a.saveCall({ ...original, name: "write" }), false)
  assert.equal(await a.saveCall({ ...original, input: { path: "other" } }), false)
  assert.equal(await a.saveCall({ ...original, result: { type: "text", value: "different original" } }), false)
  assert.equal(reports.filter((message) => message.includes("Conflicting archived tool call id")).length, 3)
  assert.deepEqual(await a.getCall("call/1"), original)
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
  kv.values.set("sessions/s/calls/x", "not json")
  await assert.rejects(store.getCall("x"), /Invalid stored JSON/)
  kv.values.set("sessions/s/calls/x", JSON.stringify({ id: "x", name: "read" }))
  await assert.rejects(store.getCall("x"), /Invalid archived call/)
  await assert.rejects(store.getCalls(), /Invalid archived call/)
  assert.equal(kv.writes.length, 0)
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

test("clear removes the whole session root, including keys written outside the store", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "s")
  await store.saveDeferredCompaction({ checkpoint: null, after: "m1", tokens: 25_001 })
  kv.values.set("sessions/s/model", JSON.stringify({ mode: "specific" }))
  kv.values.set("sessions/s/model/warning", "stale warning")
  kv.values.set("sessions/s/unknown-future-key", "x")
  kv.values.set("sessions/other/rows/r9", "{}")
  await store.clear()
  assert.deepEqual([...kv.values.keys()], ["sessions/other/rows/r9"], "the session root is gone; other sessions survive")
})

// Graduation: episode notes outlive their session at project/episodes/P<n>.

test("graduatedNotes drops corrupt records and reads what graduate wrote", async () => {
  const kv = new MemoryStorage(), project = createProjectStore(kv, () => {})
  assert.deepEqual(await project.graduatedNotes(), [])
  assert.equal(await project.graduate([{ note: "Title: Auth fix\nWork: rotated the client secret", end: 1_000 }, { note: "", end: 2_000 }], "ses_aaa"), 1, "empty notes never graduate")
  kv.values.set("project/episodes/P9", "not json{")
  kv.values.set("project/episodes/P10", JSON.stringify({ id: "P10", note: "valid note", session: "ses_bbb", end: 3_000 }))
  kv.values.set("project/episodes/P11", JSON.stringify({ id: "P11", note: "no session", end: 3_000 }))
  const notes = await project.graduatedNotes()
  assert.deepEqual(notes.map(({ id }) => id).sort(), ["P1", "P10"], "corrupt records are skipped, valid ones kept")
})

test("graduate dedups exact text across sessions and sequences P<n> above the highest existing", async () => {
  const kv = new MemoryStorage(), project = createProjectStore(kv, () => {})
  assert.equal(await project.graduate([{ note: "note one", end: 10 }, { note: "note one", end: 20 }], "ses_a"), 1, "an exact duplicate within one batch graduates once")
  assert.equal(await project.graduate([{ note: "note one", end: 30 }], "ses_b"), 0, "fork copies across sessions never graduate twice")
  assert.equal(await project.graduate([{ note: "note two", end: 40 }, { note: "note three", end: 50 }], "ses_b"), 2)
  const notes = await project.graduatedNotes()
  assert.deepEqual(notes.map(({ id, note, session }) => [id, note, session]).sort(([a], [b]) => a < b ? -1 : 1), [
    ["P1", "note one", "ses_a"],
    ["P2", "note two", "ses_b"],
    ["P3", "note three", "ses_b"],
  ])
  kv.values.set("project/episodes/P40", JSON.stringify({ id: "P40", note: "planted high", session: "ses_z", end: 60 }))
  assert.equal(await project.graduate([{ note: "note four", end: 70 }], "ses_c"), 1)
  assert.ok(kv.values.has("project/episodes/P41"), "numbering continues above the highest existing P<n>")
})

test("graduate keeps the 200 most recent notes and removes overflow oldest first", async () => {
  const kv = new MemoryStorage(), project = createProjectStore(kv, () => {})
  const batch = Array.from({ length: 205 }, (_, index) => ({ note: `note ${index}`, end: index }))
  assert.equal(await project.graduate(batch, "ses_a"), 205)
  const notes = await project.graduatedNotes()
  assert.equal(notes.length, 200, "the cap holds")
  assert.deepEqual(notes.map(({ end }) => end).sort((a, b) => a - b), Array.from({ length: 200 }, (_, index) => index + 5), "the five oldest were removed")
})

test("graduation storage failures report and never throw", async () => {
  const kv = new MemoryStorage(), reported = []
  const project = createProjectStore(kv, (message) => reported.push(message))
  kv.fail = (key) => key.startsWith("project/episodes/")
  assert.equal(await project.graduate([{ note: "note", end: 1 }], "ses_a"), 0)
  assert.equal(reported.length, 1)
  assert.ok(String(reported[0]).includes("graduate session notes"))
  kv.fail = () => false
  assert.equal(await project.graduate([{ note: "note", end: 1 }], "ses_a"), 1, "the next graduation self-heals")
})

test("episodeNotes returns every committed episode's note with an end-time fallback", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "session/s")
  const checkpoint = (id, summary) => ({ id, parent: null, rowIDs: [], episode: { id, summary, rowIDs: [] } })
  await store.saveCheckpoint(checkpoint("e1", "Title: First\nWork: one"))
  await store.saveCheckpoint(checkpoint("e2", "Title: Second\nWork: two"))
  await store.saveCheckpoint({ ...checkpoint("e3", "Title: Third\nWork: three"), episode: { id: "e3", summary: "Title: Third\nWork: three", rowIDs: [], end: 4_500 } })
  await kv.set("sessions/s/checkpoints/broken", "{not json")
  const before = Date.now()
  const notes = await store.episodeNotes()
  assert.deepEqual(notes.map(({ note }) => note).sort(), ["First\nWork: one", "Second\nWork: two", "Third\nWork: three"], "the Title: prefix is consumed, as in every other note surface")
  assert.equal(notes.find(({ note }) => note.includes("Third")).end, 4_500)
  assert.ok(notes.every(({ end }) => end === 4_500 || end >= before), "a missing end falls back to now")
})

test("episode reservations are per-parent, ride the pending record, and never reuse a committed id", async () => {
  const kv = new MemoryStorage(), store = createStore(kv, "session/s")
  const pending = await store.prepareArchive(rows())
  assert.equal(pending.parent, "old/checkpoint")
  assert.equal(await store.reservedEpisode("old/checkpoint"), "E1")
  assert.equal(await store.reservedEpisode("old/checkpoint"), "E1", "an uncommitted reservation is reused by the next precompute or cut")
  await store.pendingEpisode(pending.id, "E1")
  assert.equal((await store.getPending(pending.id)).episode, "E1")
  const adopted = adoptNative({ id: pending.id, type: "compaction", status: "completed", summary: "Native summary" }, "E1", await store.getPending(pending.id))
  await store.saveCheckpoint(adopted)
  assert.equal(await store.reservedEpisode("old/checkpoint"), "E2", "a reverted branch's committed episode id is never handed out again")
  assert.equal(await store.reservedEpisode(null), "E3", "a root cut always allocates a fresh id")
  await store.pendingEpisode("missing", "E9")
  assert.equal(await store.getPending("missing"), undefined, "recording a reservation cannot invent a pending record")
})
