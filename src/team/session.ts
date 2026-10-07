/**
 * `pxt team`: what should I work on or unblock next, strictly from my team.
 *
 * Unlike the triage queue, most "actions" here happen in GitHub's UI
 * (reviewing, merging). The loop's job is to surface the right item with the
 * reason it needs you, and offer the few things a terminal can do: take it,
 * put yourself on review, nudge whoever it is waiting on, open it, or mark it
 * done until it changes.
 */
import { Console, Effect } from "effect"
import { GitHub } from "../github/GitHub.ts"
import { type Repo, type TriageItem, repoSlug } from "../github/model.ts"
import { Executor } from "../triage/executor.ts"
import { RepoProfiles, labelColors } from "../triage/profile.ts"
import { bold, cyan, dim, green, red, yellow } from "../ui/ansi.ts"
import { type Hotkey, hotkeyMenu } from "../ui/keys.ts"
import { renderMarkdown } from "../ui/markdown.ts"
import { page } from "../ui/pager.ts"
import { openInBrowser } from "../ui/prompts.ts"
import { renderBody, renderHeader } from "../ui/render.ts"
import { BUCKET_ORDER, BUCKET_TITLES, type Bucket, type TeamItem, bucketTeamItems } from "./buckets.ts"
import { isSnoozed, readSnoozes, snooze } from "./snooze.ts"

export interface TeamOptions {
  readonly repo: Repo
  readonly queueLabel: string
  readonly limit: number
  readonly only: "all" | "issues" | "prs"
  readonly everyone: boolean
  readonly windowDays: number
  readonly includeSnoozed: boolean
  readonly json: boolean
  readonly dryRun: boolean
}

type Choice = "open" | "take" | "nudge" | "done" | "skip" | "view" | "quit"

export const loadTeamQueue = Effect.fnUntraced(function*(options: TeamOptions) {
  const github = yield* GitHub
  const me = yield* github.viewer
  const profile = yield* (yield* RepoProfiles).load(options.repo)
  const slug = repoSlug(options.repo)
  const t0 = performance.now()
  if (!options.json) yield* Console.log(dim(`  scanning open PRs and issues in ${slug} (up to ${options.limit} each)…`))
  const items = yield* github.fetchTeamItems(options.repo, me, options.limit)
  const snoozes = yield* readSnoozes
  let queue = bucketTeamItems(items, profile, { me, queueLabel: options.queueLabel, everyone: options.everyone, windowDays: options.windowDays })
  if (options.only !== "all") queue = queue.filter((t) => (options.only === "prs") === (t.item.kind === "pull_request"))
  const hidden = queue.filter((t) => isSnoozed(snoozes, slug, t.item.number, t.item.updatedAt)).length
  if (!options.includeSnoozed) queue = queue.filter((t) => !isSnoozed(snoozes, slug, t.item.number, t.item.updatedAt))
  return { me, profile, queue, hidden, scanned: items.length, ms: Math.round(performance.now() - t0) }
})

export const runTeam = Effect.fnUntraced(function*(options: TeamOptions) {
  const { me, profile, queue, hidden, scanned, ms } = yield* loadTeamQueue(options)
  const slug = repoSlug(options.repo)

  if (options.json) {
    yield* Console.log(JSON.stringify({
      schema: 1,
      repo: slug,
      me,
      scanned,
      hidden,
      count: queue.length,
      buckets: BUCKET_ORDER.map((b) => ({ bucket: b, title: BUCKET_TITLES[b], count: queue.filter((t) => t.bucket === b).length })).filter((b) => b.count > 0),
      items: queue.map((t) => ({
        number: t.item.number,
        kind: t.item.kind,
        title: t.item.title,
        url: t.item.url,
        author: t.item.author,
        bucket: t.bucket,
        why: t.why,
        waitingOn: t.waitingOn,
        idleHours: Math.round(t.ageHours),
        labels: t.item.labels,
        assignees: t.item.assignees,
        pr: t.item.pr ? { draft: t.item.pr.isDraft, checks: t.item.pr.checks, reviewDecision: t.item.pr.reviewDecision, requestedReviewers: t.item.pr.requestedReviewers, additions: t.item.pr.additions, deletions: t.item.pr.deletions } : null
      }))
    }, null, 2))
    if (queue.length === 0) process.exitCode = 3
    return
  }

  yield* Console.log(`${green("✔")} ${"team queue".padEnd(13)} ${dim(`${queue.length} item${queue.length === 1 ? "" : "s"} from your team need you · scanned ${scanned} open · ${hidden} done-until-changed · ${ms}ms`)}`)
  if (queue.length === 0) {
    yield* Console.log(green(`Nothing from your team is waiting on you in ${slug}.`))
    if (hidden > 0) yield* Console.log(dim(`${hidden} item${hidden === 1 ? "" : "s"} marked done will reappear when they change; --include-snoozed shows them now.`))
    return
  }
  yield* Console.log(
    "  " + BUCKET_ORDER.map((b) => ({ b, n: queue.filter((t) => t.bucket === b).length })).filter((x) => x.n > 0).map((x) => `${bold(String(x.n))} ${dim(BUCKET_TITLES[x.b].toLowerCase())}`).join(dim("  ·  "))
  )

  const executor = yield* Executor
  const colors = labelColors(profile)
  let index = 0
  let handled = 0
  while (index < queue.length) {
    const t = queue[index]!
    yield* printReports(yield* executor.takeReports)
    yield* Console.log("\n" + renderHeader(t.item, index, queue.length, colors))
    yield* Console.log(`  ${bucketBadge(t.bucket)} ${t.why} ${dim(`· waiting on ${t.waitingOn === "you" ? bold("you") : "@" + t.waitingOn} · idle ${Math.round(t.ageHours)}h`)}`)
    if (t.item.pr) {
      const p = t.item.pr
      const reviews = p.reviews.map((r) => `${r.state === "APPROVED" ? green("✔") : r.state === "CHANGES_REQUESTED" ? red("✖") : dim("·")} @${r.author}`).join("  ")
      if (reviews) yield* Console.log(`  ${dim("reviews")} ${reviews}`)
    }
    yield* Console.log(renderBody(t.item, 14))

    const choice = yield* hotkeyMenu<Choice>({
      keys: keysFor(t, me),
      defaultValue: "open",
      render: (keys) => `\n  ${bold(green("[Enter]"))} ${green("open in browser")}   ${keys.filter((k) => k.key !== "o").map((k) => `${bold(cyan(`[${k.key}]`))} ${k.label}`).join("   ")}`
    })

    switch (choice) {
      case "quit":
        index = queue.length
        continue
      case "skip":
        index++
        continue
      case "open":
        yield* openInBrowser(t.item.url)
        continue
      case "view": {
        const width = Math.min(process.stdout.columns ?? 100, 110) - 2
        yield* page(`${t.item.shortKind} #${t.item.number} · ${t.item.title}`, renderMarkdown(t.item.body || "_(no description)_", width))
        continue
      }
      case "take": {
        const plan = t.item.kind === "pull_request"
          ? { comment: null, labelsToAdd: [], labelsToRemove: [], assignees: [], reviewers: { users: [me], teams: [] }, close: null }
          : { comment: null, labelsToAdd: [], labelsToRemove: [], assignees: [me], reviewers: { users: [], teams: [] }, close: null }
        yield* executor.submit(options.repo, t.item, plan)
        yield* Console.log(`  ${green("↳")} ${t.item.kind === "pull_request" ? "requested your review" : "assigned to you"}`)
        yield* snooze(slug, t.item.number, t.item.updatedAt)
        handled++
        index++
        continue
      }
      case "nudge": {
        const body = nudgeComment(t, me)
        yield* Console.log(body.split("\n").map((l) => dim("  ┆ ") + l).join("\n"))
        yield* executor.submit(options.repo, t.item, { comment: body, labelsToAdd: [], labelsToRemove: [], assignees: [], reviewers: { users: [], teams: [] }, close: null })
        yield* snooze(slug, t.item.number, t.item.updatedAt)
        handled++
        index++
        continue
      }
      case "done":
        yield* snooze(slug, t.item.number, t.item.updatedAt)
        yield* Console.log(dim("  hidden until it changes"))
        handled++
        index++
        continue
    }
  }
  yield* printReports(yield* executor.drain)
  yield* Console.log(bold(`\n${handled} of ${queue.length} handled${options.dryRun ? " (dry run, nothing was changed)" : ""}.`))
})

const keysFor = (t: TeamItem, me: string): Array<Hotkey<Choice>> => {
  const keys: Array<Hotkey<Choice>> = [{ key: "o", label: "open", value: "open" }]
  if (t.item.kind === "pull_request") {
    if (!t.item.pr?.requestedReviewers.includes(me) && t.item.author !== me) keys.push({ key: "t", label: "take: request my review", value: "take" })
  } else if (!t.item.assignees.includes(me)) {
    keys.push({ key: "t", label: "take: assign me", value: "take" })
  }
  if (t.waitingOn !== "you") keys.push({ key: "n", label: `nudge @${t.waitingOn === "author" ? t.item.author : t.waitingOn}`, value: "nudge" })
  keys.push({ key: "d", label: "done until it changes", value: "done" })
  keys.push({ key: "s", label: "skip", value: "skip" })
  keys.push({ key: "v", label: "view markdown", value: "view" })
  keys.push({ key: "q", label: "quit", value: "quit" })
  return keys
}

const nudgeComment = (t: TeamItem, me: string): string => {
  const who = t.waitingOn === "author" ? t.item.author : t.waitingOn
  switch (t.bucket) {
    case "needs_review":
      return `@${who} gentle ping: this has been waiting for a review for about ${Math.round(t.ageHours / 24) || 1} day${Math.round(t.ageHours / 24) > 1 ? "s" : ""}. Happy to take it if you're swamped, just say so.`
    case "ready_to_merge":
      return `@${who} this is approved and green; anything blocking the merge? Shout if you want me to merge it.`
    case "ci_failing":
      return `@${who} checks are failing here; let me know if you need a hand getting them green.`
    case "re_review":
      return `@${who} looks like changes landed since your review; could you take another look when you get a chance?`
    default:
      return `@${who} checking in on this one, is anything blocking it? (from @${me})`
  }
}

const bucketBadge = (b: Bucket): string => {
  const text = ` ${BUCKET_TITLES[b]} `
  switch (b) {
    case "review_requested":
    case "mine":
      return red(bold(text))
    case "re_review":
    case "ci_failing":
      return yellow(bold(text))
    default:
      return cyan(bold(text))
  }
}

const printReports = (reports: ReadonlyArray<{ item: TriageItem; ok: boolean; summary: string; error?: string }>) =>
  Effect.forEach(reports, (r) => Console.log(r.ok ? `${green("✔")} #${r.item.number} ${r.summary}` : `${red("✖")} #${r.item.number} ${r.summary} ${r.error ?? ""}`), { discard: true })

