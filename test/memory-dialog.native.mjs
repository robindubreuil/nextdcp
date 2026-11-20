import assert from "node:assert/strict"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer, KeyCodes } from "@opentui/core/testing"
import { createMemoryDialog, showMemoryDialog } from "../src/memory-dialog.ts"

const theme = { text: { base: "#ffffff", muted: "#888888" } }
const message = ["FIRST_MEMORY_ROW", ...Array.from({ length: 60 }, (_, i) => `Detail ${i}: ${"long wrapped context ".repeat(4)}`), "LAST_MEMORY_ROW"].join("\n")

for (const [width, height] of [[100, 24], [60, 12], [32, 8]]) {
  const setup = await createTestRenderer({ width, height })
  try {
    // Same public geometry as the host's large, centered dialog, including its top inset.
    const host = new BoxRenderable(setup.renderer, { width: Math.min(88, width - 2), paddingTop: 1, top: 1, left: 1, position: "absolute" })
    setup.renderer.root.add(host)
    const listeners = setup.renderer.listenerCount("resize")
    const root = createMemoryDialog(setup.renderer, theme, message)
    host.add(root)
    const body = root.getChildren().find((node) => node.id === "nextdcp-memory-scroll")
    await setup.renderOnce()
    const first = setup.captureCharFrame()
    assert.match(first, /Memory · read-only/)
    assert.match(first, /Esc close/)
    assert.match(first, /FIRST_MEMORY_ROW/)
    assert.doesNotMatch(first, /LAST_MEMORY_ROW/)
    assert.ok(root.y + root.height <= height, `${width}x${height}: body must fit`)
    assert.ok(body.viewport.height > 0)
    assert.equal(setup.renderer.currentFocusedRenderable, body)

    setup.mockInput.pressKey(KeyCodes.END)
    await setup.renderOnce()
    assert.match(setup.captureCharFrame(), /LAST_MEMORY_ROW/, `${width}x${height}: keyboard reaches the last line`)
    assert.ok(body.scrollTop > 0)
    setup.mockInput.pressKey(KeyCodes.HOME)
    await setup.renderOnce()
    assert.equal(body.scrollTop, 0)
    setup.mockInput.pressKey(KeyCodes.ARROW_DOWN)
    await setup.renderOnce()
    assert.equal(body.scrollTop, 1, `${width}x${height}: arrow navigation scrolls even a tiny viewport`)
    setup.mockInput.pressKey(KeyCodes.ARROW_UP)
    await setup.renderOnce()
    assert.equal(body.scrollTop, 0)
    setup.mockInput.pressKey(KeyCodes.HOME)
    await setup.renderOnce()
    setup.mockInput.pressKey("\u001b[6~")
    await setup.renderOnce()
    assert.ok(body.scrollTop > 0, `${width}x${height}: PageDown scrolls the ${body.viewport.height}-row viewport`)
    const page = body.scrollTop
    setup.mockInput.pressKey("\u001b[5~")
    await setup.renderOnce()
    assert.ok(body.scrollTop < page, "PageUp scrolls back toward the start")
    setup.mockInput.pressKey(KeyCodes.HOME)
    await setup.renderOnce()
    await setup.mockMouse.scroll(body.x + 1, body.y, "down")
    await setup.renderOnce()
    assert.ok(body.scrollTop > 0, "mouse wheel must scroll the viewport")

    setup.resize(Math.min(width, 45), 10)
    await setup.renderOnce()
    assert.ok(root.height <= 7, "terminal resize updates the bounded body")
    root.destroyRecursively()
    assert.equal(setup.renderer.listenerCount("resize"), listeners, "closing releases the resize listener")
  } finally { setup.renderer.destroy() }
}

// Replacing a dialog and plugin unload both release native resources; unload must
// not clear an unrelated dialog that replaced ours.
const setup = await createTestRenderer({ width: 60, height: 12 })
try {
  const state = { clears: 0 }, abort = new AbortController()
  const ctx = { renderer: setup.renderer, theme, ui: { dialog: {
    show: (render, close) => { state.close = close; state.root = render(); setup.renderer.root.add(state.root) },
    set: (options) => { assert.deepEqual(options, { size: "large", centered: true }) },
    clear: () => { state.clears++; state.close() },
  } } }
  const first = showMemoryDialog(ctx, message, abort.signal)
  state.close()
  await first
  assert.equal(state.root.isDestroyed, true)
  abort.abort()
  assert.equal(state.clears, 0)
  const next = new AbortController(), second = showMemoryDialog(ctx, message, next.signal)
  next.abort()
  await second
  assert.equal(state.clears, 1)
  assert.equal(state.root.isDestroyed, true)
  // A deferred host render after dismissal must not recreate native resources.
  let render, close
  ctx.ui.dialog.show = (view, done) => { render = view; close = done }
  const pending = showMemoryDialog(ctx, message, new AbortController().signal)
  close()
  await pending
  assert.equal(render(), undefined)
  // Setup errors also release a constructed tree and its resize subscription.
  ctx.ui.dialog.show = (view) => { state.root = view(); throw new Error("host setup failure") }
  const listeners = setup.renderer.listenerCount("resize")
  await assert.rejects(showMemoryDialog(ctx, message, new AbortController().signal), /host setup failure/)
  assert.equal(state.root.isDestroyed, true)
  assert.equal(setup.renderer.listenerCount("resize"), listeners)
} finally { setup.renderer.destroy() }

console.log("Native memory viewer: short/narrow terminals, keyboard/wheel scrolling, resizing and cleanup pass.")
