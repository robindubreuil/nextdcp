import { episodeNote, renderWorking, type Anchor, type Handoff, type WorkingMemory } from "./working.ts"
import { formatSpan } from "./time.ts"

export type Row = { readonly id: string; readonly type: string; readonly status?: string; readonly summary?: string; readonly content?: readonly unknown[]; readonly time?: { readonly created?: number } }
export type Episode = {
  readonly id: string
  readonly summary: string
  readonly rowIDs: readonly string[]
  readonly native?: boolean
  readonly gap?: boolean
  /** Episode span from its rows' time.created — one pair per episode, used only to render time. */
  readonly start?: number
  readonly end?: number
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

/** Only the latest working state is visible; without one, adopted native summaries render as the episode chain. */
export function renderHandoff(memory: ReturnType<typeof resolveMemory>): string {
  const gap = [...memory.catalog.values()].some((episode) => episode.gap)
  const title = memory.through ? episodeNote(memory.catalog.get(memory.through)?.summary ?? "").title : undefined
  if (!memory.working || !memory.through) return renderMemory(memory.episodes)
  const anchor = archiveAnchor(memory.episodes)
  return renderWorking(memory.working, memory.through, gap, title, anchor)
}

/** The archive anchor: episode count, endpoints, and the covered span at adaptive precision. */
export function archiveAnchor(episodes: readonly Episode[]): Anchor | undefined {
  if (!episodes.length) return undefined
  const name = (episode: Episode) => episodeNote(episode.summary).title ?? episode.id
  const starts = episodes.flatMap((episode) => typeof episode.start === "number" ? [episode.start] : [])
  const ends = episodes.flatMap((episode) => typeof episode.end === "number" ? [episode.end] : [])
  const span = starts.length && ends.length ? formatSpan(Math.min(...starts), Math.max(...ends)) : undefined
  return { count: episodes.length, first: name(episodes[0]), last: name(episodes[episodes.length - 1]), ...(span ? { span } : {}) }
}

export function renderMemory(episodes: readonly Episode[]): string {
  return episodes.map((episode) => {
    const { title, body } = episodeNote(episode.summary)
    const heading = `## Episode ${episode.id}${title ? ` — ${title}` : ""}${episode.native ? " (native)" : ""}${episode.gap ? " (recall gap: some raw history was not archived)" : ""}`
    return body ? `${heading}\n${body}` : heading
  }).join("\n\n")
}

/** Resolve an episode's raw rows without concealing a known archive gap. */
export function episodeRows(id: string, catalog: ReadonlyMap<string, Episode>): { rowIDs: string[]; gap: boolean } {
  const episode = catalog.get(id)
  if (!episode) throw new Error("Missing episode")
  return { rowIDs: [...episode.rowIDs], gap: episode.gap === true }
}
