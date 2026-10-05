/**
 * ~/.px-triage/config.json — created by a short onboarding on first run.
 * Environment variables override the file so CI / one-off runs still work:
 *   TYPESAFE_API_KEY, PX_TRIAGE_MODEL, PX_TRIAGE_REPO,
 *   PHOENIX_COLLECTOR_ENDPOINT, PHOENIX_API_KEY, PHOENIX_PROJECT_NAME
 */
import { homedir } from "node:os"
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { Prompt } from "effect/cli"
import { bold, cyan, dim, green } from "../ui/ansi.js"

export const PhoenixConfig = Schema.Struct({
  /** Phoenix base URL, e.g. http://localhost:6006 or https://app.phoenix.arize.com */
  url: Schema.String,
  apiKey: Schema.optional(Schema.String),
  projectName: Schema.String
})
export type PhoenixConfig = typeof PhoenixConfig.Type

export const ConfigFile = Schema.Struct({
  typesafeApiKey: Schema.String,
  model: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  phoenix: Schema.optional(PhoenixConfig)
})
export type ConfigFile = typeof ConfigFile.Type

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export const CONFIG_DIR = process.env["PX_TRIAGE_HOME"] ?? join(homedir(), ".px-triage")
export const CONFIG_FILE = join(CONFIG_DIR, "config.json")
export const DECISIONS_FILE = join(CONFIG_DIR, "decisions.jsonl")
export const TRAINING_DIR = join(CONFIG_DIR, "training")
export const CACHE_DIR = join(CONFIG_DIR, "cache")

export class AppConfig extends Context.Service<AppConfig, {
  readonly config: ConfigFile
  /** True when this run created the config file. */
  readonly fresh: boolean
}>()("px-triage/config/AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(CONFIG_FILE).pipe(Effect.orElseSucceed(() => false))
      let fresh = false
      let file: ConfigFile
      if (exists) {
        const raw = yield* fs.readFileString(CONFIG_FILE).pipe(
          Effect.mapError((cause) => new ConfigError({ message: `Could not read ${CONFIG_FILE}`, cause }))
        )
        file = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile))(raw).pipe(
          Effect.mapError((cause) => new ConfigError({ message: `${CONFIG_FILE} is invalid; fix it or delete it to re-run onboarding`, cause }))
        )
      } else if (process.env["TYPESAFE_API_KEY"]) {
        // Non-interactive environments can run purely from env.
        file = { typesafeApiKey: process.env["TYPESAFE_API_KEY"] }
      } else {
        file = yield* runOnboarding
        yield* writeConfig(file)
        fresh = true
      }
      return AppConfig.of({ config: applyEnvOverrides(file), fresh })
    })
  )
}

const applyEnvOverrides = (file: ConfigFile): ConfigFile => {
  const env = process.env
  const phoenixUrl = env["PHOENIX_COLLECTOR_ENDPOINT"] ?? file.phoenix?.url
  const phoenix: PhoenixConfig | undefined = phoenixUrl
    ? {
      url: phoenixUrl,
      projectName: env["PHOENIX_PROJECT_NAME"] ?? file.phoenix?.projectName ?? "px-triage",
      ...(env["PHOENIX_API_KEY"] ?? file.phoenix?.apiKey ? { apiKey: env["PHOENIX_API_KEY"] ?? file.phoenix?.apiKey } : {})
    }
    : undefined
  return {
    typesafeApiKey: env["TYPESAFE_API_KEY"] ?? file.typesafeApiKey,
    ...(env["PX_TRIAGE_MODEL"] ?? file.model ? { model: env["PX_TRIAGE_MODEL"] ?? file.model } : {}),
    ...(env["PX_TRIAGE_REPO"] ?? file.repo ? { repo: env["PX_TRIAGE_REPO"] ?? file.repo } : {}),
    ...(phoenix ? { phoenix } : {})
  }
}

export const writeConfig = (file: ConfigFile) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(CONFIG_DIR, { recursive: true })
    yield* fs.writeFileString(CONFIG_FILE, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
    yield* Console.log(dim(`saved ${CONFIG_FILE}`))
  }).pipe(Effect.mapError((cause) => new ConfigError({ message: `Could not write ${CONFIG_FILE}`, cause })))

/** Interactive first-run setup. Keys are typed by the user and stored locally (mode 600). */
export const runOnboarding = Effect.gen(function*() {
  yield* Console.log(`\n${bold(cyan("Welcome to px-triage"))} ${dim("· first-run setup")}`)
  yield* Console.log(dim(`Config will be written to ${CONFIG_FILE}\n`))

  const key = yield* Prompt.Password({
    message: "TypeSafe (Jev) API key — create one at https://console.typesafe.ai/keys",
    validate: (v) => (v.trim().length > 10 ? Effect.succeed(v.trim()) : Effect.fail("That does not look like an API key"))
  })

  const repo = yield* Prompt.String({ message: "Default repository (owner/name)", default: "arize-ai/phoenix" })

  const trace = yield* Prompt.Confirm({
    message: "Send classification traces to Phoenix (OpenInference LLM spans)?",
    initial: true
  })
  let phoenix: PhoenixConfig | undefined
  if (trace) {
    const url = yield* Prompt.String({
      message: "Phoenix URL",
      default: "http://localhost:6006",
      validate: (v) => (/^https?:\/\//.test(v.trim()) ? Effect.succeed(v.trim().replace(/\/+$/, "")) : Effect.fail("Enter a full http(s) URL"))
    })
    const apiKey = yield* Prompt.Password({ message: "Phoenix API key (leave empty if auth is disabled)" })
    const projectName = yield* Prompt.String({ message: "Phoenix project name", default: "px-triage" })
    const k = Redacted.value(apiKey).trim()
    phoenix = { url, projectName, ...(k ? { apiKey: k } : {}) }
  }

  yield* Console.log(green("\nAll set. Edit the file any time, or set env vars to override.\n"))
  const file: ConfigFile = {
    typesafeApiKey: Redacted.value(key).trim(),
    repo: repo.trim(),
    ...(phoenix ? { phoenix } : {})
  }
  return file
})
