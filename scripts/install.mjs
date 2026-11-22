// install:local — point the OpenCode configuration at a local nextdcp release.
//
//   node scripts/install.mjs            # stage the release from this checkout, then switch to it
//   node scripts/install.mjs <uri>      # switch to an already-built release URI
//
// The previous plugin URI is the rollback; the configuration is copied to a
// dated backup before any change. Exported helpers are unit-tested.

import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, delimiter, join, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { createRelease, releasesDir } from "./release.mjs";

/** The OpenCode configuration directory, following XDG over the home convention. */
export function configDir(env, home = homedir()) {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** The registered document wins: OpenCode reads opencode.jsonc over opencode.json. */
export function findConfig(directory) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(directory, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function stamp(when) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    "" +
    when.getFullYear() +
    pad(when.getMonth() + 1) +
    pad(when.getDate()) +
    "-" +
    pad(when.getHours()) +
    pad(when.getMinutes()) +
    pad(when.getSeconds())
  );
}

/**
 * Swap every nextdcp plugin URI in an OpenCode configuration for `uri` —
 * only the URI strings change, the rest of the document is preserved byte for
 * byte. The original is copied to `<config>.bak-nextdcp-install-<stamp>` first.
 * Returns the previous URIs (the rollback). Refuses to invent an entry.
 */
export async function installConfig(config, uri, now = new Date()) {
  const original = await readFile(config, "utf8");
  const entries = /"[^"\n]*nextdcp[^"\n]*"/g;
  const previous = [...original.matchAll(entries)].map((match) => JSON.parse(match[0]));
  if (!previous.length) {
    throw new Error(
      `No nextdcp plugin entry found in ${config}; nothing was changed. Add\n` +
        `  { "package": ${JSON.stringify(uri)}, "options": {} }\nto its "plugins" array, then re-run.`,
    );
  }
  await writeFile(`${config}.bak-nextdcp-install-${stamp(now)}`, original);
  const staging = `${config}.staging-${process.pid}`;
  await writeFile(staging, original.replace(entries, JSON.stringify(uri)));
  await rename(staging, config);
  return previous;
}

/**
 * Keep the ocq launcher in the user's bin directory in step with the release
 * being installed: symlink it when the release ships a CLI, remove the link
 * when a rollback target predates it. Only symlinks that resolve inside the
 * releases directory are ever touched — anything else at the path (a regular
 * file, a foreign or dangling link) is left strictly alone. Returns the action
 * taken, or null when there is nothing to do (Windows, non-file URIs, foreign
 * targets).
 */
export async function linkBin(uri, env = process.env, platform = process.platform, home = homedir()) {
  if (platform === "win32") return null;
  let parsed;
  try { parsed = new URL(uri); } catch { return null; }
  if (parsed.protocol !== "file:") return null;
  const releases = releasesDir(platform, env, home);
  const link = join(env.XDG_BIN_HOME || join(home, ".local", "bin"), "ocq");
  // lstat, not existsSync: a dangling symlink is still something to respect.
  let status = null;
  try { status = await lstat(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const managed = status !== null && status.isSymbolicLink() &&
    resolve(dirname(link), await readlink(link)).startsWith(releases + sep);
  if (!existsSync(join(fileURLToPath(parsed), "cli.js"))) {
    if (managed) { await rm(link); return { action: "removed", path: link }; }
    return null;
  }
  if (status === null) await mkdir(dirname(link), { recursive: true });
  else if (!managed) return null;
  else await rm(link);
  await symlink(join(fileURLToPath(parsed), "cli.js"), link);
  return { action: "linked", path: link };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = fileURLToPath(new URL("../", import.meta.url));
  const uri = process.argv[2] ?? pathToFileURL(await createRelease(source, releasesDir())).href;
  const config = findConfig(configDir(process.env));
  if (!config) {
    console.error(`install:local: no opencode.jsonc or opencode.json in ${configDir(process.env)}`);
    process.exit(1);
  }
  try {
    const previous = await installConfig(config, uri);
    console.log(`Installed: ${uri}\nConfig: ${config} (backup kept next to it)`);
    for (const old of previous) console.log(`Previous (rollback): ${old}`);
    const linked = await linkBin(uri, process.env);
    if (linked) {
      console.log(linked.action === "linked" ? `ocq CLI: ${linked.path}` : "ocq CLI: link removed (this release has no CLI)");
      if (linked.action === "linked" && !(process.env.PATH ?? "").split(delimiter).includes(dirname(linked.path))) {
        console.log(`note: ${dirname(linked.path)} is not on PATH yet`);
      }
    }
  } catch (error) {
    console.error(`install:local: ${error.message}`);
    process.exit(1);
  }
}
