import assert from "node:assert/strict"
import test from "node:test"
import { partTokens, requestTokens, tokens } from "../src/tokens.ts"

const msg = (role, ...content) => ({ role, content })

test("request estimates include system, tool definitions, content and native media estimates", () => {
  const messages = [msg("user", { type: "text", text: "12345678" }, { type: "media", media: { mediaType: "image/png" } }, { type: "media", media: { mediaType: "application/pdf" } })]
  const tools = { read: { description: "desc", input: { type: "object" } }, recall: { description: "retrieve", input: { type: "object", properties: {} } } }
  assert.equal(requestTokens({ system: [{ text: "1234" }], tools, messages }), 1 + tokens("readdesc" + JSON.stringify(tools.read.input)) + tokens("recallretrieve" + JSON.stringify(tools.recall.input)) + 2 + 1500 + 2000)
})

test("token estimates count CJK scripts per character while keeping chars/4 elsewhere", () => {
  assert.equal(tokens("plain ascii text"), Math.round("plain ascii text".length / 4))
  assert.equal(tokens(""), 0)
  // Accented Latin still costs chars/4; only Han, kana and hangul count as one token each.
  assert.equal(tokens("café ☕ naïve"), Math.round("café ☕ naïve".length / 4))
  assert.equal(tokens("日本語"), 3)
  assert.equal(tokens("ひらがなカタカナ"), 8)
  assert.equal(tokens("한국어"), 3)
  assert.equal(tokens("中文english混合"), 2 + Math.round("english".length / 4) + 2)
  // Astral-plane Han (surrogate pairs) count once per character, not once per UTF-16 unit.
  assert.equal(tokens("𠀀𠀁"), 2)
  // Tool parts estimate at the same rates: 500 CJK characters cost 500 tokens.
  const cjk = msg("tool", { type: "tool-result", id: "cjk", name: "read", result: { type: "text", value: "細".repeat(500) } })
  assert.equal(partTokens(cjk.content[0]), 500)
})
