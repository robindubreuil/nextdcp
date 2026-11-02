import type { Plugin } from "@opencode/plugin/tui"
import { modelLabel, modelRpc, type ModelPreference, type ModelState } from "./model-rpc.ts"

export function installPicker(ctx: Plugin.Context) {
  const rpc = ctx.client.rpc(modelRpc)
  let open = false
  let disposed = false
  const abort = new AbortController()
  // Slash autocomplete and the command palette use non-base input modes.
  ctx.keymap.layer(() => ({ mode: "global", commands: [{
    id: "nextdcp.compact-model", title: "Select compaction model", group: "Session", palette: true, slash: { name: "compact-model" },
    enabled: ctx.ui.router.current().type === "session",
    run: async () => {
      const route = ctx.ui.router.current()
      if (disposed || open || route.type !== "session") return
      open = true
      const sessionID = route.sessionID
      try {
        const state = await rpc.get({ sessionID }, { signal: abort.signal }) as ModelState
        if (disposed) return
        if (state.warning) ctx.ui.toast.show({ title: "Last compaction fallback", message: state.warning, variant: "warning", duration: 10_000 })
        const follow = state.main ? modelLabel(state.main) : "current main model"
        const options: { value: ModelPreference; title: string; description: string; category: string }[] = [
          { value: { mode: "default" }, title: "Use configured default", description: state.configured ? modelLabel(state.configured) : `Follow ${follow}`, category: "Policy" },
          { value: { mode: "main" }, title: "Follow main model", description: `Follow ${follow}, including future changes`, category: "Policy" },
          ...state.choices.map((choice) => ({ value: { mode: "specific", model: choice.model } as ModelPreference,
            title: modelLabel(choice.model), description: `${choice.name} · ${choice.context > 0 ? `${Math.round(choice.context / 1_000)}k context` : "unknown context"}`, category: choice.model.providerID })),
        ]
        const key = (value: ModelPreference) => value.mode === "specific" ? modelLabel(value.model) : value.mode
        if (state.preference.mode === "specific" && !options.some((option) => key(option.value) === key(state.preference))) {
          options.unshift({ value: state.preference, title: `${key(state.preference)} (unavailable)`, description: "Saved selection; choose another model or policy", category: "Current" })
        }
        const current = options.find((option) => key(option.value) === key(state.preference))?.value
        const selected = await ctx.ui.dialog.select({ title: "Compaction model · this session", placeholder: "Search models or policies…", options,
          ...(current ? { current } : {}) })
        if (!selected || disposed) return
        await rpc.set({ sessionID, preference: selected }, { signal: abort.signal })
        if (disposed) return
        ctx.ui.toast.show({ title: "Compaction model saved", message: `${key(selected)} · next compaction · main model unchanged`, variant: "success" })
      } catch {
        if (disposed) return
        ctx.ui.toast.show({ title: "Compaction model", message: "Could not load or save the selection. Check that nextdcp is active and try again.", variant: "error" })
      } finally { open = false }
    },
  }] }))

  let retry: ReturnType<typeof setTimeout> | undefined
  let resume: (() => void) | undefined
  void (async () => {
    while (!abort.signal.aborted) {
      try {
        for await (const event of rpc.events.subscribe("warning", { signal: abort.signal })) {
          const route = ctx.ui.router.current()
          if (route.type === "session" && route.sessionID === event.data.sessionID) {
            ctx.ui.toast.show({ title: "Compaction fallback", message: String(event.data.message), variant: "warning", duration: 10_000 })
          }
        }
      } catch { /* Reloads can briefly remove the RPC. Reconnect without losing the command. */ }
      if (!abort.signal.aborted) await new Promise<void>((resolve) => {
        resume = resolve
        retry = setTimeout(resolve, 1_000)
      })
    }
  })()
  return () => { disposed = true; abort.abort(); clearTimeout(retry); resume?.() }
}
