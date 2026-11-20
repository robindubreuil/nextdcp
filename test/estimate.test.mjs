import assert from "node:assert/strict"
import test from "node:test"
import { durableTokens, latestProviderUsage, retainedTokens } from "../src/estimate.ts"
import { tokens } from "../src/tokens.ts"

test("retained conversation sums only the latest completed summary/tail and subsequent durable rows", () => {
  const rows = [
    { id: "old", type: "user", text: "archived".repeat(10_000) },
    { id: "c1", type: "compaction", status: "completed", summary: "older".repeat(1_000), metadata: { recent: "older tail".repeat(1_000) } },
    { id: "c2", type: "compaction", status: "completed", summary: "state", metadata: { recent: "native tail" } },
    { id: "u", type: "user", text: "new durable text", skills: [{ text: "activated skill" }] },
    { id: "a", type: "assistant", content: [{ type: "text", text: "answer" }, { type: "reasoning", text: "ephemeral".repeat(10_000) }] },
    { id: "pending", type: "compaction", status: "running", summary: "not a retained checkpoint" },
  ]
  assert.equal(retainedTokens(rows), tokens("state") + tokens("native tail") + durableTokens(rows.slice(3)))
  assert.equal(retainedTokens(rows.slice(3)), durableTokens(rows.slice(3)), "before the first completed cut, retained equals new durable growth")
  assert.equal(retainedTokens([]), 0)
  assert.equal(retainedTokens([{ id: "c", type: "compaction", status: "completed", metadata: { recent: { invalid: "shape" } } }]), 0)
})

test("raw provider cache counters support both observed shapes and are never added twice", () => {
  const row = { id: "a", type: "assistant", tokens: { input: 3, output: 100, reasoning: 20, cacheRead: 2_000, cacheWrite: 50, cache: { read: 999, write: 999 } } }
  assert.deepEqual(latestProviderUsage([row]), { messageID: "a", input: 3, output: 100, reasoning: 20, cacheRead: 2_000, cacheWrite: 50 })
  const { cacheRead, cacheWrite, ...nested } = row.tokens
  assert.deepEqual(latestProviderUsage([{ ...row, tokens: nested }]), { messageID: "a", input: 3, output: 100, reasoning: 20, cacheRead: 999, cacheWrite: 999 })
})
