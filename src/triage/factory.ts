/**
 * Phoenix's factory (factory/README.md in arize-ai/phoenix): Claude Managed
 * Agents that take a triaged issue to a PR ready for human review. Adding the
 * `factory` label as someone with write access starts a run; `dispatch.py`
 * then admits or refuses the issue, and reports the outcome in a comment.
 *
 * Pure, so the admission mirror and the comment parsing are testable. The
 * rules here copy dispatch.py's `find_admission_problem` and the
 * factory-candidate policy; keep them in sync when those change.
 */
import type { ComponentKey } from "../classify/questions.ts"
import type { Comment, TriageItem } from "../github/model.ts"
import type { RepoProfile } from "./profile.ts"

export const FACTORY_LABEL = "factory"
export const FACTORY_CANDIDATE_LABEL = "factory-candidate"

/** Issue effort labels, by effort level (0 = easy). On issues they mean effort, not PR line counts. */
export const SIZE_LABELS = ["size:S", "size:M", "size:L"] as const
export const isSizeLabel = (l: string): boolean => /^size[:/]/i.test(l)

/** The factory runs only where its trigger label exists. */
export const factoryEnabled = (profile: RepoProfile): boolean => profile.labels.some((l) => l.name === FACTORY_LABEL)

export type FactoryLane = "docs" | "bug" | "feature"

/** dispatch.py `select_lane`: documentation wins, then bug, then enhancement. */
export const factoryLane = (labels: ReadonlyArray<string>): FactoryLane | null =>
  labels.includes("documentation") ? "docs" : labels.includes("bug") ? "bug" : labels.includes("enhancement") ? "feature" : null

/** Labels that keep an issue out: dispatch.py refuses the first two, the candidate policy the rest. */
const BLOCKING_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["needs information", "it needs information from the author"],
  ["size:L", "it is size:L; split it first"],
  ["agent-in-progress", "an agent is already working on it"],
  ["good-agent-issue", "it is set aside for an agent to pick up"],
  ["good first issue", "it is kept for a first-time contributor"],
  ["good student issue", "it is kept for students"],
  ["blocked", "it is blocked"],
  ["cannot reproduce", "it could not be reproduced"],
  ["duplicate", "it is a duplicate"],
  ["stale", "it is stale"],
  ["c/auth", "it touches auth, which the factory does not take"],
  ["c/rbac", "it touches permissions, which the factory does not take"]
]

export interface FactoryFit {
  /** Nothing the factory would refuse: offering it is safe. */
  readonly eligible: boolean
  /** Eligible, and Jev also reads it as small and checkable in a sandbox. */
  readonly recommended: boolean
  readonly lane: FactoryLane | null
  /** Why it is not eligible, or why it is eligible but not recommended. */
  readonly reasons: ReadonlyArray<string>
  /** Phoenix's own triage nominated it. */
  readonly candidate: boolean
}

export interface FitInput {
  readonly item: TriageItem
  /** The labels the issue will carry after this triage step. */
  readonly labels: ReadonlyArray<string>
  /** Whether the step leaves it assigned to someone. */
  readonly assigned: boolean
  readonly component: ComponentKey | null
  /** Jev's P(checkable in a sandbox with no live services or product decision), when asked. */
  readonly checkable: number | null
  readonly checkableAbove: number
}

export const factoryFit = (i: FitInput): FactoryFit => {
  const blockers: Array<string> = []
  const { item, labels } = i
  if (item.kind !== "issue") blockers.push("only issues go through the factory")
  if (item.state !== "OPEN") blockers.push("the issue is closed")
  if (labels.includes(FACTORY_LABEL)) blockers.push("a factory run is already underway")
  if (i.assigned) blockers.push("it is assigned; the factory refuses assigned issues")
  const openPrs = item.linked.filter((l) => l.kind === "pull_request" && l.state === "OPEN")
  if (openPrs.length > 0) blockers.push(`an open PR already addresses it (${openPrs.map((p) => `#${p.number}`).join(", ")})`)
  for (const [label, why] of BLOCKING_LABELS) if (labels.includes(label)) blockers.push(why)
  if (i.component === "auth") blockers.push("it touches auth, which the factory does not take")
  const lane = factoryLane(labels)
  if (!lane) blockers.push("it has no bug, enhancement or documentation label")
  const candidate = item.labels.includes(FACTORY_CANDIDATE_LABEL)
  const reasons = [...new Set(blockers)]
  if (reasons.length > 0) return { eligible: false, recommended: false, lane, reasons, candidate }

  const doubts: Array<string> = []
  if (!labels.some((l) => l === "size:S" || l === "size:M")) doubts.push("no size:S or size:M estimate")
  if (i.checkable !== null && i.checkable < i.checkableAbove) doubts.push(`only ${Math.round(i.checkable * 100)}% likely an agent can reproduce or probe it in a sandbox`)
  // Triage's nomination stands in for Jev's read when Jev has none.
  const recommended = doubts.length === 0 && (i.checkable !== null || candidate)
  return { eligible: true, recommended, lane, reasons: doubts, candidate }
}

/** Factory PRs come from `factory/issue-N` branches. */
export const factoryIssueOf = (item: TriageItem): number | null => {
  const m = /^factory\/issue-(\d+)$/.exec(item.pr?.headRefName ?? "")
  return m ? Number(m[1]) : null
}

export type ReviewDepth = "glance" | "focused" | "deep"

/** `**Review depth:** focused, because …` from the coordinator's assessment comment. */
export const reviewDepth = (comments: ReadonlyArray<Comment>): ReviewDepth | null => {
  for (const c of [...comments].reverse()) {
    const m = /\*\*Review depth:\*\*\s*(glance|focused|deep)/i.exec(c.body)
    if (m) return m[1]!.toLowerCase() as ReviewDepth
  }
  return null
}

export type FactoryOutcome = "success" | "flawed" | "blocked" | "manual"

export type FactoryStatus =
  | { readonly _tag: "started"; readonly at: string }
  | { readonly _tag: "skipped"; readonly at: string; readonly reason: string }
  | { readonly _tag: "finished"; readonly at: string; readonly outcome: FactoryOutcome }

/** The latest 🏭 report dispatch.py left on the issue, if any. */
export const factoryStatus = (comments: ReadonlyArray<Comment>): FactoryStatus | null => {
  const reports = comments.filter((c) => c.body.startsWith("🏭")).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const last = reports[reports.length - 1]
  if (!last) return null
  const outcome = /Outcome: \*\*(success|flawed|blocked|manual)\*\*/.exec(last.body)
  if (outcome) return { _tag: "finished", at: last.createdAt, outcome: outcome[1] as FactoryOutcome }
  const skipped = /The factory skipped this issue: (.+?)\.?$/m.exec(last.body)
  if (skipped) return { _tag: "skipped", at: last.createdAt, reason: skipped[1]! }
  return { _tag: "started", at: last.createdAt }
}

/** Did a person (not a bot) comment after `at`? Then a maintainer already answered the factory. */
export const humanRepliedSince = (comments: ReadonlyArray<Comment>, at: string, isBot: (login: string) => boolean): boolean =>
  comments.some((c) => c.createdAt > at && !isBot(c.author) && !c.body.startsWith("🏭"))
