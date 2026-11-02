import assert from "node:assert/strict"
import test from "node:test"
import { conversationGrowth, projectHistory } from "./support/history.ts"
import { messageTokens, planMask, renderMask } from "../src/mask.ts"

const options = { minTokens: 10, distance: 0, batch: 1, protected: [] }
const tool = (id, input, output, extra = {}) => ({
  type: "tool", id, name: "write", ...extra,
  state: { status: "completed", input, content: [{ type: "text", text: output }] },
})

test("v2 rows project paired tool parts, content and attachments for estimation", () => {
  const rows = [
    { id: "u", type: "user", text: "hello", skills: [{ text: "skill text" }], files: [
      { mime: "text/plain", name: "a.txt", data: Buffer.from("attached contents").toString("base64") },
      { mime: "image/png", data: "" },
    ] },
    { id: "a", type: "assistant", content: [{ type: "reasoning", text: "thought" }, tool("c1", { path: "x" }, "result"), tool("hosted", {}, "hosted result", { executed: true })] },
    { id: "idle", type: "idle" },
  ]
  const { messages, calls } = projectHistory(rows)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, "user")
  assert.ok(messages[0].content.some((part) => part.text?.includes("attached contents")))
  assert.ok(messages[0].content.some((part) => part.type === "media"))
  assert.deepEqual(messages[1].content.map((part) => part.type), ["reasoning", "tool-call", "tool-call", "tool-result"])
  assert.equal(messages[1].content.at(-1).providerExecuted, true)
  assert.equal(messages[2].content[0].id, "c1")
  assert.equal(calls.get("c1").result.value, "result")
  assert.ok(messageTokens(messages) >= 1_500)
})

test("idle growth excludes the checkpoint and kept tail, and counts the committed masked view", () => {
  const checkpoint = { id: "cp", type: "compaction", status: "completed", summary: "huge".repeat(10_000), metadata: { recent: "tail".repeat(10_000) } }
  assert.deepEqual(conversationGrowth([checkpoint, { id: "idle", type: "idle" }], []), { checkpoint: "cp", tokens: 0 })
  const rows = [checkpoint,
    { id: "a", type: "assistant", content: [tool("c1", { content: "IN".repeat(4_000) }, "OUT".repeat(5_000))] },
    { id: "u", type: "user", text: "new context after the call" },
  ]
  const raw = projectHistory(rows.slice(1)).messages
  const plan = planMask(raw, [], options)
  assert.equal(plan.commit, true)
  const growth = conversationGrowth(rows, plan.masks)
  assert.equal(growth.checkpoint, "cp")
  assert.equal(growth.tokens, messageTokens(renderMask(raw, plan.masks)))
  assert.ok(growth.tokens < messageTokens(raw) / 10)
  assert.deepEqual(conversationGrowth([{ id: "u", type: "user", text: "12345678" }], []), { checkpoint: null, tokens: 2 })
})

test("duplicate call IDs do not get an ambiguous live-call index", () => {
  const { calls } = projectHistory([{ id: "a", type: "assistant", content: [tool("same", {}, "one"), tool("same", {}, "two")] }])
  assert.equal(calls.has("same"), false)
})

test("completed tools with no content project as empty text results", () => {
  const rows = [{ id: "a", type: "assistant", content: [
    { type: "tool", id: "empty", name: "read", state: { status: "completed", input: { path: "x" }, content: [] } },
  ] }]
  const { messages, calls } = projectHistory(rows)
  assert.deepEqual(calls.get("empty").result, { type: "text", value: "" })
  assert.deepEqual(messages[1].content[0].result, { type: "text", value: "" })
})
