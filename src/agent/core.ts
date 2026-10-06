/**
 * Non-interactive building blocks shared by `pxt queue|show|apply|next`.
 * Same queue loading, classification, planning, propagation, and executor
 * as the TUI, exposed as plain functions with JSON-friendly shapes.
 */
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions"
import { OtelTracer } from "@effect/opentelemetry"
import { Effect, Exit, Option } from "effect"
import { type Assessment, Classifier } from "../classify/Classifier.ts"
import { GitHub, type QueueFilter } from "../github/GitHub.ts"
import { type Repo, type TriageItem, repoSlug } from "../github/model.ts"
import { Phoenix } from "../phoenix/Phoenix.ts"
import { appendDecision, makeDecision } from "../triage/decisions.ts"
import { Executor, type ResolvedPlan, describe } from "../triage/executor.ts"
import { isMaintainer, propagate } from "../triage/links.ts"
import { ACTION_TITLES, type ActionKind, type TriagePlan, suggestPlan } from "../triage/plan.ts"
import { type RepoProfile, RepoProfiles } from "../triage/profile.ts"
import { TRIAGE_LABEL, workflowLabel } from "../triage/roster.ts"
import { dedupe, pickDefaultTemplate, quickApply, reconcileQueue, removeTriage, syncLearned, templateLabels } from "../triage/session.ts"
import { CLOSE_TEMPLATES, NEEDS_INFO_TEMPLATES, type RepoLinks, type Template, renderTemplate, templatesFor } from "../triage/templates.ts"

export const SCHEMA = 1

export interface AgentContext {
  readonly repo: Repo
  readonly label: string
  readonly sessionId: string
  readonly actor: string
  readonly links?: RepoLinks | undefined
}

/** `--session` / PX_TRIAGE_SESSION, else one per invocation. */
export const resolveSessionId = (flag: Option.Option<string>): string =>
  Option.getOrElse(flag, () => process.env["PX_TRIAGE_SESSION"] ?? `px-triage-agent-${new Date().toISOString()}`)

export const loadProfile = Effect.fnUntraced(function*(repo: Repo) {
  const profile = yield* (yield* RepoProfiles).load(repo)
  // Boot-step logging is for humans; agent commands keep stdout for data.
  return yield* syncLearned(profile, repo, { quiet: true })
})

export const classifyWithSpan = (item: TriageItem, ctx: AgentContext) =>
  Effect.gen(function*() {
    const classifier = yield* Classifier
    const otel = yield* OtelTracer.currentOtelSpan.pipe(Effect.option)
    const spanId = otel._tag === "Some" ? otel.value.spanContext().spanId : undefined
    const a = yield* classifier.classify(item)
    yield* Effect.annotateCurrentSpan({
      [SemanticConventions.OUTPUT_VALUE]: JSON.stringify({ category: a.category.choice, confidence: a.category.confidence, component: a.component.choice, complete: a.complete, inScope: a.inScope, cached: a.cached ?? false }),
      [SemanticConventions.OUTPUT_MIME_TYPE]: "application/json"
    })
    return { assessment: a, spanId }
  }).pipe(
    Effect.withSpan("triage.classify", {
      root: true,
      attributes: {
        [SemanticConventions.SESSION_ID]: ctx.sessionId,
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
        [SemanticConventions.INPUT_VALUE]: `#${item.number} ${item.title}`,
        [SemanticConventions.INPUT_MIME_TYPE]: "text/plain",
        [SemanticConventions.METADATA]: JSON.stringify({ url: item.url, kind: item.kind, actor: ctx.actor }),
        repo: repoSlug(ctx.repo),
        "github.number": item.number,
        "github.kind": item.kind
      }
    })
  )

export interface Loaded {
  readonly item: TriageItem
  readonly assessment: Assessment | null
  readonly plan: TriagePlan | null
  readonly classifySpanId: string | undefined
  readonly error: string | null
}

export const loadItem = Effect.fnUntraced(function*(item: TriageItem, ctx: AgentContext, profile: RepoProfile) {
  const exit = yield* Effect.exit(classifyWithSpan(item, ctx))
  if (Exit.isFailure(exit)) {
    const cause = exit.cause
    return { item, assessment: null, plan: null, classifySpanId: undefined, error: String(cause).split("\n")[0] ?? "classification failed" } satisfies Loaded
  }
  const { assessment, spanId } = exit.value
  return { item, assessment, plan: suggestPlan(item, assessment, profile), classifySpanId: spanId, error: null } satisfies Loaded
})

/** Queue numbers after reconciliation (dropped already-triaged, skipped to the back). */
export const loadQueueNumbers = Effect.fnUntraced(function*(ctx: AgentContext, only: QueueFilter, limit: number) {
  const github = yield* GitHub
  const queue = yield* github.fetchQueueNumbers({ repo: ctx.repo, label: ctx.label, limit, only })
  const r = yield* reconcileQueue(github, { repo: ctx.repo, label: ctx.label, limit, only, number: Option.none(), dryRun: false, concurrency: 8 }, queue.map((q) => q.number))
  return r.numbers
})

export const loadItems = Effect.fnUntraced(function*(ctx: AgentContext, numbers: ReadonlyArray<number>, profile: RepoProfile, classify: boolean, concurrency: number) {
  const github = yield* GitHub
  const batches: Array<Array<number>> = []
  for (let i = 0; i < numbers.length; i += 10) batches.push([...numbers.slice(i, i + 10)])
  const items = (yield* Effect.forEach(batches, (b) => github.fetchItems(ctx.repo, b), { concurrency: 3 })).flat()
  const byNumber = new Map(items.map((i) => [i.number, i] as const))
  const ordered = numbers.flatMap((n) => (byNumber.has(n) ? [byNumber.get(n)!] : []))
  if (!classify) return ordered.map((item): Loaded => ({ item, assessment: null, plan: null, classifySpanId: undefined, error: null }))
  return yield* Effect.forEach(ordered, (item) => loadItem(item, ctx, profile), { concurrency })
})

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export const suggestionJson = (l: Loaded) =>
  l.plan && l.assessment
    ? {
      action: l.plan.action,
      uncertain: l.plan.uncertain,
      confidence: round(l.assessment.category.confidence),
      category: l.assessment.category.choice,
      component: l.assessment.component.choice,
      language: l.assessment.language.choice,
      inScope: round(l.assessment.inScope),
      complete: round(l.assessment.complete),
      agentAuthored: round(l.assessment.agentAuthored),
      severity: l.assessment.severity?.level ?? null,
      value: l.assessment.value?.level ?? null,
      risk: l.assessment.risk?.level ?? null,
      rationale: l.plan.rationale,
      labels: l.plan.labelsToAdd,
      owners: l.plan.suggestedAssignees.slice(0, 5),
      reviewers: l.plan.suggestedReviewers
    }
    : null

export const itemSummaryJson = (l: Loaded, profile: RepoProfile) => ({
  number: l.item.number,
  kind: l.item.kind,
  title: l.item.title,
  url: l.item.url,
  author: l.item.author,
  authorAssociation: l.item.authorAssociation,
  createdAt: l.item.createdAt,
  labels: l.item.labels,
  assignees: l.item.assignees,
  comments: l.item.commentCount,
  linked: l.item.linked.map((x) => ({ number: x.number, kind: x.kind, title: x.title, author: x.author, maintainer: isMaintainer(profile, x.author, x.authorAssociation), draft: x.isDraft })),
  pr: l.item.pr
    ? { draft: l.item.pr.isDraft, additions: l.item.pr.additions, deletions: l.item.pr.deletions, changedFiles: l.item.pr.changedFiles, checks: l.item.pr.checks, files: l.item.pr.files.map((f) => f.path) }
    : null,
  suggestion: suggestionJson(l),
  classifyError: l.error
})

export const itemDetailJson = (l: Loaded, profile: RepoProfile, ctx: AgentContext) => {
  const base = itemSummaryJson(l, profile)
  const preview = l.plan && l.assessment ? previewAccept(l.item, l.plan, l.assessment, profile, ctx.links) : null
  return {
    ...base,
    body: l.item.body,
    commentsText: l.item.comments.map((c) => ({ author: c.author, createdAt: c.createdAt, body: c.body })),
    assessment: l.assessment
      ? {
        model: l.assessment.model,
        cached: l.assessment.cached ?? false,
        category: l.assessment.category,
        component: l.assessment.component,
        language: l.assessment.language,
        inScope: l.assessment.inScope,
        complete: l.assessment.complete,
        agentAuthored: l.assessment.agentAuthored,
        severity: l.assessment.severity,
        value: l.assessment.value,
        risk: l.assessment.risk
      }
      : null,
    acceptPreview: preview ? { ...planJson(preview), propagations: propagate(l.item, l.plan!.action, preview, profile).map(propagationJson) } : null,
    commands: commandsFor(l, ctx)
  }
}

export const planJson = (p: ResolvedPlan) => ({
  comment: p.comment,
  labelsAdded: p.labelsToAdd,
  labelsRemoved: p.labelsToRemove,
  assignees: p.assignees,
  reviewers: p.reviewers,
  close: p.close
})

export const propagationJson = (p: { target: { number: number; kind: string; title: string }; why: string; plan: ResolvedPlan }) => ({
  number: p.target.number,
  kind: p.target.kind,
  title: p.target.title,
  why: p.why,
  ...planJson(p.plan)
})

const round = (n: number) => Math.round(n * 1000) / 1000

/** Ready-to-run commands so an agent never has to compose flags from memory. */
export const commandsFor = (l: Loaded, ctx: AgentContext) => {
  const n = l.item.number
  const base = `pxt apply ${n} --repo ${repoSlug(ctx.repo)} --json`
  const cmds: Record<string, string> = {}
  if (l.plan && !l.plan.uncertain) cmds["accept"] = `${base} --accept`
  cmds["needs_info"] = `${base} --action needs-info --template <${templatesFor(NEEDS_INFO_TEMPLATES, l.item.kind).map((t) => t.id).join("|")}> [--comment "..."]`
  if (l.item.kind === "issue") {
    cmds["bug"] = `${base} --action bug [--assign <login>|--assign-me] [--label <name>]...`
    cmds["feature"] = `${base} --action feature [--when now|backlog|roadmap] [--assign <login>]`
  } else {
    cmds["review"] = `${base} --action review [--reviewer <login>]... [--label <name>]...`
  }
  cmds["close"] = `${base} --action close --template <${templatesFor(CLOSE_TEMPLATES, l.item.kind).map((t) => t.id).join("|")}> [--comment "..."]`
  cmds["skip"] = `${base} --action skip`
  cmds["dry_run"] = `append --dry-run to any command to preview without changing GitHub`
  return cmds
}

const previewAccept = (item: TriageItem, plan: TriagePlan, assessment: Assessment, profile: RepoProfile, links?: RepoLinks): ResolvedPlan | null =>
  Effect.runSync(quickApply(item, plan, assessment, profile, undefined, links).pipe(Effect.catch(() => Effect.succeed(null)))) as ResolvedPlan | null

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface ApplyFlags {
  readonly action: ActionKind | null
  readonly accept: boolean
  readonly assign: string | null
  readonly assignMe: boolean
  readonly reviewers: ReadonlyArray<string>
  readonly labels: ReadonlyArray<string>
  readonly when: "now" | "backlog" | "roadmap" | null
  readonly template: string | null
  readonly comment: string | null
  readonly propagateLinks: boolean
  readonly dryRun: boolean
  readonly force: boolean
}

export class ApplyError extends Error {
  readonly _tag = "ApplyError"
}

/** Turn flags into the same ResolvedPlan the TUI would produce. */
export const resolveFromFlags = Effect.fnUntraced(function*(l: Loaded, flags: ApplyFlags, profile: RepoProfile, me: string | null, links?: RepoLinks) {
  const item = l.item
  const action: ActionKind | null = flags.accept ? (l.plan?.action ?? null) : flags.action
  if (!action) return yield* Effect.fail(new ApplyError(flags.accept ? "nothing to accept: the item has no suggestion (classification failed or was uncertain)" : "--action or --accept is required"))
  if (flags.accept && l.plan?.uncertain && !flags.force) return yield* Effect.fail(new ApplyError(`the suggestion (${l.plan.action}) is uncertain; pass --action explicitly or --force to accept it anyway`))
  if (action === "skip") return { action, resolved: null as ResolvedPlan | null }
  if (item.kind === "pull_request" && (action === "bug" || action === "feature")) return yield* Effect.fail(new ApplyError(`a pull request cannot be triaged as "${action}"; use review, needs-info, or close`))
  if (item.kind === "issue" && action === "review") return yield* Effect.fail(new ApplyError(`an issue cannot be triaged as "review"; use bug, feature, needs-info, or close`))

  const assignee: string | null | undefined = flags.assignMe ? (me ?? undefined) : flags.assign !== null ? flags.assign : undefined
  if (flags.assignMe && !me) return yield* Effect.fail(new ApplyError("--assign-me needs an authenticated GitHub user"))

  let resolved: ResolvedPlan
  if (flags.accept && l.plan && l.assessment) {
    const quick = yield* quickApply(item, l.plan, l.assessment, profile, assignee, links).pipe(Effect.catch(() => Effect.succeed(null)))
    if (!quick) return yield* Effect.fail(new ApplyError("the default template needs a hand-written comment; pass --comment"))
    resolved = quick
  } else {
    resolved = yield* buildExplicit(l, action, flags, profile, assignee, links)
  }
  // Extra labels / reviewers from flags are additive.
  if (flags.labels.length) resolved = { ...resolved, labelsToAdd: dedupe(item, [...resolved.labelsToAdd, ...flags.labels]) }
  if (flags.reviewers.length) resolved = { ...resolved, reviewers: { users: [...new Set([...resolved.reviewers.users, ...flags.reviewers])], teams: resolved.reviewers.teams } }
  if (flags.comment !== null && !resolved.comment && (action === "bug" || action === "feature" || action === "review")) resolved = { ...resolved, comment: flags.comment }
  const propagations = flags.propagateLinks ? propagate(item, action, resolved, profile) : []
  return { action, resolved: { ...resolved, propagations } as ResolvedPlan }
})

const buildExplicit = Effect.fnUntraced(function*(l: Loaded, action: ActionKind, flags: ApplyFlags, profile: RepoProfile, assignee: string | null | undefined, links?: RepoLinks) {
  const item = l.item
  const plan = l.plan
  const ctx = { author: item.author, number: item.number, title: item.title, links }
  const base: ResolvedPlan = { comment: null, labelsToAdd: [], labelsToRemove: removeTriage(item), assignees: [], reviewers: { users: [], teams: [] }, close: null }
  const commentFrom = (templates: ReadonlyArray<Template>, fallbackPick: Template | null) =>
    Effect.gen(function*() {
      const template = flags.template ? templatesFor(templates, item.kind).find((t) => t.id === flags.template) ?? null : fallbackPick
      if (flags.template && !template) return yield* Effect.fail(new ApplyError(`unknown template "${flags.template}"; valid: ${templatesFor(templates, item.kind).map((t) => t.id).join(", ")}`))
      const body = flags.comment ?? (template ? renderTemplate(template, ctx) : null)
      if (!body) return yield* Effect.fail(new ApplyError(`${action} needs --template <id> or --comment <text>`))
      if (/#NNN/.test(body)) return yield* Effect.fail(new ApplyError(`template "${template?.id}" has a #NNN placeholder; pass --comment with the real number`))
      return { body, template }
    })
  switch (action) {
    case "needs_info": {
      const fallback = l.assessment ? pickDefaultTemplate(templatesFor(NEEDS_INFO_TEMPLATES, item.kind), item, l.assessment) : null
      const { body, template } = yield* commentFrom(NEEDS_INFO_TEMPLATES, fallback)
      return { ...base, comment: body, labelsToAdd: dedupe(item, [workflowLabel(profile, "needsInfo"), ...(plan?.labelsToAdd ?? []), ...templateLabels(profile, template)]) }
    }
    case "bug": {
      const owner = assignee === undefined ? plan?.suggestedAssignees[0] : assignee
      return { ...base, labelsToAdd: dedupe(item, plan?.labelsToAdd ?? [workflowLabel(profile, "bug")]), assignees: owner ? [owner] : [] }
    }
    case "feature": {
      const when = flags.when ?? (assignee ? "now" : (l.assessment?.value?.level ?? 0) >= 2 ? "now" : "backlog")
      const owner = assignee === undefined ? (when === "now" ? plan?.suggestedAssignees[0] : undefined) : assignee
      const extra = when === "backlog" ? [workflowLabel(profile, "backlog")] : when === "roadmap" ? [workflowLabel(profile, "roadmap")] : []
      return { ...base, labelsToAdd: dedupe(item, [...(plan?.labelsToAdd ?? [workflowLabel(profile, "enhancement")]), ...extra]), assignees: owner ? [owner] : [] }
    }
    case "review": {
      const already = item.pr?.requestedReviewers ?? []
      const user = assignee === undefined ? plan?.suggestedReviewers.users.find((u) => !already.includes(u)) : assignee
      return { ...base, labelsToAdd: dedupe(item, plan?.labelsToAdd ?? []), reviewers: { users: user ? [user] : [], teams: [] } }
    }
    case "close": {
      const fallback = l.assessment ? pickDefaultTemplate(templatesFor(CLOSE_TEMPLATES, item.kind), item, l.assessment) : null
      const { body, template } = yield* commentFrom(CLOSE_TEMPLATES, fallback)
      return { ...base, comment: body, labelsToAdd: dedupe(item, [...templateLabels(profile, template), ...(plan?.labelsToAdd ?? [])]), close: "not_planned" as const }
    }
    case "skip":
      return base
  }
})

/** Execute, log the decision, annotate Phoenix. Returns the executor reports. */
export const executePlan = Effect.fnUntraced(function*(l: Loaded, action: ActionKind, resolved: ResolvedPlan | null, ctx: AgentContext, dryRun: boolean, me: string | null) {
  const executor = yield* Executor
  const phoenix = yield* Phoenix
  const slug = repoSlug(ctx.repo)
  const selfAssigned = me !== null && (resolved?.assignees.includes(me) ?? false)
  yield* appendDecision(
    makeDecision({
      repo: slug,
      item: l.item,
      assessment: l.assessment,
      plan: l.plan,
      chosen: action,
      labelsAdded: resolved?.labelsToAdd ?? [],
      assignees: resolved?.assignees ?? [],
      dryRun,
      selfAssigned,
      classifySpanId: l.classifySpanId,
      actor: ctx.actor
    })
  )
  if (l.classifySpanId && !dryRun) {
    yield* phoenix.annotateClassification(l.classifySpanId, {
      chosen: action,
      suggested: l.plan?.action ?? null,
      accepted: l.plan !== null && l.plan.action === action,
      labels: resolved?.labelsToAdd ?? [],
      assignees: resolved?.assignees ?? [],
      selfAssigned,
      triager: ctx.actor,
      annotatorKind: ctx.actor.startsWith("agent:") ? "LLM" : "HUMAN"
    })
  }
  if (!resolved) return []
  yield* executor.submit(ctx.repo, l.item, resolved)
  return yield* executor.drain
})

export const actionTitle = (a: ActionKind) => ACTION_TITLES[a]
export const queueLabelOf = (ctx: AgentContext) => ctx.label || TRIAGE_LABEL
export const describePlan = describe
