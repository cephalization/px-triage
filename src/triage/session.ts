/**
 * The interactive loop. Everything slow (GitHub fetch, Jev classification,
 * GitHub mutations) is overlapped with the human's reading time:
 *
 *   fetch queue ──► classify ALL items concurrently (Deferred per item)
 *                         │
 *   show item ◄───────────┘ (await its Deferred; usually already done)
 *   hotkey → resolve plan → submit to Executor (background fiber) → next
 *
 * Enter accepts Jev's suggestion with sensible defaults (no further prompts).
 * A letter runs the guided flow for that action instead.
 */
import { Cause, Console, Deferred, Effect, Exit, Option, Terminal } from "effect"
import { Prompt } from "effect/cli"
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions"
import { type Assessment, Classifier, type ClassifyError } from "../classify/Classifier.js"
import { GitHub, type QueueFilter } from "../github/GitHub.js"
import { type Repo, type TriageItem, repoSlug } from "../github/model.js"
import { bold, cyan, dim, green, red, yellow } from "../ui/ansi.js"
import { type Hotkey, hotkeyMenu } from "../ui/keys.js"
import { renderMarkdown } from "../ui/markdown.js"
import { page } from "../ui/pager.js"
import { editText, openInBrowser } from "../ui/prompts.js"
import { renderAssessment, renderBody, renderHeader, renderReport } from "../ui/render.js"
import { appendDecision, makeDecision, readDecisions } from "./decisions.js"
import { Executor, type ResolvedPlan, describe } from "./executor.js"
import { ACTION_TITLES, type ActionKind, type TriagePlan, suggestPlan } from "./plan.js"
import { type RepoProfile, RepoProfiles, labelColors } from "./profile.js"
import { TRIAGE_LABEL, WORKFLOW_LABEL_ALIASES, type WorkflowLabelKey, workflowLabel } from "./roster.js"
import { CLOSE_TEMPLATES, NEEDS_INFO_TEMPLATES, type Template, renderTemplate, templatesFor } from "./templates.js"

export interface SessionOptions {
  readonly repo: Repo
  readonly label: string
  readonly limit: number
  readonly only: QueueFilter
  readonly number: Option.Option<number>
  readonly dryRun: boolean
  readonly concurrency: number
}

type MenuChoice = { readonly _tag: "accept"; readonly assignee?: "me" | "choose" } | { readonly _tag: "action"; readonly action: ActionKind } | { readonly _tag: "open" } | { readonly _tag: "view" } | { readonly _tag: "quit" }

export const runSession = Effect.fn("runSession")(function*(options: SessionOptions) {
  const github = yield* GitHub
  const classifier = yield* Classifier
  const executor = yield* Executor
  const slug = repoSlug(options.repo)
  const me = yield* github.viewer.pipe(Effect.orElseSucceed(() => null))
  const profile = yield* (yield* RepoProfiles).load(options.repo)
  const colors = labelColors(profile)
  // One Phoenix session per CLI run so every item's trace groups together.
  const sessionId = `px-triage-${new Date().toISOString()}`

  const t0 = performance.now()
  const fetched = Option.isSome(options.number)
    ? [yield* github.fetchItem(options.repo, options.number.value)]
    : yield* github.fetchTriageQueue(options)
  const { items, dropped, deferred: deferredCount } = Option.isSome(options.number)
    ? { items: fetched, dropped: 0, deferred: 0 }
    : yield* reconcileQueue(github, options, fetched)
  const fetchMs = Math.round(performance.now() - t0)
  if (dropped > 0 || deferredCount > 0) {
    yield* Console.log(
      dim(
        [
          dropped > 0 ? `${dropped} already triaged (search index lag)` : null,
          deferredCount > 0 ? `${deferredCount} previously skipped moved to the end` : null
        ].filter(Boolean).join(" · ")
      )
    )
  }

  if (items.length === 0) {
    yield* Console.log(green(`Nothing labeled "${options.label}" in ${slug}. Inbox zero.`))
    return
  }
  yield* Console.log(
    dim(`fetched ${items.length} item${items.length === 1 ? "" : "s"} in ${fetchMs}ms · classifying with ${classifier.model}` +
      (options.dryRun ? ` · ${yellow("DRY RUN")}` : ""))
  )

  // Kick off every classification now; the UI awaits per-item Deferreds.
  const assessments = new Map<number, Deferred.Deferred<Assessment, ClassifyError>>()
  for (const item of items) assessments.set(item.number, yield* Deferred.make<Assessment, ClassifyError>())
  yield* Effect.forEach(
    items,
    (item) => Deferred.into(classifier.classify(item), assessments.get(item.number)!),
    { concurrency: options.concurrency, discard: true }
  ).pipe(Effect.forkDetach)

  let handled = 0
  let index = 0
  while (index < items.length) {
    const item = items[index]!
    yield* printReports(yield* executor.takeReports)

    yield* Console.log("\n" + renderHeader(item, index, items.length, colors))
    yield* Console.log(renderBody(item))

    const deferred = assessments.get(item.number)!
    if (!(yield* Deferred.isDone(deferred))) yield* Console.log(dim("  waiting for jev…"))
    const exit = yield* Effect.exit(Deferred.await(deferred))
    let plan: TriagePlan | null = null
    let assessment: Assessment | null = null
    if (Exit.isSuccess(exit)) {
      assessment = exit.value
      plan = suggestPlan(item, assessment, profile)
      yield* Console.log(renderAssessment(assessment, plan, colors))
    } else {
      const reason = Cause.squash(exit.cause)
      yield* Console.log(red(`  classifier failed: ${reason instanceof Error ? reason.message : String(reason)}`))
      yield* Console.log(dim("  (you can still triage by hand with the keys below)"))
    }

    const outcome = yield* triageOne(item, plan, assessment, options, me, profile).pipe(
      Effect.withSpan("triage.item", {
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
          [SemanticConventions.SESSION_ID]: sessionId,
          [SemanticConventions.INPUT_VALUE]: `#${item.number} ${item.title}`,
          [SemanticConventions.INPUT_MIME_TYPE]: "text/plain",
          [SemanticConventions.METADATA]: JSON.stringify({ repo: slug, url: item.url, dry_run: options.dryRun }),
          "github.number": item.number,
          "github.kind": item.kind,
          "triage.suggested": plan?.action ?? "none",
          "triage.uncertain": plan?.uncertain ?? true
        }
      })
    )

    if (outcome._tag === "quit") break
    if (outcome._tag === "stay") continue
    if (outcome._tag === "skip") {
      yield* appendDecision(makeDecision({ repo: slug, item, assessment, plan, chosen: "skip", labelsAdded: [], assignees: [], dryRun: options.dryRun }))
      index++
      continue
    }
    // applied
    yield* executor.submit(options.repo, item, outcome.plan)
    yield* appendDecision(
      makeDecision({
        repo: slug,
        item,
        assessment,
        plan,
        chosen: outcome.action,
        labelsAdded: outcome.plan.labelsToAdd,
        assignees: outcome.plan.assignees,
        dryRun: options.dryRun
      })
    )
    handled++
    index++
  }

  const pending = yield* executor.pendingCount
  if (pending > 0) yield* Console.log(dim(`\nwaiting for ${pending} GitHub update${pending === 1 ? "" : "s"}…`))
  yield* printReports(yield* executor.drain)
  yield* Console.log(bold(`\n${handled} of ${items.length} triaged${options.dryRun ? " (dry run, nothing was changed)" : ""}.`))
})

/**
 * GitHub's search index lags label changes by minutes, so items triaged in a
 * previous run can reappear. Re-check live labels for anything we have a
 * recent decision for, drop what no longer carries the queue label, and push
 * recently skipped items to the back of the line.
 */
const reconcileQueue = Effect.fn("reconcileQueue")(function*(
  github: GitHub["Service"],
  options: SessionOptions,
  fetched: ReadonlyArray<TriageItem>
) {
  const slug = repoSlug(options.repo)
  const since = Date.now() - 7 * 86_400_000
  const decisions = (yield* readDecisions).filter((d) => d.repo === slug && !d.dryRun && new Date(d.ts).getTime() > since)
  const acted = new Set(decisions.filter((d) => d.chosen !== "skip").map((d) => d.number))
  const skipped = new Set(decisions.filter((d) => d.chosen === "skip").map((d) => d.number))
  const suspects = fetched.filter((i) => acted.has(i.number))
  const live = yield* Effect.forEach(
    suspects,
    (i) => github.fetchLabels(options.repo, i.number).pipe(Effect.map((labels) => [i.number, labels] as const), Effect.orElseSucceed(() => [i.number, i.labels] as const)),
    { concurrency: 8 }
  )
  const stillQueued = new Map(live)
  const kept = fetched.filter((i) => {
    const labels = stillQueued.get(i.number)
    return labels === undefined || labels.includes(options.label)
  })
  const front = kept.filter((i) => !skipped.has(i.number))
  const back = kept.filter((i) => skipped.has(i.number))
  return { items: [...front, ...back], dropped: fetched.length - kept.length, deferred: back.length }
})

type Outcome =
  | { readonly _tag: "applied"; readonly action: ActionKind; readonly plan: ResolvedPlan }
  | { readonly _tag: "skip" }
  | { readonly _tag: "stay" }
  | { readonly _tag: "quit" }

/** One item: loop on the hotkey menu until something advances. */
const triageOne = Effect.fn("triageOne")(function*(
  item: TriageItem,
  plan: TriagePlan | null,
  assessment: Assessment | null,
  options: SessionOptions,
  me: string | null,
  profile: RepoProfile
) {
  const suggested = plan && !plan.uncertain ? plan.action : null
  const assignable = plan !== null && ASSIGNABLE.has(plan.action)
  const choice = yield* hotkeyMenu<MenuChoice>({
    keys: menuKeys(item, suggested, assignable, me),
    defaultValue: suggested ? { _tag: "accept" } : undefined,
    render: (keys, def) => renderLegend(keys, def !== undefined, suggested)
  })
  const finish = (action: ActionKind, resolved: ResolvedPlan | null): Outcome =>
    resolved ? { _tag: "applied", action, plan: resolved } : { _tag: "stay" }

  switch (choice._tag) {
    case "quit":
      return { _tag: "quit" } satisfies Outcome
    case "open":
      yield* openInBrowser(item.url)
      return { _tag: "stay" } satisfies Outcome
    case "view": {
      const width = Math.min(process.stdout.columns ?? 100, 110) - 2
      const lines = [
        ...renderMarkdown(item.body || "_(no description)_", width),
        ...item.comments.flatMap((c) => ["", dim("─".repeat(width)), bold(`@${c.author}`) + dim(` · ${c.createdAt}`), ...renderMarkdown(c.body, width)])
      ]
      yield* page(`${item.shortKind} #${item.number} · ${item.title}`, lines)
      return { _tag: "stay" } satisfies Outcome
    }
    case "accept": {
      if (!plan || !assessment) return { _tag: "stay" } satisfies Outcome
      let assignee: string | null | undefined
      if (choice.assignee === "me") {
        if (!me) {
          yield* Console.log(yellow("  could not determine your GitHub login"))
          return { _tag: "stay" } satisfies Outcome
        }
        assignee = me
      } else if (choice.assignee === "choose") {
        const picked = yield* pickPerson(profile, plan.action === "review" ? "Request review from" : "Assign to", plan.action === "review" ? plan.suggestedReviewers.users : plan.suggestedAssignees, true)
        assignee = picked === "" ? null : picked
      }
      const resolved = yield* quickApply(item, plan, assessment, profile, assignee)
      if (!resolved) return { _tag: "stay" } satisfies Outcome
      yield* Console.log(`  ${green("↳")} ${describe(resolved)}`)
      yield* Effect.annotateCurrentSpan({ "triage.chosen": plan.action, "triage.accepted": true, [SemanticConventions.OUTPUT_VALUE]: describe(resolved) })
      return finish(plan.action, resolved)
    }
    case "action": {
      if (choice.action === "skip") return { _tag: "skip" } satisfies Outcome
      const resolved = yield* runFlow(choice.action, item, plan, assessment, profile)
      if (resolved) {
        yield* Effect.annotateCurrentSpan({ "triage.chosen": choice.action, "triage.accepted": plan?.action === choice.action, [SemanticConventions.OUTPUT_VALUE]: describe(resolved) })
      }
      return finish(choice.action, resolved)
    }
  }
})

const runFlow = (action: ActionKind, item: TriageItem, plan: TriagePlan | null, assessment: Assessment | null, profile: RepoProfile) => {
  switch (action) {
    case "needs_info":
      return flowNeedsInfo(item, plan, profile)
    case "bug":
      return flowBug(item, plan, profile)
    case "feature":
      return flowFeature(item, plan, profile)
    case "review":
      return flowReview(item, plan, profile)
    case "close":
      return flowClose(item, plan, assessment, profile)
    case "skip":
      return Effect.succeed(null)
  }
}

// ---------------------------------------------------------------------------
// Hotkey menu
// ---------------------------------------------------------------------------

/** Actions where "accept" involves a person (assignee or reviewer). */
const ASSIGNABLE: ReadonlySet<ActionKind> = new Set<ActionKind>(["bug", "feature", "review"])

const menuKeys = (item: TriageItem, suggested: ActionKind | null, assignable: boolean, me: string | null): Array<Hotkey<MenuChoice>> => {
  const keys: Array<Hotkey<MenuChoice>> = []
  if (suggested && assignable) {
    if (me) keys.push({ key: "m", label: `accept, ${suggested === "review" ? "review by" : "assign"} @${me}`, value: { _tag: "accept", assignee: "me" } })
    keys.push({ key: "a", label: `accept, choose ${suggested === "review" ? "reviewer" : "assignee"}`, value: { _tag: "accept", assignee: "choose" } })
  }
  const add = (key: string, action: ActionKind) => keys.push({ key, label: ACTION_TITLES[action], value: { _tag: "action", action } })
  add("i", "needs_info")
  if (item.isPr) add("r", "review")
  else {
    add("b", "bug")
    add("f", "feature")
  }
  add("c", "close")
  add("s", "skip")
  keys.push({ key: "v", label: "View markdown", value: { _tag: "view" } })
  keys.push({ key: "o", label: "Open in browser", value: { _tag: "open" } })
  keys.push({ key: "q", label: "Quit", value: { _tag: "quit" } })
  void suggested
  return keys
}

const renderLegend = (keys: ReadonlyArray<Hotkey<MenuChoice>>, hasDefault: boolean, suggested: ActionKind | null): string => {
  const parts = keys.map((k) => {
    const isSuggested = k.value._tag === "action" && k.value.action === suggested
    const label = isSuggested ? green(k.label.split(" → ")[0] ?? k.label) : k.label.split(" → ")[0] ?? k.label
    return `${bold(cyan(`[${k.key}]`))} ${label}`
  })
  const enter = hasDefault ? `${bold(green("[Enter]"))} ${green("accept suggestion")}   ` : `${dim("[Enter] (no confident suggestion)")}   `
  return `\n  ${enter}${parts.join("   ")}`
}

// ---------------------------------------------------------------------------
// Quick accept: apply the suggestion with defaults, zero extra prompts.
// ---------------------------------------------------------------------------

/**
 * `assignee`: undefined → use the suggestion; null → nobody; string → that login.
 */
const quickApply = Effect.fn("quickApply")(function*(item: TriageItem, plan: TriagePlan, assessment: Assessment, profile: RepoProfile, assignee?: string | null) {
  const ctx = { author: item.author, number: item.number, title: item.title }
  const NEEDS_INFO_LABEL = workflowLabel(profile, "needsInfo")
  const BACKLOG_LABEL = workflowLabel(profile, "backlog")
  const labelsToRemove = removeTriage(item)
  const base = { labelsToRemove, assignees: [] as ReadonlyArray<string>, reviewers: { users: [], teams: [] }, close: null, comment: null } satisfies Partial<ResolvedPlan>
  switch (plan.action) {
    case "needs_info": {
      const template = pickDefaultTemplate(templatesFor(NEEDS_INFO_TEMPLATES, item.kind), item, assessment)
      return {
        ...base,
        comment: renderTemplate(template, ctx),
        labelsToAdd: dedupe(item, [NEEDS_INFO_LABEL, ...plan.labelsToAdd, ...templateLabels(profile, template)])
      } satisfies ResolvedPlan
    }
    case "bug": {
      const owner = assignee === undefined ? plan.suggestedAssignees[0] : assignee
      return { ...base, labelsToAdd: dedupe(item, plan.labelsToAdd), assignees: owner ? [owner] : [] } satisfies ResolvedPlan
    }
    case "feature": {
      // Default scheduling: high-value → assign now, otherwise backlog. An
      // explicit assignee always means "now".
      const now = assignee ? true : (assessment.value?.score ?? 0) >= 2
      const owner = assignee === undefined ? plan.suggestedAssignees[0] : assignee
      return {
        ...base,
        labelsToAdd: dedupe(item, [...plan.labelsToAdd, ...(now ? [] : [BACKLOG_LABEL])]),
        assignees: now && owner ? [owner] : []
      } satisfies ResolvedPlan
    }
    case "review": {
      const already = item.pr?.requestedReviewers ?? []
      const user = assignee === undefined ? plan.suggestedReviewers.users.find((u) => !already.includes(u)) : assignee
      return {
        ...base,
        labelsToAdd: dedupe(item, plan.labelsToAdd),
        reviewers: { users: user ? [user] : [], teams: [] }
      } satisfies ResolvedPlan
    }
    case "close": {
      const template = pickDefaultTemplate(templatesFor(CLOSE_TEMPLATES, item.kind), item, assessment)
      const body = renderTemplate(template, ctx)
      // Templates with a placeholder need a human; fall through to the editor.
      const finalBody = /#NNN/.test(body) ? yield* editText(body) : body
      if (!finalBody.trim()) return null
      return {
        ...base,
        comment: finalBody,
        labelsToAdd: dedupe(item, [...templateLabels(profile, template), ...plan.labelsToAdd]),
        close: "not_planned"
      } satisfies ResolvedPlan
    }
    case "skip":
      return null
  }
})

/** Template labels are workflow keys ("wontfix", "duplicate", …); resolve them against this repo's labels. */
const templateLabels = (profile: RepoProfile, template: Template | null | undefined): Array<string> =>
  (template?.labels ?? []).map((l) => resolveTemplateLabel(profile, l)).filter((l): l is string => l !== null)

const resolveTemplateLabel = (profile: RepoProfile, name: string): string | null => {
  const key = (Object.keys(WORKFLOW_LABEL_ALIASES) as Array<WorkflowLabelKey>).find((k) => WORKFLOW_LABEL_ALIASES[k].some((a) => a.toLowerCase() === name.toLowerCase()))
  return key ? workflowLabel(profile, key) : profile.labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.name ?? null
}

/** Choose the template that best matches the classifier's read. */
const pickDefaultTemplate = (templates: ReadonlyArray<Template>, item: TriageItem, a: Assessment): Template => {
  const by = (id: string) => templates.find((t) => t.id === id)
  const cat = a.category.choice
  const pick =
    item.isPr
      ? cat === "off_topic_or_promotional" ? by("third-party") : a.complete < 0.4 ? by("pr-description") : by("pr-not-accepted")
      : cat === "question_or_support" ? by("support")
      : cat === "off_topic_or_promotional" ? by("third-party")
      : cat === "spam_or_nonsense" ? by("spam")
      : cat === "feature_request" || cat === "documentation" ? by("clarify-feature") ?? by("out-of-scope")
      : by("repro") ?? by("out-of-scope")
  return pick ?? templates[0]!
}

// ---------------------------------------------------------------------------
// Guided flows (letter keys). Each returns a ResolvedPlan or null on cancel.
// ---------------------------------------------------------------------------

const dedupe = (item: TriageItem, labels: ReadonlyArray<string | null>) =>
  [...new Set(labels.filter((l): l is string => l !== null))].filter((l) => !item.labels.includes(l))
const removeTriage = (item: TriageItem) => (item.labels.includes(TRIAGE_LABEL) ? [TRIAGE_LABEL] : [])

const labelChoices = (item: TriageItem, profile: RepoProfile, preselected: ReadonlyArray<string>) => {
  const all = [...new Set([...preselected, ...profile.labels.map((l) => l.name)])].filter(
    (l) => l !== TRIAGE_LABEL && !item.labels.includes(l) && !/^size[:/]/i.test(l) && !/^autorelease/.test(l)
  )
  return all.map((l) => ({ title: l, value: l, selected: preselected.includes(l) }))
}

const pickLabels = (item: TriageItem, profile: RepoProfile, preselected: ReadonlyArray<string>) =>
  Prompt.MultiSelect<string>({ message: "Labels to add", choices: labelChoices(item, profile, preselected), maxPerPage: 14 })

const pickPerson = (profile: RepoProfile, message: string, suggested: ReadonlyArray<string>, allowNone: boolean) => {
  const choices: Array<{ title: string; value: string; description?: string }> = []
  if (allowNone) choices.push({ title: dim("nobody (leave unassigned)"), value: "" })
  suggested.forEach((s, i) => choices.push(i === 0 ? { title: `@${s}`, value: s, description: "best match" } : { title: `@${s}`, value: s }))
  for (const t of profile.teammates) {
    if (!suggested.includes(t.login)) choices.push({ title: `@${t.login}`, value: t.login, description: t.areas.slice(0, 4).join(", ") || `${t.assigned} assigned · ${t.reviewed} reviewed` })
  }
  return Prompt.AutoComplete<string>({ message, choices, maxPerPage: 10 })
}

const pickTemplate = (templates: ReadonlyArray<Template>, item: TriageItem) =>
  Prompt.Select<Template | null>({
    message: "Comment template",
    choices: [
      ...templatesFor(templates, item.kind).map((t) => ({ title: t.title, value: t as Template | null, description: t.description })),
      { title: dim("Write from scratch"), value: null }
    ]
  })

const composeComment = Effect.fn("composeComment")(function*(item: TriageItem, templates: ReadonlyArray<Template>) {
  const template = yield* pickTemplate(templates, item)
  const initial = template ? renderTemplate(template, { author: item.author, number: item.number, title: item.title }) : ""
  const needsEdit = template === null || /#NNN/.test(initial)
  const edit = needsEdit ? true : yield* Prompt.Confirm({ message: "Edit the comment in $EDITOR before posting?", initial: false })
  const body = edit ? yield* editText(initial) : initial
  if (body.trim() === "") {
    yield* Console.log(yellow("  empty comment, cancelled"))
    return null
  }
  yield* Console.log(body.split("\n").map((l) => dim("  ┆ ") + l).join("\n"))
  return { body, template }
})

const confirmPlan = (resolved: ResolvedPlan) => Prompt.Confirm({ message: `Apply: ${describe(resolved)}?`, initial: true })

const flowNeedsInfo = Effect.fn("flowNeedsInfo")(function*(item: TriageItem, plan: TriagePlan | null, profile: RepoProfile) {
  const composed = yield* composeComment(item, NEEDS_INFO_TEMPLATES)
  if (!composed) return null
  const resolved: ResolvedPlan = {
    comment: composed.body,
    labelsToAdd: dedupe(item, [workflowLabel(profile, "needsInfo"), ...(plan?.labelsToAdd ?? []), ...templateLabels(profile, composed.template)]),
    labelsToRemove: removeTriage(item),
    assignees: [],
    reviewers: { users: [], teams: [] },
    close: null
  }
  return (yield* confirmPlan(resolved)) ? resolved : null
})

const flowBug = Effect.fn("flowBug")(function*(item: TriageItem, plan: TriagePlan | null, profile: RepoProfile) {
  const labels = yield* pickLabels(item, profile, plan?.labelsToAdd ?? dedupe(item, [workflowLabel(profile, "bug")]))
  const owner = yield* pickPerson(profile, "Assign to", plan?.suggestedAssignees ?? [], true)
  const resolved: ResolvedPlan = {
    comment: null,
    labelsToAdd: labels,
    labelsToRemove: removeTriage(item),
    assignees: owner ? [owner] : [],
    reviewers: { users: [], teams: [] },
    close: null
  }
  return (yield* confirmPlan(resolved)) ? resolved : null
})

const flowFeature = Effect.fn("flowFeature")(function*(item: TriageItem, plan: TriagePlan | null, profile: RepoProfile) {
  const BACKLOG_LABEL = workflowLabel(profile, "backlog")
  const ROADMAP_LABEL = workflowLabel(profile, "roadmap")
  const when = yield* Prompt.Select<"now" | "backlog" | "roadmap">({
    message: "When should this be worked on?",
    choices: [
      { title: "Now", value: "now", description: "Assign an owner right away" },
      { title: "Backlog", value: "backlog", description: BACKLOG_LABEL ? `Add "${BACKLOG_LABEL}"; pick up when there is room` : "No backlog label in this repo; just leave unassigned" },
      { title: "Roadmap", value: "roadmap", description: ROADMAP_LABEL ? `Add "${ROADMAP_LABEL}"; needs planning / design` : "No roadmap label in this repo; just leave unassigned" }
    ]
  })
  const extra = when === "backlog" ? [BACKLOG_LABEL] : when === "roadmap" ? [ROADMAP_LABEL] : []
  const labels = yield* pickLabels(item, profile, dedupe(item, [...(plan?.labelsToAdd ?? [workflowLabel(profile, "enhancement")]), ...extra]))
  const owner = yield* pickPerson(profile, when === "now" ? "Assign to" : "Assign to (optional)", plan?.suggestedAssignees ?? [], when !== "now")
  const resolved: ResolvedPlan = {
    comment: null,
    labelsToAdd: labels,
    labelsToRemove: removeTriage(item),
    assignees: owner ? [owner] : [],
    reviewers: { users: [], teams: [] },
    close: null
  }
  return (yield* confirmPlan(resolved)) ? resolved : null
})

const flowReview = Effect.fn("flowReview")(function*(item: TriageItem, plan: TriagePlan | null, profile: RepoProfile) {
  const labels = yield* pickLabels(item, profile, plan?.labelsToAdd ?? [])
  const suggestedUsers = plan?.suggestedReviewers.users ?? []
  const suggestedTeams = plan?.suggestedReviewers.teams ?? []
  const already = item.pr?.requestedReviewers ?? []
  const reviewers = yield* Prompt.MultiSelect<string>({
    message: "Request review from",
    choices: [
      ...suggestedUsers.map((u, i) => ({ title: `@${u}`, value: u, selected: i === 0 })),
      ...suggestedTeams.map((t) => ({ title: `@${profile.repo.split("/")[0]}/${t}`, value: `team:${t}`, selected: false })),
      ...profile.teammates.filter((t) => !suggestedUsers.includes(t.login)).map((t) => ({ title: `@${t.login}`, value: t.login, selected: false }))
    ].filter((c) => !already.includes(c.value)),
    maxPerPage: 12
  })
  const resolved: ResolvedPlan = {
    comment: null,
    labelsToAdd: labels,
    labelsToRemove: removeTriage(item),
    assignees: [],
    reviewers: {
      users: reviewers.filter((r) => !r.startsWith("team:")),
      teams: reviewers.filter((r) => r.startsWith("team:")).map((r) => r.slice("team:".length))
    },
    close: null
  }
  return (yield* confirmPlan(resolved)) ? resolved : null
})

const flowClose = Effect.fn("flowClose")(function*(item: TriageItem, plan: TriagePlan | null, _assessment: Assessment | null, profile: RepoProfile) {
  const composed = yield* composeComment(item, CLOSE_TEMPLATES)
  if (!composed) return null
  const resolved: ResolvedPlan = {
    comment: composed.body,
    labelsToAdd: dedupe(item, [...templateLabels(profile, composed.template), ...(plan?.labelsToAdd ?? [])]),
    labelsToRemove: removeTriage(item),
    assignees: [],
    reviewers: { users: [], teams: [] },
    close: "not_planned"
  }
  return (yield* confirmPlan(resolved)) ? resolved : null
})

// ---------------------------------------------------------------------------

const printReports = (reports: ReadonlyArray<{ item: TriageItem; ok: boolean; summary: string; error?: string }>) =>
  Effect.forEach(reports, (r) => Console.log(renderReport(r.ok, r.item.number, r.item.shortKind, r.summary, r.error)), { discard: true })

export const isQuit = (u: unknown): u is Terminal.QuitError => Terminal.isQuitError(u)

export const banner = (): string => `${bold(cyan("px-triage"))} ${dim("· Effect + TypeSafe Jev")}`
