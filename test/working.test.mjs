import assert from "node:assert/strict"
import test from "node:test"
import { assertMemoryBudget, episodeNote, parseHandoff, renderWorking, validWorking } from "../src/working.ts"
import { renderHandoff, resolveMemory } from "../src/memory.ts"

const working = (extra = {}) => ({ objective: "Implement bounded working memory", constraints: ["Do not disturb the active plugin."],
  state: ["Development is isolated."], next: ["Run isolated tests."], references: [], ...extra })
const raw = (extra = {}) => JSON.stringify({ archive: "Working-memory redesign; src/working.ts.", working: working(), retiredConstraints: [], ...extra })
const ids = new Set(["E1", "E2"])

test("a valid handoff contains current work, not its cold archive note", () => {
  const parsed = parseHandoff(raw(), undefined, [], ids)
  assert.deepEqual(parsed.working, working())
  const rendered = assertMemoryBudget(parsed.working, "E2", false, 2_000)
  assert.match(rendered, /Implement bounded working memory/)
  assert.doesNotMatch(rendered, /src\/working.ts/)
  assert.ok(rendered.length < 1_000)
})

test("the checkpoint line names the episode from its Title line without leaking the note", () => {
  const parsed = parseHandoff(raw({ archive: "Title: Recall fixes\nWorking-memory redesign; src/working.ts." }), undefined, [], ids)
  const rendered = assertMemoryBudget(parsed.working, "E2", false, 2_000, episodeNote(parsed.archive).title)
  assert.match(rendered, /Archive through E2 \(Recall fixes\): older tasks/)
  assert.doesNotMatch(rendered, /Working-memory redesign|src\/working\.ts/)
  assert.match(assertMemoryBudget(working(), "E2", false, 2_000), /Archive through E2: older tasks/)
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

test("budget includes headings, preserved constraints, references and gap notices; never slices text", () => {
  const value = working({ references: [{ id: "E1", why: "Earlier design decision" }] })
  const rendered = renderWorking(value, "E2", true), budget = Math.ceil(rendered.length / 4)
  assert.equal(assertMemoryBudget(value, "E2", true, budget), rendered)
  assert.throws(() => assertMemoryBudget(value, "E2", true, budget - 1), /budget/)
  assert.throws(() => assertMemoryBudget(working({ constraints: ["required ".repeat(4_000)] }), "E2", false, 2_000), /not truncated/)
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
