import type { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core"

/** Reserve the host's top inset and a spare row on each edge of its centered
 *  dialog. Only the scroll viewport shrinks, never its content. */
export function createMemoryDialog(renderer: CliRenderer, theme: Plugin.Context["theme"], message: string): BoxRenderable {
  const root = new BoxRenderable(renderer, { id: "nextdcp-memory", width: "100%", flexDirection: "column",
    paddingLeft: 2, paddingRight: 2, paddingBottom: 1, overflow: "hidden", minHeight: 0 })
  const body: ScrollBoxRenderable = new ScrollBoxRenderable(renderer, { id: "nextdcp-memory-scroll", flexGrow: 1, flexBasis: 0,
    minHeight: 0, scrollX: false, scrollY: true, onKeyDown: (key) => {
      if (key.ctrl || key.meta || key.shift) return
      // Native proportional arrow steps can round to zero in a short viewport.
      const page = Math.max(1, body.viewport.height - 1)
      const step = key.name === "down" ? 1 : key.name === "up" ? -1 : key.name === "pagedown" ? page : key.name === "pageup" ? -page : 0
      if (!step) return
      key.preventDefault()
      body.scrollBy(step)
    } })
  root.add(new TextRenderable(renderer, { content: "Memory · read-only", fg: theme.text.base, height: 1, flexShrink: 0 }))
  body.add(new TextRenderable(renderer, { content: message, fg: theme.text.base, width: "100%", wrapMode: "word", flexShrink: 0 }))
  root.add(body)
  root.add(new TextRenderable(renderer, { content: "Esc close · ↑↓ scroll · PgUp/PgDn · Home/End · wheel", fg: theme.text.muted, height: 1, flexShrink: 0 }))
  const resize = () => { root.height = Math.max(1, renderer.height - 3) }
  resize()
  renderer.on("resize", resize)
  root.once("destroyed", () => renderer.off("resize", resize))
  body.focus()
  return root
}

export function showMemoryDialog(ctx: Plugin.Context, message: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { resolve(); return }
    let root: BoxRenderable | undefined, closed = false
    const dispose = () => { closed = true; signal.removeEventListener("abort", cancel); root?.destroyRecursively() }
    const close = () => { if (closed) return; dispose(); resolve() }
    const cancel = () => ctx.ui.dialog.clear()
    try {
      ctx.ui.dialog.show(() => closed || signal.aborted ? undefined : (root = createMemoryDialog(ctx.renderer, ctx.theme, message)), close)
      if (closed) return
      ctx.ui.dialog.set({ size: "large", centered: true })
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
    } catch (error) { dispose(); reject(error) }
  })
}
