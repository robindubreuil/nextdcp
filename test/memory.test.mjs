import assert from "node:assert/strict"
import test from "node:test"
import { adoptNative, episodeRows, planCut, renderMemory, resolveMemory } from "../src/memory.ts"

const row = (id, type, status, extra = {}) => ({ id, type, ...(status ? { status } : {}), ...extra })
const ep = (id, summary, rowIDs = [], extra = {}) => ({ id, summary, rowIDs, ...extra })
const record = (id, parent, episode) => ({ id, parent, episode })

test("the episode cut spans every row after the previous checkpoint, including the native tail", () => {
  const rows = [
    row("old", "user"), row("checkpoint-1", "compaction", "completed"),
    row("user", "user"), row("assistant", "assistant"), row("failed", "compaction", "failed"),
    row("tail-user", "user"), row("tail-assistant", "assistant"), row("checkpoint-2", "compaction", "running"),
    row("later", "user"),
  ]
  assert.deepEqual(planCut(rows), { checkpoint: "checkpoint-2", parent: "checkpoint-1", rowIDs: ["user", "assistant", "failed", "tail-user", "tail-assistant"] })
  assert.deepEqual(planCut([row("u", "user"), row("a", "assistant"), row("c", "compaction", "running")]), { checkpoint: "c", parent: null, rowIDs: ["u", "a"] })
  assert.throws(() => planCut([row("u", "user")]), /running compaction/)
})

test("memory appends without rewriting previous episodes and reverts follow the selected parent", () => {
  const e1 = ep("E1", "First summary", ["u1", "a1"])
  const e2 = ep("E2", "Second summary", ["u2", "a2"])
  const e3 = ep("E3", "New branch", ["u3", "a3"])
  const records = new Map([
    ["c1", record("c1", null, e1)], ["c2", record("c2", "c1", e2)], ["c3", record("c3", "c1", e3)],
  ])
  const first = renderMemory(resolveMemory("c1", records).episodes)
  const originalBranch = resolveMemory("c2", records)
  // Rendering is bounded: an older episode keeps its heading, the latest its whole note.
  assert.equal(first, "## Episode E1\nFirst summary")
  assert.equal(renderMemory(originalBranch.episodes), "## Episode E1\n\n## Episode E2\nSecond summary")
  assert.deepEqual(originalBranch.episodes.map((item) => item.id), ["E1", "E2"])
  const reverted = resolveMemory("c3", records)
  assert.deepEqual(reverted.episodes.map((item) => item.id), ["E1", "E3"])
  assert.equal(reverted.catalog.has("E2"), false)
  assert.deepEqual(episodeRows("E3", reverted.catalog), { rowIDs: ["u3", "a3"], gap: false })
  assert.deepEqual(resolveMemory(null, records).episodes, [])
})

test("the episode header takes its title from the Title line without repeating it", () => {
  const titled = ep("E1", "Title: Repair search\nUser requests:\n- Find it\nCurrent state and next step:\n- Test it")
  assert.equal(renderMemory([titled]), "## Episode E1 — Repair search\nUser requests:\n- Find it\nCurrent state and next step:\n- Test it")
  assert.equal(renderMemory([ep("E2", "Title: Finished")]), "## Episode E2 — Finished")
  assert.equal(renderMemory([ep("E3", "Untitled native summary", [], { native: true })]), "## Episode E3 (native)\nUntitled native summary")
  assert.equal(renderMemory([ep("E4", "Title: A\r\n\r\nFiles touched:\r\n- x")]), "## Episode E4 — A\nFiles touched:\r\n- x")
})

test("the episode chain fallback is bounded so old bodies cannot overflow the memory budget", () => {
  const episodes = [...Array.from({ length: 8 }, (_, index) =>
    ep(`E${index + 1}`, `Title: Task ${index + 1}\n${"stale body ".repeat(200)}`)),
    ep("E9", "Title: Task 9\nkept note for the newest episode")]
  const rendered = renderMemory(episodes)
  assert.match(rendered, /## Episode E1 — Task 1/)
  assert.match(rendered, /## Episode E9 — Task 9\nkept note for the newest episode/)
  assert.doesNotMatch(rendered, /stale body/)
  assert.ok(Math.ceil(rendered.length / 4) < 2_000, "nine episodes with fat notes once rendered ~8.7k estimated tokens against the 2,000-token budget")
})

test("native fallback adopts the summary and discloses an unknown archive gap", () => {
  const checkpoint = row("native", "compaction", "completed", { summary: "Native summary" })
  const known = adoptNative(checkpoint, "E2", { id: "native", parent: "c1", rowIDs: ["u2", "a2"], archived: true })
  assert.equal(known.parent, "c1")
  assert.deepEqual(known.episode.rowIDs, ["u2", "a2"])
  assert.equal(known.episode.gap, undefined)
  assert.equal(renderMemory([known.episode]), "## Episode E2 (native)\nNative summary")
  const unknown = adoptNative(checkpoint, "E3")
  assert.equal(unknown.parent, null)
  assert.equal(unknown.episode.gap, true)
  assert.match(renderMemory([unknown.episode]), /recall gap/)
  assert.throws(() => adoptNative(checkpoint, "E2", { id: "other", parent: null, rowIDs: [], archived: true }), /does not match/)
})

test("corrupt chains fail rather than silently dropping history", () => {
  const e1 = ep("E1", "one", ["r1"])
  const e2 = ep("E2", "two", ["r2"])
  assert.throws(() => resolveMemory("missing", new Map()), /Missing checkpoint/)
  assert.throws(() => resolveMemory("c1", new Map([["c1", record("c1", "c1", e1)]])), /Cyclic checkpoint/)
  assert.throws(() => resolveMemory("c2", new Map([["c1", record("c1", null, e1)], ["c2", record("c2", "gone", e2)]])), /Missing checkpoint/)
  assert.throws(() => resolveMemory("c2", new Map([["c1", record("c1", null, e1)], ["c2", record("c2", "c1", e1)]])), /Duplicate episode id/)
  assert.throws(() => episodeRows("missing", new Map()), /Missing episode/)
})
