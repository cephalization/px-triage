#!/usr/bin/env node
/**
 * pnpm 11 dropped `pnpm link --global`, so this symlinks bin/pxt.js into the
 * global pnpm bin directory (already on PATH). The link points at the repo
 * file, and bin/pxt.js imports dist/main.js, so `tsc --watch` keeps `pxt`
 * current without ever re-linking. `node scripts/link.mjs --remove` undoes it.
 */
import { execSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const target = join(repo, "bin", "px-triage.js")
const binDir = process.env.PXT_BIN_DIR ?? execSync("pnpm bin -g", { encoding: "utf8" }).trim()
const remove = process.argv.includes("--remove")

for (const name of ["pxt", "px-triage"]) {
  const link = join(binDir, name)
  // Ours if it points anywhere inside this repo's bin/ (the entry file has been renamed before).
  const lstat = (() => { try { return lstatSync(link) } catch { return null } })()
  // Ours if it is a symlink into this repo's bin/, even a dangling one (the entry file has been renamed before).
  const isOurs = lstat !== null && lstat.isSymbolicLink() && readlinkSync(link).startsWith(join(repo, "bin") + "/")
  if (isOurs && readlinkSync(link) !== target && !remove) {
    rmSync(link)
    symlinkSync(target, link)
    console.log(`${name} → ${target} (relinked)`)
    continue
  }
  if (remove) {
    if (isOurs) {
      rmSync(link)
      console.log(`removed ${link}`)
    }
    continue
  }
  if (isOurs) {
    console.log(`${name} → ${target} (already linked)`)
    continue
  }
  if (lstat !== null) {
    console.error(`refusing to overwrite ${link}; it is not our symlink`)
    process.exitCode = 1
    continue
  }
  mkdirSync(binDir, { recursive: true })
  symlinkSync(target, link)
  console.log(`${name} → ${target}`)
}
