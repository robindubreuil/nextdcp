import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { configDir, findConfig, installConfig, linkBin } from "../scripts/install.mjs"

const CONFIG = `{
  "plugins": [
    { "package": "file:///home/user/.local/share/opencode/nextdcp/releases/0.17.1-05593d37dd9f5c6b", "options": {} }
  ]
}
`

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nextdcp-install-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("install swaps only the plugin URI and keeps a dated copy for rollback", async (t) => {
  const root = await fixture(t)
  const config = join(root, "opencode.json")
  await writeFile(config, CONFIG)
  assert.deepEqual(await installConfig(config, "file:///home/user/.local/share/opencode/nextdcp/releases/0.17.2-deadbeefcafe0000"),
    ["file:///home/user/.local/share/opencode/nextdcp/releases/0.17.1-05593d37dd9f5c6b"])
  const updated = await readFile(config, "utf8")
  assert.ok(updated.includes("0.17.2-deadbeefcafe0000") && updated.includes('"options": {}'), "only the URI changes")
  const backup = (await readdir(root)).find((name) => name.startsWith("opencode.json.bak-nextdcp-install-"))
  assert.equal(await readFile(join(root, backup), "utf8"), CONFIG)
})

test("install refuses to invent an entry and explains the one to add", async (t) => {
  const root = await fixture(t)
  const config = join(root, "opencode.json")
  await writeFile(config, '{ "plugins": [] }\n')
  await assert.rejects(() => installConfig(config, "file:///releases/0.17.2-deadbeefcafe0000"), /No nextdcp plugin entry found/)
  assert.equal(await readFile(config, "utf8"), '{ "plugins": [] }\n')
})

test("the configuration directory follows XDG and the registered document wins", async (t) => {
  assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/user"), join("/xdg/config", "opencode"))
  assert.equal(configDir({}, "/home/user"), join("/home/user", ".config", "opencode"))
  const root = await fixture(t)
  await writeFile(join(root, "opencode.json"), '{ "plugins": [] }\n')
  await writeFile(join(root, "opencode.jsonc"), '{ "plugins": ["file:///x/opencode/nextdcp/releases/0.5.0-abc"] }\n')
  assert.equal(findConfig(root), join(root, "opencode.jsonc"))
})

test("linkBin links, retargets and removes the ocq launcher across installs", async (t) => {
  const root = await fixture(t)
  const releases = join(root, "opencode", "nextdcp", "releases")
  const withCli = join(releases, "0.20.0-aaaa"), newer = join(releases, "0.20.1-bbbb"), legacy = join(releases, "0.19.0-cccc")
  for (const directory of [withCli, newer, legacy]) await mkdir(directory, { recursive: true })
  await writeFile(join(withCli, "cli.js"), "one")
  await writeFile(join(newer, "cli.js"), "two")
  const env = { XDG_DATA_HOME: root }, link = join(root, ".local", "bin", "ocq")
  assert.deepEqual(await linkBin(pathToFileURL(withCli).href, env, "linux", root), { action: "linked", path: link })
  assert.equal(await readFile(link, "utf8"), "one")
  assert.equal((await linkBin(pathToFileURL(newer).href, env, "linux", root)).action, "linked")
  assert.equal(await readFile(link, "utf8"), "two")
  assert.deepEqual(await linkBin(pathToFileURL(legacy).href, env, "linux", root), { action: "removed", path: link }, "rollback drops the link")
  assert.ok(!existsSync(link))
  assert.equal(await linkBin(pathToFileURL(legacy).href, env, "linux", root), null, "nothing left to remove")
  await symlink(join(releases, "0.22.0-gone", "cli.js"), link)
  assert.equal((await linkBin(pathToFileURL(newer).href, env, "linux", root)).action, "linked", "a dangling link we own is retargeted")
  assert.equal(await readFile(link, "utf8"), "two")
})

test("linkBin never touches an ocq it does not own", async (t) => {
  const root = await fixture(t)
  const releases = join(root, "opencode", "nextdcp", "releases")
  const release = join(releases, "0.20.0-aaaa")
  await mkdir(release, { recursive: true })
  await writeFile(join(release, "cli.js"), "mine")
  const env = { XDG_DATA_HOME: root, XDG_BIN_HOME: join(root, "bin") }, link = join(root, "bin", "ocq")
  await mkdir(join(root, "bin"))
  await writeFile(link, "user file")
  assert.equal(await linkBin(pathToFileURL(release).href, env, "linux", root), null, "a regular file is left alone")
  assert.equal(await readFile(link, "utf8"), "user file")
  await rm(link)
  await symlink(join(root, "nowhere"), link)
  assert.equal(await linkBin(pathToFileURL(release).href, env, "linux", root), null, "a dangling foreign symlink is left alone")
  assert.equal(await readlink(link), join(root, "nowhere"))
})

test("linkBin declines windows and non-file URIs", async () => {
  assert.equal(await linkBin("https://example.com/x", {}, "linux", "/home/user"), null)
  assert.equal(await linkBin("not a url", {}, "linux", "/home/user"), null)
  assert.equal(await linkBin("file:///x", {}, "win32", "/home/user"), null)
})
