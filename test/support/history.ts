// Test-only projection of persisted rows into provider messages (mirrors OpenCode v2.2.0).
import { messageTokens, type ArchivedCall, type Message, type Part } from "../../src/tokens.ts"
import type { Row } from "../../src/memory.ts"

type ProjectedMessage = Message & { readonly id?: string; readonly role: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown) => typeof value === "string" ? value : ""
const asText = (value: string): Part => ({ type: "text", text: value } as Part)

/** Project persisted v2 rows for idle estimation and live search, not for sending to a provider. */
export function projectHistory(rows: readonly Row[]): { messages: ProjectedMessage[]; calls: Map<string, ArchivedCall> } {
  const messages: ProjectedMessage[] = [], calls = new Map<string, ArchivedCall>(), duplicate = new Set<string>()
  const push = (role: string, content: Part[], id?: string) => {
    if (content.length) messages.push({ role, content, ...(id ? { id } : {}) })
  }
  for (const row of rows) {
    const data = row as Row & Record<string, unknown>
    if (row.type === "assistant") {
      const parts: Part[] = [], results: Part[] = []
      for (const value of row.content ?? []) {
        if (!object(value)) continue
        if (value.type === "text" || value.type === "reasoning") {
          if (typeof value.text === "string" && value.text) parts.push({ type: value.type, text: value.text } as Part)
          continue
        }
        if (value.type !== "tool" || typeof value.id !== "string" || typeof value.name !== "string" || !object(value.state)) continue
        const state = value.state, providerExecuted = value.executed === true
        parts.push({ type: "tool-call", id: value.id, name: value.name, input: state.input, providerExecuted } as Part)
        let result: ArchivedCall["result"] | undefined
        if (state.status === "completed") {
          const content = Array.isArray(state.content) ? state.content : []
          const item = content.length === 1 ? content[0] : undefined
          result = content.length === 0 ? { type: "text", value: "" } : object(item) && item.type === "text" && typeof item.text === "string"
            ? { type: "text", value: item.text } : { type: "content", value: content }
        } else if (state.status === "error") {
          result = { type: "error", value: { error: state.error, content: state.content ?? [] } }
        }
        if (!result) continue
        const part = { type: "tool-result", id: value.id, name: value.name, result, providerExecuted } as Part
        if (providerExecuted) parts.push(part)
        else results.push(part)
        if (calls.has(value.id)) { calls.delete(value.id); duplicate.add(value.id) }
        else if (!duplicate.has(value.id)) calls.set(value.id, { id: value.id, name: value.name, input: state.input, result })
      }
      push("assistant", parts, row.id)
      for (const result of results) push("tool", [result])
      continue
    }
    if (row.type === "user") {
      const parts: Part[] = []
      if (Array.isArray(data.skills)) for (const skill of data.skills) if (object(skill) && text(skill.text)) parts.push(asText(text(skill.text)))
      if (text(data.text)) parts.push(asText(text(data.text)))
      if (Array.isArray(data.files)) for (const file of data.files) {
        if (!object(file)) continue
        const mime = text(file.mime)
        if (mime === "text/plain" || mime === "application/x-directory") {
          let decoded = ""
          try { decoded = new TextDecoder().decode(Uint8Array.from(atob(text(file.data)), (char) => char.charCodeAt(0))) } catch { /* malformed attachment */ }
          parts.push(asText(`Attached ${mime === "text/plain" ? "file" : "directory"}: ${text(file.name)}\n${text(file.description)}\n${decoded}`))
        } else if (mime.startsWith("image/") || mime === "application/pdf") {
          parts.push({ type: "media", media: { mediaType: mime } } as Part)
        }
      }
      push("user", parts, row.id)
      continue
    }
    if (row.type === "synthetic" || row.type === "skill" || row.type === "system") {
      if (text(data.text)) push(row.type === "system" ? "system" : "user", [asText(text(data.text))], row.id)
      continue
    }
    if (row.type === "shell" && !(object(data.metadata) && data.metadata.background === true)) {
      const output = object(data.output) ? text(data.output.output) : ""
      push("user", [asText(`Command:\n${text(data.command)}\nOutput:\n${output}`)], row.id)
      continue
    }
    if (row.type === "location-switched" && object(data.location)) {
      push("user", [asText(`The working directory has been changed to ${text(data.location.directory)}.`)], row.id)
      continue
    }
    if (row.type === "compaction" && row.status === "completed") {
      const recent = object(data.metadata) ? text(data.metadata.recent) : ""
      push("user", [asText(`${text(row.summary)}\n${recent}`)], row.id)
    }
  }
  return { messages, calls }
}

/** Kept recent-context belongs to the checkpoint, not to the subsequent conversation. */
export function conversationGrowth(rows: readonly Row[]): { checkpoint: string | null; tokens: number } {
  const index = rows.findLastIndex((row) => row.type === "compaction" && row.status === "completed")
  const messages = projectHistory(rows.slice(index + 1)).messages
  return { checkpoint: index < 0 ? null : rows[index].id, tokens: messageTokens(messages) }
}
