/**
 * Applies a resolved plan to GitHub in the background so the UI never waits
 * on the network. Results are collected and printed before the next prompt,
 * and everything is drained before the process exits.
 */
import { Context, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { GitHub, type GitHubError } from "../github/GitHub.js"
import type { Repo, TriageItem } from "../github/model.js"

export interface ResolvedPlan {
  readonly labelsToAdd: ReadonlyArray<string>
  readonly labelsToRemove: ReadonlyArray<string>
  readonly assignees: ReadonlyArray<string>
  readonly reviewers: { readonly users: ReadonlyArray<string>; readonly teams: ReadonlyArray<string> }
  readonly comment: string | null
  readonly close: "completed" | "not_planned" | null
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

        const apply = Effect.fn("Executor.apply")(function*(repo: Repo, item: TriageItem, plan: ResolvedPlan) {
          const n = item.number
          if (plan.comment) yield* github.comment(repo, n, plan.comment)
          yield* github.addLabels(repo, n, plan.labelsToAdd)
          for (const label of plan.labelsToRemove) yield* github.removeLabel(repo, n, label)
          yield* github.assign(repo, n, plan.assignees)
          if (item.kind === "pull_request") {
            yield* github.requestReviewers(repo, n, plan.reviewers.users, plan.reviewers.teams)
          }
          if (plan.close) {
            if (item.kind === "pull_request") yield* github.closePullRequest(repo, n)
            else yield* github.close(repo, n, plan.close)
          }
        })

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
  return parts.length ? parts.join(" · ") : "no changes"
}
