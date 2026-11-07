import { mediaTokens, messageTokens, partTokens, tokens, type Message, type Part } from "./tokens.ts"
import { modelRef, object, positive } from "./guards.ts"
import type { Row } from "./memory.ts"
import { rowCalls } from "./store.ts"

// Token estimation over host rows and hook messages. The budget gate, the idle
// trigger, and the deferral ceiling all meter against these counts, calibrated
// against provider-reported usage where the host supplies it.

export type ViewMessage = Message & { readonly id?: string; readonly role?: string }

/** Conversation tokens sent after the checkpoint message; undefined when that message is not identifiable. */
export function growthAfter(messages: readonly ViewMessage[], checkpoint: string | null): number | undefined {
  const start = checkpoint === null ? 0 : messages.findIndex((message) => message.id === checkpoint) + 1
  if (start === 0 && checkpoint !== null) return undefined
  return messageTokens(messages.slice(start).filter((message) => message.role !== "system"))
}

/** Upper bound on the raw conversation a deferral may hold live, as a share of the window left after the output reserve. */
export const DEFER_WINDOW_SHARE = 0.8

/** Estimated tokens of a user-row attachment: fixed media rates, decoded text size otherwise. */
function attachmentTokens(file: unknown): number {
  if (!object(file)) return 0
  const media = mediaTokens(file.mime)
  if (media) return media
  if (typeof file.data !== "string") return 0
  try { return tokens(new TextDecoder().decode(Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0)))) }
  catch { return Math.ceil(file.data.length * 3 / 16) }
}

/** Estimated tokens of one assistant row: its text and reasoning parts plus its tool calls. */
function assistantTokens(row: Row): number {
  const text = (row.content ?? []).reduce<number>((n, part) => n + (object(part) && (part.type === "text" || part.type === "reasoning") ? partTokens(part as Part) : 0), 0)
  return text + rowCalls(row).reduce((n, call) => n + partTokens({ type: "tool-call", ...call } as Part) + partTokens({ type: "tool-result", ...call } as Part), 0)
}

/** Estimated tokens of the raw conversation a deferral would hold live,
 *  counting the same text and reasoning parts that responseTokens counts. */
export function conversationTokens(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => {
    if (row.type === "user") {
      const data = row as Row & Record<string, unknown>
      const text = typeof data.text === "string" ? tokens(data.text) : 0
      const files = Array.isArray(data.files) ? data.files.reduce<number>((n, file) => n + attachmentTokens(file), 0) : 0
      return sum + text + files
    }
    return sum + (row.type === "assistant" ? assistantTokens(row) : 0)
  }, 0)
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
