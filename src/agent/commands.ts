/**
 * `pxt queue | show | apply | next`: stateless, JSON-first commands for agents.
 */
import { Console, Effect, Option } from "effect"
import { GitHub, type QueueFilter } from "../github/GitHub.ts"
import { type Repo, repoSlug } from "../github/model.ts"
import { bold, cyan, dim, green, red, yellow } from "../ui/ansi.ts"
import { renderAssessment, renderBody, renderHeader } from "../ui/render.ts"
import { labelColors } from "../triage/profile.ts"
import {
  type AgentContext,
  type ApplyFlags,
  ApplyError,
  SCHEMA,
  commandsFor,
  describePlan,
  executePlan,
  itemDetailJson,
  itemSummaryJson,
  loadItem,
  loadItems,
  loadProfile,
  loadQueueNumbers,
  planJson,
  propagationJson,
  resolveFromFlags
} from "./core.ts"

export const EXIT_EMPTY = 3

const emit = (json: boolean, data: unknown, human: () => Effect.Effect<void>) =>
  json ? Console.log(JSON.stringify(data, null, 2)) : human()

export const runQueue = Effect.fnUntraced(function*(ctx: AgentContext, input: { only: QueueFilter; limit: number; classify: boolean; concurrency: number; json: boolean }) {
  const profile = yield* loadProfile(ctx.repo)
  const numbers = yield* loadQueueNumbers(ctx, input.only, input.limit)
  const loaded = yield* loadItems(ctx, numbers, profile, input.classify, input.concurrency)
  const items = loaded.map((l) => itemSummaryJson(l, profile))
  const data = { schema: SCHEMA, repo: repoSlug(ctx.repo), label: ctx.label, session: ctx.sessionId, count: items.length, items }
  yield* emit(input.json, data, () =>
    Effect.gen(function*() {
      if (items.length === 0) {
        yield* Console.log(green(`Nothing labeled "${ctx.label}" in ${repoSlug(ctx.repo)}.`))
        return
      }
      for (const i of items) {
        const s = i.suggestion
        yield* Console.log(`${i.kind === "pull_request" ? cyan("PR   ") : cyan("ISSUE")} ${bold(`#${i.number}`)} ${i.title}`)
        yield* Console.log(`      ${dim(`@${i.author} · ${i.labels.join(", ") || "no labels"}`)}${s ? ` → ${s.uncertain ? yellow(s.action + " (uncertain)") : green(s.action)} ${dim(`${Math.round(s.confidence * 100)}% · ${s.category}`)}` : i.classifyError ? red(`  classify failed: ${i.classifyError}`) : ""}`)
      }
    })
  )
  if (items.length === 0) process.exitCode = EXIT_EMPTY
})

export const runShow = Effect.fnUntraced(function*(ctx: AgentContext, number: number, json: boolean) {
  const github = yield* GitHub
  const profile = yield* loadProfile(ctx.repo)
  const item = yield* github.fetchItem(ctx.repo, number)
  const l = yield* loadItem(item, ctx, profile)
  const data = { schema: SCHEMA, repo: repoSlug(ctx.repo), session: ctx.sessionId, item: itemDetailJson(l, profile, ctx) }
  yield* emit(json, data, () =>
    Effect.gen(function*() {
      const colors = labelColors(profile)
      yield* Console.log(renderHeader(l.item, 0, 1, colors))
      yield* Console.log(renderBody(l.item, 60))
      if (l.assessment && l.plan) yield* Console.log(renderAssessment(l.assessment, l.plan, colors))
      else if (l.error) yield* Console.log(red(`classifier failed: ${l.error}`))
      yield* Console.log(bold("\nCommands"))
      for (const [k, v] of Object.entries(commandsFor(l, ctx))) yield* Console.log(`  ${k.padEnd(11)} ${dim(v)}`)
    })
  )
})

export const runNext = Effect.fnUntraced(function*(ctx: AgentContext, input: { only: QueueFilter; json: boolean }) {
  const numbers = yield* loadQueueNumbers(ctx, input.only, 1)
  const head = numbers[0]
  if (head === undefined) {
    const data = { schema: SCHEMA, repo: repoSlug(ctx.repo), label: ctx.label, empty: true }
    yield* emit(input.json, data, () => Console.log(green(`Nothing labeled "${ctx.label}" in ${repoSlug(ctx.repo)}. Queue empty.`)))
    process.exitCode = EXIT_EMPTY
    return
  }
  yield* runShow(ctx, head, input.json)
})

export const runApply = Effect.fnUntraced(function*(ctx: AgentContext, number: number, flags: ApplyFlags, json: boolean) {
  const github = yield* GitHub
  const profile = yield* loadProfile(ctx.repo)
  const me = yield* github.viewer.pipe(Effect.orElseSucceed(() => null))
  const item = yield* github.fetchItem(ctx.repo, number)
  if (!item.labels.includes(ctx.label) && !flags.force) {
    const data = { schema: SCHEMA, repo: repoSlug(ctx.repo), number, alreadyTriaged: true, labels: item.labels, hint: "pass --force to act anyway" }
    yield* emit(json, data, () => Console.log(yellow(`#${number} no longer carries "${ctx.label}" (labels: ${item.labels.join(", ") || "none"}); pass --force to act anyway`)))
    return
  }
  const l = yield* loadItem(item, ctx, profile)
  const { action, resolved } = yield* resolveFromFlags(l, flags, profile, me, ctx.links)
  const reports = yield* executePlan(l, action, resolved, ctx, flags.dryRun, me)
  const propagations = resolved?.propagations ?? []
  const data = {
    schema: SCHEMA,
    repo: repoSlug(ctx.repo),
    session: ctx.sessionId,
    number,
    kind: item.kind,
    action,
    accepted: l.plan !== null && l.plan.action === action,
    suggested: l.plan?.action ?? null,
    dryRun: flags.dryRun,
    actor: ctx.actor,
    applied: resolved ? planJson(resolved) : null,
    propagations: propagations.map(propagationJson),
    results: reports.map((r) => ({ number: r.item.number, ok: r.ok, summary: r.summary, error: r.error ?? null }))
  }
  yield* emit(json, data, () =>
    Effect.gen(function*() {
      yield* Console.log(`${green("✔")} #${number} ${bold(action)}${flags.dryRun ? yellow(" (dry run)") : ""}: ${resolved ? describePlan(resolved) : "no changes"}`)
      for (const p of propagations) yield* Console.log(`  ${cyan("↳")} #${p.target.number} ${dim(p.why)}: ${describePlan(p.plan)}`)
      for (const r of reports) if (!r.ok) yield* Console.log(red(`  ✖ #${r.item.number} ${r.error ?? "failed"}`))
    })
  )
  if (reports.some((r) => !r.ok)) process.exitCode = 1
})

export const emitError = (json: boolean, e: unknown) => {
  const message = e instanceof ApplyError ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e)
  const usage = e instanceof ApplyError
  if (json) console.error(JSON.stringify({ schema: SCHEMA, error: message, usage }))
  else console.error(red(message))
  process.exitCode = usage ? 2 : 1
  return Effect.void
}

export const parseActionFlag = (s: string): ApplyFlags["action"] => {
  const map: Record<string, ApplyFlags["action"]> = { "needs-info": "needs_info", needs_info: "needs_info", bug: "bug", feature: "feature", review: "review", close: "close", skip: "skip" }
  return map[s] ?? null
}

export const agentContext = (repo: Repo, label: string, session: Option.Option<string>, actor: Option.Option<string>, me: string | null, sessionId: string, links?: AgentContext["links"]): AgentContext => ({
  repo,
  label,
  sessionId,
  links,
  // Non-interactive runs are agents unless told otherwise; humans at a TTY keep their login.
  actor: Option.getOrElse(actor, () => (process.stdout.isTTY && me ? me : `agent:${process.env["PX_TRIAGE_AGENT"] ?? "unknown"}`))
})
