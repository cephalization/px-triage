/**
 * Work out which repository to triage when none is given: the `origin` remote
 * of the git checkout in the current directory, else the configured default,
 * else arize-ai/phoenix.
 */
import { spawnSync } from "node:child_process"

export const FALLBACK_REPO = "arize-ai/phoenix"

/** owner/name from an ssh or https GitHub remote URL, or null. */
export const parseGitHubRemote = (url: string): string | null => {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

export const detectRepoFromCwd = (cwd: string = process.cwd()): string | null => {
  const res = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  if (res.status !== 0 || !res.stdout) return null
  return parseGitHubRemote(res.stdout)
}

export const defaultRepo = (configured: string | undefined): string => configured ?? detectRepoFromCwd() ?? FALLBACK_REPO
