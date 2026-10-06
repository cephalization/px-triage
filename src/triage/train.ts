/**
 * `pxt train`: the feedback loop, with Phoenix as the backend.
 *
 *   1. Build the training set: your live decisions (strong signal) plus items
 *      already triaged by others, with the action inferred from their final
 *      state (weaker, used for cold start). Upsert it as a Phoenix dataset.
 *   2. Run a Phoenix experiment: classify every example with the current
 *      question set and planner, evaluate against the human/inferred action.
 *      Every run is visible in Phoenix next to earlier ones, so editing
 *      questions.ts and re-running is an A/B you can inspect.
 *   3. Report agreement, confusion, threshold sweeps, and disagreements here.
 *   4. With --apply, write what was learned (thresholds, per-category policy,
 *      owner picks) into the repo profile. The planner reads it on the next run.
 *
 * Without Phoenix configured, training is unavailable and we say how to set it up.
 */
import { asEvaluator, runExperiment } from "@arizeai/phoenix-client/experiments"
import type { Example } from "@arizeai/phoenix-client/types/datasets"
import { Console, Effect, FileSystem, Schema } from "effect"
import { type Assessment, Classifier, toState } from "../classify/Classifier.ts"
import { THRESHOLDS } from "../classify/questions.ts"
import { TRAINING_DIR } from "../config/AppConfig.ts"
import { GitHub } from "../github/GitHub.ts"
import { type Repo, TriageItem, repoSlug } from "../github/model.ts"
import { PHOENIX_SETUP_HINT, Phoenix } from "../phoenix/Phoenix.ts"
import { bold, cyan, dim, gray, green, hr, red, terminalWidth, truncate, yellow } from "../ui/ansi.ts"
import { type Decision, readDecisions } from "./decisions.ts"
import type { RemoteDecision } from "../phoenix/Phoenix.ts"
import { type Learned, type RepoProfile, RepoProfiles } from "./profile.ts"
import { type ActionKind, type Thresholds, pct, suggestPlan } from "./plan.ts"

export const ACTIONS: ReadonlyArray<ActionKind> = ["needs_info", "bug", "feature", "review", "close"]

/** What the humans ended up doing, inferred from the item's current state. */
export const groundTruth = (item: TriageItem): ActionKind | null => {
  const has = (l: string) => item.labels.includes(l)
  if (item.kind === "pull_request") {
    if (item.pr?.merged || item.state === "MERGED") return "review"
    if (has("needs information")) return "needs_info"
    if (item.state === "CLOSED") return "close"
    if (has("lgtm") || (item.pr?.reviewCount ?? 0) > 0 || (item.pr?.requestedReviewers.length ?? 0) > 0) return "review"
    return null
  }
  if (has("needs information") || has("cannot reproduce")) return "needs_info"
  if (item.state === "CLOSED" && (item.stateReason === "NOT_PLANNED" || has("wontfix") || has("duplicate") || has("invalid") || has("question"))) return "close"
  if (has("bug")) return "bug"
  if (has("enhancement") || has("documentation") || has("user request") || has("roadmap") || has("backlog")) return "feature"
  if (item.state === "CLOSED" && item.stateReason === "COMPLETED") return item.title.toLowerCase().includes("bug") ? "bug" : null
  return null
}

export interface TrainOptions {
  readonly repo: Repo
  readonly label: string
  readonly limit: number
  readonly concurrency: number
  readonly apply: boolean
  /** Count decisions made by agents (LLM annotations) as ground truth too. */
  readonly includeAgents: boolean
}

interface Labeled {
  readonly item: TriageItem
  readonly truth: ActionKind
  readonly source: "human" | "inferred"
  readonly decision: Decision | null
}

const ItemJson = Schema.fromJsonString(TriageItem)

export const runTrain = Effect.fnUntraced(function*(options: TrainOptions) {
  const phoenix = yield* Phoenix
  if (!phoenix.enabled || !phoenix.client) {
    yield* Console.log(yellow("Training uses Phoenix datasets and experiments as its backend."))
    yield* Console.log(PHOENIX_SETUP_HINT)
    return
  }
  const github = yield* GitHub
  const classifier = yield* Classifier
  const profiles = yield* RepoProfiles
  const profile = yield* profiles.load(options.repo)
  const slug = repoSlug(options.repo)
  const width = terminalWidth()

  // ---- 1. Training set -------------------------------------------------------
  // Phoenix annotations are the shared source of truth (every teammate's
  // decisions); the local log only fills in anything that never made it there.
  const t0 = performance.now()
  // Agent decisions are excluded by default: an agent that accepts every
  // suggestion would make the model look perfect.
  const remoteAll = yield* phoenix.listHumanDecisions(slug)
  const remote = options.includeAgents ? remoteAll : remoteAll.filter((r) => r.annotatorKind === "HUMAN")
  const localAll = (yield* readDecisions).filter((d) => d.repo === slug && !d.dryRun && d.chosen !== "skip")
  const local = options.includeAgents ? localAll : localAll.filter((d) => !d.actor?.startsWith("agent:"))
  const decisions: Array<Decision> = [
    ...remote.map(toDecision(slug)),
    ...local.filter((d) => !remote.some((r) => r.number === d.number))
  ].filter((d) => ACTIONS.includes(d.chosen as ActionKind))
  const latestByNumber = new Map<number, Decision>()
  for (const d of [...decisions].sort((a, b) => a.ts.localeCompare(b.ts))) latestByNumber.set(d.number, d)
  const triagers = new Set(remote.map((r) => r.triager).filter((t): t is string => t !== null))
  const agentCount = remoteAll.length - remoteAll.filter((r) => r.annotatorKind === "HUMAN").length
  yield* Console.log(dim(`decisions: ${remote.length} from Phoenix${triagers.size ? ` (${[...triagers].map((t) => "@" + t).join(", ")})` : ""} · ${decisions.length - remote.length} local-only${agentCount ? ` · ${agentCount} agent decision${agentCount === 1 ? "" : "s"} ${options.includeAgents ? "included" : "excluded (--include-agents)"}` : ""}`))
  const history = yield* github.fetchHistory(options)
  const humanNumbers = [...latestByNumber.keys()]
  const humanItems = yield* Effect.forEach(
    chunk(humanNumbers, 10),
    (nums) => github.fetchItems(options.repo, nums).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TriageItem>)),
    { concurrency: 3 }
  ).pipe(Effect.map((xs) => xs.flat()))

  const labeled: Array<Labeled> = []
  for (const item of humanItems) {
    const d = latestByNumber.get(item.number)
    if (d) labeled.push({ item, truth: d.chosen as ActionKind, source: "human", decision: d })
  }
  for (const item of history) {
    if (latestByNumber.has(item.number)) continue
    const truth = groundTruth(item)
    if (truth) labeled.push({ item, truth, source: "inferred", decision: null })
  }
  yield* Console.log(
    dim(`training set: ${labeled.filter((l) => l.source === "human").length} from your decisions · ${labeled.filter((l) => l.source === "inferred").length} inferred from history · ${Math.round(performance.now() - t0)}ms`)
  )
  if (labeled.length === 0) {
    yield* Console.log(yellow("nothing to train on yet; triage a few items first"))
    return
  }

  const examples: Array<Example> = labeled.map((l) => ({
    input: { number: l.item.number, kind: l.item.kind, title: l.item.title, url: l.item.url, state: toState(l.item), item: JSON.stringify(l.item) },
    output: { action: l.truth, labels: l.decision?.labelsAdded ?? l.item.labels, assignees: l.decision?.assignees ?? l.item.assignees },
    metadata: { number: l.item.number, kind: l.item.kind, url: l.item.url, source: l.source, repo: slug }
  }))
  const datasetName = `px-triage/${slug}`
  const dataset = yield* phoenix.upsertDataset(datasetName, `Triage outcomes for ${slug}: human decisions from px-triage plus inferred history.`, examples)
  yield* Console.log(`${green("✔")} dataset ${bold(datasetName)} ${dim(`${dataset.total} examples (+${dataset.added}) · ${phoenix.datasetUrl(dataset.datasetId)}`)}`)

  // ---- 2. Experiment ---------------------------------------------------------
  const byNumber = new Map(labeled.map((l) => [l.item.number, l] as const))
  const assessments = new Map<number, Assessment>()
  const errors = new Map<number, string>()
  const experimentName = `${classifier.model} · q${classifier.questionsHash} · ${new Date().toISOString().slice(0, 16)}`
  const client = phoenix.client

  const task = (example: Example) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const raw = example.input["item"]
        const item = typeof raw === "string" ? yield* Schema.decodeUnknownEffect(ItemJson)(raw) : null
        if (!item) return { action: null, error: "example has no item payload" }
        const exit = yield* Effect.exit(classifier.classify(item))
        if (exit._tag === "Failure") {
          const msg = String(exit.cause)
          errors.set(item.number, msg)
          return { action: null, error: msg }
        }
        const a = exit.value
        assessments.set(item.number, a)
        const plan = suggestPlan(item, a, profile)
        return {
          action: plan.action,
          uncertain: plan.uncertain,
          category: a.category.choice,
          confidence: a.category.confidence,
          component: a.component.choice,
          complete: a.complete,
          inScope: a.inScope,
          labels: plan.labelsToAdd,
          owners: plan.suggestedAssignees.slice(0, 3),
          rationale: plan.rationale
        }
      })
    )

  const actionMatch = asEvaluator({
    name: "action_match",
    kind: "CODE",
    evaluate: ({ output, expected }) => {
      const got = (output as { action?: string | null } | null)?.action ?? null
      const want = (expected as { action?: string } | null)?.action ?? null
      return { score: got !== null && got === want ? 1 : 0, label: got === want ? "match" : `expected ${want}, got ${got}` }
    }
  })
  const ownerMatch = asEvaluator({
    name: "owner_in_top3",
    kind: "CODE",
    evaluate: ({ output, expected }) => {
      const owners = ((output as { owners?: ReadonlyArray<string> } | null)?.owners ?? [])
      const want = ((expected as { assignees?: ReadonlyArray<string> } | null)?.assignees ?? [])
      if (want.length === 0) return { score: null, label: "no assignee" }
      const hit = want.some((w) => owners.includes(w))
      return { score: hit ? 1 : 0, label: hit ? "hit" : `expected ${want.join("/")}` }
    }
  })

  yield* Console.log(dim(`running experiment "${experimentName}" over ${labeled.length} examples…`))
  const t1 = performance.now()
  const experiment = yield* Effect.tryPromise({
    try: () =>
      runExperiment({
        client,
        dataset: { datasetId: dataset.datasetId },
        experimentName,
        experimentDescription: "px-triage train: current questions + planner vs. human / inferred outcomes",
        experimentMetadata: { model: classifier.model, questionsHash: classifier.questionsHash, thresholds: { ...THRESHOLDS, ...(profile.learned?.thresholds ?? {}) }, repo: slug },
        task,
        evaluators: [actionMatch, ownerMatch],
        concurrency: options.concurrency,
        setGlobalTracerProvider: false,
        // Quiet: we print our own report. Errors still surface.
        logger: { info: () => {}, log: () => {}, debug: () => {}, table: () => {}, warn: (m: string) => console.warn(dim(m)), error: (m: string) => console.error(red(m)) }
      }),
    catch: (cause) => new Error(`Phoenix experiment failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  const ok = labeled.filter((l) => assessments.has(l.item.number))
  yield* Console.log(
    `${green("✔")} experiment ${bold(experiment.id)} ${dim(`${ok.length} classified · ${errors.size} failed · ${Math.round(performance.now() - t1)}ms · ${phoenix.datasetUrl(dataset.datasetId)}/experiments`)}`
  )
  if (ok.length === 0) {
    const first = [...errors.values()][0]
    yield* Console.log(red(`nothing to evaluate${first ? `: ${first}` : ""}`))
    return
  }

  // ---- 3. Local report -------------------------------------------------------
  const evaluate = (overrides: Partial<Thresholds>, policy?: Record<string, string>) => {
    let correct = 0
    const matrix = new Map<string, number>()
    const p = policy ? { ...profile, learned: { ...(profile.learned ?? emptyLearned()), policy } } : profile
    for (const l of ok) {
      const suggested = suggestPlan(l.item, assessments.get(l.item.number)!, p, overrides).action
      if (suggested === l.truth) correct++
      matrix.set(`${l.truth}>${suggested}`, (matrix.get(`${l.truth}>${suggested}`) ?? 0) + 1)
    }
    return { accuracy: ok.length ? correct / ok.length : 0, matrix }
  }
  const base = evaluate({})
  const humanOnly = ok.filter((l) => l.source === "human")
  const humanAcc = humanOnly.length
    ? humanOnly.filter((l) => suggestPlan(l.item, assessments.get(l.item.number)!, profile).action === l.truth).length / humanOnly.length
    : null
  yield* Console.log(`\n${bold("Agreement:")} ${pctColor(base.accuracy)} ${dim(`over ${ok.length} items`)}${humanAcc !== null ? `   ${bold("with your decisions:")} ${pctColor(humanAcc)} ${dim(`(${humanOnly.length})`)}` : ""}`)

  yield* Console.log(hr(width))
  const cell = (s: string, n = 11) => s.padStart(n)
  yield* Console.log(dim(cell("truth \\ jev", 12)) + ACTIONS.map((a) => dim(cell(a))).join(""))
  for (const t of ACTIONS) {
    const row = ACTIONS.map((s) => {
      const n = base.matrix.get(`${t}>${s}`) ?? 0
      const txt = cell(String(n))
      return n === 0 ? gray(txt) : t === s ? green(txt) : red(txt)
    })
    yield* Console.log(bold(cell(t, 12)) + row.join(""))
  }

  // ---- 4. Learn --------------------------------------------------------------
  const learned = learn({ ok, assessments, profile, evaluate, decisions })
  yield* Console.log(hr(width))
  yield* Console.log(bold("Learned") + dim(options.apply ? "  (writing to the repo profile)" : "  (preview; re-run with --apply to use these)"))
  const thresholdLines = Object.entries(learned.thresholds)
  yield* Console.log(`  thresholds  ${thresholdLines.length ? thresholdLines.map(([k, v]) => `${k}=${v} ${dim(`(default ${THRESHOLDS[k as keyof typeof THRESHOLDS]})`)}`).join("  ") : dim("defaults hold")}`)
  const policyLines = Object.entries(learned.policy)
  yield* Console.log(`  policy      ${policyLines.length ? policyLines.map(([k, v]) => `${k} → ${v}`).join("  ") : dim("no consistent overrides yet")}`)
  const ownerLines = Object.entries(learned.owners)
  yield* Console.log(`  owners      ${ownerLines.length ? ownerLines.map(([k, v]) => `${k}: @${v.slice(0, 2).join(" @")}`).join("  ") : dim("no owner picks logged yet")}`)
  const after = evaluate(learned.thresholds, learned.policy).accuracy
  yield* Console.log(`  agreement with learned settings: ${pctColor(after)} ${dim(`(was ${pct(base.accuracy)})`)}`)
  if (options.apply) {
    const applied = { learned: { ...learned, experimentId: experiment.id }, experimentId: experiment.id, appliedBy: yield* github.viewer.pipe(Effect.orElseSucceed(() => null)), appliedAt: new Date().toISOString() }
    yield* profiles.save(options.repo, { ...profile, learned: applied.learned })
    yield* phoenix.publishLearned(applied)
    yield* Console.log(green("  saved locally and published to Phoenix; every teammate's next pxt run picks them up"))
  }

  // ---- Disagreements -----------------------------------------------------------
  const disagreements = ok
    .map((l) => ({ ...l, a: assessments.get(l.item.number)!, suggested: suggestPlan(l.item, assessments.get(l.item.number)!, profile).action }))
    .filter((l) => l.suggested !== l.truth)
    .sort((x, y) => (x.source === "human" ? -1 : 1) - (y.source === "human" ? -1 : 1) || y.a.category.confidence - x.a.category.confidence)
    .slice(0, 12)
  if (disagreements.length) {
    yield* Console.log(hr(width))
    yield* Console.log(bold("Disagreements") + dim(" (yours first · truth ← jev · category · confidence):"))
    for (const d of disagreements) {
      yield* Console.log(
        `  ${cyan(`#${d.item.number}`)} ${d.source === "human" ? green("you") : dim("hist")} ${truncate(d.item.title, width - 64).padEnd(width - 64)} ${yellow(d.truth)} ← ${red(d.suggested)} ${dim(`${d.a.category.choice} ${pct(d.a.category.confidence)}`)}`
      )
    }
  }

  const fs = yield* FileSystem.FileSystem
  const file = `${TRAINING_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  yield* fs.makeDirectory(TRAINING_DIR, { recursive: true }).pipe(Effect.ignore)
  yield* fs.writeFileString(file, JSON.stringify({ repo: slug, experimentId: experiment.id, datasetId: dataset.datasetId, model: classifier.model, questionsHash: classifier.questionsHash, accuracy: base.accuracy, learned, applied: options.apply }, null, 2)).pipe(Effect.ignore)
  yield* Console.log(dim(`\nsaved ${file}`))
})

// ---------------------------------------------------------------------------

const toDecision = (repo: string) => (r: RemoteDecision): Decision => ({
  ts: r.at,
  repo,
  number: r.number,
  kind: r.kind ?? "issue",
  title: "",
  suggested: r.suggested,
  uncertain: false,
  chosen: r.chosen,
  accepted: r.accepted,
  model: null,
  category: null,
  categoryConfidence: null,
  complete: null,
  inScope: null,
  labelsAdded: [...r.labels],
  assignees: [...r.assignees],
  dryRun: false,
  selfAssigned: r.selfAssigned,
  classifySpanId: r.spanId
})

const emptyLearned = (): Learned => ({ updatedAt: new Date().toISOString(), sampleSize: 0, thresholds: {}, policy: {}, owners: {} })

/** Guardrails: enough data, clear majorities, and a real gain before anything changes. */
const MIN_SAMPLES_FOR_THRESHOLDS = 30
const MIN_GAIN = 0.02
const MIN_POLICY_SAMPLES = 5
const MIN_POLICY_MAJORITY = 0.7

const learn = (input: {
  ok: ReadonlyArray<Labeled>
  assessments: Map<number, Assessment>
  profile: RepoProfile
  evaluate: (overrides: Partial<Thresholds>, policy?: Record<string, string>) => { accuracy: number }
  decisions: ReadonlyArray<Decision>
}): Learned => {
  const thresholds: Record<string, number> = {}
  if (input.ok.length >= MIN_SAMPLES_FOR_THRESHOLDS) {
    const base = input.evaluate({}).accuracy
    const sweeps: Array<{ name: keyof Thresholds; values: ReadonlyArray<number> }> = [
      { name: "needsInfoBelow", values: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] },
      { name: "outOfScopeBelow", values: [0.1, 0.2, 0.3, 0.4, 0.5] },
      { name: "categoryConfidenceFloor", values: [0.3, 0.4, 0.5, 0.6, 0.7] }
    ]
    for (const sweep of sweeps) {
      let best = { value: THRESHOLDS[sweep.name] as number, acc: base }
      for (const v of sweep.values) {
        const acc = input.evaluate({ [sweep.name]: v }).accuracy
        if (acc > best.acc) best = { value: v, acc }
      }
      if (best.acc - base >= MIN_GAIN && best.value !== THRESHOLDS[sweep.name]) thresholds[sweep.name] = best.value
    }
  }

  // Policy: for each (kind, category), what did humans choose? Live decisions only.
  const policy: Record<string, string> = {}
  const votes = new Map<string, Map<string, number>>()
  for (const l of input.ok) {
    if (l.source !== "human") continue
    const a = input.assessments.get(l.item.number)!
    const key = `${l.item.kind}:${a.category.choice}`
    const m = votes.get(key) ?? new Map<string, number>()
    m.set(l.truth, (m.get(l.truth) ?? 0) + 1)
    votes.set(key, m)
  }
  for (const [key, m] of votes) {
    const total = [...m.values()].reduce((x, y) => x + y, 0)
    const [top, n] = [...m.entries()].sort((x, y) => y[1] - x[1])[0]!
    if (total >= MIN_POLICY_SAMPLES && n / total >= MIN_POLICY_MAJORITY) {
      // Only record it when it differs from what the planner would do anyway.
      const sample = input.ok.find((l) => l.source === "human" && `${l.item.kind}:${input.assessments.get(l.item.number)!.category.choice}` === key)!
      const defaultAction = suggestPlan(sample.item, input.assessments.get(sample.item.number)!, { ...input.profile, learned: undefined }).action
      if (defaultAction !== top) policy[key] = top
    }
  }

  // Owners: who did the triager pick per component (excluding self-assigns)?
  const owners: Record<string, Array<string>> = {}
  const ownerVotes = new Map<string, Map<string, number>>()
  for (const d of input.decisions) {
    if (d.selfAssigned || d.assignees.length === 0) continue
    const a = input.assessments.get(d.number)
    if (!a) continue
    const m = ownerVotes.get(a.component.choice) ?? new Map<string, number>()
    for (const login of d.assignees) m.set(login, (m.get(login) ?? 0) + 1)
    ownerVotes.set(a.component.choice, m)
  }
  for (const [component, m] of ownerVotes) {
    owners[component] = [...m.entries()].sort((x, y) => y[1] - x[1]).map(([login]) => login)
  }

  return { updatedAt: new Date().toISOString(), sampleSize: input.ok.length, thresholds, policy, owners }
}

const chunk = <A>(xs: ReadonlyArray<A>, size: number): Array<Array<A>> => {
  const out: Array<Array<A>> = []
  for (let i = 0; i < xs.length; i += size) out.push([...xs.slice(i, i + size)])
  return out
}

const pctColor = (p: number) => (p >= 0.8 ? green(pct(p)) : p >= 0.6 ? yellow(pct(p)) : red(pct(p)))
