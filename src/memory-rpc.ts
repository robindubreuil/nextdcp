export type MemoryDecision = { readonly at?: number; readonly action: string; readonly reason: string; readonly id?: string }
export type MemoryRequest = {
  readonly at: number
  readonly checkpoint: string | null
  readonly model: string
  readonly scale: number
  readonly messages: number
  readonly system: number
  readonly tools: number
  readonly total: number
  readonly outputReserve: number
  readonly margin: number
  readonly window?: number
  readonly inputLimit?: number
  readonly ceiling?: number
}
export type ProviderUsage = {
  readonly messageID: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}
export type BudgetScope = "retained" | "growth"
export type MemoryStatus = {
  readonly sessionID: string
  readonly at: number
  readonly checkpoint?: { readonly id: string; readonly episode?: string; readonly native: boolean; readonly author?: "main" | "compactor" }
  readonly summary: { readonly chars: number; readonly tokens: number }
  readonly recent: { readonly chars: number; readonly tokens: number }
  readonly growth: { readonly rows: number; readonly tokens: number }
  readonly retained: number
  readonly scale: number
  readonly budgetMode: "auto" | "explicit" | "disabled" | "unknown"
  readonly budgetScope: BudgetScope
  readonly budget?: number
  readonly budgetBaseline?: number
  readonly liveAllowance?: number
  readonly budgetBounds?: { readonly floor: number; readonly start: number; readonly ceiling: number }
  readonly compaction: "running" | "pending" | "idle"
  readonly request?: MemoryRequest
  readonly usage?: ProviderUsage
  readonly decision?: MemoryDecision
  readonly lastCut?: MemoryDecision
}

const count = { type: "number", minimum: 0 } as const
const text = { type: "string", minLength: 1 } as const
const size = { type: "object", additionalProperties: false, required: ["chars", "tokens"], properties: { chars: count, tokens: count } } as const
const decision = { type: "object", additionalProperties: false, required: ["action", "reason"],
  properties: { at: count, action: text, reason: text, id: text } } as const

// Portable, read-only RPC: no tool registration, prompt injection, or model request.
export const memoryRpc = {
  id: "nextdcp.memory",
  methods: {
    get: {
      input: { type: "object", additionalProperties: false, required: ["sessionID"], properties: { sessionID: text } },
      output: {
        type: "object", additionalProperties: false,
        required: ["sessionID", "at", "summary", "recent", "growth", "retained", "scale", "budgetMode", "budgetScope", "compaction"],
        properties: {
          sessionID: text, at: count, summary: size, recent: size, retained: count, scale: count, budget: count, budgetBaseline: count, liveAllowance: count,
          budgetMode: { enum: ["auto", "explicit", "disabled", "unknown"] }, compaction: { enum: ["running", "pending", "idle"] },
          budgetScope: { enum: ["retained", "growth"] },
          budgetBounds: { type: "object", additionalProperties: false, required: ["floor", "start", "ceiling"], properties: { floor: count, start: count, ceiling: count } },
          checkpoint: { type: "object", additionalProperties: false, required: ["id", "native"], properties: { id: text, episode: text, native: { type: "boolean" }, author: { enum: ["main", "compactor"] } } },
          growth: { type: "object", additionalProperties: false, required: ["rows", "tokens"], properties: { rows: count, tokens: count } },
          request: {
            type: "object", additionalProperties: false,
            required: ["at", "checkpoint", "model", "scale", "messages", "system", "tools", "total", "outputReserve", "margin"],
            properties: { at: count, checkpoint: { type: ["string", "null"] }, model: text, scale: count,
              messages: count, system: count, tools: count, total: count, outputReserve: count, margin: count,
              window: count, inputLimit: count, ceiling: count },
          },
          usage: { type: "object", additionalProperties: false, required: ["messageID", "input", "cacheRead", "cacheWrite", "output", "reasoning"],
            properties: { messageID: text, input: count, cacheRead: count, cacheWrite: count, output: count, reasoning: count } },
          decision, lastCut: decision,
        },
      },
    },
  },
  events: {},
} as const
