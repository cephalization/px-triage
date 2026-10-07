/**
 * "Done for now" state for the team queue: an item stays hidden until it
 * changes on GitHub (updatedAt moves). Local, per machine, like the cache.
 */
import { join } from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import { CONFIG_DIR } from "../config/AppConfig.ts"

const FILE = join(CONFIG_DIR, "team-snooze.json")
const Store = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)) // repo -> number -> updatedAt when snoozed

export const readSnoozes = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(FILE).pipe(Effect.orElseSucceed(() => "{}"))
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Store))(raw)
  return decoded._tag === "Some" ? decoded.value : {}
})

export const snooze = (repo: string, number: number, updatedAt: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const all = yield* readSnoozes
    const next = { ...all, [repo]: { ...(all[repo] ?? {}), [String(number)]: updatedAt } }
    yield* fs.makeDirectory(CONFIG_DIR, { recursive: true })
    yield* fs.writeFileString(FILE, JSON.stringify(next, null, 2))
  }).pipe(Effect.ignore)

/** True when the item was snoozed and has not changed since. */
export const isSnoozed = (store: Record<string, Record<string, string>>, repo: string, number: number, updatedAt: string): boolean =>
  store[repo]?.[String(number)] === updatedAt
