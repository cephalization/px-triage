import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"

export class EditorError extends Schema.TaggedError<EditorError>()("EditorError", {
  message: Schema.String
}) {}

/**
 * Open `initial` in $VISUAL / $EDITOR and return the edited text. Synchronous
 * on purpose: the editor owns the terminal while it runs.
 */
export const editText = (initial: string, suffix = ".md"): Effect.Effect<string, EditorError> =>
  Effect.try({
    try: () => {
      const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vim"
      const dir = mkdtempSync(join(tmpdir(), "px-triage-"))
      const file = join(dir, `comment${suffix}`)
      writeFileSync(file, initial, "utf8")
      try {
        const result = spawnSync(editor, [file], { stdio: "inherit", shell: true })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error(`${editor} exited with ${result.status}`)
        return readFileSync(file, "utf8").replace(/\s+$/, "")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    catch: (e) => new EditorError({ message: e instanceof Error ? e.message : String(e) })
  })

export const openInBrowser = (url: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    spawnSync(cmd, [url], { stdio: "ignore", shell: process.platform === "win32" })
  })
