/**
 * Pure routing: turn an Assessment into a suggested TriagePlan.
 * No I/O here so it is trivially unit-testable. Thresholds live in questions.ts.
 */
import type { Assessment } from "../classify/Classifier.ts"
import { THRESHOLDS as DEFAULT_THRESHOLDS, type ComponentKey, type IssueCategory, type LanguageKey, type PrCategory } from "../classify/questions.ts"
import type { TriageItem } from "../github/model.ts"
import type { RepoProfile } from "./profile.ts"
import { TRIAGE_LABEL, codeownerTeamsFor, priorityLabel, rankTeammates, workflowLabel } from "./roster.ts"

export type ActionKind = "needs_info" | "bug" | "feature" | "review" | "close" | "skip"

export interface TriagePlan {
  readonly action: ActionKind
  /** Why the planner chose `action`, in human terms. */
  readonly rationale: ReadonlyArray<string>
  /** True when the classifier was not confident; UI should not preselect. */
  readonly uncertain: boolean
  readonly labelsToAdd: ReadonlyArray<string>
  readonly labelsToRemove: ReadonlyArray<string>
  readonly suggestedAssignees: ReadonlyArray<string>
  readonly suggestedReviewers: { readonly users: ReadonlyArray<string>; readonly teams: ReadonlyArray<string> }
  readonly component: ComponentKey
  readonly language: LanguageKey
}

const isIssueCategory = (c: string): c is IssueCategory =>
  ["bug_report", "feature_request", "question_or_support", "documentation", "off_topic_or_promotional", "spam_or_nonsense"].includes(c)

export type Thresholds = { -readonly [K in keyof typeof DEFAULT_THRESHOLDS]: number }

const compact = (labels: ReadonlyArray<string | null>): Array<string> => [...new Set(labels.filter((l): l is string => l !== null))]

export const suggestPlan = (item: TriageItem, a: Assessment, profile: RepoProfile, overrides?: Partial<Thresholds>): TriagePlan => {
  // Defaults < learned (from `pxt train`) < explicit overrides (threshold sweeps).
  const THRESHOLDS: Thresholds = { ...DEFAULT_THRESHOLDS, ...(profile.learned?.thresholds ?? {}), ...(overrides ?? {}) }
  const base0 = suggestPlanWith(item, a, profile, THRESHOLDS)
  // Learned policy: when humans consistently chose a different action for this
  // (kind, category), follow them. Confidence gating still applies.
  const learnedAction = profile.learned?.policy[`${item.kind}:${a.category.choice}`] as ActionKind | undefined
  if (learnedAction && learnedAction !== base0.action && learnedAction !== "skip") {
    return { ...base0, action: learnedAction, rationale: [...base0.rationale, `learned: maintainers usually choose "${learnedAction}" for ${a.category.choice}`] }
  }
  return base0
}

const suggestPlanWith = (item: TriageItem, a: Assessment, profile: RepoProfile, THRESHOLDS: Thresholds): TriagePlan => {
  const rationale: Array<string> = []
  const BUG_LABEL = workflowLabel(profile, "bug")
  const ENHANCEMENT_LABEL = workflowLabel(profile, "enhancement")
  const DOCS_LABEL = workflowLabel(profile, "docs")
  const NEEDS_INFO_LABEL = workflowLabel(profile, "needsInfo")
  const uncertain = a.category.confidence < THRESHOLDS.categoryConfidenceFloor
  if (uncertain) {
    rationale.push(`category confidence ${pct(a.category.confidence)} is below the ${pct(THRESHOLDS.categoryConfidenceFloor)} floor`)
  }

  const component = a.component.choice
  const language = a.language.choice
  const componentProb = a.component.probabilities[component] ?? 0
  const languageProb = a.language.probabilities[language] ?? 0

  const metaLabels: Array<string> = []
  const compLabel = profile.componentLabels[component]
  if (compLabel && componentProb >= THRESHOLDS.componentLabelMinProbability) metaLabels.push(compLabel)
  const langLabel = profile.languageLabels[language]
  if (langLabel && languageProb >= THRESHOLDS.languageLabelMinProbability) metaLabels.push(langLabel)

  const assignees = rankTeammates(profile, component, language).map((t) => t.login)
  const reviewers = {
    users: assignees.slice(0, 3),
    teams: item.pr ? codeownerTeamsFor(profile, item.pr.files.map((f) => f.path)) : []
  }

  const base = {
    uncertain,
    labelsToRemove: item.labels.includes(TRIAGE_LABEL) ? [TRIAGE_LABEL] : [],
    suggestedAssignees: assignees,
    suggestedReviewers: reviewers,
    component,
    language
  } as const

  const outOfScope = a.inScope < THRESHOLDS.outOfScopeBelow
  const incomplete = a.complete < THRESHOLDS.needsInfoBelow

  // ---- Pull requests ------------------------------------------------------
  if (item.kind === "pull_request") {
    const cat = a.category.choice as PrCategory
    if (cat === "off_topic_or_promotional" || outOfScope) {
      rationale.push(outOfScope ? `in-scope probability ${pct(a.inScope)}` : "classified as off-topic / promotional")
      return { ...base, action: "close", rationale, labelsToAdd: [] }
    }
    // Mechanical PRs (dependency bumps, release chores, test-only changes) have
    // thin descriptions by nature; asking for more information is never right.
    const mechanical = cat === "dependency_update" || cat === "refactor_or_chore" || cat === "tests_only"
    if (incomplete && !mechanical) {
      rationale.push(`description completeness ${pct(a.complete)} is below ${pct(THRESHOLDS.needsInfoBelow)}`)
      return { ...base, action: "needs_info", rationale, labelsToAdd: compact([NEEDS_INFO_LABEL, ...metaLabels]) }
    }
    const typeLabel = cat === "bug_fix" ? BUG_LABEL : cat === "feature" ? ENHANCEMENT_LABEL : cat === "documentation" ? DOCS_LABEL : null
    rationale.push(`PR looks like a ${cat.replaceAll("_", " ")}` + (a.risk ? `, review risk level ${a.risk.level}` : ""))
    if (item.pr?.linkedIssues.length) rationale.push(`closes ${item.pr.linkedIssues.map((i) => `#${i.number}`).join(", ")}`)
    return { ...base, action: "review", rationale, labelsToAdd: compact([typeLabel, ...metaLabels]) }
  }

  // ---- Issues -------------------------------------------------------------
  const cat = isIssueCategory(a.category.choice) ? a.category.choice : "question_or_support"
  if (cat === "spam_or_nonsense" || cat === "off_topic_or_promotional" || outOfScope) {
    rationale.push(outOfScope ? `in-scope probability ${pct(a.inScope)}` : `classified as ${cat.replaceAll("_", " ")}`)
    return { ...base, action: "close", rationale, labelsToAdd: [] }
  }
  if (cat === "question_or_support") {
    rationale.push("reads as a usage / support question rather than a defect or request")
    return { ...base, action: "close", rationale, labelsToAdd: [] }
  }
  if (incomplete) {
    rationale.push(`reproducibility ${pct(a.complete)} is below ${pct(THRESHOLDS.needsInfoBelow)}`)
    return { ...base, action: "needs_info", rationale, labelsToAdd: compact([NEEDS_INFO_LABEL, ...metaLabels]) }
  }
  if (cat === "bug_report") {
    const labels: Array<string | null> = [BUG_LABEL, ...metaLabels]
    if (a.severity && a.severity.confidence >= THRESHOLDS.severityConfidenceFloor) {
      labels.push(priorityLabel(profile, a.severity.level))
      rationale.push(`severity level ${a.severity.level} (${pct(a.severity.confidence)} confident)`)
    }
    rationale.push(`reproducibility ${pct(a.complete)}`)
    return { ...base, action: "bug", rationale, labelsToAdd: compact(labels) }
  }
  // feature_request or documentation
  const labels = [cat === "documentation" ? DOCS_LABEL ?? ENHANCEMENT_LABEL : ENHANCEMENT_LABEL, ...metaLabels]
  if (a.value) rationale.push(`value level ${a.value.level} (${pct(a.value.confidence)} confident)`)
  return { ...base, action: "feature", rationale, labelsToAdd: compact(labels) }
}

export const pct = (p: number): string => `${Math.round(p * 100)}%`

export const ACTION_TITLES: Record<ActionKind, string> = {
  needs_info: "Needs information",
  bug: "Bug → label + assign",
  feature: "Feature → label + schedule",
  review: "Ready for review → label + request reviewers",
  close: "Close with a message",
  skip: "Skip for now"
}
