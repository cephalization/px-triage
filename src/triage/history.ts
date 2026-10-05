/**
 * `px-triage train`: replay already-triaged issues/PRs through the classifier
 * and compare Jev's suggestion with what actually happened. Ground truth is
 * derived from the item's final state + labels, which is noisy (labels get
 * added after triage too), so read the report as "where do we disagree most",
 * not as a benchmark.
 */
import { Console, Effect, FileSystem } from "effect"
import { type Assessment, Classifier } from "../classify/Classifier.js"
import { THRESHOLDS } from "../classify/questions.js"
import { TRAINING_DIR } from "../config/AppConfig.js"
import { GitHub } from "../github/GitHub.js"
import type { Repo, TriageItem } from "../github/model.js"
import { bold, cyan, dim, gray, green, hr, red, terminalWidth, truncate, yellow } from "../ui/ansi.js"
import { readDecisions } from "./decisions.js"
import { RepoProfiles } from "./profile.js"
import { type ActionKind, type Thresholds, pct, suggestPlan } from "./plan.js"

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
}

export const runTrain = Effect.fn("runTrain")(function*(options: TrainOptions) {
  const github = yield* GitHub
  const classifier = yield* Classifier
  const profile = yield* (yield* RepoProfiles).load(options.repo)
  const width = terminalWidth()

  const t0 = performance.now()
  const history = yield* github.fetchHistory(options)
  const labeled = history.flatMap((item) => {
    const truth = groundTruth(item)
    return truth ? [{ item, truth }] : []
  })
  yield* Console.log(dim(`fetched ${history.length} triaged items in ${Math.round(performance.now() - t0)}ms · ${labeled.length} with an inferable outcome · classifying with ${classifier.model}…`))

  const t1 = performance.now()
  const results = yield* Effect.forEach(
    labeled,
    ({ item, truth }) =>
      classifier.classify(item).pipe(
        Effect.map((assessment) => ({ item, truth, assessment, error: null as string | null })),
        Effect.catch((e) => Effect.succeed({ item, truth, assessment: null as Assessment | null, error: e.message }))
      ),
    { concurrency: options.concurrency }
  )
  const ok = results.filter((r): r is typeof r & { assessment: Assessment } => r.assessment !== null)
  const tokens = ok.reduce((n, r) => n + r.assessment.inputTokens, 0)
  yield* Console.log(dim(`classified ${ok.length} in ${Math.round(performance.now() - t1)}ms · ${tokens} input tokens · ${results.length - ok.length} failed`))
  if (ok.length === 0) {
    const firstError = results.find((r) => r.error)?.error
    yield* Console.log(red(`nothing to evaluate${firstError ? `: ${firstError}` : ""}`))
    return
  }

  const evaluate = (thresholds: Thresholds) => {
    let correct = 0
    const matrix = new Map<string, number>()
    for (const r of ok) {
      const suggested = suggestPlan(r.item, r.assessment, profile, thresholds).action
      if (suggested === r.truth) correct++
      matrix.set(`${r.truth}>${suggested}`, (matrix.get(`${r.truth}>${suggested}`) ?? 0) + 1)
    }
    return { accuracy: ok.length ? correct / ok.length : 0, matrix }
  }

  const base = evaluate(THRESHOLDS)
  yield* Console.log(`\n${bold("Agreement with history:")} ${pctColor(base.accuracy)} ${dim(`(${ok.length} items)`)}`)

  // Confusion matrix
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

  // Per-action precision / recall
  yield* Console.log(hr(width))
  for (const a of ACTIONS) {
    const tp = base.matrix.get(`${a}>${a}`) ?? 0
    const predicted = ACTIONS.reduce((n, t) => n + (base.matrix.get(`${t}>${a}`) ?? 0), 0)
    const actual = ACTIONS.reduce((n, s) => n + (base.matrix.get(`${a}>${s}`) ?? 0), 0)
    if (predicted === 0 && actual === 0) continue
    yield* Console.log(`  ${a.padEnd(12)} precision ${pctColor(predicted ? tp / predicted : 0)}  recall ${pctColor(actual ? tp / actual : 0)}  ${dim(`(${actual} actual, ${predicted} predicted)`)}`)
  }

  // Threshold sweep: which single knob would move agreement the most?
  yield* Console.log(hr(width))
  yield* Console.log(bold("Threshold sweep") + dim(" (edit src/classify/questions.ts if one of these is clearly better):"))
  const sweeps: Array<{ name: keyof Thresholds; values: ReadonlyArray<number> }> = [
    { name: "needsInfoBelow", values: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] },
    { name: "outOfScopeBelow", values: [0.1, 0.2, 0.3, 0.4, 0.5] },
    { name: "categoryConfidenceFloor", values: [0.3, 0.4, 0.5, 0.6, 0.7] }
  ]
  for (const sweep of sweeps) {
    const line = sweep.values
      .map((v) => {
        const acc = evaluate({ ...THRESHOLDS, [sweep.name]: v }).accuracy
        const label = `${v}→${pct(acc)}`
        return v === THRESHOLDS[sweep.name] ? bold(label) : acc > base.accuracy + 0.005 ? green(label) : dim(label)
      })
      .join("  ")
    yield* Console.log(`  ${sweep.name.padEnd(24)} ${line}`)
  }

  // Biggest disagreements, most confident first
  const disagreements = ok
    .map((r) => ({ ...r, suggested: suggestPlan(r.item, r.assessment, profile).action }))
    .filter((r) => r.suggested !== r.truth)
    .sort((a, b) => b.assessment.category.confidence - a.assessment.category.confidence)
    .slice(0, 15)
  if (disagreements.length) {
    yield* Console.log(hr(width))
    yield* Console.log(bold("Confident disagreements") + dim(" (truth ← jev · category · confidence):"))
    for (const d of disagreements) {
      yield* Console.log(
        `  ${cyan(`#${d.item.number}`)} ${truncate(d.item.title, width - 60).padEnd(width - 60)} ${yellow(d.truth)} ← ${red(d.suggested)} ${dim(`${d.assessment.category.choice} ${pct(d.assessment.category.confidence)}`)}`
      )
    }
  }

  // Acceptance from live sessions
  const decisions = yield* readDecisions
  if (decisions.length) {
    const live = decisions.filter((d) => d.suggested !== null && d.chosen !== "skip")
    const accepted = live.filter((d) => d.accepted).length
    yield* Console.log(hr(width))
    yield* Console.log(`${bold("Live acceptance:")} ${pctColor(live.length ? accepted / live.length : 0)} ${dim(`of ${live.length} suggestions across ${decisions.length} logged decisions`)}`)
    const overrides = new Map<string, number>()
    for (const d of live) if (!d.accepted) overrides.set(`${d.suggested}→${d.chosen}`, (overrides.get(`${d.suggested}→${d.chosen}`) ?? 0) + 1)
    const top = [...overrides.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    if (top.length) yield* Console.log(dim("  most common overrides: ") + top.map(([k, n]) => `${k} ×${n}`).join(", "))
  }

  // Persist the raw run for later analysis
  const fs = yield* FileSystem.FileSystem
  const file = `${TRAINING_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  yield* fs.makeDirectory(TRAINING_DIR, { recursive: true }).pipe(Effect.ignore)
  yield* fs
    .writeFileString(
      file,
      JSON.stringify(
        {
          repo: `${options.repo.owner}/${options.repo.name}`,
          model: classifier.model,
          thresholds: THRESHOLDS,
          accuracy: base.accuracy,
          items: results.map((r) => ({
            number: r.item.number,
            kind: r.item.kind,
            title: r.item.title,
            truth: r.truth,
            suggested: r.assessment ? suggestPlan(r.item, r.assessment, profile).action : null,
            error: r.error,
            assessment: r.assessment
          }))
        },
        null,
        2
      )
    )
    .pipe(Effect.ignore)
  yield* Console.log(dim(`\nsaved ${file}`))
})

const pctColor = (p: number) => (p >= 0.8 ? green(pct(p)) : p >= 0.6 ? yellow(pct(p)) : red(pct(p)))
