/**
 * Applies a resolved plan to GitHub in the background so the UI never waits
 * on the network. Results are collected and printed before the next prompt,
 * and everything is drained before the process exits.
 */
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions"
import { Context, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { GitHub, type GitHubError } from "../github/GitHub.ts"
import type { LinkedItem, Repo, TriageItem } from "../github/model.ts"
import type { Propagation } from "./links.ts"

export interface ResolvedPlan {
  readonly labelsToAdd: ReadonlyArray<string>
  readonly labelsToRemove: ReadonlyArray<string>
  readonly assignees: ReadonlyArray<string>
  readonly reviewers: { readonly users: ReadonlyArray<string>; readonly teams: ReadonlyArray<string> }
  readonly comment: string | null
  readonly close: "completed" | "not_planned" | null
  /** Follow-on changes to linked items (see links.ts). */
  readonly propagations?: ReadonlyArray<Propagation>
}

export interface Report {
  readonly item: TriageItem
  readonly ok: boolean
  readonly summary: string
  readonly error?: string
}

export class Executor extends Context.Service<Executor, {
  readonly submit: (repo: Repo, item: TriageItem, plan: ResolvedPlan) => Effect.Effect<void>
  /** Reports that finished since the last call. */
  readonly takeReports: Effect.Effect<ReadonlyArray<Report>>
  /** Wait for everything in flight, then return all remaining reports. */
  readonly drain: Effect.Effect<ReadonlyArray<Report>>
  readonly pendingCount: Effect.Effect<number>
}>()("px-triage/triage/Executor") {
  static readonly layer = (options: { readonly dryRun: boolean }) =>
    Layer.effect(
      Executor,
      Effect.gen(function*() {
        const github = yield* GitHub
        const fibers = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void, never>>>([])
        const reports = yield* Ref.make<ReadonlyArray<Report>>([])
        const pending = yield* Ref.make(0)

        const applyTo = Effect.fnUntraced(function*(repo: Repo, target: { number: number; kind: TriageItem["kind"] }, plan: ResolvedPlan) {
          const n = target.number
          if (plan.comment) yield* github.comment(repo, n, plan.comment)
          yield* github.addLabels(repo, n, plan.labelsToAdd)
          for (const label of plan.labelsToRemove) yield* github.removeLabel(repo, n, label)
          yield* github.assign(repo, n, plan.assignees)
          if (target.kind === "pull_request") {
            yield* github.requestReviewers(repo, n, plan.reviewers.users, plan.reviewers.teams)
          }
          if (plan.close) {
            if (target.kind === "pull_request") yield* github.closePullRequest(repo, n)
            else yield* github.close(repo, n, plan.close)
          }
        })

        const applyBody = Effect.fnUntraced(function*(repo: Repo, item: TriageItem, plan: ResolvedPlan) {
          yield* applyTo(repo, item, plan)
          for (const p of plan.propagations ?? []) yield* applyTo(repo, p.target, p.plan)
          yield* Effect.annotateCurrentSpan({
            [SemanticConventions.OUTPUT_VALUE]: JSON.stringify({
              applied: `#${item.number} ${describe(plan)}`,
              propagated: (plan.propagations ?? []).map((p) => `#${p.target.number} ${describe(p.plan)}`)
            }),
            [SemanticConventions.OUTPUT_MIME_TYPE]: "application/json"
          })
        })

        /** One root CHAIN trace per applied plan, with each GitHub call as a TOOL child. */
        const apply = (repo: Repo, item: TriageItem, plan: ResolvedPlan) =>
          applyBody(repo, item, plan).pipe(
            Effect.withSpan("triage.apply", {
              root: true,
              attributes: {
                [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
                [SemanticConventions.INPUT_VALUE]: JSON.stringify({ number: item.number, kind: item.kind, title: item.title, url: item.url, ...plan, propagations: (plan.propagations ?? []).map((p) => ({ number: p.target.number, why: p.why })) }),
                [SemanticConventions.INPUT_MIME_TYPE]: "application/json",
                "github.number": item.number,
                "github.kind": item.kind
              }
            })
          )

        const submit = (repo: Repo, item: TriageItem, plan: ResolvedPlan) =>
          Effect.gen(function*() {
            const summary = describe(plan)
            if (options.dryRun) {
              yield* Ref.update(reports, (rs) => [...rs, { item, ok: true, summary: `[dry-run] ${summary}` }])
              return
            }
            yield* Ref.update(pending, (p) => p + 1)
            const fiber = yield* apply(repo, item, plan).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Ref.update(reports, (rs) => [
                  ...rs,
                  Exit.isSuccess(exit)
                    ? { item, ok: true, summary }
                    : { item, ok: false, summary, error: renderError(exit) }
                ])
              ),
              Effect.ensuring(Ref.update(pending, (p) => p - 1)),
              Effect.forkDetach
            )
            yield* Ref.update(fibers, (fs) => [...fs, fiber])
          })

        const takeReports = Ref.getAndSet(reports, [])

        const drain = Effect.gen(function*() {
          const fs = yield* Ref.getAndSet(fibers, [])
          yield* Fiber.awaitAll(fs)
          return yield* takeReports
        })

        return Executor.of({ submit, takeReports, drain, pendingCount: Ref.get(pending) })
      })
    )
}

const renderError = (exit: Exit.Exit<void, GitHubError>): string =>
  Exit.isFailure(exit) ? String(exit.cause) : "unknown"

export const describe = (plan: ResolvedPlan): string => {
  const parts: Array<string> = []
  if (plan.comment) parts.push("comment")
  if (plan.labelsToAdd.length) parts.push(`+[${plan.labelsToAdd.join(", ")}]`)
  if (plan.labelsToRemove.length) parts.push(`-[${plan.labelsToRemove.join(", ")}]`)
  if (plan.assignees.length) parts.push(`assign ${plan.assignees.map((a) => "@" + a).join(" ")}`)
  const rev = [...plan.reviewers.users.map((u) => "@" + u), ...plan.reviewers.teams.map((t) => "@arize-ai/" + t)]
  if (rev.length) parts.push(`review ${rev.join(" ")}`)
  if (plan.close) parts.push(`close (${plan.close})`)
  if (plan.propagations?.length) parts.push(`+${plan.propagations.length} linked (${plan.propagations.map((p) => `#${p.target.number}`).join(" ")})`)
  return parts.length ? parts.join(" · ") : "no changes"
}

export const describeTarget = (t: LinkedItem): string => `${t.kind === "pull_request" ? "PR" : "issue"} #${t.number}`
