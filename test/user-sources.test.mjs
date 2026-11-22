import assert from "node:assert/strict"
import test from "node:test"
import { matchSource, questionSource, userSources } from "../src/user-sources.ts"
import { questionRow } from "./support/question.ts"

test("human sources include user text and separate completed question answers with durable call IDs", () => {
  const row = questionRow([["  Exact free-form reply.  ", "Selected option"], [], ["", " ", "Another answer"]])
  const before = structuredClone(row)
  assert.deepEqual(userSources([{ id: "user", type: "user", text: "Direct request" }, row]), [
    { id: "user", text: "Direct request" },
    { id: "call_question", text: "  Exact free-form reply.  " },
    { id: "call_question", text: "Selected option" },
    { id: "call_question", text: "Another answer" },
  ])
  assert.deepEqual(row, before, "normalization must not rewrite the host's archived original")
})

test("tool input, rendered output, unrelated metadata and assistant or injected prose are not human sources", () => {
  const quote = "Always ask before publishing."
  const source = questionRow([[quote]])
  for (const mutate of [
    (row) => { row.type = "system" }, (row) => { row.type = "synthetic" },
    (row) => { row.content[0].type = "text" }, (row) => { row.content[0].name = "read" },
    (row) => { row.content[0].name = "mcp.question" }, (row) => { row.content[0].id = "" },
    (row) => { row.content[0].state.status = "running" }, (row) => { row.content[0].state.status = "error" },
    (row) => { delete row.content[0].state.metadata },
    (row) => { row.content[0].state.metadata = { output: { answers: [[quote]] } } },
  ]) {
    const row = structuredClone(source)
    mutate(row)
    row.text = quote
    row.content[0].state.content = [{ type: "text", text: quote }]
    row.content[0].state.input = { questions: [{ question: quote }] }
    assert.deepEqual(userSources([row]), [])
  }
  assert.deepEqual(userSources([{ id: "user", type: "user", files: [{ text: quote }], skills: [{ text: quote }] },
    { id: "assistant", type: "assistant", content: [{ type: "text", text: quote }] }]), [])
})

test("malformed structured answers fail closed instead of coercing or trusting their text", () => {
  for (const answers of [undefined, null, "reply", ["reply"], [[42]], [[{ text: "reply" }]], [["reply"], null], [[["reply"]]]]) {
    const row = questionRow([])
    row.content[0].state.metadata.answers = answers
    assert.equal(questionSource(row.content[0]), undefined)
    assert.deepEqual(userSources([row]), [])
  }
  for (const part of [null, "question", {}, { type: "tool", name: "question", id: "call_q", state: null }])
    assert.equal(questionSource(part), undefined)
  assert.deepEqual(userSources([{ id: "bad", type: "assistant", content: null }]), [])
})

test("quotes are locators: the resolved span is the source's own text, not the author's", () => {
  const span = "Keep the \u201cplugin\u201d safe\u2014\nalways."
  const users = userSources([{ id: "u1", type: "user", text: `For this session: ${span}` }, { id: "u2", type: "user", text: `Note: ${span}` }])
  assert.deepEqual(matchSource(users, span), { id: "u2", text: span }, "an exact quote pins the identical span; the latest source wins")
  assert.deepEqual(matchSource(users, 'Keep the "plugin" safe- always.'), { id: "u2", text: span }, "whitespace and typography drift resolves to the source span")
  assert.deepEqual(matchSource(users, 'Keep the "plugin" safe- always.', "u1"), { id: "u1", text: span }, "messageID restricts resolution")
  assert.equal(matchSource(users, "Keep the plugin safe", "u1"), undefined, "an out-of-scope source stays silent")
  assert.equal(matchSource(users, "Keep the plugin safe at all times."), undefined, "a paraphrase has no span")
  assert.equal(matchSource(users, "  \t "), undefined, "an empty locator resolves nothing")
})
