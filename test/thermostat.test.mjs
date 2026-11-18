import assert from "node:assert/strict"
import test from "node:test"
import { budgetBounds, closeCycle, effectiveBudget, MIN_CYCLES, THERMOSTAT_FLOOR, thermostatModels } from "../src/thermostat.ts"
import { createProjectStore } from "../src/store.ts"

// The pure law first: defaults hold until evidence exists, thresholds step at
// most once per completed cycle, and every value stays inside physics bounds.

const WIDE = budgetBounds(400_000, 100_000) // start 100k, ceiling 200k, floor 30k
const NARROW = budgetBounds(100_000, 100_000) // start 50k, ceiling 50k, floor 30k

test("bounds start at the static default, cap at half the window, floor at 30k", () => {
  assert.deepEqual(budgetBounds(100_000, 100_000), { floor: 30_000, start: 50_000, ceiling: 50_000 })
  assert.deepEqual(budgetBounds(400_000, 100_000), { floor: THERMOSTAT_FLOOR, start: 100_000, ceiling: 200_000 })
  assert.deepEqual(budgetBounds(40_000, 100_000), { floor: 20_000, start: 20_000, ceiling: 20_000 }, "a small window's own default is its floor")
})

test("the effective budget is the default until a learned entry exists, then clamped", () => {
  assert.equal(effectiveBudget(undefined, WIDE), 100_000)
  assert.equal(effectiveBudget({ ema: 1, cycles: 5, budget: 140_000 }, WIDE), 140_000)
  assert.equal(effectiveBudget({ ema: 3, cycles: 9, budget: 900_000 }, WIDE), 200_000, "never above half the window")
  assert.equal(effectiveBudget({ ema: 0, cycles: 9, budget: 1_000 }, WIDE), 30_000)
})

test("defaults hold below the evidence floor of four completed cycles", () => {
  let entry
  for (let cycle = 1; cycle < MIN_CYCLES; cycle++) {
    entry = closeCycle(entry, 12, WIDE)
    assert.deepEqual(entry, { ema: 12, cycles: cycle, budget: 100_000 }, `cycle ${cycle} never moves the budget`)
  }
})

test("EMA at or above 2.0 raises the budget by one step per completed cycle", () => {
  let entry = closeCycle(undefined, 4, WIDE)
  for (let cycle = 2; cycle <= MIN_CYCLES; cycle++) entry = closeCycle(entry, 4, WIDE)
  assert.deepEqual(entry, { ema: 4, cycles: 4, budget: 120_000 }, "the fourth cycle takes exactly one raise step")
  assert.deepEqual(closeCycle(entry, 4, WIDE), { ema: 4, cycles: 5, budget: 144_000 })
  assert.equal(closeCycle(entry, 400, WIDE).budget, 144_000, "even a huge count takes one step, not a jump")
})

test("EMA at or below 0.5 lowers the budget, never below the floor", () => {
  let entry
  for (let cycle = 1; cycle <= MIN_CYCLES; cycle++) entry = closeCycle(entry, 0, WIDE)
  assert.deepEqual(entry, { ema: 0, cycles: 4, budget: 90_000 })
  for (let cycle = 0; cycle < 12; cycle++) entry = closeCycle(entry, 0, WIDE)
  assert.equal(entry.budget, 30_000, "the floor holds")
  assert.deepEqual(closeCycle({ ema: 4, cycles: 9, budget: 50_000 }, 4, NARROW), { ema: 4, cycles: 10, budget: 50_000 }, "a raise on a narrow window clamps to its ceiling")
})

test("an EMA strictly between the thresholds steps nothing, and invalid counts fail loudly", () => {
  let entry
  for (let cycle = 1; cycle <= 8; cycle++) entry = closeCycle(entry, 1, WIDE)
  assert.deepEqual(entry, { ema: 1, cycles: 8, budget: 100_000 }, "one recall per cycle is no pressure either way")
  assert.throws(() => closeCycle(undefined, -1, WIDE), /Invalid cycle recall count/)
  assert.throws(() => closeCycle(undefined, Number.NaN, WIDE), /Invalid cycle recall count/)
})

test("tolerant model records drop corrupt entries, never throw", () => {
  assert.deepEqual(thermostatModels(undefined), {})
  assert.deepEqual(thermostatModels("junk"), {})
  assert.deepEqual(thermostatModels({ a: { ema: 1, cycles: 2, budget: 50_000 }, b: { ema: -1, cycles: 2, budget: 50_000 }, c: { ema: 1 } }), { a: { ema: 1, cycles: 2, budget: 50_000 } })
})

// The project store persists the same law under an exclusive lock and never throws.

class MemoryStorage {
  values = new Map()
  fail = () => false
  async get(key) { return this.values.get(key) }
  async set(key, value) { if (this.fail(key, value)) throw new Error("injected storage failure"); this.values.set(key, value) }
  async remove(key) { this.values.delete(key) }
  async scan() { return { entries: [] } }
}

const record = async (storage) => JSON.parse((await storage.get("project/thermostat")) ?? "null")

test("the project store folds cycles per model and shares one record", async () => {
  const storage = new MemoryStorage()
  const store = createProjectStore(storage, () => {})
  assert.deepEqual(await store.readThermostat(), {})
  const entry = await store.closeCycle("provider/model", 2, NARROW)
  assert.deepEqual(entry, { ema: 2, cycles: 1, budget: 50_000 })
  assert.deepEqual(await store.closeCycle("provider/other", 0, NARROW), { ema: 0, cycles: 1, budget: 50_000 })
  assert.deepEqual(await record(storage), {
    "provider/model": { ema: 2, cycles: 1, budget: 50_000 },
    "provider/other": { ema: 0, cycles: 1, budget: 50_000 },
  })
  assert.deepEqual(await store.readThermostat(), await record(storage), "reads and writes agree")
})

test("thermostat storage failures self-heal and never throw", async () => {
  const storage = new MemoryStorage()
  const reported = []
  const store = createProjectStore(storage, (message) => reported.push(message))
  storage.fail = (key) => key === "project/thermostat"
  assert.equal(await store.closeCycle("provider/model", 2, NARROW), undefined, "a failed write reports and returns nothing")
  assert.ok(reported.length === 1 && reported[0].includes("provider/model"))
  storage.fail = () => false
  await storage.set("project/thermostat", "not json{")
  assert.deepEqual(await store.readThermostat(), {}, "an undecodable record reads as absent")
  assert.deepEqual(await store.closeCycle("provider/model", 2, NARROW), { ema: 2, cycles: 1, budget: 50_000 }, "the next write self-heals over corruption")
  assert.deepEqual(await record(storage), { "provider/model": { ema: 2, cycles: 1, budget: 50_000 } })
})
