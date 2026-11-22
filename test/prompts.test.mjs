import assert from "node:assert/strict"
import test from "node:test"
import { CHECKPOINT_NOW_DESCRIPTION, RECALL_DESCRIPTION, WORKING_PROMPT, budgetGateNotice, checkpointReminder, workingPrompt } from "../src/prompts.ts"
import { CHECKPOINT_INPUT } from "../src/checkpoint.ts"
import { tokens } from "../src/tokens.ts"

test("always-present tool instructions stay small without hiding recall addressing or checkpoint modes", () => {
  assert.ok(tokens(RECALL_DESCRIPTION) + tokens(CHECKPOINT_NOW_DESCRIPTION) + tokens(JSON.stringify(CHECKPOINT_INPUT)) <= 900)
  for (const cue of ["E57", "call_", "msg_", "P12", "catalog", "conversation", "tools", "full", "30000"])
    assert.ok(RECALL_DESCRIPTION.includes(cue), `missing recall cue: ${cue}`)
  assert.match(RECALL_DESCRIPTION, /id: E57.*catalog browse/s)
  assert.match(RECALL_DESCRIPTION, /Copy returned addresses into id/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /\{\}/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /already has|already receives/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /no recap|not.*recap/i)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /Admission is not completion/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /'Title: <name>' first line/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /Never to close a completed task: finish your reply; that cut lands with the user's next message, steered by it/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /ideally under ~1k tokens: no history, finished work, re-injected instructions, or detail that files or recall restore/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /Never state an unverified claim as fact; label it unverified/)
})

test("the compactor is asked for continuation state, never a quota-filling recap", () => {
  assert.ok(tokens(WORKING_PROMPT) <= 600)
  assert.match(WORKING_PROMPT, /pins each quote to its exact source span/)
  assert.match(WORKING_PROMPT, /verbatim|exact quotes/)
  assert.match(WORKING_PROMPT, /task.*state\/next|state\/next.*task/i)
  assert.match(WORKING_PROMPT, /next decision|next action/)
  assert.match(WORKING_PROMPT, /label every unverified claim or inference unverified — later turns take state as truth/)
  const value = workingPrompt({ through: "E2", budget: 2000, archives: ["E1", "E2"] }, undefined, true)
  assert.match(value, /not a quota/)
  assert.doesNotMatch(value, /"users"|"previous"/)
})

test("the gate offers normal work or direct authorship, not a preliminary summary for the compactor", () => {
  const notice = budgetGateNotice(60_000, 50_000, 200_000)
  assert.ok(tokens(notice) <= 130)
  assert.doesNotMatch(notice, /Name in-flight|anchors the working state/)
  assert.match(notice, /actual history|already has|no recap/i)
  assert.match(notice, /author the compact state directly, skipping the summary call/)
})

test("the automatic notice describes an overdue retained-conversation safeguard, not a cadence or physical capacity limit", () => {
  const notice = budgetGateNotice(220_000, 200_000, 1_050_000, false, "retained")
  assert.ok(tokens(notice) <= 180)
  assert.match(notice, /Overdue checkpoint safeguard — automated notice, not a user message/)
  assert.match(notice, /Retained conversation ~220000.*adaptive safeguard 200000/)
  assert.match(notice, /not a cadence target/)
  assert.doesNotMatch(notice, /New durable conversation|soft budget/)
  const limited = budgetGateNotice(310_000, 300_000, 1_050_000, true, "retained")
  assert.match(limited, /upper policy bound/)
  assert.match(limited, /does not mean.*context window is full/)
  assert.doesNotMatch(limited, /use a larger window|ceiling-saturated/)
})

test("checkpoint reminders are short optional guidance with continue as the free default", () => {
  const pause = checkpointReminder(84_600), near = checkpointReminder(160_000, 200_000)
  const capacity = checkpointReminder(80_000, undefined, { total: 80_006, ceiling: 90_784 })
  for (const text of [pause, near, capacity]) {
    assert.ok(tokens(text) <= 115, text)
    assert.match(text, /automated notice, not a user message/)
    assert.match(text, /checkpoint_now as the ONLY tool/)
    assert.doesNotMatch(text, /NextDCP|recap|summar/i)
  }
  assert.match(pause, /Paused after ~85k tokens since the last checkpoint\. If your conclusions cover what's next/)
  assert.match(pause, /raw outputs won't be needed again/)
  assert.match(pause, /never to close a completed task: finish the reply; that cut lands with the user's next message, steered by it\. Else continue; nothing is queued\./)
  assert.doesNotMatch(pause, /safeguard/)
  assert.match(near, /; overdue safeguard ~200k is near\./)
  assert.match(capacity, /Projected input ~80k of ~91k safe tokens\. Avoid large new reads; at your next pause/)
  assert.match(capacity, /compaction is forced regardless/)
  assert.match(CHECKPOINT_NOW_DESCRIPTION, /after stating conclusions.*not while raw results are still needed/)
})
