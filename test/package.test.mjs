import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import plugin from "../dist/index.js"

test("the shipped entry is a single ESM bundle with only the host SDK external", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(manifest.exports["."], "./dist/index.js")
  assert.equal(manifest.exports["./tui"], "./dist/tui.js")
  assert.equal(manifest.dependencies, undefined)
  const source = await readFile(new URL("../dist/index.js", import.meta.url), "utf8")
  assert.deepEqual([...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]), ["@opencode/plugin"])
  assert.equal(plugin.id, "nextdcp")
  assert.equal(typeof plugin.setup, "function")
  const tui = await readFile(new URL("../dist/tui.js", import.meta.url), "utf8")
  assert.deepEqual([...tui.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]), ["@opencode/plugin/tui"])
})
