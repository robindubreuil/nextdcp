import type { Plugin } from "@opencode/plugin"
import { exclusive } from "./store.ts"

type Storage = Plugin.Context["storage"]
type Tasks = { readonly abort: AbortController; readonly pending: Set<Promise<unknown>>; closed: boolean }
const deletedKey = (id: string) => `deleted/${encodeURIComponent(id)}`
const CLEARED = "cleared"
const writeKey = (id: string) => `nextdcp/session-writes/${encodeURIComponent(id)}`
const sessionOf = (key: string) => /^sessions\/([^/]+)\//.exec(key)?.[1]

/** Own asynchronous work and every session mutation, including model RPC/telemetry.
 *  A durable tombstone closes the namespace across plugin instances and reloads.
 *  Writes already inside storage cannot be cancelled: deletion drains them before
 *  its final clear. Unload drains without deleting durable session data. */
export function createLifecycle(raw: Storage) {
  const sessions = new Map<string, Tasks>(), mutations = new Set<Promise<unknown>>()
  let disposed = false
  const state = (id: string) => {
    let tasks = sessions.get(id)
    if (!tasks) sessions.set(id, tasks = { abort: new AbortController(), pending: new Set(), closed: false })
    return tasks
  }
  const track = <T>(set: Set<Promise<unknown>>, work: Promise<T>): Promise<T> => {
    set.add(work)
    void work.then(() => set.delete(work), () => set.delete(work))
    return work
  }
  const writable = async (id: string) => {
    if (disposed || sessions.get(id)?.closed || await raw.get(deletedKey(id)) !== undefined) throw new Error("Session archive is closed")
    // Closing can race the asynchronous tombstone read.
    if (disposed || sessions.get(id)?.closed) throw new Error("Session archive is closed")
  }
  const storage: Storage = {
    get: (key) => raw.get(key),
    scan: (options) => raw.scan(options),
    set: (key, value) => {
      const encoded = sessionOf(key)
      if (encoded === undefined) {
        if (disposed) return Promise.reject(new Error("Plugin is unloading"))
        return track(mutations, raw.set(key, value))
      }
      const id = decodeURIComponent(encoded)
      return track(mutations, exclusive(writeKey(id), async () => { await writable(id); await raw.set(key, value) }))
    },
    remove: (key) => {
      const encoded = sessionOf(key)
      if (disposed) return Promise.reject(new Error("Plugin is unloading"))
      return track(mutations, encoded === undefined ? raw.remove(key) : exclusive(writeKey(decodeURIComponent(encoded)), () => raw.remove(key)))
    },
  }
  const run = <T>(id: string, work: (signal: AbortSignal) => Promise<T>, unavailable: T): Promise<T> => {
    if (disposed) return Promise.resolve(unavailable)
    const tasks = state(id)
    if (tasks.closed) return Promise.resolve(unavailable)
    return track(tasks.pending, Promise.resolve().then(async () => {
      if (tasks.closed || disposed || await raw.get(deletedKey(id)) !== undefined || tasks.closed || disposed) return unavailable
      try { return await work(tasks.abort.signal) }
      catch (error) { if (tasks.abort.signal.aborted) return unavailable; throw error }
    }))
  }
  const stop = (tasks: Tasks) => { tasks.closed = true; tasks.abort.abort() }
  const drain = async (pending: Set<Promise<unknown>>) => {
    while (pending.size) await Promise.allSettled([...pending])
  }
  return {
    storage,
    run,
    signal: (id: string) => state(id).abort.signal,
    assertOpen: writable,
    /** Closing is synchronous; no newly arriving work can enter while writes drain. */
    async deleteSession(id: string) {
      const tasks = state(id)
      stop(tasks)
      await exclusive(writeKey(id), async () => {
        if (await raw.get(deletedKey(id)) === undefined) await raw.set(deletedKey(id), true)
      })
      await drain(tasks.pending)
      // Everything admitted before the tombstone has settled; subsequent mutations
      // from another instance must check the same tombstone under this write lock.
      await exclusive(writeKey(id), async () => {})
    },
    /** A tombstone is also a durable cleanup journal. Legacy `true` records are
     *  pending; only a successful final clear may mark one complete. Both fence writes. */
    completeDeletion: (id: string) => raw.set(deletedKey(id), CLEARED),
    async *pendingDeletions() {
      const prefix = "deleted/"
      let after: string | undefined
      do {
        const page = await raw.scan({ prefix, after, limit: 500 })
        for (const entry of page.entries) {
          if (!entry.key.startsWith(prefix)) throw new Error("Invalid deletion journal entry")
          if (entry.value !== CLEARED) yield decodeURIComponent(entry.key.slice(prefix.length))
        }
        if (page.next !== undefined && page.next === after) throw new Error("Deletion journal scan did not advance")
        after = page.next
      } while (after !== undefined)
    },
    async dispose() {
      disposed = true
      for (const tasks of sessions.values()) stop(tasks)
      await Promise.all([...sessions.values()].map((tasks) => drain(tasks.pending)))
      await drain(mutations)
    },
  }
}
