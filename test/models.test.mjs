import assert from "node:assert/strict"
import test from "node:test"
import { assertFits, validPreference } from "../src/models.ts"

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
