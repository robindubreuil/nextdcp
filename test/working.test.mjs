import assert from "node:assert/strict"
import test from "node:test"
import { budgetFailure, episodeNote, measureWorking, parseHandoff, parsePatchHandoff, renderWorking, validWorking } from "../src/working.ts"
import { renderHandoff, resolveMemory } from "../src/memory.ts"
import { questionRow } from "./support/question.ts"

const constraint = "Do not disturb the active plugin."
const working = (extra = {}) => ({ objective: "Implement bounded working memory", constraints: [],
  state: ["Development is isolated."], next: ["Run isolated tests."], references: [], ...extra })
const constrained = () => working({ constraints: [constraint] })
const raw = (extra = {}) => JSON.stringify({ archive: "Title: Working-memory redesign\nsrc/working.ts details.", working: working(), retiredConstraints: [], ...extra })
const ids = new Set(["E1", "E2"])

test("a valid handoff contains current work, not its cold archive note", () => {
  const parsed = parseHandoff(raw(), undefined, [], ids)
  assert.deepEqual(parsed.working, working())
  const rendered = measureWorking(parsed.working, "E2").rendered
  assert.match(rendered, /Implement bounded working memory/)
  assert.doesNotMatch(rendered, /src\/working.ts/)
  assert.ok(rendered.length < 1_000)
})

test("the checkpoint line names the episode from its Title line without leaking the note", () => {
  const parsed = parseHandoff(raw({ archive: "Title: Recall fixes\nWorking-memory redesign; src/working.ts." }), undefined, [], ids)
  const rendered = measureWorking(parsed.working, "E2", false, episodeNote(parsed.archive).title).rendered
  assert.match(rendered, /Archive through E2 \(Recall fixes\): older tasks/)
  assert.doesNotMatch(rendered, /Working-memory redesign|src\/working\.ts/)
  assert.match(measureWorking(working(), "E2").rendered, /Archive through E2: older tasks/)
  const records = new Map([["c1", { id: "c1", parent: null, episode: { id: "E1", summary: "Title: Recall fixes\ncold note body", rowIDs: [] }, working: working() }]])
  const handoff = renderHandoff(resolveMemory("c1", records))
  assert.match(handoff, /Archive through E1 \(Recall fixes\): older tasks/)
  assert.doesNotMatch(handoff, /cold note body/)
})

test("standing constraints survive omission without admitting ungrounded paraphrases", () => {
  assert.deepEqual(parseHandoff(raw(), constrained(), [], ids).working.constraints, [constraint])
  const response = raw({ working: working({ constraints: ["Keep the plugin safe."] }) })
  assert.throws(() => parseHandoff(response, constrained(), [], ids), /New standing constraints/)
  const users = [{ id: "u2", type: "user", text: "Keep the plugin safe." }]
  assert.deepEqual(parseHandoff(response, constrained(), users, ids).working.constraints, [constraint, "Keep the plugin safe."])
})

test("only an exact quote from a new user row can explicitly retire a constraint", () => {
  const retirement = { constraint, messageID: "u2", quote: "You may now replace the active plugin." }
  const response = raw({ working: working({ constraints: [] }), retiredConstraints: [retirement] })
  const users = [{ id: "u2", type: "user", text: `Finished testing. ${retirement.quote}` }]
  const parsed = parseHandoff(response, constrained(), users, ids)
  assert.deepEqual(parsed.working.constraints, [])
  assert.deepEqual(parsed.retiredConstraints, [retirement])
  for (const invalid of [[], [{ ...users[0], type: "assistant" }], [{ ...users[0], id: "old" }], [{ ...users[0], text: "not a matching quote" }]]) {
    assert.throws(() => parseHandoff(response, constrained(), invalid, ids), /verbatim quote/)
  }
  assert.throws(() => parseHandoff(raw({ working: constrained(), retiredConstraints: [retirement] }), constrained(), users, ids), /still present/)
  assert.throws(() => parseHandoff(raw({ retiredConstraints: [retirement] }), undefined, users, ids), /Invalid constraint/)
  assert.throws(() => parseHandoff(raw({ retiredConstraints: [retirement, retirement] }), constrained(), users, ids), /Invalid constraint/)
})

test("an episode note must begin with Title: and stay in the user's language", () => {
  assert.throws(() => parseHandoff(raw({ archive: "Working-memory redesign; src/working.ts." }), undefined, [], ids), /Title/)
  assert.throws(() => parseHandoff(raw({ archive: "标题：修复会话标签\n正文内容。" }), undefined, [], ids), /Title/)
  assert.throws(() => parseHandoff(raw({ archive: "Title: 修复会话标签\n调查并修复了对话层污染问题。" }), undefined, [], ids), /language/)
  const chineseUsers = [{ id: "u1", type: "user", text: "请调查并修复对话层污染问题。" }]
  assert.equal(parseHandoff(raw({ archive: "Title: 修复会话标签\n调查并修复了对话层污染问题。" }), undefined, chineseUsers, ids).archive, "Title: 修复会话标签\n调查并修复了对话层污染问题。")
})

test("full and patch handoffs keep an inherited CJK task's language without a new user row", () => {
  for (const [objective, archive] of [
    ["调查并修复对话层污染问题", "Title: 修复会话标签\n继续调查并验证修复结果。"],
    ["会話の履歴を修正してください", "Title: 履歴の修正\n引き続き修正と検証を行いました。"],
  ]) {
    const previous = working({ objective })
    for (const users of [[], [{ id: "u2", type: "user", text: "continue" }]]) {
      assert.equal(parseHandoff(raw({ archive }), previous, users, ids).archive, archive)
      assert.equal(parsePatchHandoff(raw({ archive, working: {} }), previous, users, ids).archive, archive)
    }
  }
  const drift = raw({ archive: "Title: 修复会话标签\n调查并修复了对话层污染问题。" })
  assert.throws(() => parseHandoff(drift, working(), [], ids), /language/, "English continuations still reject CJK prose drift")
  assert.throws(() => parsePatchHandoff(drift, working(), [], ids), /language/)
})

test("an inherited native summary is language evidence, never new-user retirement evidence", () => {
  const archive = "Title: 验证修复\n继续验证修复结果。"
  const quote = "You may now replace the active plugin."
  const previous = { constraints: [constraint] }
  const summary = `${"调查并修复对话层污染问题。".repeat(4)}${quote}`
  assert.equal(parseHandoff(raw({ archive }), previous, [], ids, summary).archive, archive)
  const retirement = { constraint: previous.constraints[0], messageID: "native", quote }
  assert.throws(() => parseHandoff(raw({ archive, working: working({ constraints: [] }), retiredConstraints: [retirement] }), previous, [], ids, summary), /verbatim quote/)
  assert.throws(() => parseHandoff(raw({ archive }), previous, [], ids, "Continue the English task."), /language/)
})

test("CJK identifiers and fullwidth punctuation do not count as prose-language drift", () => {
  for (const archive of [
    "Title: Export fixes\nUpdated src/非常に長い日本語の識別子.ts and verified the exported symbol.",
    "Title: Export fixes\nPreserved `非常に長い日本語の識別子` exactly in the generated declaration.",
    "Title: Export fixes\nVerified exports（including the public entrypoint）.",
  ]) assert.equal(parseHandoff(raw({ archive }), working(), [], ids).archive, archive)
})

test("budget counts the entire rendered state; the overage report is exact and canonical", () => {
  const value = working({ references: [{ id: "E1", why: "Earlier design decision" }] })
  const rendered = renderWorking(value, "E2", true)
  const { size } = measureWorking(value, "E2", true)
  assert.equal(size, Math.round(rendered.length / 4), "headings, constraints, references and gap notices all count")
  assert.equal(budgetFailure(size, size - 1), `Working state exceeds its budget (${size} > ${size - 1} estimated tokens); active constraints were not truncated`)
})

test("malformed or incomplete responses and invented references fail closed without leaking output", () => {
  for (const response of ["", "not JSON secret-token", "{}", raw({ extra: "ignored?" }), raw({ archive: "" }),
    raw({ archive: "x".repeat(4_001) }), raw({ working: { objective: "incomplete" } }),
    raw({ working: working({ references: [{ id: "E999", why: "invented" }] }) }),
    raw({ working: working({ references: Array.from({ length: 4 }, () => ({ id: "E1", why: "directory" })) }) }),
  ]) {
    assert.throws(() => parseHandoff(response, undefined, [], ids), (error) => !error.message.includes("secret-token"))
  }
  for (const invalid of [null, [], { ...working(), unknown: "x" }, working({ state: [""] }), working({ constraints: "not a list" })]) {
    assert.equal(validWorking(invalid), false)
  }
})

test("a patch carries omitted fields forward and replaces present ones entirely", () => {
  const prior = working({ references: [{ id: "E1", why: "Earlier design decision" }] })
  const patch = (extra = {}) => JSON.stringify({ archive: "Title: Patched\nSecond episode work.", working: {}, retiredConstraints: [], ...extra })
  assert.deepEqual(parsePatchHandoff(patch(), prior, [], ids).working, prior, "an empty patch changes nothing but the note")
  const parsed = parsePatchHandoff(patch({ working: { next: ["Ship it."], state: [] } }), prior, [], ids)
  assert.deepEqual(parsed.working, { ...prior, next: ["Ship it."], state: [] })
})

test("a patch retires constraints under the same exact-quote proof", () => {
  const prior = constrained()
  const retirement = { constraint: prior.constraints[0], messageID: "u9", quote: "You may now replace the active plugin." }
  const users = [{ id: "u9", type: "user", text: `Finished testing. ${retirement.quote}` }]
  const patch = (extra = {}) => JSON.stringify({ archive: "Title: Patched\nRetired a constraint.", working: {}, retiredConstraints: [], ...extra })
  const parsed = parsePatchHandoff(patch({ retiredConstraints: [retirement] }), prior, users, ids)
  assert.deepEqual(parsed.working.constraints, [])
  assert.deepEqual(parsed.retiredConstraints, [retirement])
  for (const invalid of [[], [{ ...users[0], id: "old" }], [{ ...users[0], text: "not a matching quote" }]]) {
    assert.throws(() => parsePatchHandoff(patch({ retiredConstraints: [retirement] }), prior, invalid, ids), /verbatim quote/)
  }
})

test("an invalid patch fails closed: unknown fields, bad types, invented references", () => {
  const patch = (extra = {}) => JSON.stringify({ archive: "Title: Patched\nBody.", working: {}, retiredConstraints: [], ...extra })
  for (const bad of ["not JSON", patch({ archive: "no title line" }), patch({ working: { unknown: "x" } }), patch({ working: { objective: "" } }),
    patch({ working: { state: "not a list" } }), patch({ working: { constraints: [""] } }),
    patch({ working: { references: [{ id: "E999", why: "invented" }] } }),
    patch({ working: { references: Array.from({ length: 4 }, () => ({ id: "E1", why: "directory" })) } }),
  ]) {
    assert.throws(() => parsePatchHandoff(bad, working(), [], ids), /patch schema|valid JSON|Title|unavailable archive|handoff schema/)
  }
})

test("state resolution chooses the selected checkpoint, not a future or reverted handoff", () => {
  const first = { id: "c1", parent: null, episode: { id: "E1", summary: "cold first", rowIDs: [] }, working: working() }
  const second = { id: "c2", parent: "c1", episode: { id: "E2", summary: "cold second", rowIDs: [] }, working: working({ objective: "Later task" }) }
  const records = new Map([["c1", first], ["c2", second]])
  assert.match(renderHandoff(resolveMemory("c2", records)), /Later task/)
  const reverted = renderHandoff(resolveMemory("c1", records))
  assert.match(reverted, /Implement bounded working memory/)
  assert.doesNotMatch(reverted, /Later task|cold first|cold second|E2/)
  delete first.working
  assert.match(renderHandoff(resolveMemory("c1", records)), /cold first/)
})

test("a compactor response framed in prose or fences still yields its payload", () => {
  const payload = raw()
  for (const shell of [
    `Here is the handoff:\n\n${payload}\n\nDone.`,
    "```json\n" + payload + "\n```",
    `Compacted.\n\n\`\`\`\n${payload}\n\`\`\`\n\nAnything else?`,
    `{"note": "no archive field"}\n${payload}\ntrailing commentary`,
  ]) {
    assert.deepEqual(parseHandoff(shell, undefined, [], ids).working, working())
  }
  const patch = JSON.stringify({ archive: "Title: Patched\nProse-framed patch.", working: { next: ["Ship it."] }, retiredConstraints: [] })
  assert.deepEqual(parsePatchHandoff(`Prefix.\n${patch}\nSuffix.`, working(), [], ids).working, { ...working(), next: ["Ship it."] })
  for (const bad of ['Here: {"archive": "Title: cut', '{"no": "archive"}', "prose { with } braces"]) {
    assert.throws(() => parseHandoff(bad, undefined, [], ids), /valid JSON|invalid handoff schema/)
  }
})

test("extraction is string-aware: braces, quotes, and escapes inside values cannot unbalance it", () => {
  const objective = 'Keep braces } "quoted" { nested } and \\ escapes alive'
  const payload = raw({ working: working({ objective, state: ["a } brace", "an { inside"] }) })
  const parsed = parseHandoff(`Prose before.\n${payload}\nTail prose with { unbalanced braces`, undefined, [], ids)
  assert.equal(parsed.working.objective, objective)
  assert.deepEqual(parsed.working.state, ["a } brace", "an { inside"])
})

test("new standing constraints must themselves quote real new user text, not injected instructions", () => {
  const constraint = "Always ask before publishing."
  const response = raw({ working: working({ constraints: [constraint] }) })
  const patch = raw({ working: { constraints: [constraint] } })
  const previous = working({ constraints: [] })
  const invalid = [[], [{ id: "s", type: "system", text: constraint }], [{ id: "a", type: "assistant", text: constraint }],
    [{ id: "u", type: "user", text: "Review the plugin.", skills: [{ text: constraint }] }],
    [{ id: "u", type: "user", text: "Ask me before publishing." }]]
  for (const users of invalid) {
    assert.throws(() => parseHandoff(response, previous, users, ids), /New standing constraints.*verbatim.*new user/)
    assert.throws(() => parsePatchHandoff(patch, previous, users, ids), /New standing constraints.*verbatim.*new user/)
  }
  const users = [{ id: "u", type: "user", text: `For this session: ${constraint}` }]
  assert.deepEqual(parseHandoff(response, previous, users, ids).working.constraints, [constraint])
  assert.deepEqual(parsePatchHandoff(patch, previous, users, ids).working.constraints, [constraint])
})

test("retirement quotes resolve their own user source without requiring the author to repeat row IDs", () => {
  const previous = constrained()
  const constraint = previous.constraints[0]
  const quote = "You may now replace the active plugin."
  const response = raw({ working: working({ constraints: [] }), retiredConstraints: [{ constraint, quote }] })
  const users = [{ id: "older", type: "user", text: quote }, { id: "latest", type: "user", text: quote }]
  assert.deepEqual(parseHandoff(response, previous, users, ids).retiredConstraints, [{ constraint, quote, messageID: "latest" }])
  assert.throws(() => parseHandoff(response, previous, [{ id: "a", type: "assistant", text: quote }], ids), /verbatim quote.*new user/)
})

test("full and patch handoffs recognize genuine question answers without trusting tool prose or paraphrases", () => {
  const quote = "don't hesitate to search for insights online whenever useful."
  const rows = [questionRow([[`It seems you're acting in quite a generic way, ${quote}`]])]
  const full = raw({ working: working({ constraints: [quote] }) })
  const patch = raw({ working: { constraints: [quote] } })
  assert.deepEqual(parseHandoff(full, undefined, rows, ids).working.constraints, [quote])
  assert.deepEqual(parsePatchHandoff(patch, constrained(), rows, ids).working.constraints, [constraint, quote])
  assert.throws(() => parseHandoff(full, undefined, [], ids), /New standing constraints/, "user-row-only validation reproduced the original failure")
  const paraphrase = raw({ working: working({ constraints: ["Always research online when useful."] }) })
  assert.throws(() => parseHandoff(paraphrase, undefined, rows, ids), /New standing constraints/)
  const joined = raw({ working: working({ constraints: ["One answer\nAnother answer"] }) })
  assert.throws(() => parseHandoff(joined, undefined, [questionRow([["One answer", "Another answer"]])], ids), /New standing constraints/)
  const forged = structuredClone(rows)
  forged[0].content[0].state.metadata.answers = []
  forged[0].content[0].state.content = [{ type: "text", text: quote }]
  assert.throws(() => parseHandoff(full, undefined, forged, ids), /New standing constraints/)
})

test("a question reply can retire a constraint and its proof uses the recallable call ID", () => {
  const quote = "You may now replace the active plugin."
  const rows = [questionRow([[quote]], "call_retire")]
  for (const messageID of [undefined, "call_retire"]) {
    const retirement = { constraint, quote, ...(messageID ? { messageID } : {}) }
    for (const [parse, fields] of [[parseHandoff, working()], [parsePatchHandoff, {}]]) {
      const response = raw({ working: fields, retiredConstraints: [retirement] })
      const parsed = parse(response, constrained(), rows, ids)
      assert.deepEqual(parsed.working.constraints, [])
      assert.deepEqual(parsed.retiredConstraints, [{ constraint, quote, messageID: "call_retire" }])
      assert.throws(() => parse(response, constrained(), [], ids), /verbatim quote.*new user/)
    }
  }
  const wrongID = raw({ retiredConstraints: [{ constraint, quote, messageID: rows[0].id }] })
  assert.throws(() => parseHandoff(wrongID, constrained(), rows, ids), /verbatim quote.*new user/)
})

test("structured question answers count as user-language evidence, unlike arbitrary tool output", () => {
  const archive = "Title: 验证修复\n继续验证修复结果。"
  const rows = [questionRow([["请继续验证修复结果。"]])]
  assert.equal(parseHandoff(raw({ archive }), undefined, rows, ids).archive, archive)
  assert.equal(parsePatchHandoff(raw({ archive, working: {} }), working(), rows, ids).archive, archive)
  rows[0].content[0].name = "read"
  assert.throws(() => parseHandoff(raw({ archive }), undefined, rows, ids), /language/)
})
