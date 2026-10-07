import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Layer, Option } from "effect"
import { HttpClient } from "effect/http"
import { Argument, Command, Flag } from "effect/cli"
import { EXIT_EMPTY, agentContext, emitError, parseActionFlag, runApply, runNext, runQueue, runShow } from "./agent/commands.ts"
import { resolveSessionId } from "./agent/core.ts"
import { SKILL_MD } from "./agent/skill.ts"
import { runAutomate } from "./automate/automate.ts"
import { runTeam } from "./team/session.ts"
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
  Flag.withDescription("GitHub repository as owner/name (default: this directory's git origin, else the configured default, else arize-ai/phoenix)"),
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
  // --repo flag, else the git origin of the current directory, else config, else arize-ai/phoenix.
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
      concurrency: input.concurrency,
      links: (yield* AppConfig).repoConfig(repoSlug(repo)).links
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
    apply: Flag.Boolean("apply").pipe(Flag.withDescription("Write learned thresholds / policy / owners into the repo profile"), Flag.withDefault(false)),
    includeAgents: Flag.Boolean("include-agents").pipe(Flag.withDescription("Treat agent-made decisions as ground truth too (humans only by default)"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    yield* Console.log(banner() + dim(" · train"))
    const repo = yield* resolveRepo(input.repo)
    yield* runTrain({
      repo,
      label: yield* resolveLabel(repo, input.label),
      limit: input.limit,
      concurrency: input.concurrency,
      apply: input.apply,
      includeAgents: input.includeAgents
      // The experiment traces itself into its own Phoenix project; our tracer
      // would capture those task spans into the triage project instead.
    }).pipe(Effect.provide(appLayer(repo, { model: input.model, dryRun: true, noTrace: true, noCache: input.noCache })), handleErrors)
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

// ---------------------------------------------------------------------------
// Agent-facing, non-interactive commands. JSON in, JSON out, no prompts.
// ---------------------------------------------------------------------------

const jsonFlag = Flag.Boolean("json").pipe(Flag.withDescription("Machine-readable output (schema 1)"), Flag.withDefault(false))
const sessionFlag = Flag.String("session").pipe(Flag.withDescription("Phoenix session id to group traces across invocations (or PX_TRIAGE_SESSION)"), Flag.optional)
const actorFlag = Flag.String("actor").pipe(Flag.withDescription("Who is deciding, e.g. agent:claude (default: your login at a TTY, agent:unknown otherwise)"), Flag.optional)
const onlyFlag = Flag.Literals("only", ["all", "issues", "prs"]).pipe(Flag.withDescription("Restrict to issues or pull requests"), Flag.withDefault("all"))

type AgentServices = Layer.Success<ReturnType<typeof appLayer>> | AppConfig | FileSystem.FileSystem

const withAgentContext = <A, E>(
  input: { repo: Option.Option<string>; label: Option.Option<string>; session: Option.Option<string>; actor: Option.Option<string>; model: Option.Option<string>; noTrace: boolean; noCache: boolean; json: boolean },
  dryRun: boolean,
  body: (ctx: ReturnType<typeof agentContext>) => Effect.Effect<A, E, AgentServices>
) =>
  Effect.gen(function*() {
    const repo = yield* resolveRepo(input.repo)
    const label = yield* resolveLabel(repo, input.label)
    yield* Effect.gen(function*() {
      const me = yield* GitHub.pipe(Effect.flatMap((g) => g.viewer), Effect.orElseSucceed(() => null))
      const links = (yield* AppConfig).repoConfig(repoSlug(repo)).links
      const ctx = agentContext(repo, label, input.session, input.actor, me, resolveSessionId(input.session), links)
      yield* body(ctx)
    }).pipe(
      Effect.provide(appLayer(repo, { model: input.model, dryRun, noTrace: input.noTrace, noCache: input.noCache })),
      Effect.catch((e) => emitError(input.json, e))
    )
  })

const commonAgentFlags = { repo: repoFlag, label: labelFlag, session: sessionFlag, actor: actorFlag, model: modelFlag, noTrace: noTraceFlag, noCache: noCacheFlag, json: jsonFlag }

const queue = Command.make(
  "queue",
  { ...commonAgentFlags, only: onlyFlag, limit: limitFlag, concurrency: concurrencyFlag, noClassify: Flag.Boolean("no-classify").pipe(Flag.withDescription("List without running Jev (fast)"), Flag.withDefault(false)) },
  Effect.fn(function*(input) {
    yield* withAgentContext(input, true, (ctx) => runQueue(ctx, { only: input.only, limit: input.limit, classify: !input.noClassify, concurrency: input.concurrency, json: input.json }))
  })
).pipe(Command.withDescription(`List the queue with Jev's suggestion per item. Exit ${EXIT_EMPTY} when empty.`))

const show = Command.make(
  "show",
  { ...commonAgentFlags, number: Argument.Int("number").pipe(Argument.withDescription("Issue or PR number")) },
  Effect.fn(function*(input) {
    yield* withAgentContext(input, true, (ctx) => runShow(ctx, input.number, input.json))
  })
).pipe(Command.withDescription("Describe one item: body, comments, assessment, suggestion, accept preview, and ready-to-run apply commands"))

const next = Command.make(
  "next",
  { ...commonAgentFlags, only: onlyFlag },
  Effect.fn(function*(input) {
    yield* withAgentContext(input, true, (ctx) => runNext(ctx, { only: input.only, json: input.json }))
  })
).pipe(Command.withDescription(`Show the head of the queue (same shape as show). Exit ${EXIT_EMPTY} when the queue is empty.`))

const apply = Command.make(
  "apply",
  {
    ...commonAgentFlags,
    number: Argument.Int("number").pipe(Argument.withDescription("Issue or PR number")),
    action: Flag.Literals("action", ["needs-info", "bug", "feature", "review", "close", "skip"]).pipe(Flag.withDescription("What to do"), Flag.optional),
    accept: Flag.Boolean("accept").pipe(Flag.withDescription("Take Jev's suggestion with defaults (refused when uncertain unless --force)"), Flag.withDefault(false)),
    assign: Flag.String("assign").pipe(Flag.withDescription("Assignee login (bug/feature) or reviewer (review)"), Flag.optional),
    assignMe: Flag.Boolean("assign-me").pipe(Flag.withDescription("Assign / request review from the authenticated user"), Flag.withDefault(false)),
    reviewer: Flag.String("reviewer").pipe(Flag.withDescription("Additional reviewer login (repeatable)"), Flag.atLeast(0)),
    labelAdd: Flag.String("add-label").pipe(Flag.withDescription("Additional label to add (repeatable)"), Flag.atLeast(0)),
    when: Flag.Literals("when", ["now", "backlog", "roadmap"]).pipe(Flag.withDescription("Feature scheduling"), Flag.optional),
    template: Flag.String("template").pipe(Flag.withDescription("Comment template id for needs-info / close"), Flag.optional),
    comment: Flag.String("comment").pipe(Flag.withDescription("Comment text (overrides the template)"), Flag.optional),
    commentFile: Flag.File("comment-file", { mustExist: true }).pipe(Flag.withDescription("Read the comment from a file"), Flag.optional),
    noPropagate: Flag.Boolean("no-propagate").pipe(Flag.withDescription("Do not touch linked items"), Flag.withDefault(false)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Print the plan; change nothing on GitHub"), Flag.withDefault(false)),
    force: Flag.Boolean("force").pipe(Flag.withDescription("Act even if the item left the queue or the suggestion is uncertain"), Flag.withDefault(false))
  },
  Effect.fn(function*(input) {
    const fileComment = Option.isSome(input.commentFile)
      ? yield* Effect.tryPromise(() => import("node:fs/promises").then((fs) => fs.readFile(Option.getOrThrow(input.commentFile), "utf8"))).pipe(Effect.orElseSucceed(() => null))
      : null
    yield* withAgentContext(input, input.dryRun, (ctx) =>
      runApply(ctx, input.number, {
        action: Option.isSome(input.action) ? parseActionFlag(input.action.value) : null,
        accept: input.accept,
        assign: Option.getOrNull(input.assign),
        assignMe: input.assignMe,
        reviewers: input.reviewer,
        labels: input.labelAdd,
        when: Option.getOrNull(input.when),
        template: Option.getOrNull(input.template),
        comment: Option.getOrNull(input.comment) ?? (fileComment ? fileComment.replace(/\s+$/, "") : null),
        propagateLinks: !input.noPropagate,
        dryRun: input.dryRun,
        force: input.force
      }, input.json)
    )
  })
).pipe(
  Command.withDescription("Apply a triage action to one item without prompts. --accept takes the suggestion; otherwise pass --action and the relevant flags."),
  Command.withExamples([
    { command: "px-triage apply 1234 --accept --json", description: "Take Jev's suggestion with defaults" },
    { command: "px-triage apply 1234 --action bug --assign-me --json", description: "Label as a bug and assign yourself" },
    { command: "px-triage apply 1234 --action close --template support --dry-run --json", description: "Preview closing as a support question" }
  ])
)

const team = Command.make(
  "team",
  {
    repo: repoFlag,
    label: labelFlag,
    only: onlyFlag,
    limit: Flag.Int("limit").pipe(Flag.withAlias("n"), Flag.withDescription("Open items to scan per search"), Flag.withDefault(100)),
    everyone: Flag.Boolean("everyone").pipe(Flag.withDescription("Include items from non-teammates too"), Flag.withDefault(false)),
    mine: Flag.Boolean("mine").pipe(Flag.withDescription("Only your plate: review requests to you and items assigned to you"), Flag.withDefault(false)),
    window: Flag.Int("window").pipe(Flag.withDescription("Days of activity for unowned issues to count (default 14)"), Flag.withDefault(14)),
    includeSnoozed: Flag.Boolean("include-snoozed").pipe(Flag.withDescription("Show items you marked done even if unchanged"), Flag.withDefault(false)),
    json: jsonFlag,
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Do not change anything on GitHub"), Flag.withDefault(false)),
    noTrace: noTraceFlag
  },
  Effect.fn(function*(input) {
    if (!input.json) yield* Console.log(banner() + dim(" · team"))
    const repo = yield* resolveRepo(input.repo)
    const queueLabel = yield* resolveLabel(repo, input.label)
    yield* runTeam({ repo, queueLabel, limit: input.limit, only: input.only, everyone: input.everyone, mine: input.mine, windowDays: input.window, includeSnoozed: input.includeSnoozed, json: input.json, dryRun: input.dryRun }).pipe(
      Effect.provide(appLayer(repo, { model: Option.none(), dryRun: input.dryRun, noTrace: input.noTrace, noCache: false })),
      handleErrors
    )
  })
).pipe(
  Command.withDescription("What should I work on or unblock next, from my team: review requests, re-reviews, approved-but-unmerged, failing CI, unowned issues"),
  Command.withExamples([
    { command: "px-triage team", description: "Walk the team queue; Enter opens in the browser" },
    { command: "px-triage team --mine", description: "Just your plate: review requests to you and your assignments" },
    { command: "px-triage team --only prs --json", description: "Machine-readable list of teammate PRs needing attention" }
  ])
)

const skill = Command.make("skill", {}, Effect.fn(function*() {
  yield* Console.log(SKILL_MD)
})).pipe(Command.withDescription("Print agent instructions (SKILL.md) for driving px-triage non-interactively"))

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
  Command.withSubcommands([team, queue, next, show, apply, skill, train, roster, automate, init]),
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
