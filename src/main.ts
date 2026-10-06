import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer, Option } from "effect"
import { HttpClient } from "effect/http"
import { Command, Flag } from "effect/cli"
import { runAutomate } from "./automate/automate.ts"
import { Classifier } from "./classify/Classifier.ts"
import { AppConfig, CONFIG_FILE, runOnboarding, writeConfig } from "./config/AppConfig.ts"
import { GitHub } from "./github/GitHub.ts"
import { defaultRepo } from "./github/detectRepo.ts"
import { type Repo, parseRepo, repoSlug } from "./github/model.ts"
import { resolveRepoContext } from "./config/repoContext.ts"
import { Phoenix } from "./phoenix/Phoenix.ts"
import { VERSION, tracingLayer } from "./tracing.ts"
import { Executor } from "./triage/executor.ts"
import { runTrain } from "./triage/train.ts"
import { RepoProfiles } from "./triage/profile.ts"
import { renderProfile } from "./triage/rosterView.ts"
import { banner, isQuit, runSession } from "./triage/session.ts"
import { dim, red } from "./ui/ansi.ts"

const repoFlag = Flag.String("repo").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("GitHub repository as owner/name (default: config, else this directory's git origin, else arize-ai/phoenix)"),
  Flag.optional
)
const limitFlag = Flag.Int("limit").pipe(Flag.withAlias("n"), Flag.withDescription("Maximum number of items to load"), Flag.withDefault(50))
const modelFlag = Flag.String("model").pipe(Flag.withDescription("TypeSafe model (default jev-latest)"), Flag.optional)
const concurrencyFlag = Flag.Int("concurrency").pipe(Flag.withDescription("Parallel classification requests"), Flag.withDefault(8))
const noCacheFlag = Flag.Boolean("no-cache").pipe(Flag.withDescription("Re-classify even when a cached assessment exists"), Flag.withDefault(false))
const noTraceFlag = Flag.Boolean("no-trace").pipe(Flag.withDescription("Do not send traces to Phoenix this run"), Flag.withDefault(false))

/** Services every subcommand needs, built on top of AppConfig + NodeServices. */
const appLayer = (repo: Repo, input: { readonly model: Option.Option<string>; readonly dryRun: boolean; readonly noTrace: boolean; readonly noCache: boolean }) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const { config } = yield* AppConfig
      // No http.client spans: GitHub calls are already wrapped in TOOL spans where they matter.
      const github = GitHub.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.TracerDisabledWhen, () => true)),
        Layer.provide(NodeHttpClient.layerUndici)
      )
      // The project description lives in config; seed it from GitHub if missing.
      const context = yield* resolveRepoContext(repo).pipe(Effect.provide(github))
      const services = Layer.mergeAll(Executor.layer({ dryRun: input.dryRun }), RepoProfiles.layer, Phoenix.layer(config.phoenix)).pipe(
        Layer.provideMerge(github),
        Layer.provideMerge(Classifier.layer({ model: Option.getOrUndefined(input.model), cache: !input.noCache, context }))
      )
      const tracing = input.noTrace ? Layer.empty : tracingLayer(config.phoenix)
      return Layer.mergeAll(services, tracing).pipe(Layer.provide(NodeHttpClient.layerUndici))
    })
  )

const resolveRepo = (flag: Option.Option<string>) =>
  // --repo flag, else config, else the git origin of the current directory, else arize-ai/phoenix.
  Effect.map(AppConfig, ({ config }) => parseRepo(Option.getOrElse(flag, () => defaultRepo(config.repo))))

const labelFlag = Flag.String("label").pipe(Flag.withDescription("Queue label (default from config, else triage)"), Flag.optional)
const resolveLabel = (repo: Repo, flag: Option.Option<string>) =>
  Effect.map(AppConfig, (c) => Option.getOrElse(flag, () => c.repoConfig(repoSlug(repo)).label ?? "triage"))

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
    const repo = yield* resolveRepo(input.repo)
    yield* runSession({
      repo,
      label: yield* resolveLabel(repo, input.label),
      limit: input.limit,
      only: input.only,
      number: input.number,
      dryRun: input.dryRun,
      concurrency: input.concurrency
    }).pipe(Effect.provide(appLayer(repo, input)), handleErrors)
  })
).pipe(
  Command.withDescription("Absurdly fast triage for GitHub issues and PRs. Jev suggests the next step; you press Enter."),
  Command.withExamples([
    { command: "px-triage", description: "Walk the triage queue (Enter accepts Jev's suggestion)" },
    { command: "px-triage --only prs --dry-run", description: "Preview PR triage without touching GitHub" },
    { command: "px-triage --number 1234", description: "Triage one specific issue" },
    { command: "px-triage train --limit 200", description: "Replay triaged history and report agreement" },
    { command: "px-triage roster --refresh", description: "Regenerate the cached owners/labels profile for the repo" }
  ])
)

const train = Command.make(
  "train",
  {
    repo: repoFlag,
    label: labelFlag,
    limit: Flag.Int("limit").pipe(Flag.withAlias("n"), Flag.withDescription("How many past items to add to the training set"), Flag.withDefault(150)),
    model: modelFlag,
    concurrency: concurrencyFlag,
    noTrace: noTraceFlag,
    noCache: noCacheFlag,
    apply: Flag.Boolean("apply").pipe(Flag.withDescription("Write learned thresholds / policy / owners into the repo profile"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    yield* Console.log(banner() + dim(" · train"))
    const repo = yield* resolveRepo(input.repo)
    yield* runTrain({
      repo,
      label: yield* resolveLabel(repo, input.label),
      limit: input.limit,
      concurrency: input.concurrency,
      apply: input.apply
    }).pipe(Effect.provide(appLayer(repo, { model: input.model, dryRun: true, noTrace: input.noTrace, noCache: input.noCache })), handleErrors)
  })
).pipe(Command.withDescription("Build a Phoenix dataset from your decisions + history, run a Jev experiment, report agreement; --apply writes what it learned into the repo profile"))

const roster = Command.make(
  "roster",
  {
    repo: repoFlag,
    refresh: Flag.Boolean("refresh").pipe(Flag.withDescription("Regenerate from GitHub history now instead of using the cached profile"), Flag.withDefault(false)),
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print the raw profile JSON"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    const repo = yield* resolveRepo(input.repo)
    yield* Effect.gen(function*() {
      const profile = yield* (yield* RepoProfiles).load(repo, { refresh: input.refresh })
      yield* Console.log(input.json ? JSON.stringify(profile, null, 2) : renderProfile(profile))
    }).pipe(Effect.provide(appLayer(repo, { model: Option.none(), dryRun: true, noTrace: true, noCache: false })), handleErrors)
  })
).pipe(Command.withDescription("Show the generated repo profile (owners, reviewers, label mapping); --refresh regenerates it"))

const automate = Command.make(
  "automate",
  {
    label: Flag.String("label").pipe(Flag.withDescription("Queue label the workflow should apply (default: triage)"), Flag.optional),
    yes: Flag.Boolean("yes").pipe(Flag.withAlias("y"), Flag.withDescription("Accept the defaults, commit on a branch, and open a PR without asking"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    yield* runAutomate({ label: input.label, yes: input.yes }).pipe(handleErrors)
  })
).pipe(
  Command.withDescription("Write a GitHub Actions workflow into the current repo that labels new issues and PRs for triage; optionally commit it on a branch and open a PR"),
  Command.withExamples([
    { command: "cd your/repo && px-triage automate", description: "Answer a few questions, write .github/workflows/triage-label.yml, open a PR" },
    { command: "px-triage automate --yes", description: "Defaults: issues + PRs, skip changesets and bots, open a PR" }
  ])
)

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
  Command.withSubcommands([train, roster, automate, init]),
  // AppConfig is needed by every subcommand; onboarding runs here on first use.
  Command.provide(AppConfig.layer)
)

root.pipe(
  Command.run({ version: VERSION }),
  Effect.catchTag("ConfigError", (e) => Console.error(red(`Config: ${e.message}`))),
  Effect.catchIf(isQuit, () => Console.log(dim("\nbye"))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
)
