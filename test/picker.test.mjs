import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { installPicker } from "../src/picker.ts"

function harness() {
  const state = { route: { type: "session", sessionID: "s" }, saved: [], toasts: [], dialogs: [],
    snapshot: { preference: { mode: "default" }, configured: { providerID: "p", id: "cheap" }, choices: [
      { model: { providerID: "p", id: "cheap", variant: "light" }, name: "Cheap", context: 200_000 },
    ] }, selected: { mode: "main" } }
  const ctx = {
    keymap: { layer: (factory) => { state.commands = factory } },
    ui: { router: { current: () => state.route }, dialog: { select: async (input) => { state.dialogs.push(input); return state.selected } },
      toast: { show: (input) => state.toasts.push(input) } },
    client: { rpc: () => ({ get: async () => state.snapshot, set: async (input) => { state.saved.push(input) },
      events: { subscribe: (name, { signal }) => (async function* () {
        state.signal = signal
        if (state.warning) yield { data: state.warning }
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      })() } }) },
  }
  return { ctx, state }
}

test("picker is session-only, searchable, preselected and saves without changing main model", async () => {
  const { ctx, state } = harness()
  const cleanup = installPicker(ctx)
  const command = state.commands().commands[0]
  assert.equal(command.slash.name, "compact-model")
  assert.equal(command.palette, true)
  await command.run()
  assert.deepEqual(state.saved, [{ sessionID: "s", preference: { mode: "main" } }])
  assert.match(state.dialogs[0].placeholder, /Search/)
  assert.equal(state.dialogs[0].current, state.dialogs[0].options[0].value)
  assert.equal(state.dialogs[0].options.length, 3)
  assert.match(state.dialogs[0].options[2].title, /#light/)
  state.route = { type: "home" }
  assert.equal(state.commands().commands[0].enabled, false)
  await state.commands().commands[0].run()
  assert.equal(state.saved.length, 1)
  cleanup()
  assert.equal(state.signal.aborted, true)
})

test("picker discovery is global across autocomplete and command-palette input modes", () => {
  const { ctx, state } = harness()
  // Plugins load on the home screen, before a session route is selected.
  state.route = { type: "home" }
  const cleanup = installPicker(ctx)
  try {
    // OpenCode's default base layer is filtered out in autocomplete/dialog mode.
    // The host discovers slash and palette commands only from active layers.
    assert.equal(state.commands().mode, "global")
    assert.equal(state.commands().commands[0].enabled, false)
    state.route = { type: "session", sessionID: "s" }
    const command = state.commands().commands[0]
    assert.equal(command.enabled, true)
    assert.equal(command.slash.name, "compact-model")
    assert.equal(command.palette, true)
  } finally { cleanup() }
})

test("cancelling writes nothing and a second invocation cannot open another picker", async () => {
  const { ctx, state } = harness()
  let release
  ctx.ui.dialog.select = async () => new Promise((resolve) => { release = resolve })
  const cleanup = installPicker(ctx)
  const command = state.commands().commands[0]
  const first = command.run()
  await setImmediate()
  await command.run()
  release(undefined)
  await first
  assert.deepEqual(state.saved, [])
  cleanup()
})

test("picker shows unavailable saved selections and failures do not report success", async () => {
  const { ctx, state } = harness()
  state.snapshot.preference = { mode: "specific", model: { providerID: "gone", id: "old" } }
  const rpc = ctx.client.rpc()
  rpc.set = async () => { throw new Error("save failed") }
  ctx.client.rpc = () => rpc
  const cleanup = installPicker(ctx)
  await state.commands().commands[0].run()
  assert.match(state.dialogs[0].options[0].title, /unavailable/)
  assert.equal(state.dialogs[0].current, state.dialogs[0].options[0].value)
  assert.equal(state.toasts.at(-1).variant, "error")
  cleanup()
})

test("unloading a picker with an open dialog cannot save a stale selection", async () => {
  const { ctx, state } = harness()
  let release
  ctx.ui.dialog.select = () => new Promise((resolve) => { release = resolve })
  const cleanup = installPicker(ctx)
  const running = state.commands().commands[0].run()
  await setImmediate()
  cleanup()
  release({ mode: "main" })
  await running
  assert.equal(state.saved.length, 0)
  assert.equal(state.toasts.length, 0)
})

test("switching tabs while the dialog is open saves to its original session", async () => {
  const { ctx, state } = harness()
  ctx.ui.dialog.select = async () => { state.route = { type: "session", sessionID: "other" }; return { mode: "main" } }
  const cleanup = installPicker(ctx)
  await state.commands().commands[0].run()
  assert.equal(state.saved[0].sessionID, "s")
  cleanup()
})

test("warning subscription reconnects after reload and cleanup cancels retries", { timeout: 4_000 }, async () => {
  const { ctx } = harness()
  const rpc = ctx.client.rpc()
  let connections = 0, connected
  const reconnected = new Promise((resolve) => { connected = resolve })
  rpc.events.subscribe = (name, { signal }) => (async function* () {
    connections++
    if (connections === 1) throw new Error("RPC temporarily removed by reload")
    connected()
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
  })()
  ctx.client.rpc = () => rpc
  const cleanup = installPicker(ctx)
  try { await reconnected; assert.equal(connections, 2) } finally { cleanup() }
  await setImmediate()
  assert.equal(connections, 2)
})

test("fallback events toast only for the current session", async () => {
  for (const sessionID of ["s", "other"]) {
    const { ctx, state } = harness()
    state.warning = { sessionID, message: "using main model" }
    const cleanup = installPicker(ctx)
    await setImmediate()
    assert.equal(state.toasts.length, sessionID === "s" ? 1 : 0)
    cleanup()
  }
})
