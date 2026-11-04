import { Plugin } from "@opencode/plugin"
import { install } from "./runtime.ts"

function retryDelay(signal: AbortSignal, delay: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, delay)
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
  })
}

export async function setup(ctx: Plugin.Context) {
  const controller = await install(ctx), abort = new AbortController()
  void (async () => {
    // Capped exponential backoff: a transient host failure gets a prompt retry, but a
    // persistently broken RPC must not spin the loop at a fixed pace.
    let backoff = 250
    while (!abort.signal.aborted) {
      try {
        const events = ctx.event.subscribe({
          types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.compaction.failed", "session.deleted", "session.forked"],
          signal: abort.signal,
        })
        for await (const event of events) {
          backoff = 250 // A delivered event proves the subscription healthy again.
          if (event.type === "session.execution.succeeded") await controller.onIdle(event.data.sessionID)
          else if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") controller.onRoundEnded(event.data.sessionID)
          else if (event.type === "session.deleted") await controller.onDeleted(event.data.sessionID)
          else if (event.type === "session.forked") await controller.onFork(event.data.sessionID)
          else controller.onCompactionFinished(event.data.sessionID, event.type === "session.compaction.failed")
        }
      } catch (error) {
        if (!abort.signal.aborted && ctx.options.debug === true) console.warn("[nextdcp] event subscription", error)
      }
      if (!abort.signal.aborted) await retryDelay(abort.signal, backoff)
      backoff = Math.min(backoff * 2, 5_000)
    }
  })()
  return () => abort.abort()
}

export default Plugin.define({ id: "nextdcp", setup })
