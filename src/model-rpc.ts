export type ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }
export type ModelPreference = { readonly mode: "default" | "main" } | { readonly mode: "specific"; readonly model: ModelRef }
export type ModelChoice = { readonly model: ModelRef; readonly name: string; readonly context: number }
export type ModelState = {
  readonly preference: ModelPreference
  readonly configured?: ModelRef
  readonly main?: ModelRef
  readonly choices: readonly ModelChoice[]
  readonly warning?: string
}

const ref = {
  type: "object", additionalProperties: false, required: ["providerID", "id"],
  properties: { providerID: { type: "string", minLength: 1 }, id: { type: "string", minLength: 1 }, variant: { type: "string", minLength: 1 } },
} as const
const preference = { oneOf: [
  { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { enum: ["default", "main"] } } },
  { type: "object", additionalProperties: false, required: ["mode", "model"], properties: { mode: { const: "specific" }, model: ref } },
] } as const
const session = { type: "string", minLength: 1 } as const
const state = {
  type: "object", additionalProperties: false, required: ["preference", "choices"], properties: {
    preference, configured: ref, main: ref, warning: { type: "string" },
    choices: { type: "array", items: { type: "object", additionalProperties: false, required: ["model", "name", "context"],
      properties: { model: ref, name: { type: "string" }, context: { type: "number" } } } },
  },
} as const

// Portable JSON Schema keeps the TUI bundle independent of the server SDK.
export const modelRpc = {
  id: "nextdcp.model",
  methods: {
    get: { input: { type: "object", additionalProperties: false, required: ["sessionID"], properties: { sessionID: session } }, output: state },
    set: { input: { type: "object", additionalProperties: false, required: ["sessionID", "preference"], properties: { sessionID: session, preference } },
      output: { type: "object", additionalProperties: false, required: ["preference"], properties: { preference } },
      errors: { invalid_selection: { type: "null" } } },
  },
  events: { warning: { schema: { type: "object", additionalProperties: false, required: ["sessionID", "message"],
    properties: { sessionID: session, message: { type: "string" } } } } },
} as const

export const modelLabel = (model: ModelRef) => `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
