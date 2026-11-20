import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import { createLifecycle } from "../src/lifecycle.ts"
import { createStore } from "../src/store.ts"

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const storage = () => {
  const values = new Map()
  return {
    values,
    async get(key) { return values.get(key) },
    async set(key, value) { values.set(key, value) },
    async remove(key) { values.delete(key) },
    async scan({ prefix }) { return { entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) } },
  }
}

test("deletion fences an already-running write from another plugin instance before clearing", { timeout: 5_000 }, async () => {
  const raw = storage(), a = createLifecycle(raw), b = createLifecycle(raw)
  const entered = deferred(), release = deferred(), set = raw.set
  raw.set = async (key, value) => {
    if (key === "sessions/shared/rows/original") { entered.resolve(); await release.promise }
    await set(key, value)
  }
  const writing = b.storage.set("sessions/shared/rows/original", "private bytes")
  await entered.promise
  let closed = false
  const deleting = a.deleteSession("shared").then(() => { closed = true })
  await setImmediate()
  assert.equal(closed, false, "the shared mutation fence must wait for the other instance's non-cancellable write")
  release.resolve()
  await Promise.all([writing, deleting])
  await createStore(raw, "shared").clear()
  await assert.rejects(b.storage.set("sessions/shared/rows/late", "late bytes"), /archive is closed/)
  const reloaded = createLifecycle(raw)
  assert.equal(await reloaded.run("shared", async () => "entered", "closed"), "closed")
  assert.deepEqual([...raw.values], [["deleted/shared", true]])
})

test("unload fences every mutation already admitted but preserves other live instances", { timeout: 5_000 }, async () => {
  const raw = storage(), a = createLifecycle(raw), b = createLifecycle(raw)
  const entered = deferred(), release = deferred(), set = raw.set
  raw.set = async (key, value) => { entered.resolve(); await release.promise; await set(key, value) }
  const writing = a.storage.set("projects/p/thermostat", "stats")
  await entered.promise
  let done = false
  const disposing = a.dispose().then(() => { done = true })
  await setImmediate()
  assert.equal(done, false)
  release.resolve()
  await Promise.all([writing, disposing])
  await assert.rejects(a.storage.set("sessions/s/model", "late"), /archive is closed/)
  await b.storage.set("sessions/s/model", "still live")
  assert.equal(raw.values.get("sessions/s/model"), "still live")
  assert.equal(raw.values.has("deleted/s"), false)
})

test("a close racing an asynchronous tombstone read still refuses the write", { timeout: 5_000 }, async () => {
  const raw = storage(), lifecycle = createLifecycle(raw), entered = deferred(), release = deferred(), get = raw.get
  raw.get = async (key) => {
    const value = await get(key)
    if (key === "deleted/s") { entered.resolve(); await release.promise }
    return value
  }
  const writing = lifecycle.storage.set("sessions/s/rows/late", "must not land")
  await entered.promise
  const disposing = lifecycle.dispose()
  release.resolve()
  await assert.rejects(writing, /archive is closed/)
  await disposing
  assert.equal(raw.values.size, 0)
})

test("the deletion journal pages legacy pending tombstones and keeps completed namespaces closed", async () => {
  const raw = storage(), lifecycle = createLifecycle(raw), pages = []
  for (const [key, value] of [["deleted/a", true], ["deleted/b%2Fc", true], ["deleted/d", "cleared"], ["deleted/e", true], ["sessions/live/rows/r", "untouched"]]) raw.values.set(key, value)
  raw.scan = async ({ prefix, after }) => {
    pages.push(after)
    const keys = [...raw.values.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort()
    return { entries: keys.slice(0, 2).map((key) => ({ key, value: raw.values.get(key) })), ...(keys.length > 2 ? { next: keys[1] } : {}) }
  }
  const pending = []
  for await (const id of lifecycle.pendingDeletions()) pending.push(id)
  assert.deepEqual(pending, ["a", "b/c", "e"])
  assert.equal(pages.length, 2)
  await lifecycle.completeDeletion("a")
  await lifecycle.deleteSession("a")
  assert.equal(raw.values.get("deleted/a"), "cleared", "a duplicate deletion never reopens a completed cleanup")
  await assert.rejects(createLifecycle(raw).storage.set("sessions/a/rows/late", "must not land"), /archive is closed/)
  assert.equal(raw.values.get("sessions/live/rows/r"), "untouched")
})
