import assert from "node:assert/strict"
import test from "node:test"
import { budgetFailure, episodeNote, measureWorking, parseHandoff, parsePatchHandoff, renderWorking, validWorking } from "../src/working.ts"
import { renderHandoff, resolveMemory } from "../src/memory.ts"

const working = (extra = {}) => ({ objective: "Implement bounded working memory", constraints: ["Do not disturb the active plugin."],
  state: ["Development is isolated."], next: ["Run isolated tests."], references: [], ...extra })
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

test("standing constraints survive an omitted or paraphrased model response", () => {
  const parsed = parseHandoff(raw({ working: working({ constraints: ["Keep the plugin safe."] }) }), working(), [], ids)
  assert.deepEqual(parsed.working.constraints, ["Do not disturb the active plugin.", "Keep the plugin safe."])
  assert.deepEqual(parseHandoff(raw(), working(), [], ids).working.constraints, working().constraints)
})

test("only an exact quote from a new user row can explicitly retire a constraint", () => {
  const retirement = { constraint: working().constraints[0], messageID: "u2", quote: "You may now replace the active plugin." }
  const response = raw({ working: working({ constraints: [] }), retiredConstraints: [retirement] })
  const users = [{ id: "u2", type: "user", text: `Finished testing. ${retirement.quote}` }]
  const parsed = parseHandoff(response, working(), users, ids)
  assert.deepEqual(parsed.working.constraints, [])
  assert.deepEqual(parsed.retiredConstraints, [retirement])
  for (const invalid of [[], [{ ...users[0], type: "assistant" }], [{ ...users[0], id: "old" }], [{ ...users[0], text: "not a matching quote" }]]) {
    assert.throws(() => parseHandoff(response, working(), invalid, ids), /verbatim quote/)
  }
  assert.throws(() => parseHandoff(raw({ retiredConstraints: [retirement] }), working(), users, ids), /still present/)
  assert.throws(() => parseHandoff(raw({ retiredConstraints: [retirement] }), undefined, users, ids), /Invalid constraint/)
  assert.throws(() => parseHandoff(raw({ retiredConstraints: [retirement, retirement] }), working(), users, ids), /Invalid constraint/)
})

test("an episode note must begin with Title: and stay in the user's language", () => {
  assert.throws(() => parseHandoff(raw({ archive: "Working-memory redesign; src/working.ts." }), undefined, [], ids), /Title/)
  assert.throws(() => parseHandoff(raw({ archive: "标题：修复会话标签\n正文内容。" }), undefined, [], ids), /Title/)
  assert.throws(() => parseHandoff(raw({ archive: "Title: 修复会话标签\n调查并修复了对话层污染问题。" }), undefined, [], ids), /language/)
  const chineseUsers = [{ id: "u1", type: "user", text: "请调查并修复对话层污染问题。" }]
  assert.equal(parseHandoff(raw({ archive: "Title: 修复会话标签\n调查并修复了对话层污染问题。" }), undefined, chineseUsers, ids).archive, "Title: 修复会话标签\n调查并修复了对话层污染问题。")
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
  const prior = working()
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
