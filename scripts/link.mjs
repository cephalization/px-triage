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
const target = join(repo, "bin", "pxt.js")
const binDir = process.env.PXT_BIN_DIR ?? execSync("pnpm bin -g", { encoding: "utf8" }).trim()
const remove = process.argv.includes("--remove")

for (const name of ["pxt", "px-triage"]) {
  const link = join(binDir, name)
  const isOurs = existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === target
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
  if (existsSync(link) || (() => { try { lstatSync(link); return true } catch { return false } })()) {
    console.error(`refusing to overwrite ${link}; it is not our symlink`)
    process.exitCode = 1
    continue
  }
  mkdirSync(binDir, { recursive: true })
  symlinkSync(target, link)
  console.log(`${name} → ${target}`)
}
