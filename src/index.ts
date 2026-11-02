import { Plugin } from "@opencode/plugin"
import { install } from "./runtime.ts"

function retryDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, 250)
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
  })
}

export async function setup(ctx: Plugin.Context) {
  const controller = await install(ctx), abort = new AbortController()
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        const events = ctx.event.subscribe({
          types: ["session.execution.succeeded", "session.compaction.ended", "session.compaction.failed", "session.deleted", "session.forked"],
          signal: abort.signal,
        })
        for await (const event of events) {
          if (event.type === "session.execution.succeeded") await controller.onIdle(event.data.sessionID)
          else if (event.type === "session.deleted") await controller.onDeleted(event.data.sessionID)
          else if (event.type === "session.forked") await controller.onFork(event.data.sessionID)
          else controller.onCompactionFinished(event.data.sessionID, event.type === "session.compaction.failed")
        }
      } catch (error) {
        if (!abort.signal.aborted && ctx.options.debug === true) console.warn("[nextdcp] event subscription", error)
      }
      if (!abort.signal.aborted) await retryDelay(abort.signal)
    }
  })()
  return () => abort.abort()
}

export default Plugin.define({ id: "nextdcp", setup })
