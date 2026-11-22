// host.ts — facts about the host OpenCode instance, independent of any feature.

import { homedir } from "node:os"
import { join } from "node:path"

/** Default host database location, mirroring OpenCode's own resolution. */
export function defaultDatabase(): string {
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "opencode", "opencode.db")
  const base = process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".local", "share")
  return join(base, "opencode", "opencode.db")
}
