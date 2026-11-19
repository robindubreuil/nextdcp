import assert from "node:assert/strict"
import test from "node:test"
import { assertFits, createModels, validPreference } from "../src/models.ts"

class MemoryStorage {
  values = new Map()
  fail = () => false
  async get(key) { return this.values.get(key) }
  async remove(key) { return this.values.delete(key) }
  async set(key, value) { if (this.fail(key)) throw new Error("injected storage failure"); this.values.set(key, value) }
}

test("preference validation rejects corrupt or mixed policies", () => {
  for (const value of [undefined, null, [], {}, { mode: "specific" }, { mode: "main", model: {} },
    { mode: "specific", model: { providerID: "p", id: "" } }, { mode: "specific", model: { providerID: "p", id: "m", extra: true } }]) {
    assert.equal(validPreference(value), false)
  }
  for (const value of [{ mode: "default" }, { mode: "main" }, { mode: "specific", model: { providerID: "p", id: "a/b", variant: "light" } }]) {
    assert.equal(validPreference(value), true)
  }
})

test("capacity checks reserve output and margin, honor input limits, and reject unknown windows", () => {
  const prompt = "normal transcript ".repeat(100)
  assert.doesNotThrow(() => assertFits({ limit: { context: 32_000, output: 4_000 } }, prompt))
  for (const limit of [{ context: 0, output: 4_000 }, { context: 1_000, output: 4_000 },
    { context: 32_000, output: 4_000, input: 1_000 }, { context: 32_000, output: 32_000 }]) {
    assert.throws(() => assertFits({ limit }, prompt), /safe capacity/)
  }
})

test("fallback warnings keep a capped append-only history and never break the fallback", async () => {
  const kv = new MemoryStorage(), models = createModels({ storage: kv })
  const quiet = console.warn
  console.warn = () => {}
  try {
    for (let at = 1; at <= 12; at++) await models.warning("s1", `fallback ${at}`)
    assert.equal(kv.values.get("sessions/s1/model/warning"), "fallback 12")
    const entries = JSON.parse(kv.values.get("sessions/s1/model/warnings"))
    assert.deepEqual(entries.map((entry) => entry.message), Array.from({ length: 10 }, (_, index) => `fallback ${index + 3}`), "the history keeps the last ten")
    assert.ok(entries.every((entry) => typeof entry.time === "number" && entry.time <= Date.now()))
    kv.values.set("sessions/s1/model/warnings", "{not json")
    await models.warning("s1", "fallback 13")
    assert.deepEqual(JSON.parse(kv.values.get("sessions/s1/model/warnings")).map((entry) => entry.message), ["fallback 13"], "a corrupt history self-heals")
    kv.fail = () => true
    await models.warning("s1", "fallback 14")
    assert.equal(kv.values.get("sessions/s1/model/warning"), "fallback 13", "a storage failure leaves prior state untouched and does not throw")
  } finally { console.warn = quiet }
})
