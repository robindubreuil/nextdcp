import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("the real memory dialog fits short terminals and scrolls to its last line", {
  skip: !process.allowedNodeEnvironmentFlags.has("--experimental-ffi") && "Native UI tests need Node 26.4+ with FFI; the server still supports Node 20.",
}, () => {
  const output = execFileSync(process.execPath, ["--experimental-ffi", fileURLToPath(new URL("./memory-dialog.native.mjs", import.meta.url))], { encoding: "utf8", timeout: 30_000 })
  assert.match(output, /Native memory viewer:.*pass/)
})
