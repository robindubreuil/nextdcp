import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createRelease, releasesDir } from "../scripts/release.mjs"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nextdcp-release-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "source"), releases = join(root, "releases")
  await mkdir(join(source, "dist"), { recursive: true })
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "nextdcp", version: "0.3.0" }))
  await writeFile(join(source, "dist/index.js"), "server first")
  await writeFile(join(source, "dist/tui.js"), "tui first")
  return { source, releases }
}

test("release publication is reproducible and development builds cannot change an active snapshot", async (t) => {
  const { source, releases } = await fixture(t)
  const first = await createRelease(source, releases)
  assert.equal(await createRelease(source, releases), first)
  await writeFile(join(source, "dist/index.js"), "server second")
  const second = await createRelease(source, releases)
  assert.notEqual(first, second)
  assert.equal(await readFile(join(first, "index.js"), "utf8"), "server first")
  assert.equal(await readFile(join(second, "index.js"), "utf8"), "server second")
  assert.deepEqual(JSON.parse(await readFile(join(first, "package.json"), "utf8")).exports, { ".": "./index.js", "./tui": "./tui.js" })
})

test("concurrent publishers converge on identical releases; altered releases are never overwritten", async (t) => {
  const { source, releases } = await fixture(t)
  const [first, second] = await Promise.all([createRelease(source, releases), createRelease(source, releases)])
  assert.equal(first, second)
  await writeFile(join(first, "index.js"), "user modification")
  await assert.rejects(() => createRelease(source, releases), /refusing to overwrite/)
  assert.equal(await readFile(join(first, "index.js"), "utf8"), "user modification")
})

test("release directories follow each platform's application-data convention", () => {
  const env = { XDG_DATA_HOME: "/xdg/data" }, bare = {}, home = "/home/user"
  assert.equal(releasesDir("win32", { LOCALAPPDATA: "C:\\AppData\\Local" }, home), join("C:\\AppData\\Local", "opencode", "nextdcp", "releases"))
  assert.throws(() => releasesDir("win32", bare, home), /LOCALAPPDATA/)
  assert.equal(releasesDir("darwin", bare, home), join(home, "Library", "Application Support", "opencode", "nextdcp", "releases"))
  assert.equal(releasesDir("linux", env, home), join("/xdg/data", "opencode", "nextdcp", "releases"))
  assert.equal(releasesDir("linux", bare, home), join(home, ".local", "share", "opencode", "nextdcp", "releases"))
  assert.equal(releasesDir("freebsd", bare, home), releasesDir("linux", bare, home), "other platforms use the XDG convention")
})
