import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { configDir, findConfig, installConfig } from "../scripts/install.mjs"

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
  assert.equal(await findConfig(root), join(root, "opencode.jsonc"))
})
