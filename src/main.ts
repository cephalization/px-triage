import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { Classifier } from "./classify/Classifier.js"
import { AppConfig, CONFIG_FILE, runOnboarding, writeConfig } from "./config/AppConfig.js"
import { GitHub } from "./github/GitHub.js"
import { parseRepo } from "./github/model.js"
import { tracingLayer } from "./tracing.js"
import { Executor } from "./triage/executor.js"
import { runTrain } from "./triage/history.js"
import { banner, isQuit, runSession } from "./triage/session.js"
import { dim, red } from "./ui/ansi.js"

const repoFlag = Flag.String("repo").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("GitHub repository as owner/name (default from config, else arize-ai/phoenix)"),
  Flag.optional
)
const labelFlag = Flag.String("label").pipe(Flag.withDescription("Queue label"), Flag.withDefault("triage"))
const limitFlag = Flag.Int("limit").pipe(Flag.withAlias("n"), Flag.withDescription("Maximum number of items to load"), Flag.withDefault(50))
const modelFlag = Flag.String("model").pipe(Flag.withDescription("TypeSafe model (default jev-latest)"), Flag.optional)
const concurrencyFlag = Flag.Int("concurrency").pipe(Flag.withDescription("Parallel classification requests"), Flag.withDefault(8))
const noCacheFlag = Flag.Boolean("no-cache").pipe(Flag.withDescription("Re-classify even when a cached assessment exists"), Flag.withDefault(false))
const noTraceFlag = Flag.Boolean("no-trace").pipe(Flag.withDescription("Do not send traces to Phoenix this run"), Flag.withDefault(false))

/** Services every subcommand needs, built on top of AppConfig + NodeServices. */
const appLayer = (input: { readonly model: Option.Option<string>; readonly dryRun: boolean; readonly noTrace: boolean; readonly noCache: boolean }) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const { config } = yield* AppConfig
      const services = Executor.layer({ dryRun: input.dryRun }).pipe(
        Layer.provideMerge(GitHub.layer),
        Layer.provideMerge(Classifier.layer({ model: Option.getOrUndefined(input.model), cache: !input.noCache }))
      )
      const tracing = input.noTrace ? Layer.empty : tracingLayer(config.phoenix)
      return Layer.mergeAll(services, tracing).pipe(Layer.provide(NodeHttpClient.layerUndici))
    })
  )

const describeError = (e: unknown): string => {
  if (typeof e === "object" && e !== null && "_tag" in e && "message" in e) {
    const tag = String((e as { _tag: unknown })._tag).replace(/Error$/, "")
    return `${tag}: ${String((e as { message: unknown }).message)}`
  }
  return String(e)
}

/** Known failures become one red line; Ctrl+C becomes a quiet goodbye. */
const handleErrors = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
  self.pipe(
    Effect.catch((e) => (isQuit(e) ? Console.log(dim("\nbye")) : Console.error(red(describeError(e)))))
  )

const triage = Command.make(
  "px-triage",
  {
    repo: repoFlag,
    label: labelFlag,
    limit: limitFlag,
    only: Flag.Literals("only", ["all", "issues", "prs"]).pipe(Flag.withDescription("Restrict the queue to issues or pull requests"), Flag.withDefault("all")),
    number: Flag.Int("number").pipe(Flag.withDescription("Triage a single issue/PR number instead of the queue"), Flag.optional),
    model: modelFlag,
    concurrency: concurrencyFlag,
    noTrace: noTraceFlag,
    noCache: noCacheFlag,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Show what would change on GitHub without changing anything"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    yield* Console.log(banner())
    const { config } = yield* AppConfig
    yield* runSession({
      repo: parseRepo(Option.getOrElse(input.repo, () => config.repo ?? "arize-ai/phoenix")),
      label: input.label,
      limit: input.limit,
      only: input.only,
      number: input.number,
      dryRun: input.dryRun,
      concurrency: input.concurrency
    }).pipe(Effect.provide(appLayer(input)), handleErrors)
  })
).pipe(
  Command.withDescription("Absurdly fast triage for GitHub issues and PRs. Jev suggests the next step; you press Enter."),
  Command.withExamples([
    { command: "px-triage", description: "Walk the triage queue (Enter accepts Jev's suggestion)" },
    { command: "px-triage --only prs --dry-run", description: "Preview PR triage without touching GitHub" },
    { command: "px-triage --number 16760", description: "Triage one specific issue" },
    { command: "px-triage train --limit 200", description: "Replay triaged history and report agreement" }
  ])
)

const train = Command.make(
  "train",
  { repo: repoFlag, label: labelFlag, limit: Flag.Int("limit").pipe(Flag.withAlias("n"), Flag.withDescription("How many past items to replay"), Flag.withDefault(150)), model: modelFlag, concurrency: concurrencyFlag, noTrace: noTraceFlag, noCache: noCacheFlag },
  Effect.fn(function*(input) {
    yield* Console.log(banner() + dim(" · train"))
    const { config } = yield* AppConfig
    yield* runTrain({
      repo: parseRepo(Option.getOrElse(input.repo, () => config.repo ?? "arize-ai/phoenix")),
      label: input.label,
      limit: input.limit,
      concurrency: input.concurrency
    }).pipe(Effect.provide(appLayer({ model: input.model, dryRun: true, noTrace: input.noTrace, noCache: input.noCache })), handleErrors)
  })
).pipe(Command.withDescription("Replay already-triaged items through Jev and report agreement, confusion, and threshold sweeps"))

const init = Command.make(
  "init",
  {},
  Effect.fn(function*() {
    yield* Console.log(banner() + dim(" · init"))
    yield* Console.log(dim(`(re)writing ${CONFIG_FILE}`))
    const file = yield* runOnboarding
    yield* writeConfig(file).pipe(handleErrors)
  })
).pipe(Command.withDescription("Run the first-time setup again (TypeSafe key, Phoenix tracing)"))

const root = triage.pipe(
  Command.withSubcommands([train, init]),
  // AppConfig is needed by every subcommand; onboarding runs here on first use.
  Command.provide(AppConfig.layer)
)

root.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.catchTag("ConfigError", (e) => Console.error(red(`Config: ${e.message}`))),
  Effect.catchIf(isQuit, () => Console.log(dim("\nbye"))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
