import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The per-user application-data root, following each platform's convention. */
export function releasesDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "win32") {
    if (!env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required for a persistent local release")
    return join(env.LOCALAPPDATA, "opencode", "nextdcp", "releases")
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "opencode", "nextdcp", "releases")
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "nextdcp", "releases")
}

/** Content-addressed releases are never updated in place. Does not edit OpenCode config. */
export async function createRelease(source, releases) {
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error("Invalid release version")
  const files = new Map([
    ["index.js", await readFile(join(source, "dist/index.js"))],
    ["tui.js", await readFile(join(source, "dist/tui.js"))],
    ["package.json", Buffer.from(JSON.stringify({ name: manifest.name, version: manifest.version, type: "module",
      exports: { ".": "./index.js", "./tui": "./tui.js" } }, null, 2) + "\n")],
  ])
  const hash = createHash("sha256")
  for (const [name, bytes] of files) hash.update(name).update("\0").update(bytes).update("\0")
  const directory = join(releases, `${manifest.version}-${hash.digest("hex").slice(0, 16)}`)
  const verify = async () => {
    for (const [name, bytes] of files) {
      if (!(await readFile(join(directory, name))).equals(bytes)) throw new Error(`Existing release differs; refusing to overwrite ${directory}`)
    }
    return directory
  }
  try { return await verify() } catch (error) { if (error.code !== "ENOENT") throw error }
  await mkdir(releases, { recursive: true })
  const staging = join(releases, `.staging-${randomBytes(12).toString("hex")}`)
  await mkdir(staging)
  try {
    for (const [name, bytes] of files) await writeFile(join(staging, name), bytes, { flag: "wx" })
    try { await rename(staging, directory) } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error
      // Another publisher may have won the race. Verify; never replace it.
      await verify()
    }
    return await verify()
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const source = fileURLToPath(new URL("../", import.meta.url))
  const directory = await createRelease(source, releasesDir())
  console.log(`Release ready: ${directory}\nPlugin URI: ${pathToFileURL(directory).href}\nOpenCode configuration was not changed.`)
}
