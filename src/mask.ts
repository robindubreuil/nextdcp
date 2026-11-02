import { inputStub, outputStub } from "./prompts.ts"

export type Part = { readonly type: string }
export type Message = { readonly content: readonly Part[] }
type Call = Part & { readonly id: string; readonly name: string; readonly input: unknown; readonly providerExecuted?: boolean }
type Result = Part & {
  readonly id: string
  readonly name: string
  readonly providerExecuted?: boolean
  readonly result: { readonly type: string; readonly value: unknown }
}
type Position<T> = { readonly part: T; readonly message: number; readonly partIndex: number; readonly order: number }
type Pair = { readonly call: Position<Call>; readonly result: Position<Result> }

export type InputMask = { readonly path: readonly (string | number)[]; readonly stub: string }
export type Mask = { readonly id: string; readonly name: string; readonly input?: readonly InputMask[]; readonly output?: string }
export type ArchivedCall = { readonly id: string; readonly name: string; readonly input: unknown; readonly result: Result["result"] }
export type MaskOptions = { readonly minTokens: number; readonly distance: number; readonly batch: number; readonly protected: readonly string[] }
export type MaskPlan = { readonly commit: boolean; readonly savedTokens: number; readonly base: readonly Mask[]; readonly masks: readonly Mask[]; readonly calls: readonly ArchivedCall[] }

export const DEFAULT_MASK: MaskOptions = { minTokens: 400, distance: 20_000, batch: 10_000, protected: ["skill", "todowrite", "todoread", "task", "subagent"] }
export const tokens = (text: string) => Math.max(0, Math.round(text.length / 4))

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const json = (value: unknown) => JSON.stringify(value) ?? ""
const mediaTokens = (mime: unknown) => {
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

// Require an unambiguous, completed pair. Tool result messages themselves often have no message ID.
function pairs(messages: readonly Message[]): Map<string, Pair> {
  const found = new Map<string, { calls: Position<Call>[]; results: Position<Result>[] }>()
  let order = 0
  messages.forEach((message, mi) => message.content.forEach((part, pi) => {
    const current = order++
    if (part.type !== "tool-call" && part.type !== "tool-result") return
    const p = part as Part & Record<string, unknown>
    if (typeof p.id !== "string" || typeof p.name !== "string") return
    const entry = found.get(p.id) ?? { calls: [], results: [] }
    if (part.type === "tool-call") entry.calls.push({ part: part as Call, message: mi, partIndex: pi, order: current })
    else if (object(p.result) && typeof p.result.type === "string") entry.results.push({ part: part as Result, message: mi, partIndex: pi, order: current })
    found.set(p.id, entry)
  }))
  const valid = new Map<string, Pair>()
  for (const [id, entry] of found) {
    if (entry.calls.length !== 1 || entry.results.length !== 1) continue
    const call = entry.calls[0], result = entry.results[0]
    if (call.order >= result.order || call.part.name !== result.part.name || call.part.providerExecuted || result.part.providerExecuted || result.part.result.type === "error") continue
    valid.set(id, { call, result })
  }
  return valid
}

function cloneWith<T extends object>(value: T, key: string, replacement: unknown): T {
  const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(value)
  const old = descriptors[key]
  descriptors[key] = { value: replacement, writable: old?.writable ?? true, enumerable: old?.enumerable ?? true, configurable: old?.configurable ?? true }
  return Object.create(Object.getPrototypeOf(value), descriptors) as T
}

function replacePath(value: unknown, path: readonly (string | number)[], replacement: string): unknown {
  if (path.length === 0) return typeof value === "string" ? replacement : value
  const [key, ...rest] = path
  if (!object(value) && !Array.isArray(value)) return value
  if (!Object.hasOwn(value, key)) return value
  const previous = (value as Record<string | number, unknown>)[key]
  const next = replacePath(previous, rest, replacement)
  if (next === previous) return value
  if (Array.isArray(value)) {
    const copy = value.slice()
    copy[key as number] = next
    return copy
  }
  return { ...value, [key]: next }
}

function fields(value: unknown, minTokens: number): { path: (string | number)[]; value: string }[] {
  const result: { path: (string | number)[]; value: string }[] = []
  const visit = (item: unknown, path: (string | number)[]) => {
    if (typeof item === "string") {
      if (tokens(item) > minTokens) result.push({ path, value: item })
      return
    }
    if (!object(item) && !Array.isArray(item)) return
    if (Array.isArray(item)) item.forEach((child, i) => visit(child, [...path, i]))
    else for (const [key, child] of Object.entries(item)) visit(child, [...path, key])
  }
  // Tool inputs remain objects, with their original keys and nested shape.
  if (object(value)) visit(value, [])
  return result
}

function canArchive(call: ArchivedCall): boolean {
  try {
    const stored: unknown = JSON.parse(JSON.stringify(call))
    return object(stored) && "input" in stored && object(stored.result) &&
      typeof stored.result.type === "string" && "value" in stored.result
  } catch {
    return false
  }
}

/** Render committed masks unchanged, even if the protection options have since changed. */
export function renderMask<T extends Message>(messages: readonly T[], masks: readonly Mask[]): T[] {
  const valid = pairs(messages)
  const byID = new Map<string, Mask>()
  for (const mask of masks) {
    if (byID.has(mask.id)) throw new Error(`Duplicate mask id: ${mask.id}`)
    byID.set(mask.id, mask)
  }
  return messages.map((message, mi) => {
    let changed = false
    const content = message.content.map((part, pi) => {
      const p = part as Part & Record<string, unknown>
      if (typeof p.id !== "string") return part
      const mask = byID.get(p.id), pair = valid.get(p.id)
      if (!mask || !pair || mask.name !== pair.call.part.name) return part
      if (part.type === "tool-call" && pair.call.message === mi && pair.call.partIndex === pi && mask.input?.length) {
        let input = pair.call.part.input
        for (const field of mask.input) input = replacePath(input, field.path, field.stub)
        if (input !== pair.call.part.input) { changed = true; return cloneWith(part, "input", input) }
      }
      if (part.type === "tool-result" && pair.result.message === mi && pair.result.partIndex === pi && mask.output !== undefined) {
        if (pair.result.part.result.type === "text" && pair.result.part.result.value === mask.output) return part
        changed = true
        return cloneWith(part, "result", { type: "text", value: mask.output })
      }
      return part
    })
    return changed ? cloneWith(message, "content", content) : message
  })
}

/** Plan a batch against the current rendered view; the caller archives calls before committing it. */
export function planMask(messages: readonly Message[], previous: readonly Mask[] = [], options: MaskOptions = DEFAULT_MASK): MaskPlan {
  const base = previous.map((mask) => ({
    ...mask,
    ...(mask.input ? { input: mask.input.map((field) => ({ ...field, path: [...field.path] })) } : {}),
  }))
  const raw = pairs(messages)
  const view = renderMask(messages, base)
  const visible = pairs(view)
  const distances = new Map<string, number>()
  const invalid = new Set<string>()
  let distance = 0
  for (let mi = view.length - 1; mi >= 0; mi--) for (let pi = view[mi].content.length - 1; pi >= 0; pi--) {
    distances.set(`${mi}/${pi}`, distance)
    const part = view[mi].content[pi] as Part & { readonly id?: unknown }
    try { distance += partTokens(part) } catch { if (typeof part.id === "string") invalid.add(part.id) }
  }
  const masks: Mask[] = base.slice()
  const indexes = new Map(masks.map((mask, index) => [mask.id, index]))
  const calls: ArchivedCall[] = []
  let savedTokens = 0
  for (const [id, pair] of raw) {
    try {
      const archived = { id, name: pair.call.part.name, input: pair.call.part.input, result: pair.result.part.result }
      if (invalid.has(id)) continue
      const current = visible.get(id)
      if (!current || options.protected.includes(pair.call.part.name)) continue
      const index = indexes.get(id)
      const old = index === undefined ? { id, name: pair.call.part.name } : masks[index]
      if (old.name !== pair.call.part.name) continue
      const inputMasks = [...(old.input ?? [])]
      const knownPaths = new Set(inputMasks.map((item) => JSON.stringify(item.path)))
      let input = current.call.part.input
      let output = old.output
      let saved = 0
      if ((distances.get(`${current.call.message}/${current.call.partIndex}`) ?? 0) > options.distance) {
        for (const field of fields(pair.call.part.input, options.minTokens)) {
          if (knownPaths.has(JSON.stringify(field.path))) continue
          const stub = inputStub(pair.call.part.name, tokens(field.value), id)
          const next = replacePath(input, field.path, stub)
          const before = partTokens({ ...current.call.part, input } as Call)
          const after = partTokens({ ...current.call.part, input: next } as Call)
          if (after >= before) continue
          inputMasks.push({ path: field.path, stub })
          input = next
          saved += before - after
        }
      }
      if (output === undefined && (distances.get(`${current.result.message}/${current.result.partIndex}`) ?? 0) > options.distance) {
        const size = partTokens(current.result.part)
        if (size > options.minTokens) {
          const stub = outputStub(size, id)
          const after = partTokens({ ...current.result.part, result: { type: "text", value: stub } } as Result)
          if (after < size) { output = stub; saved += size - after }
        }
      }
      if (saved === 0 || !canArchive(archived)) continue
      const next: Mask = { id, name: old.name, ...(inputMasks.length ? { input: inputMasks } : {}), ...(output === undefined ? {} : { output }) }
      if (index === undefined) { indexes.set(id, masks.length); masks.push(next) } else masks[index] = next
      calls.push(archived)
      savedTokens += saved
    } catch {
      // One unreadable or deeply nested call must not prevent other masks.
    }
  }
  const commit = savedTokens > 0 && savedTokens >= options.batch
  return { commit, savedTokens, base, masks: commit ? masks : base, calls: commit ? calls : [] }
}
