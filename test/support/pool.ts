// Shared fixtures for the recurring one-shot nudge tests: a host-shaped sqlite
// database plus the code payloads its sessions keep re-typing. The writer loads
// node:sqlite dynamically so importing these fixtures never breaks a node too
// old to have it; the tests that need a database skip themselves instead.
export type FixtureSession = {
  readonly id: string
  readonly directory?: string
  readonly time?: number
  readonly commands: readonly string[]
}

// One family: a json summary one-shot retyped in four sessions as two similar
// variants, prefixed the way model commands arrive on this host.
const command = (payload: string) => `rtk bypass python3 -c '${payload}'`

export const jsonSummary = `import json, sys
rows = json.load(open(sys.argv[1]))
counts = {}
for row in rows:
    key = row.get("session", "unknown")
    counts[key] = counts.get(key, 0) + 1
print(json.dumps(counts, indent=2, sort_keys=True))`

export const jsonSummaryVariant = jsonSummary
  .replaceAll("counts", "totals")
  .replace("indent=2", "indent=4")

// Different work entirely: no word-set overlap worth matching, and only two
// recent sessions besides — doubly outside every family gate.
export const csvSorter = `import csv, sys
reader = csv.reader(open(sys.argv[1]))
table = sorted(reader, key=lambda row: row[0].lower())
for row in table:
    print("%s,%s" % (row[0], row[1]))`

// What a live session types: close kin of the pooled variants, not a copy.
export const liveJsonSummary = jsonSummary
  .replaceAll("counts", "per_session_counts")
  .replace("indent=2", "indent=4")

export const pooledSessions: readonly FixtureSession[] = [
  { id: "ses_a1", directory: "C:/nextdcp-test", commands: [command(jsonSummary), command(jsonSummary), command(jsonSummary)] },
  { id: "ses_a2", directory: "C:/nextdcp-test", commands: [command(jsonSummary), command(jsonSummary), command(jsonSummary)] },
  { id: "ses_b1", directory: "C:/nextdcp-test", commands: [command(jsonSummaryVariant), command(jsonSummaryVariant), command(jsonSummaryVariant)] },
  { id: "ses_b2", directory: "C:/nextdcp-test", commands: [command(jsonSummaryVariant), command(jsonSummaryVariant), command(jsonSummaryVariant)] },
  { id: "ses_c1", directory: "C:/nextdcp-test", commands: [command(csvSorter), command(csvSorter), command(csvSorter), command(csvSorter)] },
  { id: "ses_c2", directory: "C:/nextdcp-test", commands: [command(csvSorter), command(csvSorter), command(csvSorter), command(csvSorter)] },
  { id: "ses_old", directory: "C:/nextdcp-test", time: Date.now() - 91 * 86_400_000, commands: [command(csvSorter), command(csvSorter), command(csvSorter), command(csvSorter)] },
]

/** Write a host-shaped database of assistant bash tool calls for the sessions. */
export async function fixtureDatabase(path: string, sessions: readonly FixtureSession[]): Promise<void> {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path)
  try {
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_updated INTEGER)")
    db.exec("CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, data TEXT)")
    const insertSession = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?)")
    const insertMessage = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?)")
    for (const session of sessions) {
      insertSession.run(session.id, session.directory ?? "", session.time ?? Date.now())
      for (const [seq, text] of session.commands.entries())
        insertMessage.run(session.id, seq, JSON.stringify({ content: [
          { type: "tool", id: `call_${session.id}_${seq}`, name: "bash", state: { status: "completed", input: { command: text } } },
        ] }))
    }
  } finally { db.close() }
}
