import assert from "node:assert/strict"
import test from "node:test"
import { CONCLUSION_TOKENS, evidenceWeight, freshEvidence, liveBudget, pause, reminderFor } from "../src/safeguard.ts"
import { evidenceTokens } from "../src/estimate.ts"

const tool = (id, name, status, text = "") => ({ type: "tool", id, name, state: status === "error"
  ? { status, input: {}, error: "failed" } : { status, input: {}, content: [{ type: "text", text }] } })
const step = (id, created, parts) => ({ id, type: "assistant", time: { created }, content: parts })
const read = (id, created, tokens, text = "") => step(id, created, [...(text ? [{ type: "text", text }] : []), tool(`${id}-call`, "read", "completed", "r".repeat(tokens * 4))])
const said = (id, created, tokens) => step(id, created, [{ type: "text", text: "c".repeat(tokens * 4) }])
const user = (id, created, text = "next") => ({ id, type: "user", time: { created }, text })

test("returned evidence excludes errors, human answers and checkpoint acknowledgements", () => {
  const rows = [step("a", 1, [tool("r", "read", "completed", "x".repeat(400)), tool("e", "bash", "error"),
    tool("q", "question", "completed", "answer".repeat(100)), tool("c", "checkpoint_now", "completed", "Requested".repeat(100))]),
    { id: "shell", type: "shell", command: "build", output: { output: "y".repeat(400) } },
    { id: "background", type: "shell", command: "watch", metadata: { background: true }, output: { output: "z".repeat(400) } }]
  assert.equal(evidenceTokens(rows), 200)
})

test("each result ages by its own assistant steps until a successful turn end", () => {
  assert.equal(evidenceWeight(0), 1)
  assert.equal(evidenceWeight(12), 1)
  assert.equal(evidenceWeight(20), 0.5)
  assert.equal(evidenceWeight(28), 0)
  const old = [read("previous", 10, 9_000), { id: "idle", type: "idle", outcome: "succeeded", time: { created: 11 } }]
  const rows = [...old, read("first", 100, 1_000), ...Array.from({ length: 19 }, (_, at) => said(`s${at}`, 101 + at, 10)), read("second", 200, 100)]
  assert.deepEqual(freshEvidence(rows), { tokens: 1_100, weighted: 1_000 * 0.5 + 100 })
  assert.deepEqual(freshEvidence(rows, 2), { tokens: 2_200, weighted: 1_200 }, "calibration scales evidence")
  assert.deepEqual(freshEvidence(rows.slice(0, -1)).weighted, 1_000 * (8 / 16 + 1 / 16),
    "a later read never makes an earlier cohort younger")
  for (const outcome of ["interrupted", "failed"]) {
    const resumed = [read("before", 1, 1_000), { id: "idle", type: "idle", outcome }, user("steer", 2), read("after", 3, 100)]
    assert.deepEqual(freshEvidence(resumed), { tokens: 1_100, weighted: 1_100 }, `${outcome} work continues`)
  }
  assert.deepEqual(freshEvidence([read("ended", 1, 1_000), { id: "idle", type: "idle" }]), { tokens: 0, weighted: 0 })
  assert.deepEqual(freshEvidence([{ ...read("untimed", 0, 1_000), time: undefined }]).tokens, 1_000, "timestamps are not required")
})

test("temporary room cannot consume fixed overhead, output or margin", () => {
  assert.deepEqual(liveBudget(200_000, { tokens: 100_000, weighted: 100_000 }, 900_000), { baseline: 200_000, allowance: 150_000, budget: 350_000 })
  assert.equal(liveBudget(200_000, { tokens: 900_000, weighted: 900_000 }, 500_000).budget, 500_000)
  assert.equal(liveBudget(200_000, { tokens: 1, weighted: 1 }, 150_000).allowance, 0, "capacity below the baseline leaves the separate capacity check authoritative")
})

test("a pause states conclusions about the model's own work and keeps working", () => {
  const work = [user("u", 1), read("r", 2, 50_000)]
  const conclude = (id, created, tokens = CONCLUSION_TOKENS, name = "edit") => step(id, created, [{ type: "text", text: "c".repeat(tokens * 4) }, tool(`${id}-call`, name, "completed", "ok")])
  assert.deepEqual(pause(work), { steps: 1, unseen: 50_000, concluded: false }, "a step answering the user is not a conclusion about own work")
  assert.equal(pause([...work, conclude("short", 3, CONCLUSION_TOKENS - 1)]).concluded, false, "a preamble is not a conclusion")
  assert.deepEqual(pause([...work, conclude("long", 3)]), { steps: 2, unseen: 1, concluded: true })
  assert.deepEqual(pause([...work, read("next", 3, 20_000, "c".repeat(400))]), { steps: 2, unseen: 20_000, concluded: true })
  assert.equal(pause([...work, step("failed", 3, [{ type: "text", text: "c".repeat(400) }, tool("e", "bash", "error")])]).concluded, false)
  assert.equal(pause([...work, said("final", 3, 200)]).concluded, false, "a final reply's round end belongs to next-prompt scheduling")
  assert.equal(pause([...work, conclude("steered", 3), user("u2", 4)]).concluded, false, "steering takes precedence")
  assert.equal(pause([...work, user("u2", 3), conclude("reply", 4)]).concluded, false, "a reply to the user is not a pause")
  assert.equal(pause([...work, conclude("ask", 3, CONCLUSION_TOKENS, "question")]).concluded, false, "a human answer is pending")
  assert.equal(pause([...work, conclude("short", 3, 40)], 40).concluded, true, "the threshold is a parameter for back-testing")
  assert.deepEqual(pause([user("u", 1)]), { steps: 0, unseen: 1, concluded: false })
})

test("reminders need worthwhile work, replay until answered, and are spaced by progress", () => {
  const input = (steps, growth, extra = {}) => ({ checkpoint: "c1", pause: { steps, unseen: 0, concluded: true }, growth, baseline: 200_000, request: growth, ceiling: 900_000, ...extra })
  assert.equal(reminderFor(input(3, 49_999)), undefined)
  const first = reminderFor(input(3, 50_000))
  assert.deepEqual(first, { checkpoint: "c1", steps: 3, growth: 50_000, kind: "boundary", warned: false })
  assert.equal(reminderFor(input(3, 50_000), first), first, "an identical rebuild replays unanswered guidance")
  assert.equal(reminderFor(input(4, 99_999), first), undefined)
  assert.equal(reminderFor(input(5, 100_000), first)?.kind, "boundary")
  assert.equal(reminderFor({ ...input(5, 100_000), pause: { steps: 5, unseen: 10_001, concluded: true } }), undefined)
  assert.equal(reminderFor({ ...input(5, 100_000), pause: { steps: 5, unseen: 0, concluded: false } }), undefined)
  assert.equal(reminderFor(input(5, 100_000), { ...first, checkpoint: "old" })?.growth, 100_000, "a new checkpoint resets spacing")
})

test("near capacity warns once per checkpoint, even before a pause", () => {
  const input = (steps, request, checkpoint = "c1") => ({ checkpoint, pause: { steps, unseen: 50_000, concluded: false }, growth: 60_000, baseline: 50_000, request, ceiling: 90_000 })
  assert.equal(reminderFor(input(1, 76_499)), undefined)
  const warned = reminderFor(input(1, 76_500))
  assert.deepEqual(warned, { checkpoint: "c1", steps: 1, growth: 60_000, kind: "capacity", warned: true })
  assert.equal(reminderFor(input(2, 89_000), warned), undefined)
  assert.equal(reminderFor(input(2, 89_000, "c2"), warned)?.kind, "capacity")
  assert.equal(reminderFor({ ...input(2, 76_500), growth: 12_499 }), undefined, "a checkpoint must be able to free meaningful room")
})
