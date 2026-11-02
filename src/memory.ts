import { renderWorking, type Handoff, type WorkingMemory } from "./working.ts"

export type Row = { readonly id: string; readonly type: string; readonly status?: string; readonly summary?: string; readonly content?: readonly unknown[] }
export type Episode = {
  readonly id: string
  readonly summary: string
  readonly rowIDs: readonly string[]
  readonly native?: boolean
  readonly gap?: boolean
}
export type Checkpoint = { readonly id: string; readonly parent: string | null; readonly episode: Episode; readonly working?: WorkingMemory; readonly retiredConstraints?: Handoff["retiredConstraints"] }
export type Pending = { readonly id: string; readonly parent: string | null; readonly rowIDs: readonly string[]; readonly archived: boolean }

/** The episode ends at the selected checkpoint (default: running), not at native compaction's retained-tail cut. */
export function planCut(rows: readonly Row[], checkpoint?: string): { checkpoint: string; parent: string | null; rowIDs: string[] } {
  const end = rows.findLastIndex((row) => row.type === "compaction" && (checkpoint === undefined ? row.status === "running" : row.id === checkpoint))
  if (end < 0) throw new Error(checkpoint === undefined ? "No running compaction row" : "Missing compaction row")
  let start = -1
  for (let i = end - 1; i >= 0; i--) if (rows[i].type === "compaction" && rows[i].status === "completed") { start = i; break }
  return { checkpoint: rows[end].id, parent: start < 0 ? null : rows[start].id, rowIDs: rows.slice(start + 1, end).map((row) => row.id) }
}

/** A pending record preserves the old chain and archive boundary if generation fell back to native. */
export function adoptNative(row: Row, episodeID: string, pending?: Pending): Checkpoint {
  if (row.type !== "compaction" || row.status !== "completed" || typeof row.summary !== "string") throw new Error("Not a completed native checkpoint")
  if (pending && pending.id !== row.id) throw new Error("Pending checkpoint does not match")
  return {
    id: row.id,
    parent: pending?.parent ?? null,
    episode: { id: episodeID, summary: row.summary, rowIDs: pending?.rowIDs ?? [], native: true, ...(!pending?.archived ? { gap: true } : {}) },
  }
}

/** Follow only the current checkpoint's ancestry, so a reverted branch cannot leak into memory. */
export function resolveMemory(current: string | null, records: ReadonlyMap<string, Checkpoint>) {
  const chain: Checkpoint[] = []
  const visited = new Set<string>()
  for (let id = current; id !== null;) {
    if (visited.has(id)) throw new Error("Cyclic checkpoint chain")
    visited.add(id)
    const record = records.get(id)
    if (!record || record.id !== id) throw new Error("Missing checkpoint in memory chain")
    chain.push(record)
    id = record.parent
  }
  const episodes: Episode[] = []
  const catalog = new Map<string, Episode>()
  const add = (episode: Episode) => {
    if (catalog.has(episode.id)) throw new Error("Duplicate episode id")
    catalog.set(episode.id, episode)
  }
  for (const record of chain.reverse()) {
    add(record.episode)
    episodes.push(record.episode)
  }
  const latest = current === null ? undefined : records.get(current)
  return { episodes, catalog, working: latest?.working, through: latest?.episode.id }
}

/** Only the latest working state is visible. Legacy/native summaries are migration input. */
export function renderHandoff(memory: ReturnType<typeof resolveMemory>): string {
  return memory.working && memory.through ? renderWorking(memory.working, memory.through, [...memory.catalog.values()].some((episode) => episode.gap)) : renderMemory(memory.episodes)
}

export function renderMemory(episodes: readonly Episode[]): string {
  return episodes.map((episode) => {
    const title = /^Title:[\t ]*([^\r\n]+?)[\t ]*(?:\r?\n|$)/.exec(episode.summary)
    const heading = `## Episode ${episode.id}${title ? ` — ${title[1]}` : ""}${episode.native ? " (native)" : ""}${episode.gap ? " (recall gap: some raw history was not archived)" : ""}`
    const body = title ? episode.summary.slice(title[0].length).replace(/^\r?\n/, "") : episode.summary
    return body ? `${heading}\n${body}` : heading
  }).join("\n\n")
}

/** Resolve an episode's raw rows without concealing a known archive gap. */
export function episodeRows(id: string, catalog: ReadonlyMap<string, Episode>): { rowIDs: string[]; gap: boolean } {
  const episode = catalog.get(id)
  if (!episode) throw new Error("Missing episode")
  return { rowIDs: [...episode.rowIDs], gap: episode.gap === true }
}
