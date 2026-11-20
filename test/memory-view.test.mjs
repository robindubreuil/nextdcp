import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { formatMemoryStatus, installMemoryView } from "../src/memory-view.ts"
import { memoryRpc } from "../src/memory-rpc.ts"

const snapshot = () => ({ sessionID: "s", at: 1_000, checkpoint: { id: "cp", episode: "E7", native: false, author: "main" },
  summary: { chars: 400, tokens: 100 }, recent: { chars: 4_000, tokens: 1_000 }, growth: { rows: 4, tokens: 2_000 },
  retained: 3_100, scale: 1, budgetMode: "auto", budgetScope: "retained", budget: 200_000,
  budgetBounds: { floor: 150_000, start: 200_000, ceiling: 300_000 }, compaction: "idle" })

function harness() {
  const state = { route: { type: "session", sessionID: "s" }, location: { directory: "C:/session-project" }, dialogs: [], toasts: [], calls: [], status: snapshot() }
  const ctx = {
    location: { directory: "C:/plugin-default" },
    data: { session: { get: () => ({ location: state.location }) }, location: { default: () => ({ directory: "C:/default" }) } },
    keymap: { layer: (factory) => { state.commands = factory } },
    client: { rpc: (definition) => {
      assert.equal(definition, memoryRpc)
      return { get: async (input, options) => { state.calls.push(input); state.signal = options.signal; state.options = options; return state.status } }
    } },
    ui: { router: { current: () => state.route }, dialog: { alert: async (input) => { state.dialogs.push(input) } },
      toast: { show: (input) => state.toasts.push(input) } },
  }
  const show = async (_ctx, message) => { state.dialogs.push({ message }) }
  return { ctx, state, show }
}

test("/memory is a session-only read-only dialog, not a model command or writable RPC", async () => {
  const { ctx, state, show } = harness(), cleanup = installMemoryView(ctx, show)
  try {
    const command = state.commands().commands[0]
    assert.equal(state.commands().mode, "global")
    assert.equal(command.slash.name, "memory")
    assert.equal(command.palette, true)
    await command.run()
    assert.deepEqual(state.calls, [{ sessionID: "s" }])
    assert.deepEqual(state.options.location, state.location, "the session Location overrides the plugin/default directory")
    assert.equal(state.dialogs.length, 1)
    assert.match(state.dialogs[0].message, /E7 · cp · main-authored/)
    assert.match(state.dialogs[0].message, /Working summary: ~100 tokens · 400 chars/)
    assert.match(state.dialogs[0].message, /Native recent tail: ~1,000 tokens/)
    assert.match(state.dialogs[0].message, /Retained conversation total: ~3,100 tokens/)
    assert.match(state.dialogs[0].message, /Overdue-checkpoint safeguard: ~200,000 tokens \(auto · total retained conversation\)/)
    assert.match(state.dialogs[0].message, /Baseline bounds: 150,000–300,000 · starts at 200,000 · at most \+50% \/ −20% per completed cycle/)
    assert.match(state.dialogs[0].message, /Last context build: unavailable since plugin load/)
    assert.match(state.dialogs[0].message, /Read-only snapshot. No model request, compaction, or conversation change/)
    state.route = { type: "home" }
    assert.equal(command.enabled(), false)
    await command.run()
    assert.equal(state.calls.length, 1)
    assert.deepEqual(Object.keys(memoryRpc.methods), ["get"])
    assert.deepEqual(memoryRpc.events, {})
  } finally { cleanup() }
  assert.equal(state.signal.aborted, true)
})

test("memory output separates provider counters from estimates and labels stale request projections", () => {
  const state = { ...snapshot(), request: { at: 2_000, checkpoint: "old-cp", model: "p/model", scale: 1.2,
    messages: 100, system: 200, tools: 300, total: 600, outputReserve: 8_192, margin: 1_024, window: 100_000, inputLimit: 80_000, ceiling: 78_976 },
    usage: { messageID: "a1", input: 400, cacheRead: 2_000, cacheWrite: 50, output: 100, reasoning: 20 },
    decision: { at: 3_000, action: "held", reason: "Automatic spike hold." },
    lastCut: { at: 1_000, action: "completed", reason: "Early checkpoint.", id: "cp" } }
  const text = formatMemoryStatus(state)
  assert.match(text, /projection predates the current checkpoint/)
  assert.match(text, /Messages: ~100 · system: ~200 · tool definitions: ~300/)
  assert.match(text, /Projected input: ~600 \/ 78,976 safe input tokens/)
  assert.match(text, /Output reserve: 8,192 · safety margin: 1,024/)
  assert.match(text, /do not add the row estimates again/)
  assert.match(text, /Provider-reported usage · last recorded request \(a1\)/)
  assert.match(text, /Input: 400 · cache read: 2,000 · cache write: 50/)
  assert.match(text, /Last cut: completed — Early checkpoint\. \(cp\)/)
  assert.doesNotMatch(text, /NaN|Infinity|undefined/)
})

test("memory labels explicit growth overrides and never mislabels an older automatic budget during hot reload", () => {
  const { budgetBounds, retained, budgetScope, ...legacy } = snapshot()
  const text = formatMemoryStatus(legacy)
  assert.match(text, /Soft budget: ~200,000 tokens \(auto · new durable growth only\)/)
  assert.match(text, /Retained conversation total: ~3,100 tokens/)
  assert.doesNotMatch(text, /Overdue-checkpoint safeguard|Baseline bounds/)
  const explicit = formatMemoryStatus({ ...legacy, retained, budgetScope: "growth", budgetMode: "explicit", budget: 40_000 })
  assert.match(explicit, /Soft budget: ~40,000 tokens \(explicit · new durable growth only\)/)
  assert.doesNotMatch(explicit, /Overdue-checkpoint safeguard|Baseline bounds|allowance/)
})

test("memory separates the adaptive baseline from temporary same-round evidence room", () => {
  const text = formatMemoryStatus({ ...snapshot(), budget: 530_000, budgetBaseline: 200_000, liveAllowance: 330_000 })
  assert.match(text, /Overdue-checkpoint safeguard: ~530,000 tokens/)
  assert.match(text, /Adaptive baseline: ~200,000 · temporary evidence\/work allowance: ~330,000/)
  assert.match(text, /ages independently and ends at a successful turn end; capacity always wins/)
  const idle = formatMemoryStatus({ ...snapshot(), budgetBaseline: 200_000, liveAllowance: 0 })
  assert.match(idle, /temporary evidence\/work allowance: ~0/)
  assert.doesNotMatch(idle, /ages independently/)
})

test("memory dialog coalesces invocations and ignores late replies after unload or a tab switch", async () => {
  for (const cancel of ["unload", "switch"]) {
    const { ctx, state, show } = harness()
    let release
    ctx.client.rpc = () => ({ get: async () => new Promise((resolve) => { release = resolve }) })
    const cleanup = installMemoryView(ctx, show), command = state.commands().commands[0]
    const first = command.run()
    await setImmediate()
    await command.run()
    if (cancel === "unload") cleanup()
    else state.route = { type: "session", sessionID: "other" }
    release(snapshot())
    await first
    assert.equal(state.dialogs.length, 0, cancel)
    assert.equal(state.toasts.length, 0, cancel)
    cleanup()
  }
})

test("memory transport failures are generic and never display uncontrolled server data", async () => {
  const { ctx, state, show } = harness()
  ctx.client.rpc = () => ({ get: async () => { throw new Error("SECRET transcript or transport details") } })
  const cleanup = installMemoryView(ctx, show)
  try {
    await state.commands().commands[0].run()
    assert.equal(state.dialogs.length, 0)
    assert.equal(state.toasts[0].variant, "error")
    assert.doesNotMatch(state.toasts[0].message, /SECRET/)
  } finally { cleanup() }
})

test("the first /memory waits for a cold Location's RPC registration without showing an error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { ctx, state, show } = harness()
  let calls = 0
  ctx.client.rpc = () => ({ get: async () => { calls++; throw { type: "rpc.unavailable" } } })
  const cleanup = installMemoryView(ctx, show)
  try {
    const first = state.commands().commands[0].run()
    await setImmediate()
    ctx.client = { rpc: () => ({ get: async (_input, options) => {
      calls++; assert.deepEqual(options.location, state.location); return snapshot()
    } }) }
    t.mock.timers.tick(100)
    await first
    assert.equal(calls, 2, "a retry reads the current client, not a stale setup-time subclient")
    assert.equal(state.dialogs.length, 1)
    assert.deepEqual(state.toasts, [])
  } finally { cleanup() }
})

test("unavailable RPC retries are bounded, abortable, and coalesce repeated commands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  for (const cancel of [false, true]) {
    const { ctx, state, show } = harness()
    let calls = 0
    ctx.client.rpc = () => ({ get: async () => { calls++; throw { type: "rpc.unavailable" } } })
    const cleanup = installMemoryView(ctx, show), command = state.commands().commands[0]
    try {
      const first = command.run()
      await setImmediate()
      await command.run()
      if (cancel) cleanup()
      else for (let attempt = 0; attempt < 5; attempt++) { t.mock.timers.tick(100 * 2 ** attempt); await setImmediate() }
      await first
      assert.equal(calls, cancel ? 1 : 6)
      assert.equal(state.toasts.length, cancel ? 0 : 1)
      assert.equal(state.dialogs.length, 0)
    } finally { cleanup() }
  }
})

test("broken handlers are not retried and late errors do not toast in another session", async () => {
  for (const changeRoute of [false, true]) {
    const { ctx, state, show } = harness()
    let calls = 0, reject
    ctx.client.rpc = () => ({ get: () => { calls++; return new Promise((_resolve, fail) => { reject = fail }) } })
    const cleanup = installMemoryView(ctx, show)
    try {
      const first = state.commands().commands[0].run()
      if (changeRoute) state.route = { type: "session", sessionID: "other" }
      reject({ type: "rpc.internal", message: "SECRET" })
      await first
      assert.equal(calls, 1)
      assert.equal(state.toasts.length, changeRoute ? 0 : 1)
      assert.doesNotMatch(JSON.stringify(state.toasts), /SECRET/)
    } finally { cleanup() }
  }
})
