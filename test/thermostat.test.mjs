import assert from "node:assert/strict"
import test from "node:test"
import { budgetBounds, closeCycle, effectiveBudget, L_MIN, L_TARGET, shortCycles, THERMOSTAT_VERSION, thermostatModels } from "../src/thermostat.ts"
import { createProjectStore } from "../src/store.ts"

const WIDE = budgetBounds(1_050_000, 128_000, 922_000), NARROW = budgetBounds(100_000)
const entry = (extra = {}) => ({ version: THERMOSTAT_VERSION, growth: 2_500, span: 20, cycles: 1, budget: 160_000, ...extra })

test("the overdue safeguard starts at 200k within bounded policy, scaling down for smaller windows", () => {
  assert.deepEqual(WIDE, { floor: 150_000, start: 200_000, ceiling: 300_000 })
  assert.deepEqual(NARROW, { floor: 37_500, start: 50_000, ceiling: 75_000 })
  assert.deepEqual(budgetBounds(400_000), WIDE)
  assert.deepEqual(budgetBounds(40_000), { floor: 15_000, start: 20_000, ceiling: 30_000 })
  assert.deepEqual(budgetBounds(8_000, 8_000), { floor: 1, start: 1, ceiling: 1 }, "never a negative bound")
  assert.deepEqual(budgetBounds(1_000_000, 128_000, 180_000), { floor: 134_232, start: 178_976, ceiling: 178_976 }, "a separate input limit clamps the policy too")
  assert.equal(budgetBounds(100_001).ceiling, 75_000, "fractional half-window arithmetic cannot round above a bound")
})

test("the effective safeguard defaults, then clamps learned state to policy/capacity bounds", () => {
  assert.equal(effectiveBudget(undefined, WIDE), 200_000)
  assert.equal(effectiveBudget(entry({ budget: 240_000 }), WIDE), 240_000)
  assert.equal(effectiveBudget(entry({ budget: 900_000 }), WIDE), WIDE.ceiling)
  assert.equal(effectiveBudget(entry({ budget: 1_000 }), WIDE), WIDE.floor)
})

test("cycle EMAs fold durable rate and observed span, not an evidence-demand allowance", () => {
  const first = closeCycle(undefined, 50_000, 20, WIDE, 0)
  assert.deepEqual(first, entry())
  const next = closeCycle(first, 225_000, 30, WIDE, 0)
  assert.deepEqual(next, entry({ growth: 5_000, span: 25, cycles: 2, budget: 150_000 }))
})

test("the rate target includes the retained starting summary/tail but cannot prescribe a low routine cadence", () => {
  let state
  for (let cycle = 1; cycle <= 3; cycle++) state = closeCycle(state, 5_000 * 28, 28, WIDE, 80_000)
  assert.equal(state.budget, 80_000 + 5_000 * L_TARGET)
  let small
  for (let cycle = 1; cycle <= 12; cycle++) small = closeCycle(small, 3_000, 30, WIDE, 0)
  assert.equal(small.budget, 150_000)
})

test("each adjustment allows at most 50% growth or 20% reduction, with immediate capacity clamps", () => {
  assert.equal(closeCycle(entry({ budget: 160_000 }), 1_400_000, 28, WIDE, 0).budget, 240_000)
  assert.equal(closeCycle(entry({ budget: 200_000 }), 1_400_000, 28, WIDE, 0).budget, 300_000)
  assert.equal(closeCycle(entry({ budget: 200_000 }), 3_000, 30, WIDE, 0).budget, 160_000)
  assert.equal(closeCycle(entry({ budget: 300_000 }), 140_000, 28, NARROW, 0).budget, NARROW.ceiling, "a smaller live model can force an immediate clamp")
  assert.equal(closeCycle(entry({ budget: 160_001 }), 1_400_000, 28, WIDE, 0).budget, 240_001, "integer rounding cannot exceed +50%")
  assert.equal(closeCycle(entry({ budget: 200_001 }), 0, 30, WIDE, 0).budget, 160_001, "integer rounding cannot exceed a 20% reduction")
})

test("bulk evidence and huge retained baselines cannot lift learning toward the full model window", () => {
  let state
  for (let cycle = 0; cycle < 12; cycle++) {
    state = closeCycle(state, 2_000_000, 20, WIDE, 1_000_000)
    assert.ok(state.budget <= 300_000)
  }
  assert.equal(state.budget, 300_000)
  assert.ok(state.budget < 920_976 / 2, "the policy ceiling is not the usable input window")
})

test("invalid measurements fail loudly and corrupt persisted entries are dropped", () => {
  for (const [tokens, turns, baseline] of [[-1, 10, 0], [NaN, 10, 0], [1_000, 0, 0], [1_000, 1.5, 0], [1_000, 2, -1], [1_000, 2, Infinity]]) {
    assert.throws(() => closeCycle(undefined, tokens, turns, WIDE, baseline), /Invalid/)
  }
  assert.deepEqual(thermostatModels(undefined), {})
  assert.deepEqual(thermostatModels("junk"), {})
  assert.deepEqual(thermostatModels({ valid: entry(), bad: entry({ growth: NaN }), fractional: entry({ budget: 200_000.5 }), future: entry({ version: 3 }), obsolete: { growth: 2_500, span: 20, cycles: 2, budget: 50_000 } }), { valid: entry() })
})

test("old unbounded growth/demand learning reseeds rather than masquerading as a new retained safeguard", () => {
  const old = { growth: 10_000, generated: 500, demand: 0.8, span: 20, cycles: 10, budget: 429_982 }
  assert.deepEqual(thermostatModels({ "provider/model": old }), {})
  assert.equal(effectiveBudget(thermostatModels({ "provider/model": old })["provider/model"], WIDE), 200_000)
  assert.deepEqual(thermostatModels({ "provider/model": entry({ budget: 250_000 }) }), { "provider/model": entry({ budget: 250_000 }) }, "new learning survives a reload")
})

test("short-cycle diagnostics refer to the upper policy bound, not physical window exhaustion", () => {
  assert.equal(shortCycles(undefined, WIDE), false)
  assert.equal(shortCycles(entry({ budget: WIDE.ceiling, span: 5 }), WIDE), true)
  assert.equal(shortCycles(entry({ budget: 200_000, span: 5 }), WIDE), false)
  assert.equal(shortCycles(entry({ budget: WIDE.ceiling, span: L_MIN }), WIDE), false)
})

class MemoryStorage {
  values = new Map()
  fail = () => false
  async get(key) { return this.values.get(key) }
  async set(key, value) { if (this.fail(key, value)) throw new Error("injected storage failure"); this.values.set(key, value) }
  async remove(key) { this.values.delete(key) }
  async scan() { return { entries: [] } }
}

test("project stores isolate learned models, share concurrent cycles, and self-heal storage failures", async () => {
  const storage = new MemoryStorage(), reported = []
  const a = createProjectStore(storage, "a", (message) => reported.push(message)), b = createProjectStore(storage, "b")
  await Promise.all([a.closeCycle("provider/model", 50_000, 20, WIDE, 0), a.closeCycle("provider/model", 50_000, 20, WIDE, 0)])
  assert.equal((await a.readThermostat())["provider/model"].cycles, 2)
  assert.deepEqual(await b.readThermostat(), {})
  storage.fail = (key) => key === "projects/a/thermostat"
  assert.equal(await a.closeCycle("provider/model", 50_000, 20, WIDE, 0), undefined)
  assert.equal(reported.length, 1)
  storage.fail = () => false
  await storage.set("projects/a/thermostat", "not json{")
  assert.deepEqual(await a.readThermostat(), {})
  assert.deepEqual(await a.closeCycle("provider/model", 50_000, 20, WIDE, 0), entry())
})
