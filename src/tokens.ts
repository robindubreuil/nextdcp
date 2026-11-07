// Token estimation matching OpenCode's native estimate (chars/4 with fixed
// media costs). The budget gate, recall sizing and the memory budget check all
// meter against it.

export type Part = { readonly type: string }
export type Message = { readonly content: readonly Part[] }
export type ArchivedCall = { readonly id: string; readonly name: string; readonly input: unknown; readonly result: { readonly type: string; readonly value: unknown } }

// Non-CJK text matches the native chars/4 estimate. Han, kana and hangul are
// closer to one token per character, so they are counted separately.
const NON_ASCII = /[\u0080-\uFFFF]/
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
export const tokens = (text: string): number => {
  if (!NON_ASCII.test(text)) return Math.max(0, Math.round(text.length / 4))
  let wide = 0, units = 0
  for (const match of text.matchAll(CJK)) { wide++; units += match[0].length }
  return Math.max(0, Math.round((text.length - units) / 4 + wide))
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const json = (value: unknown) => JSON.stringify(value) ?? ""
export const mediaTokens = (mime: unknown) => {
  if (typeof mime !== "string") return 0
  const type = mime.toLowerCase()
  return type.startsWith("image/") ? 1_500 : type === "application/pdf" ? 2_000 : 0
}

// Match the native chars/4 estimate, including its fixed estimates for media.
export function partTokens(part: Part): number {
  const p = part as Part & Record<string, unknown>
  if (p.type === "text" || p.type === "reasoning" || p.type === "compaction") return tokens(typeof p.text === "string" ? p.text : "")
  if (p.type === "media") return mediaTokens(object(p.media) ? p.media.mediaType : undefined)
  if (p.type === "tool-call") return tokens((typeof p.name === "string" ? p.name : "") + json(p.input))
  if (p.type !== "tool-result" || !object(p.result)) return 0
  if (p.result.type === "content" && Array.isArray(p.result.value)) {
    return p.result.value.reduce((sum: number, item: unknown) => {
      if (!object(item)) return sum
      return sum + (item.type === "text" ? tokens(typeof item.text === "string" ? item.text : "") : mediaTokens(item.mime))
    }, 0)
  }
  return tokens(typeof p.result.value === "string" ? p.result.value : json(p.result.value))
}

export const messageTokens = (messages: readonly Message[]) =>
  messages.reduce((sum, message) => sum + message.content.reduce((n, part) => n + partTokens(part), 0), 0)

type HookTool = { readonly description: string; readonly input: unknown }
export function requestTokens(request: { readonly system: readonly { readonly text: string }[]; readonly tools: Readonly<Record<string, HookTool>>; readonly messages: readonly Message[] }): number {
  const toolTokens = Object.entries(request.tools).reduce((sum, [name, tool]) => sum + tokens(name + tool.description + json(tool.input)), 0)
  return request.system.reduce((sum, part) => sum + tokens(part.text), 0) + toolTokens + messageTokens(request.messages)
}
