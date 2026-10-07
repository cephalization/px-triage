/**
 * The team queue: open items from teammates, bucketed by what they are
 * waiting on. Pure, so the ordering rules are testable and auditable.
 *
 * Buckets, in the order they are shown. Review work first (it blocks
 * someone else), then your own plate, then unowned issues:
 *   review_requested  a teammate asked *you* to review
 *   re_review         you (or someone) requested changes and the author pushed since
 *   needs_review      teammate PR with no approval and nobody reviewing
 *   ready_to_merge    approved, checks green, not merged
 *   ci_failing        teammate PR with failing checks
 *   mine              assigned to you (issue or PR), most recently active first
 *   needs_owner       teammate issue with no assignee, opened within the window
 */
import type { TriageItem } from "../github/model.ts"
import { isMaintainer } from "../triage/links.ts"
import type { RepoProfile } from "../triage/profile.ts"

export type Bucket = "review_requested" | "mine" | "re_review" | "needs_review" | "ready_to_merge" | "ci_failing" | "needs_owner"

export const BUCKET_ORDER: ReadonlyArray<Bucket> = ["review_requested", "re_review", "needs_review", "ready_to_merge", "ci_failing", "mine", "needs_owner"]

/** Review buckets: longest-waiting first. Your plate and unowned issues: most recent activity first. */
const OLDEST_FIRST: ReadonlySet<Bucket> = new Set<Bucket>(["review_requested", "re_review", "needs_review", "ready_to_merge", "ci_failing"])

export const BUCKET_TITLES: Record<Bucket, string> = {
  review_requested: "Review requested from you",
  mine: "Assigned to you",
  re_review: "Author pushed after changes were requested",
  needs_review: "Teammate PR waiting for a reviewer",
  ready_to_merge: "Approved and green, not merged",
  ci_failing: "Teammate PR with failing checks",
  needs_owner: "Teammate issue with no owner"
}

export interface TeamItem {
  readonly item: TriageItem
  readonly bucket: Bucket
  /** One line on why it is here and what unblocks it. */
  readonly why: string
  /** Who the next move belongs to: you, the author, or another reviewer. */
  readonly waitingOn: "you" | "author" | string
  readonly ageHours: number
}

export interface BucketOptions {
  readonly me: string
  readonly queueLabel: string
  /** Include items from non-teammates too (default false). */
  readonly everyone?: boolean
  /** Unowned issues opened more than this many days ago are left out; default 14. */
  readonly windowDays?: number
  readonly now?: Date
}

const hours = (iso: string, now: Date) => Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000)

export const classifyTeamItem = (item: TriageItem, profile: RepoProfile, o: BucketOptions): TeamItem | null => {
  const now = o.now ?? new Date()
  const teammate = isMaintainer(profile, item.author, item.authorAssociation)
  if (!teammate && !o.everyone && !item.assignees.includes(o.me)) return null
  if (item.labels.includes(o.queueLabel)) return null // still in the triage queue; pxt handles it
  if (item.state !== "OPEN") return null
  const age = hours(item.updatedAt, now)
  const mk = (bucket: Bucket, why: string, waitingOn: TeamItem["waitingOn"]): TeamItem => ({ item, bucket, why, waitingOn, ageHours: age })

  if (item.kind === "pull_request" && item.pr) {
    const pr = item.pr
    if (item.author === o.me) {
      // Your own PRs only matter here when they are blocked on you.
      const changes = pr.reviews.find((r) => r.state === "CHANGES_REQUESTED")
      if (changes) return mk("mine", `@${changes.author} requested changes on your PR`, "you")
      if (pr.checks === "FAILURE" || pr.checks === "ERROR") return mk("mine", "checks are failing on your PR", "you")
      if (pr.reviewDecision === "APPROVED" && pr.checks !== "FAILURE") return mk("mine", "your PR is approved; merge it", "you")
      return null
    }
    if (pr.requestedReviewers.includes(o.me)) return mk("review_requested", `@${item.author} asked you to review`, "you")
    if (item.assignees.includes(o.me)) return mk("mine", "assigned to you", "you")
    if (pr.isDraft) return null
    const myReview = pr.reviews.find((r) => r.author === o.me)
    const changesRequested = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED")
    const approved = pr.reviews.some((r) => r.state === "APPROVED") || pr.reviewDecision === "APPROVED"
    const failing = pr.checks === "FAILURE" || pr.checks === "ERROR"
    if (changesRequested.length > 0) {
      const latest = changesRequested[0]!
      const pushedSince = item.updatedAt > latest.submittedAt
      if (pushedSince && (latest.author === o.me || !pr.reviews.some((r) => r.author === o.me))) {
        return mk("re_review", `@${item.author} pushed after @${latest.author} requested changes`, latest.author === o.me ? "you" : latest.author)
      }
      return null // waiting on the author
    }
    if (approved) {
      if (failing) return mk("ci_failing", "approved but checks are failing", "author")
      return mk("ready_to_merge", `approved${pr.mergeStateStatus === "BEHIND" ? ", branch is behind main" : ""}; nobody has merged it`, item.author)
    }
    if (failing) return mk("ci_failing", "checks are failing and it has no review yet", "author")
    if (myReview) return null // you already weighed in; ball is elsewhere
    const otherRequested = pr.requestedReviewers.filter((r) => r !== o.me && !r.startsWith("team:"))
    return mk("needs_review", otherRequested.length ? `waiting on @${otherRequested.join(" @")} for ${Math.round(age)}h` : "no reviewer requested", otherRequested[0] ?? "you")
  }

  // Issues
  if (item.assignees.includes(o.me)) return mk("mine", "assigned to you", "you")
  if (item.assignees.length === 0) {
    // Old backlog is not "next", and label/bot churn keeps updatedAt fresh, so
    // window on when the issue was opened.
    if (hours(item.createdAt, now) > (o.windowDays ?? 14) * 24) return null
    return mk("needs_owner", `opened by @${item.author}; nobody owns it`, "you")
  }
  return null
}

export const bucketTeamItems = (items: ReadonlyArray<TriageItem>, profile: RepoProfile, o: BucketOptions): Array<TeamItem> =>
  items
    .flatMap((i) => {
      const t = classifyTeamItem(i, profile, o)
      return t ? [t] : []
    })
    .sort((a, b) => {
      const byBucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)
      if (byBucket !== 0) return byBucket
      return OLDEST_FIRST.has(a.bucket) ? b.ageHours - a.ageHours : a.ageHours - b.ageHours
    })
