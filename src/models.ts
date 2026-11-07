import type { Plugin } from "@opencode/plugin"
import { tokens } from "./tokens.ts"
import { modelRpc, modelLabel, type ModelPreference, type ModelRef, type ModelState } from "./model-rpc.ts"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
type ModelInfo = Awaited<ReturnType<Plugin.Context["model"]["list"]>>["data"][number]
type HostRef = NonNullable<Parameters<Plugin.Context["experimental"]["generate"]["text"]>[0]["model"]>
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const ref = (value: unknown): value is ModelRef => object(value) && typeof value.providerID === "string" && !!value.providerID &&
  typeof value.id === "string" && !!value.id && Object.keys(value).every((key) => ["providerID", "id", "variant"].includes(key)) &&
  (value.variant === undefined || typeof value.variant === "string" && !!value.variant)
export function validPreference(value: unknown): value is ModelPreference {
  return object(value) && (value.mode === "main" || value.mode === "default" ? Object.keys(value).length === 1 :
    value.mode === "specific" && Object.keys(value).length === 2 && ref(value.model))
}
const usable = (model: ModelInfo) => model.enabled !== false && model.capabilities.input.includes("text") && model.capabilities.output.includes("text")
const matching = (models: readonly ModelInfo[], selected: ModelRef) => models.find((model) =>
  usable(model) && model.providerID === selected.providerID && model.id === selected.id &&
  (!selected.variant || model.variants.some((variant) => variant.id === selected.variant)))
const root = (id: string) => `sessions/${encodeURIComponent(id)}/model`

// Unknown windows are deliberately not assumed safe for cross-model generation.
export function assertFits(model: Pick<ModelInfo, "limit">, prompt: string) {
  const { context, input, output } = model.limit
  const reserve = output > 0 ? output : 8_192
  const available = Math.min(context > 0 ? context - reserve : 0, input && input > 0 ? input : Infinity)
  const estimate = Math.ceil(tokens(prompt) * 1.2) + 1_024
  if (estimate > available) throw new Error(`transcript needs about ${estimate} input tokens including safety margin; safe capacity is ${Math.max(0, available)}`)
}

export function createModels(ctx: Plugin.Context) {
  let emit: ((sessionID: SessionID, message: string) => Promise<void>) | undefined
  const warning = async (sessionID: SessionID, message: string) => {
    console.warn(`[nextdcp] ${message}`)
    try { await ctx.storage.set(`${root(sessionID)}/warning`, message) } catch { /* The warning must not prevent fallback. */ }
    try { await emit?.(sessionID, message) } catch { /* Clients may be disconnected. */ }
  }
  const preference = async (id: SessionID): Promise<ModelPreference> => {
    const stored = await ctx.storage.get(root(id))
    if (stored === undefined) return { mode: "default" }
    if (!validPreference(stored)) throw new Error("Invalid stored compaction-model preference")
    return stored
  }
  const configured = async (): Promise<ModelRef | undefined> => {
    const { data } = await ctx.agent.get({ agentID: "compaction" as Parameters<typeof ctx.agent.get>[0]["agentID"] })
    return data.model
  }
  const main = async (sessionID: SessionID) => (await ctx.session.get({ sessionID })).model
  const choices = async () => {
    try { return (await ctx.model.list()).data.filter(usable) } catch { throw new Error("Text-model catalog is unavailable") }
  }
  const snapshot = async (sessionID: SessionID): Promise<ModelState> => {
    const [selected, defaultModel, mainModel, models, lastWarning] = await Promise.all([
      preference(sessionID), configured(), main(sessionID), choices(), ctx.storage.get(`${root(sessionID)}/warning`),
    ])
    return {
      preference: selected, ...(defaultModel ? { configured: defaultModel } : {}), ...(mainModel ? { main: mainModel } : {}),
      ...(typeof lastWarning === "string" ? { warning: lastWarning } : {}),
      choices: models.flatMap((model) => [undefined, ...model.variants.map((variant) => variant.id)].map((variant) => ({
        model: { providerID: model.providerID, id: model.id, ...(variant ? { variant } : {}) },
        name: model.name, context: model.limit.context,
      }))),
    }
  }
  const register = async () => {
    const registration = await ctx.rpc.register(modelRpc, {
      get: async (input) => snapshot((input as { sessionID: SessionID }).sessionID),
      set: async (input, call) => {
        const { sessionID, preference: selected } = input as { sessionID: SessionID; preference: ModelPreference }
        await ctx.session.get({ sessionID }) // Check existence and Location before writing anything.
        if (!validPreference(selected)) return call.error("invalid_selection", "Invalid compaction-model selection", null)
        if (selected.mode === "specific" && !matching(await choices(), selected.model)) {
          return call.error("invalid_selection", "That text model or variant is unavailable; selection was not changed", null)
        }
        await ctx.storage.set(root(sessionID), selected)
        await ctx.storage.remove(`${root(sessionID)}/warning`).catch(() => undefined)
        return { preference: selected }
      },
    })
    emit = (sessionID, message) => registration.events.emit("warning", { sessionID, message })
  }
  return {
    register,
    // Snapshot once per compaction: changes during a request apply to the next one.
    async select(sessionID: SessionID): Promise<ModelRef | undefined> {
      const selected = await preference(sessionID)
      return selected.mode === "specific" ? selected.model : selected.mode === "default" ? configured() : undefined
    },
    main,
    warning,
    async generate(selected: ModelRef, prompt: string) {
      const model = matching(await choices(), selected)
      if (!model) throw new Error(`${modelLabel(selected)} is unavailable`)
      assertFits(model, prompt)
      // Feature-detect the single experimental surface this plugin consumes; a V2.3
      // shape change must degrade to the main-model fallback, not a deep TypeError.
      const generate = ctx.experimental?.generate
      if (typeof generate?.text !== "function") throw new Error(`${modelLabel(selected)} cannot run stateless generation in this OpenCode build`)
      let result: Awaited<ReturnType<typeof ctx.experimental.generate.text>>
      try { result = await generate.text({ model: selected as HostRef, prompt }) } catch {
        // Provider errors can contain prompts or credentials. Do not send them to clients.
        throw new Error(`${modelLabel(selected)} request failed`)
      }
      if (!result.text?.trim()) throw new Error(`${modelLabel(selected)} returned an empty summary`)
      return result.text
    },
  }
}
