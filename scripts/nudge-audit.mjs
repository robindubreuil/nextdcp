// Live audit: run src/recurring.ts against the real host database, then map
// every pooled payload to the family the live scan would match it to.
import { DatabaseSync } from "node:sqlite"
import { homedir } from "node:os"
import { codeWrapper, createNudge, commandsIn, normalizeCommand, occurrences } from "../src/recurring.ts"


const nudge = createNudge((where, error) => console.error(`[report] ${where}`, error))
await nudge.settle()
const families = nudge.families()
console.log(`families: ${families.length}`)
for (const [index, family] of families.entries())
  console.log(`family ${index}: [${family.sessions} sessions, ~${family.retyped} tokens, ${family.members.length} variants] ${family.wrapper}`)

const db = new DatabaseSync(`${homedir()}/.local/share/opencode/opencode.db`, { readOnly: true })
const rows = db.prepare(`
  SELECT m.session_id AS session, s.directory AS directory, m.data AS data
  FROM session_message m JOIN session_v2 s ON s.id = m.session_id
  WHERE m.type = 'assistant' AND s.time_updated >= ?
  ORDER BY m.session_id, m.seq`).all(Date.now() - 90 * 86_400_000)
db.close()

const pool = new Map()
for (const row of rows) {
  let data
  try { data = JSON.parse(row.data) } catch { continue }
  const commands = commandsIn([{ id: "", type: "assistant", content: data.content }])
  for (const command of commands) {
    const text = normalizeCommand(command, row.directory ?? "")
    const roots = row.directory && row.directory !== homedir() ? [homedir(), row.directory] : [homedir()]
    for (const found of occurrences(text, roots)) {
      if (found.payload.length < 8 || !codeWrapper(found.wrapper)) continue
      const key = JSON.stringify([found.wrapper, found.payload])
      const entry = pool.get(key) ?? { wrapper: found.wrapper, payload: found.payload, sessions: new Set(), count: 0, command: text }
      entry.count++, entry.sessions.add(row.session)
      pool.set(key, entry)
    }
  }
}

const buckets = new Map()
let unmatched = 0
for (const entry of pool.values()) {
  const family = nudge.scan([entry.command], "")
  if (!family) { unmatched++; continue }
  const key = `${family.wrapper}|${family.sessions}|${family.retyped}`
  const list = buckets.get(key) ?? []
  list.push(entry)
  buckets.set(key, list)
}
for (const [key, list] of buckets) {
  list.sort((a, b) => b.count - a.count)
  console.log(`\n=== ${key} — ${list.length} pooled payloads, ${list.reduce((sum, item) => sum + item.count, 0)} occurrences ===`)
  for (const item of list.slice(0, 6))
    console.log(`  [${item.sessions.size}s ×${item.count}] ${item.payload.split("\n").find((line) => line.trim())?.slice(0, 110)}`)
}
console.log(`\nunmatched pooled payloads: ${unmatched} (wrapper-gated or below every family's similarity)`)
