import assert from "node:assert/strict"
import test from "node:test"
import { budgetBounds, closeCycle, effectiveBudget, L_MIN, L_TARGET, overWindow, THERMOSTAT_CEILING, THERMOSTAT_FLOOR, thermostatModels } from "../src/thermostat.ts"
import { createProjectStore } from "../src/store.ts"

// The pure law first: the growth and span EMAs fold at half weight, the budget
// takes at most one proportional step per completed cycle unless physics forces
// it, and every value stays inside the window's bounds.

const WIDE = budgetBounds(400_000, 100_000) // start 100k, ceiling 150k, floor 30k
const NARROW = budgetBounds(100_000, 100_000) // start 50k, ceiling 50k, floor 30k

test("bounds start at the static default, cap at min(half the window, the context-rot ceiling), floor at 30k", () => {
  assert.deepEqual(budgetBounds(100_000, 100_000), { floor: 30_000, start: 50_000, ceiling: 50_000 })
  assert.deepEqual(budgetBounds(400_000, 100_000), { floor: THERMOSTAT_FLOOR, start: 100_000, ceiling: THERMOSTAT_CEILING })
  assert.deepEqual(budgetBounds(1_000_000, 100_000), { floor: THERMOSTAT_FLOOR, start: 100_000, ceiling: THERMOSTAT_CEILING }, "a huge window earns no more than the context-rot ceiling")
  assert.deepEqual(budgetBounds(40_000, 100_000), { floor: 20_000, start: 20_000, ceiling: 20_000 }, "a small window's own default is its floor")
})

test("the effective budget is the default until a learned entry exists, then clamped", () => {
  assert.equal(effectiveBudget(undefined, WIDE), 100_000)
  assert.equal(effectiveBudget({ growth: 2_500, span: 20, cycles: 5, budget: 140_000 }, WIDE), 140_000)
  assert.equal(effectiveBudget({ growth: 3, span: 20, cycles: 9, budget: 900_000 }, WIDE), 150_000, "never above the context-rot ceiling, let alone half the window")
  assert.equal(effectiveBudget({ growth: 0, span: 20, cycles: 9, budget: 1_000 }, WIDE), 30_000)
})

test("the first cycle measures growth and span; later cycles fold both at half weight", () => {
  assert.deepEqual(closeCycle(undefined, 50_000, 20, WIDE), { growth: 2_500, span: 20, cycles: 1, budget: 80_000 })
  assert.deepEqual(closeCycle({ growth: 2_500, span: 20, cycles: 1, budget: 80_000 }, 225_000, 30, WIDE),
    { growth: 5_000, span: 25, cycles: 2, budget: 96_000 }, "growth 2500·0.5+7500·0.5, span 20·0.5+30·0.5, budget one step toward 140k")
})

test("a sustained rate settles at growth times the turn-space setpoint", () => {
  let entry
  for (let cycle = 1; cycle <= 3; cycle++) entry = closeCycle(entry, 5_000 * 28, 28, WIDE)
  assert.deepEqual(entry, { growth: 5_000, span: 28, cycles: 3, budget: 140_000 }, `${5_000}·${L_TARGET} exactly`)
  let small
  for (let cycle = 1; cycle <= 4; cycle++) small = closeCycle(small, 120 * 30, 30, WIDE)
  assert.equal(small.budget, 80_000 * 0.8 * 0.8 * 0.8, "a cheap transcript lowers the budget one step per cycle, toward the floor")
})

test("the budget moves at most one rate-limited step per cycle — except physics", () => {
  const at = { growth: 5_000, span: 28, cycles: 5, budget: 100_000 }
  assert.equal(closeCycle(at, 140_000, 28, WIDE).budget, 120_000, "one +20% step toward the setpoint")
  assert.equal(closeCycle(at, 1_400_000, 28, WIDE).budget, 150_000,
    `a freak cycle half-folds growth yet pushes to the ceiling: below growth·${L_MIN} the budget would cut more often than physics allows`)
  assert.equal(closeCycle({ growth: 100, span: 30, cycles: 5, budget: 100_000 }, 3_000, 30, WIDE).budget, 80_000, "one −20% step")
  let cheap = { growth: 100, span: 30, cycles: 9, budget: 100_000 }
  for (let cycle = 0; cycle < 12; cycle++) cheap = closeCycle(cheap, 3_000, 30, WIDE)
  assert.equal(cheap.budget, 30_000, "the floor holds")
  assert.equal(closeCycle({ growth: 5_000, span: 28, cycles: 9, budget: 50_000 }, 140_000, 28, NARROW).budget, 50_000, "a raise on a narrow window clamps to its ceiling")
})

test("invalid cycle measurements fail loudly", () => {
  assert.throws(() => closeCycle(undefined, -1, 10, WIDE), /Invalid cycle token count/)
  assert.throws(() => closeCycle(undefined, Number.NaN, 10, WIDE), /Invalid cycle token count/)
  assert.throws(() => closeCycle(undefined, 1_000, 0, WIDE), /Invalid cycle turn count/)
  assert.throws(() => closeCycle(undefined, 1_000, 1.5, WIDE), /Invalid cycle turn count/)
})

test("overWindow flags only a ceiling-saturated budget whose measured cycles run short", () => {
  assert.equal(overWindow(undefined, NARROW), false)
  assert.equal(overWindow({ growth: 10_000, span: 5, cycles: 3, budget: 50_000 }, NARROW), true, "span below L_MIN at the ceiling")
  assert.equal(overWindow({ growth: 10_000, span: 5, cycles: 3, budget: 40_000 }, NARROW), false, "not yet saturated")
  assert.equal(overWindow({ growth: 10_000, span: 5 * L_MIN, cycles: 3, budget: 50_000 }, NARROW), false, "long cycles are fine at the ceiling")
})

test("tolerant model records drop corrupt and pre-turn-space entries, never throw", () => {
  assert.deepEqual(thermostatModels(undefined), {})
  assert.deepEqual(thermostatModels("junk"), {})
  assert.deepEqual(thermostatModels({
    a: { growth: 2_500, span: 20, cycles: 2, budget: 50_000 },
    b: { growth: -1, span: 20, cycles: 2, budget: 50_000 },
    c: { ema: 1, cycles: 2, budget: 50_000 },
    d: { growth: 2_500 },
  }), { a: { growth: 2_500, span: 20, cycles: 2, budget: 50_000 } }, "an ema-keyed legacy entry drops whole")
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
  const entry = await store.closeCycle("provider/model", 50_000, 20, NARROW)
  assert.deepEqual(entry, { growth: 2_500, span: 20, cycles: 1, budget: 50_000 })
  assert.deepEqual(await store.closeCycle("provider/other", 24_000, 200, NARROW), { growth: 120, span: 200, cycles: 1, budget: 40_000 })
  assert.deepEqual(await record(storage), {
    "provider/model": { growth: 2_500, span: 20, cycles: 1, budget: 50_000 },
    "provider/other": { growth: 120, span: 200, cycles: 1, budget: 40_000 },
  })
  assert.deepEqual(await store.readThermostat(), await record(storage), "reads and writes agree")
})

test("thermostat storage failures self-heal and never throw", async () => {
  const storage = new MemoryStorage()
  const reported = []
  const store = createProjectStore(storage, (message) => reported.push(message))
  storage.fail = (key) => key === "project/thermostat"
  assert.equal(await store.closeCycle("provider/model", 50_000, 20, NARROW), undefined, "a failed write reports and returns nothing")
  assert.ok(reported.length === 1 && reported[0].includes("provider/model"))
  storage.fail = () => false
  await storage.set("project/thermostat", "not json{")
  assert.deepEqual(await store.readThermostat(), {}, "an undecodable record reads as absent")
  assert.deepEqual(await store.closeCycle("provider/model", 50_000, 20, NARROW), { growth: 2_500, span: 20, cycles: 1, budget: 50_000 }, "the next write self-heals over corruption")
  assert.deepEqual(await record(storage), { "provider/model": { growth: 2_500, span: 20, cycles: 1, budget: 50_000 } })
})
