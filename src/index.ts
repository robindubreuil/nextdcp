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
  let recovery: Promise<void> | undefined
  const recover = () => {
    if (recovery) return
    const work = (async () => {
      let backoff = 250
      while (!abort.signal.aborted) {
        try { await controller.recoverDeleted(); return }
        catch (error) { if (!abort.signal.aborted) console.warn("[nextdcp] deletion recovery", error) }
        if (!abort.signal.aborted) await retryDelay(abort.signal, backoff)
        backoff = Math.min(backoff * 2, 5_000)
      }
    })()
    recovery = work
    void work.then(() => { if (recovery === work) recovery = undefined })
  }
  const subscription = (async () => {
    // Capped exponential backoff: a transient host failure gets a prompt retry, but a
    // persistently broken RPC must not spin the loop at a fixed pace.
    let backoff = 250
    while (!abort.signal.aborted) {
      // Recovery must not delay the event stream: one stuck cleanup cannot hide
      // later deletion events. Failures retry independently with bounded backoff.
      recover()
      try {
        const events = ctx.event.subscribe({
          types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.compaction.ended", "session.compaction.failed", "session.deleted"],
          signal: abort.signal,
        })
        for await (const event of events) {
          if (abort.signal.aborted) break
          backoff = 250 // A delivered event proves the subscription healthy again.
          const accepted = await controller.acceptsEvent(event.data.sessionID, event.location)
          if (abort.signal.aborted) break // Ownership lookup may have outlived cleanup.
          if (!accepted) continue
          if (event.type === "session.execution.succeeded") await controller.onIdle(event.data.sessionID)
          else if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") await controller.onRoundEnded(event.data.sessionID)
          else if (event.type === "session.deleted") await controller.onDeleted(event.data.sessionID)
          else await controller.onCompactionFinished(event.data.sessionID, event.type === "session.compaction.failed")
        }
      } catch (error) {
        if (!abort.signal.aborted) console.warn("[nextdcp] event subscription", error)
      }
      if (!abort.signal.aborted) await retryDelay(abort.signal, backoff)
      backoff = Math.min(backoff * 2, 5_000)
    }
  })()
  return async () => {
    abort.abort()
    await controller.dispose()
    await subscription
    await recovery
  }
}

export default Plugin.define({ id: "nextdcp", setup })
