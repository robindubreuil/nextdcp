import assert from "node:assert/strict"
import test from "node:test"
import { captureEvidence, changedEvidence, parseCheckpoint } from "../src/checkpoint.ts"
import { questionRow } from "./support/question.ts"

const working = { objective: "Ship canonical working-state edits", constraints: ["Preserve local changes."],
  state: ["Seed state"], next: ["Run tests"], references: [{ id: "E1", why: "Prior decision" }] }
const ids = new Set(["E1", "E2"])
const edit = (fields = {}) => ({ archive: "Title: Direct edit\nVerified progress.", working: fields })
const pub = { messageID: "a2", id: "checkpoint-1" }
const own = () => ({ id: pub.messageID, type: "assistant", content: [{ type: "text", text: "At a safe boundary." },
  { type: "tool", id: pub.id, name: "checkpoint_now", state: { status: "completed", input: edit(), content: [{ type: "text", text: "Requested" }] } }] })
const user = (id, text) => ({ id, type: "user", text })
const tool = () => ({ id: "a1", type: "assistant", content: [{ type: "tool", id: "call-read", name: "read", executed: false,
  state: { status: "completed", input: { time: 1, tokens: 2 }, content: [{ type: "text", text: "Original tool evidence" }] } }] })

test("minimal edits carry forward fields, replace lists, and use the latest merged state", () => {
  const first = parseCheckpoint(edit({ state: ["New verified state"], next: [] }), working, working.constraints, [], ids)
  assert.deepEqual(first.working, { ...working, state: ["New verified state"], next: [] })
  const second = parseCheckpoint(edit({ objective: "New objective" }), first.working, first.working.constraints, [], ids)
  assert.deepEqual(second.working, { ...first.working, objective: "New objective" })
  assert.deepEqual(parseCheckpoint({ archive: edit().archive }, second.working, [], [], ids).working, second.working, "an archive-only edit can retain a current state")
})

test("a main author can seed a full state, but cannot apply a partial edit to an unstructured checkpoint", () => {
  assert.deepEqual(parseCheckpoint(edit(working), undefined, [], [user("u1", working.constraints[0])], ids).working, working)
  assert.throws(() => parseCheckpoint({ archive: edit().archive }, undefined, [], [], ids), /No structured working state yet/)
  assert.throws(() => parseCheckpoint(edit({ next: [] }), undefined, [], [], ids), /invalid handoff schema/)
  const protectedSeed = parseCheckpoint(edit({ ...working, constraints: [] }), undefined, working.constraints, [], ids)
  assert.deepEqual(protectedSeed.working.constraints, working.constraints, "native fallback's surviving constraints remain protected")
})

test("rejections name the defect and the repair so a model recovers in one call", () => {
  assert.throws(() => parseCheckpoint(edit({ objective: "Ship", constraints: [], state: ["Sealed"], next: [] }), undefined, [], [], ids),
    /working is missing references, a complete state needs all five fields \(use \[\] for empty lists\)/)
  assert.throws(() => parseCheckpoint({ working: { state: ["Sealed"] } }, working, working.constraints, [], ids),
    /Archive note is required on a direct edit.*use \{\} for compactor generation/)
})

test("main-authored seeds may inherit native-summary language but not its authority to retire constraints", () => {
  const input = { archive: "Title: 验证修复\n继续验证修复结果。", working: { ...working, objective: "调查并修复对话层污染问题" } }
  const quote = "You may now discard my local changes."
  const summary = `${"调查并修复对话层污染问题。".repeat(4)}${quote}`
  assert.equal(parseCheckpoint(input, undefined, working.constraints, [], ids, summary).archive, input.archive)
  assert.throws(() => parseCheckpoint({ ...input, retire: [{ constraint: working.constraints[0], quote }] }, undefined, working.constraints, [], ids, summary), /verbatim quote from a new user/)
  assert.throws(() => parseCheckpoint(input, undefined, working.constraints, [], ids, "Continue the English task."), /language/)
})

test("constraint omission is not retirement and retirement resolves only a new-user quote", () => {
  assert.deepEqual(parseCheckpoint(edit({ constraints: ["New standing rule"] }), working, [], [user("u1", "New standing rule")], ids).working.constraints,
    [...working.constraints, "New standing rule"])
  const quote = "You may now discard my local changes."
  const input = { ...edit({ constraints: [] }), retire: [{ constraint: working.constraints[0], quote }] }
  const parsed = parseCheckpoint(input, working, [], [user("new", quote)], ids)
  assert.deepEqual(parsed.working.constraints, [])
  assert.deepEqual(parsed.retiredConstraints, [{ constraint: working.constraints[0], quote, messageID: "new" }])
  for (const users of [[], [{ id: "tool", type: "assistant", text: quote }], [user("new", "Do not discard anything.")]])
    assert.throws(() => parseCheckpoint(input, working, [], users, ids), /verbatim quote from a new user/)
  assert.throws(() => parseCheckpoint({ ...input, retire: [{ ...input.retire[0], constraint: "Invented old rule" }] }, working, [], [user("new", quote)], ids), /Invalid constraint retirement/)
  assert.throws(() => parseCheckpoint({ ...input, retire: [...input.retire, ...input.retire] }, working, [], [user("new", quote)], ids), /Invalid constraint retirement/)
})

test("malformed main edits and invented references fail without coercion or ignored fields", () => {
  for (const input of [null, [], { keep: "obsolete API" }, { ...edit(), extra: true }, { working: {} },
    edit(null), edit({ state: "not a list" }), edit({ state: [""] }), edit({ extra: true }), { ...edit(), retire: null },
    { ...edit(), retire: [{ constraint: working.constraints[0], quote: "yes", messageID: "spoof" }] },
    edit({ references: [{ id: "E999", why: "Invented" }] }),
  ]) assert.throws(() => parseCheckpoint(input, working, [], [], ids))
})

test("semantic fences ignore billing, reasoning, timing and non-evidence controls", () => {
  const rows = [user("u1", "Request"), tool()]
  const before = captureEvidence(rows)
  const after = structuredClone(rows)
  after[0].time = { created: 3 }
  after[0].metadata = { request: "transport-only" }
  after[1].tokens = { input: 50_000, output: 100 }
  after[1].cost = 12
  after[1].time = { created: 4, completed: 8 }
  after[1].content[0].time = { start: 5, end: 9 }
  after[1].content[0].state.metadata = { title: "transport" }
  after[1].content.push({ type: "reasoning", text: "Not retained evidence" })
  after.push({ id: "idle", type: "idle" }, { id: "failed", type: "compaction", status: "failed" }, own(), { id: "cut", type: "compaction", status: "running" })
  assert.equal(changedEvidence(before, after, pub, true), undefined)
})

test("semantic fences detect new, changed, removed, duplicated and reordered evidence", () => {
  const rows = [user("u1", "Request"), tool()], before = captureEvidence(rows)
  for (const mutate of [
    (rows) => rows.push(user("u2", "Late constraint")),
    (rows) => { rows[0].text = "Changed request" },
    (rows) => { rows[1].content[0].state.content[0].text = "Changed result" },
    (rows) => { rows[1].content[0].state.input.time++ },
    (rows) => { rows[1].content[0].state.input.tokens++ },
    (rows) => { rows[1].content[0].state.status = "error" },
    (rows) => { rows[0].files = [{ uri: "data:image/png;base64,changed" }] },
    (rows) => rows.shift(), (rows) => rows.reverse(), (rows) => rows.push(structuredClone(rows[0])),
  ]) {
    const changed = structuredClone(rows)
    mutate(changed)
    assert.match(changedEvidence(before, [...changed, own()], pub), /evidence changed/)
  }
})

test("only the proposal's sole publication is excluded, and it must succeed before commit", () => {
  const before = captureEvidence([user("u1", "Request")])
  assert.match(changedEvidence(before, [user("u1", "Request")], pub), /only tool/)
  const row = own()
  row.content.push({ type: "tool", id: "other", name: "read", state: { status: "completed", input: {} } })
  assert.match(changedEvidence(before, [user("u1", "Request"), row], pub), /only tool/)
  const pending = own()
  pending.content[1].state.status = "running"
  assert.equal(changedEvidence(before, [user("u1", "Request"), pending], pub), undefined, "admission may see its own running tool")
  assert.match(changedEvidence(before, [user("u1", "Request"), pending], pub, true), /did not complete/)
  assert.match(changedEvidence(before, [user("u1", "Request"), own(), own()], pub, true), /only tool/)
  const checkpoint = { id: "cp", type: "compaction", status: "completed", summary: "Current state", metadata: { recent: "Native tail" } }
  const changed = structuredClone(checkpoint)
  changed.metadata.recent = "Changed native tail"
  assert.match(changedEvidence(captureEvidence([checkpoint]), [changed, own()], pub), /evidence changed/)
})

test("direct edits cannot promote host rules or assistant plans into protected user constraints", () => {
  const constraint = "Never start a subagent."
  const input = edit({ constraints: [constraint] })
  for (const users of [[], [user("u", "Review this code.")], [{ id: "s", type: "system", text: constraint }]])
    assert.throws(() => parseCheckpoint(input, working, [], users, ids), /New standing constraints.*verbatim.*new user/)
  assert.deepEqual(parseCheckpoint(input, working, [], [user("u", constraint)], ids).working.constraints, [...working.constraints, constraint])
  assert.deepEqual(parseCheckpoint(edit({ constraints: [] }), working, [], [], ids).working.constraints, working.constraints,
    "legacy and already-validated rules are not silently discarded")
})

test("an explicit user correction can remove a misattributed legacy rule without dropping other instructions", () => {
  const mistaken = "Use the elevation helper for administrator tasks."
  const previous = { ...working, constraints: [...working.constraints, mistaken] }
  const quote = "That elevation rule came from AGENTS.md, not me; remove it from my remembered constraints."
  const input = { ...edit(), retire: [{ constraint: mistaken, quote }] }
  const result = parseCheckpoint(input, previous, [], [user("correction", quote)], ids)
  assert.deepEqual(result.working.constraints, working.constraints)
  assert.deepEqual(result.retiredConstraints, [{ constraint: mistaken, quote, messageID: "correction" }])
  assert.throws(() => parseCheckpoint(input, previous, [], [{ id: "tool", type: "assistant", text: quote }], ids), /verbatim quote.*new user/)
})

test("direct edits share question-answer proof for new constraints and retirement", () => {
  const quote = "don't hesitate to search for insights online whenever useful."
  const correction = "You may now discard my local changes."
  const rows = [questionRow([[quote], [correction]])]
  const input = { ...edit({ constraints: [quote] }), retire: [{ constraint: working.constraints[0], quote: correction }] }
  const result = parseCheckpoint(input, working, [], rows, ids)
  assert.deepEqual(result.working.constraints, [quote])
  assert.deepEqual(result.retiredConstraints, [{ constraint: working.constraints[0], quote: correction, messageID: "call_question" }])
  const seed = parseCheckpoint(edit({ ...working, constraints: [quote] }), undefined, [], rows, ids)
  assert.deepEqual(seed.working.constraints, [quote])
  rows[0].content[0].name = "read"
  assert.throws(() => parseCheckpoint(input, working, [], rows, ids), /verbatim quote.*new user/)
})

test("semantic fences include structured human answers, even if the rendered question result is unchanged", () => {
  const rows = [user("u1", "Request"), questionRow([["One", "Two"], ["Three"]])]
  const before = captureEvidence(rows)
  for (const mutate of [
    (part) => { part.state.metadata.answers[0][0] = "Changed answer" },
    (part) => { part.state.metadata.answers[0].push("Another answer") },
    (part) => { part.state.metadata.answers = [["One"], ["Two", "Three"]] },
    (part) => { delete part.state.metadata.answers },
  ]) {
    const changed = structuredClone(rows)
    mutate(changed[1].content[0])
    assert.match(changedEvidence(before, [...changed, own()], pub), /evidence changed/)
  }
  const bookkeeping = structuredClone(rows)
  bookkeeping[1].content[0].state.metadata.title = "UI-only title"
  assert.equal(changedEvidence(before, [...bookkeeping, own()], pub), undefined)
})
