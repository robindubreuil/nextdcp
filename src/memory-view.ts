import type { Plugin } from "@opencode/plugin/tui"
import timers from "node:timers/promises"
import { memoryRpc, type MemoryDecision, type MemoryStatus } from "./memory-rpc.ts"
import { showMemoryDialog } from "./memory-dialog.ts"

const number = (value: number) => Math.round(value).toLocaleString("en-US")
const stamp = (at: number) => new Date(at).toISOString()
const decision = (value: MemoryDecision | undefined) => value
  ? `${value.action} — ${value.reason}${value.id ? ` (${value.id})` : ""}${value.at === undefined ? "" : ` · ${stamp(value.at)}`}` : "unavailable since plugin load"

export function formatMemoryStatus(state: MemoryStatus): string {
  const request = state.request, usage = state.usage
  // An older server may answer briefly during a plugin hot reload. Its automatic
  // budget was growth-based: never relabel that old value as a retained safeguard.
  const retained = state.retained ?? state.summary.tokens + state.recent.tokens + state.growth.tokens
  const scope = state.budgetScope ?? "growth", bounds = state.budgetBounds
  return [
    `Checkpoint: ${state.checkpoint ? `${state.checkpoint.episode ? `${state.checkpoint.episode} · ` : ""}${state.checkpoint.id}${state.checkpoint.author ? ` · ${state.checkpoint.author}-authored` : ""}` : "none"} · compaction ${state.compaction}`,
    "",
    `Current retained rows · estimates, scale ×${state.scale.toFixed(2)}`,
    `${state.checkpoint?.native ? "Native" : "Working"} summary: ~${number(state.summary.tokens)} tokens · ${number(state.summary.chars)} chars`,
    `Native recent tail: ~${number(state.recent.tokens)} tokens · ${number(state.recent.chars)} chars`,
    `New durable growth: ~${number(state.growth.tokens)} tokens · ${number(state.growth.rows)} rows (reasoning included)`,
    `Retained conversation total: ~${number(retained)} tokens (summary + native tail + new growth)`,
    `${scope === "retained" ? "Overdue-checkpoint safeguard" : "Soft budget"}: ${state.budget === undefined ? state.budgetMode : `~${number(state.budget)} tokens (${state.budgetMode} · ${scope === "retained" ? "total retained conversation" : "new durable growth only"})`}`,
    ...(state.budgetBaseline === undefined ? [] : [`Adaptive baseline: ~${number(state.budgetBaseline)} · temporary evidence/work allowance: ~${number(state.liveAllowance ?? 0)}`]),
    ...(state.liveAllowance ? ["Each result's allowance ages independently and ends at a successful turn end; capacity always wins."] : []),
    ...(bounds ? [`Baseline bounds: ${number(bounds.floor)}–${number(bounds.ceiling)} · starts at ${number(bounds.start)} · at most +50% / −20% per completed cycle`] : []),
    "",
    ...(request ? [
      `Last context build · estimates · ${stamp(request.at)}`,
      `Model: ${request.model} · scale ×${request.scale.toFixed(2)}`,
      ...(request.checkpoint !== (state.checkpoint?.id ?? null) ? ["This projection predates the current checkpoint; it is not the current request."] : []),
      `Messages: ~${number(request.messages)} · system: ~${number(request.system)} · tool definitions: ~${number(request.tools)}`,
      `Projected input: ~${number(request.total)}${request.ceiling === undefined ? " · safe input ceiling unknown" : ` / ${number(request.ceiling)} safe input tokens`}`,
      `Output reserve: ${number(request.outputReserve)} · safety margin: ${number(request.margin)}${request.window === undefined ? "" : ` · window: ${number(request.window)}`}${request.inputLimit === undefined ? "" : ` · input limit: ${number(request.inputLimit)}`}`,
      "Messages include summary/tail, wrappers, reasoning and injected content; do not add the row estimates again.",
    ] : ["Last context build: unavailable since plugin load. System/tool overhead and output reserve are not yet observed."]),
    "",
    ...(usage ? [
      `Provider-reported usage · last recorded request (${usage.messageID})`,
      `Input: ${number(usage.input)} · cache read: ${number(usage.cacheRead)} · cache write: ${number(usage.cacheWrite)}`,
      `Output: ${number(usage.output)} · reasoning: ${number(usage.reasoning)} (provider accounting; not a new estimate)`,
    ] : ["Provider-reported usage: unavailable."]),
    "",
    `Last decision: ${decision(state.decision)}`,
    `Last cut: ${decision(state.lastCut)}`,
    "Read-only snapshot. No model request, compaction, or conversation change.",
  ].join("\n")
}

/** A cold Location boots its plugins asynchronously. Retry only the host's
 *  explicit unavailable response, not broken handlers or transport failures. */
export async function readMemoryStatus(ctx: Plugin.Context, sessionID: string, signal: AbortSignal): Promise<MemoryStatus> {
  const location = ctx.data.session.get(sessionID)?.location ?? ctx.location ?? ctx.data.location.default()
  for (let attempt = 0;; attempt++) {
    try { return await ctx.client.rpc(memoryRpc).get({ sessionID }, { location, signal }) as MemoryStatus }
    catch (error) {
      if (signal.aborted || attempt >= 5 || typeof error !== "object" || error === null || !("type" in error) || error.type !== "rpc.unavailable") throw error
      await timers.setTimeout(100 * 2 ** attempt, undefined, { signal })
    }
  }
}

export function installMemoryView(ctx: Plugin.Context, show: typeof showMemoryDialog = showMemoryDialog) {
  const abort = new AbortController()
  let open = false, disposed = false
  ctx.keymap.layer(() => ({ mode: "global", commands: [{
    id: "nextdcp.memory", title: "Show memory status", group: "Session", palette: true, slash: { name: "memory" },
    enabled: () => ctx.ui.router.current().type === "session",
    run: async () => {
      const route = ctx.ui.router.current()
      if (disposed || open || route.type !== "session") return
      open = true
      try {
        const status = await readMemoryStatus(ctx, route.sessionID, abort.signal)
        const current = ctx.ui.router.current()
        if (disposed || current.type !== "session" || current.sessionID !== route.sessionID) return
        await show(ctx, formatMemoryStatus(status), abort.signal)
      } catch {
        const current = ctx.ui.router.current()
        if (!disposed && current.type === "session" && current.sessionID === route.sessionID)
          ctx.ui.toast.show({ title: "Memory", message: "Memory status is unavailable. The plugin may still be loading or inactive.", variant: "error" })
      } finally { open = false }
    },
  }] }))
  return () => { disposed = true; abort.abort() }
}
