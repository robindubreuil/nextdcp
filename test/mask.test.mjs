import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { DEFAULT_MASK, messageTokens, partTokens, planMask, renderMask, requestTokens, tokens } from "../src/mask.ts"
import { inputStub, outputStub } from "../src/prompts.ts"

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"))
const options = (overrides = {}) => ({ ...DEFAULT_MASK, minTokens: 10, distance: 0, batch: 1, ...overrides })
const call = (id, name, input, extra = {}) => ({ type: "tool-call", id, name, input, ...extra })
const result = (id, name, value, extra = {}) => ({ type: "tool-result", id, name, result: { type: "text", value }, ...extra })
const msg = (role, ...content) => ({ role, content })
const tail = (length = 1_000) => msg("user", { type: "text", text: "t".repeat(length) })

test("the captured message fixture is masked without changing anything else", async () => {
  const before = await fixture("before-mask")
  const golden = await fixture("after-mask-1")
  const original = JSON.stringify(before)
  const firstResult = before.findIndex((message) => message.content.some((part) => part.type === "tool-result"))
  const secondResult = before.findIndex((message, index) => index > firstResult && message.content.some((part) => part.type === "tool-result"))
  const secondDistance = messageTokens(before.slice(secondResult + 1))
  const plan = planMask(before, [], options({ minTokens: 400, distance: secondDistance }))

  assert.equal(plan.commit, true)
  assert.equal(plan.masks.length, 1)
  assert.equal(plan.calls[0].id, before[firstResult].content[0].id)
  assert.match(plan.calls[0].result.value, /^ALPHA row 0000:/)
  assert.equal(before[firstResult].id, undefined)
  const rendered = renderMask(before, plan.masks)
  assert.equal(plan.savedTokens, messageTokens(before) - messageTokens(rendered))
  assert.match(rendered[firstResult].content[0].result.value, /^\[Output elided to save context: \w+, ~[\d.]+k? tokens\. (Retrieve with recall|Re-run it)/)
  assert.deepEqual(rendered[secondResult], before[secondResult])
  golden[firstResult].content[0].result = rendered[firstResult].content[0].result
  assert.deepEqual(rendered, golden)
  assert.equal(JSON.stringify(before), original)
  assert.deepEqual(renderMask(rendered, plan.masks), rendered)
})

test("the captured compaction and generation histories render an identical prefix", async () => {
  const compaction = await fixture("compaction-unmasked")
  const generation = await fixture("generate-mask-2")
  const originals = new Map(compaction.flatMap((message) => message.content.filter((part) => part.type === "tool-result").map((part) => [part.id, part.result])))
  const restored = structuredClone(generation)
  for (const message of restored) for (const part of message.content) if (part.type === "tool-result") part.result = originals.get(part.id)
  assert.deepEqual(restored.slice(0, compaction.length), compaction)
  const plan = planMask(compaction, [], options({ minTokens: 400, distance: 0 }))
  assert.equal(plan.masks.length, 2)
  assert.deepEqual(renderMask(restored, plan.masks).slice(0, compaction.length), renderMask(compaction, plan.masks))
  assert.deepEqual(renderMask(restored, plan.masks).at(-1), generation.at(-1))
  const after = await fixture("post-compaction")
  assert.deepEqual(renderMask(after, plan.masks), after)
})

test("strict size and distance thresholds and batching do not commit early", async () => {
  const before = await fixture("before-mask")
  const indexes = before.flatMap((message, i) => message.content.some((part) => part.type === "tool-result") ? [i] : [])
  const firstDistance = messageTokens(before.slice(indexes[0] + 1))
  assert.equal(planMask(before, [], options({ distance: firstDistance })).commit, false)
  const one = planMask(before, [], options({ distance: firstDistance - 1 }))
  assert.equal(one.masks.length, 1)
  const tooSmall = planMask(before, [], options({ distance: firstDistance - 1, batch: one.savedTokens + 1 }))
  assert.equal(tooSmall.commit, false)
  assert.equal(tooSmall.savedTokens, one.savedTokens)
  assert.deepEqual(tooSmall.masks, [])
  assert.deepEqual(tooSmall.calls, [])
  assert.equal(planMask(before, [], options({ distance: firstDistance - 1, batch: one.savedTokens })).commit, true)
  const size = partTokens(before[indexes[0]].content[0])
  assert.equal(planMask(before, [], options({ minTokens: size, distance: firstDistance - 1 })).commit, false)
  assert.equal(planMask(before).commit, false)
})

test("committed prefixes stay byte-identical until the next batch", async () => {
  const before = await fixture("before-mask")
  const first = planMask(before, [], options({ minTokens: 400, distance: 100 }))
  assert.equal(first.masks.length, 1)
  const prefix = JSON.stringify(renderMask(before, first.masks))
  const extended = [...before, tail(8_000)]
  const withSameMasks = renderMask(extended, first.masks)
  assert.equal(JSON.stringify(withSameMasks.slice(0, before.length)), prefix)
  const second = planMask(extended, first.masks, options({ minTokens: 400, distance: 100 }))
  assert.equal(second.masks.length, 2)
  assert.deepEqual(second.masks[0], first.masks[0])
  assert.equal(renderMask(extended, second.masks)[2].content[0].result.value, renderMask(before, first.masks)[2].content[0].result.value)
  assert.equal(planMask(extended, second.masks, options({ minTokens: 400, distance: 100 })).commit, false)
})

test("new protection options do not silently unmask a committed prefix", () => {
  const messages = [msg("assistant", call("id", "read", { path: "x" })), msg("tool", result("id", "read", "x".repeat(8_000))), tail()]
  const first = planMask(messages, [], options())
  assert.equal(first.commit, true)
  const rendered = renderMask(messages, first.masks)
  const next = planMask(messages, first.masks, options({ protected: ["read"] }))
  assert.equal(next.commit, false)
  assert.deepEqual(renderMask(messages, next.masks), rendered)
  const newCall = [msg("assistant", call("new", "read", { path: "y" })), msg("tool", result("new", "read", "y".repeat(8_000))), tail()]
  assert.equal(planMask(newCall, first.masks, options({ protected: ["read"] })).commit, false)
})

test("a plan snapshots its base masks for stale-write detection", () => {
  const previous = [{ id: "old", name: "write", input: [{ path: ["content"], stub: "saved" }] }]
  const plan = planMask([tail()], previous, options())
  previous[0].input[0].path[0] = "changed"
  previous[0].input[0].stub = "changed"
  previous.push({ id: "other", name: "read", output: "changed" })
  assert.deepEqual(plan.base, [{ id: "old", name: "write", input: [{ path: ["content"], stub: "saved" }] }])
})

test("large nested input fields and output can become eligible in separate batches", () => {
  const input = { path: "src/x", nested: { content: "i".repeat(4_000), list: ["small", "z".repeat(3_200)] }, flag: true }
  const signature = { google: { thoughtSignature: "signed" } }
  class ModelMessage { constructor(role, content) { Object.assign(this, { role, content }) } }
  const reasoning = { type: "reasoning", text: "unchanged", encrypted: "opaque", providerMetadata: signature }
  const messages = [
    new ModelMessage("assistant", [reasoning, call("call-1", "write", input, { providerMetadata: signature })]),
    new ModelMessage("tool", [result("call-1", "write", "o".repeat(30_000), { providerMetadata: signature })]),
    tail(400),
  ]
  const first = planMask(messages, [], options({ distance: 2_500 }))
  assert.equal(first.masks.length, 1)
  assert.equal(first.masks[0].input.length, 2)
  assert.equal(first.masks[0].output, undefined)
  const rendered = renderMask(messages, first.masks)
  assert.ok(rendered[0] instanceof ModelMessage)
  assert.equal(rendered[0].content[0], reasoning)
  assert.equal(rendered[0].content[1].providerMetadata, signature)
  assert.deepEqual(Object.keys(rendered[0].content[1].input), Object.keys(input))
  assert.deepEqual(Object.keys(rendered[0].content[1].input.nested), Object.keys(input.nested))
  assert.equal(rendered[0].content[1].input.nested.list[0], "small")
  assert.match(rendered[0].content[1].input.nested.content, /^\[Input elided/)
  assert.match(rendered[0].content[1].input.nested.list[1], /^\[Input elided/)
  assert.equal(messages[0].content[1].input, input)
  assert.equal(first.calls[0].input, input)
  assert.equal(first.calls[0].result.value.length, 30_000)

  const extended = [...messages, tail(12_000)]
  const second = planMask(extended, first.masks, options({ distance: 2_500 }))
  assert.equal(second.masks.length, 1)
  assert.deepEqual(second.masks[0].input, first.masks[0].input)
  assert.match(second.masks[0].output, /^\[Output elided to save context: /)
  assert.doesNotMatch(second.masks[0].output, /"content"|"text"|"nested"/, "the output stub names the tool but must not echo the input")
  assert.equal(second.savedTokens, messageTokens(renderMask(extended, first.masks)) - messageTokens(renderMask(extended, second.masks)))
})

test("protected, provider-executed, incomplete, failed, and ambiguous pairs are untouched", () => {
  const huge = "x".repeat(8_000)
  const cases = [
    [call("a", "skill", { text: huge }), result("a", "skill", huge)],
    [call("b", "task", { text: huge }), result("b", "task", huge)],
    [call("sub", "subagent", { text: huge }), result("sub", "subagent", huge)],
    [call("r", "recall", { text: huge }), result("r", "recall", huge)],
    [call("c", "read", { text: huge }, { providerExecuted: true }), result("c", "read", huge)],
    [call("d", "read", { text: huge }), result("d", "read", huge, { providerExecuted: true })],
    [call("e", "read", { text: huge }), { type: "tool-result", id: "e", name: "read", result: { type: "error", value: huge } }],
    [call("f", "read", { text: huge })],
    [result("g", "read", huge)],
    [call("h", "read", { text: huge }), result("h", "read", huge), result("h", "read", huge)],
    [call("i", "read", { text: huge }), result("i", "write", huge)],
    [result("j", "read", huge), call("j", "read", { text: huge })],
  ]
  for (const [index, parts] of cases.entries()) {
    const messages = [msg("assistant", ...parts), tail()]
    assert.equal(planMask(messages, [], options()).commit, false, JSON.stringify(parts.map((p) => p.id)))
    // Protection is checked at planning time; the remaining cases must also be
    // rejected when rendering an invalid or incomplete persisted pair.
    if (index >= 4) assert.deepEqual(renderMask(messages, [{ id: parts[0].id, name: parts[0].name, output: "unsafe", input: [{ path: ["text"], stub: "unsafe" }] }]), messages)
  }
})

test("JSON and mixed-content outputs preserve their complete archived originals", () => {
  for (const value of [
    { type: "json", value: { text: "j".repeat(8_000) } },
    { type: "content", value: [{ type: "text", text: "c".repeat(8_000) }, { type: "file", mime: "image/png", uri: "file:///x.png" }] },
  ]) {
    const messages = [msg("assistant", call("id", "read", { path: "x" })), msg("tool", { type: "tool-result", id: "id", name: "read", result: value }), tail()]
    const plan = planMask(messages, [], options())
    assert.equal(plan.commit, true)
    assert.equal(plan.calls[0].result, value)
    assert.equal(renderMask(messages, plan.masks)[1].content[0].result.type, "text")
    assert.deepEqual(messages[1].content[0].result, value)
  }
})

test("request estimates include system, tool definitions, content and native media estimates", () => {
  const messages = [msg("user", { type: "text", text: "12345678" }, { type: "media", media: { mediaType: "image/png" } }, { type: "media", media: { mediaType: "application/pdf" } })]
  const tools = { read: { description: "desc", input: { type: "object" } }, recall: { description: "retrieve", input: { type: "object", properties: {} } } }
  assert.equal(requestTokens({ system: [{ text: "1234" }], tools, messages }), 1 + tokens("readdesc" + JSON.stringify(tools.read.input)) + tokens("recallretrieve" + JSON.stringify(tools.recall.input)) + 2 + 1500 + 2000)
})

test("stub templates escape identifiers without repeating the tool input", () => {
  const id = 'a"b'
  assert.equal(outputStub(3_100, id, "write"), '[Output elided to save context: write, ~3.1k tokens. Retrieve with recall {"id":"a\\"b"}]')
  assert.equal(outputStub(3_100, id, "read"), '[Output elided to save context: read, ~3.1k tokens. Re-run it for current content, or recall {"id":"a\\"b"} for the original]')
  assert.equal(inputStub("write", 901, id), '[Input elided to save context: write, ~901 tokens. Retrieve with recall {"id":"a\\"b"}]')
  const messages = [msg("assistant", call("id", "write", { text: "x".repeat(5_000) })), msg("tool", result("id", "write", "o".repeat(1_000))), tail()]
  assert.ok(planMask(messages, [], options()).masks[0].output, "short notice allows useful output masking even for a large input")
  const short = [msg("assistant", call("id", "read", { path: "x" })), msg("tool", result("id", "read", "tiny")), tail()]
  assert.equal(planMask(short, [], options({ minTokens: 0 })).commit, false, "never replace output with a larger notice")
})

test("a call that cannot be archived does not block unrelated candidates", () => {
  const messages = [
    msg("assistant", call("invalid", "write", { content: "x".repeat(8_000), invalid: 1n })),
    msg("tool", result("invalid", "write", "x".repeat(8_000))),
    msg("assistant", call("valid", "read", { path: "file.ts" })),
    msg("tool", result("valid", "read", "y".repeat(8_000))),
    tail(),
  ]
  const plan = planMask(messages, [], options())
  assert.equal(plan.commit, true)
  assert.deepEqual(plan.calls.map((item) => item.id), ["valid"])
  assert.deepEqual(plan.masks.map((item) => item.id), ["valid"])
  const rendered = renderMask(messages, plan.masks)
  assert.equal(rendered[1], messages[1])
  assert.match(rendered[3].content[0].result.value, /^\[Output elided/)
})

test("a deeply nested JSON input does not block unrelated candidates", () => {
  let input = "x".repeat(500)
  for (let depth = 0; depth < 3_500; depth++) input = { child: input }
  input = JSON.parse(JSON.stringify(input))
  const messages = [
    msg("assistant", call("deep", "write", input)),
    msg("tool", result("deep", "write", "x".repeat(2_000))),
    msg("assistant", call("valid", "read", { path: "file.ts" })),
    msg("tool", result("valid", "read", "y".repeat(8_000))),
    tail(),
  ]
  const plan = planMask(messages, [], options())
  assert.equal(plan.commit, true)
  assert.ok(plan.calls.some((item) => item.id === "valid"))
  assert.ok(plan.masks.some((item) => item.id === "valid"))
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
  // Mask thresholds fire on CJK content at the right estimated size.
  const cjk = msg("tool", result("cjk", "read", "細".repeat(500)))
  assert.equal(partTokens(cjk.content[0]), 500)
  assert.ok(partTokens(cjk.content[0]) > DEFAULT_MASK.minTokens)
})

test("a CJK conversation crosses the mask distance threshold at the correct estimate", () => {
  const messages = [
    msg("assistant", call("far", "read", { path: "a" })),
    msg("tool", result("far", "read", "資料を読み込んだ".repeat(200))),
    tail(80_004),
  ]
  const plan = planMask(messages, [], { ...DEFAULT_MASK, batch: 1 })
  assert.ok(plan.masks.some((item) => item.id === "far"), "CJK output is masked once past the distance")
})
