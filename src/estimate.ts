import { mediaTokens, messageTokens, partTokens, tokens, type Message, type Part } from "./tokens.ts"
import { modelRef, object, positive } from "./guards.ts"
import type { Row } from "./memory.ts"
import { rowCalls } from "./store.ts"
import type { ProviderUsage } from "./memory-rpc.ts"

// Token estimation over host rows and hook messages. The budget gate, the idle
// trigger, and the deferral ceiling all meter against these counts, calibrated
// against provider-reported usage where the host supplies it.

export type ViewMessage = Message & { readonly id?: string; readonly role?: string }

/** Complete outgoing request projection, not the scheduling-growth meter. Hook
 *  messages already include checkpoint/tail, skills, shell and media. Definitions
 *  and system parts consume capacity too. This remains an estimate, not a tokenizer. */
export function requestParts(request: { readonly system: readonly Part[]; readonly messages: readonly Message[]; readonly tools: unknown }) {
  const system = request.system.reduce((sum, part) => sum + partTokens(part), 0), messages = messageTokens(request.messages)
  const tools = tokens(JSON.stringify(request.tools) ?? "")
  return { system, messages, tools, total: system + messages + tools }
}
export const requestTokens = (request: Parameters<typeof requestParts>[0]): number => requestParts(request).total

/** Conversation tokens sent after the checkpoint message; undefined when that message is not identifiable. */
export function growthAfter(messages: readonly ViewMessage[], checkpoint: string | null): number | undefined {
  const start = checkpoint === null ? 0 : messages.findIndex((message) => message.id === checkpoint) + 1
  if (start === 0 && checkpoint !== null) return undefined
  return messageTokens(messages.slice(start).filter((message) => message.role !== "system"))
}

/** Upper bound on the raw conversation a deferral may hold live, as a share of the window left after the output reserve. */
export const DEFER_WINDOW_SHARE = 1
export const REQUEST_MARGIN = 1_024

/** Estimated tokens of a user-row attachment: fixed media rates, decoded text size otherwise. */
function attachmentTokens(file: unknown): number {
  if (!object(file)) return 0
  const media = mediaTokens(file.mime)
  if (media) return media
  if (typeof file.data !== "string") return 0
  try { return tokens(new TextDecoder().decode(Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)))) }
  catch { return Math.ceil(file.data.length * 3 / 16) }
}

/** Estimated tokens of one assistant row: its text and reasoning parts plus
 *  its tool calls. */
function assistantTokens(row: Row): number {
  const text = (row.content ?? []).reduce<number>((n, part) => n + (object(part) && (part.type === "text" || part.type === "reasoning") ? partTokens(part as Part) : 0), 0)
  return text + rowCalls(row).reduce((n, call) => n + partTokens({ type: "tool-call", ...call } as Part) + partTokens({ type: "tool-result", ...call } as Part), 0)
}

/** Estimated tokens of one user row, including activated skills and attachments. */
function userTokens(row: Row): number {
  const data = row as Row & Record<string, unknown>
  const text = typeof data.text === "string" ? tokens(data.text) : 0
  const files = Array.isArray(data.files) ? data.files.reduce<number>((n, file) => n + attachmentTokens(file), 0) : 0
  const skills = Array.isArray(data.skills) ? data.skills.reduce<number>((n, skill) => n + (object(skill) && typeof skill.text === "string" ? tokens(skill.text) : 0), 0) : 0
  return text + files + skills
}

function otherTokens(row: Row): number {
  const data = row as Row & Record<string, unknown>
  if (["skill", "system", "synthetic"].includes(row.type)) return typeof data.text === "string" ? tokens(data.text) : 0
  if (row.type === "shell" && !(object(data.metadata) && data.metadata.background === true)) {
    return tokens(`${typeof data.command === "string" ? data.command : ""}\n${object(data.output) && typeof data.output.output === "string" ? data.output.output : ""}`)
  }
  return 0
}

/** Estimated tokens of the raw conversation a deferral would hold live,
 *  counting the same text and reasoning parts that responseTokens counts. */
export function conversationTokens(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => {
    if (row.type === "user") return sum + userTokens(row)
    return sum + (row.type === "assistant" ? assistantTokens(row) : otherTokens(row))
  }, 0)
}

/** The measurement window for the live growth rate: the most recent assistant
 *  turns whose durable tokens one backwards walk counts. */
export const RECENT_TURNS = 10

/** Durable tokens of the rows a compaction cut would archive: user rows plus
 *  assistant text, reasoning and tool calls. Reasoning counts because replaying
 *  hosts (GLM) carry it in every later request; usageScale absorbs hosts that
 *  strip it, so counting it never overshoots by much and never undercounts. */
export function durableTokens(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => {
    if (row.type === "user") return sum + userTokens(row)
    return sum + (row.type === "assistant" ? assistantTokens(row) : otherTokens(row))
  }, 0)
}

/** Returned evidence, not assistant production: successful tool results and
 *  foreground shell output. Arguments, errors, human answers and checkpoint
 *  acknowledgements still count toward routine growth. This is a mechanical
 *  split, not a claim that every successful result is necessary evidence. */
export function evidenceTokens(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => {
    if (row.type === "assistant") return sum + rowCalls(row).reduce((n, call) =>
      call.result.type === "error" || ["question", "checkpoint_now"].includes(call.name) ? n
        : n + partTokens({ type: "tool-result", ...call } as Part), 0)
    const data = row as Row & Record<string, unknown>
    return sum + (row.type === "shell" && !(object(data.metadata) && data.metadata.background === true) && object(data.output) && typeof data.output.output === "string"
      ? tokens(data.output.output) : 0)
  }, 0)
}

/** Conversation retained after the latest checkpoint: summary + native recent
 *  tail + NEW durable rows, reasoning included (replaying hosts carry it).
 *  System/tool-definition overhead and host wrappers belong to the separate
 *  complete-request meter. */
export function retainedTokens(rows: readonly Row[]): number {
  const index = rows.findLastIndex((row) => row.type === "compaction" && row.status === "completed")
  const checkpoint = rows[index] as (Row & { readonly metadata?: unknown }) | undefined
  const metadata = object(checkpoint?.metadata) ? checkpoint.metadata : {}
  const summary = typeof checkpoint?.summary === "string" ? tokens(checkpoint.summary) : 0
  const recent = typeof metadata.recent === "string" ? tokens(metadata.recent) : 0
  return summary + recent + durableTokens(rows.slice(index + 1))
}

/** Durable tokens over the most recent assistant turns and the user rows
 *  between them: the live transcript's current growth rate, measured rather
 *  than predicted. `turns` caps the walk; the result reports how many
 *  assistant rows actually fit. */
export function recentDurable(rows: readonly Row[], turns: number): { tokens: number; turns: number } {
  let counted = 0, sum = 0
  for (let at = rows.length - 1; at >= 0 && counted < turns; at--) {
    const row = rows[at]
    if (row.type === "assistant") { sum += assistantTokens(row); counted++ }
    else if (row.type === "user") sum += userTokens(row)
    else sum += otherTokens(row)
  }
  return { tokens: sum, turns: counted }
}

/** Provider-reported billed tokens of a completed request: input plus cache traffic,
 *  read tolerantly across row shapes. Summing the cache fields is exact on the observed
 *  hosts and stays conservative if a provider folds them into input. */
function billedTokens(row: Row): number {
  const data = row as Row & { readonly tokens?: unknown }
  if (!object(data.tokens)) return 0
  const usage = data.tokens, cache = object(usage.cache) ? usage.cache : {}
  return positive(usage.input, 0) + positive(usage.cacheRead ?? cache.read, 0) + positive(usage.cacheWrite ?? cache.write, 0)
}

/** Raw counters from the last usage-bearing assistant row, never a calibrated estimate. */
export function latestProviderUsage(rows: readonly Row[]): ProviderUsage | undefined {
  for (let at = rows.length - 1; at >= 0; at--) {
    const row = rows[at], data = row as Row & { readonly tokens?: unknown }
    if (row.type !== "assistant" || !object(data.tokens)) continue
    const usage = data.tokens, cache = object(usage.cache) ? usage.cache : {}
    const result = { messageID: row.id, input: positive(usage.input, 0), output: positive(usage.output, 0),
      reasoning: positive(usage.reasoning, 0), cacheRead: positive(usage.cacheRead ?? cache.read, 0), cacheWrite: positive(usage.cacheWrite ?? cache.write, 0) }
    if (result.input + result.output + result.reasoning + result.cacheRead + result.cacheWrite > 0) return result
  }
  return undefined
}

/** Billed-token correction for estimates that face model window limits: the median ratio
 *  of provider-reported input growth to the estimator's count of the rows in between,
 *  over the last few completed requests of the rows' own model. Native chars/4 units
 *  (scale 1) apply until a usable pair of usage-bearing rows exists. */
export function usageScale(rows: readonly Row[]): number {
  const samples: number[] = []
  let later: { at: number; billed: number; model: string } | undefined
  const key = (row: Row) => {
    const model = modelRef((row as Row & { readonly model?: unknown }).model)
    return model ? `${model.providerID}/${model.id}` : ""
  }
  for (let at = rows.length - 1; at >= 0 && samples.length < 3; at--) {
    const row = rows[at]
    if (row.type !== "assistant") continue
    const billed = billedTokens(row)
    if (billed <= 0) continue
    if (later) {
      // The earlier row's own output lands in the later request; a span holding a
      // checkpoint or a model change cannot attribute billed growth to its rows.
      const span = rows.slice(at, later.at), growth = later.billed - billed
      const estimate = conversationTokens(span)
      const usable = growth > 0 && estimate >= 256 && key(row) === later.model &&
        !span.some((entry) => entry.type === "compaction" || entry.type === "model-switched")
      const ratio = growth / estimate
      if (usable && ratio >= 0.5 && ratio <= 2.5) samples.push(ratio)
    }
    later = { at, billed, model: key(row) }
  }
  if (!samples.length) return 1
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Only newly generated assistant rows, not a second projection of the history. */
export function responseTokens(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => sum + (row.type === "assistant" ? assistantTokens(row) : 0), 0)
}
