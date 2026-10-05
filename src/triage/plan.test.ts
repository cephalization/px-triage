import { describe, expect, it } from "vitest"
import type { Assessment } from "../classify/Classifier.js"
import { TriageItem } from "../github/model.js"
import { suggestPlan } from "./plan.js"
import type { RepoProfile } from "./profile.js"

const label = (name: string) => ({ name, color: "aaaaaa", description: null })
const profile: RepoProfile = {
  format: 1,
  repo: "arize-ai/phoenix",
  generatedAt: new Date().toISOString(),
  labels: ["bug", "enhancement", "documentation", "needs information", "wontfix", "duplicate", "c/ui", "c/server", "language: typescript", "language: python", "priority: low", "priority: medium", "priority: high", "triage"].map(label),
  componentLabels: { ui: "c/ui", server: "c/server", evals: null, traces: null, playground: null, client: null, cli: null, prompts: null, datasets: null, experiments: null, sessions: null, annotations: null, auth: null, otel_instrumentation: null, helm_infra: null, mcp: null, agents: null, api: null, docs: "documentation", unclear: null },
  languageLabels: { python: "language: python", typescript: "language: typescript", not_applicable: null },
  teammates: [
    { login: "ui-owner", areas: ["ui"], languages: ["typescript"], assigned: 10, reviewed: 5, authored: 2 },
    { login: "server-owner", areas: ["server"], languages: ["python"], assigned: 8, reviewed: 4, authored: 1 }
  ],
  codeowners: [{ prefix: "js/", teams: ["oss-javascript"], users: [] }],
  sampleSize: 100
}

const item = (over: Partial<ConstructorParameters<typeof TriageItem>[0]> = {}) =>
  new TriageItem({
    kind: "issue",
    id: "I_1",
    number: 1,
    title: "t",
    url: "https://github.com/arize-ai/phoenix/issues/1",
    body: "b",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    author: "someone",
    authorName: null,
    authorAssociation: "NONE",
    labels: ["triage"],
    assignees: [],
    commentCount: 0,
    comments: [],
    reactions: 0,
    state: "OPEN",
    stateReason: null,
    linked: [],
    pr: null,
    ...over
  })

// Partial distributions are fine for tests; the planner only reads the winner's probability.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dist = <K extends string>(choice: K, p: number, others: ReadonlyArray<K>): any => {
  const rest = (1 - p) / Math.max(1, others.length)
  const probabilities = Object.fromEntries([[choice, p], ...others.map((o) => [o, rest])]) as Record<K, number>
  return { choice, confidence: p, probabilities }
}

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  kind: "issue",
  model: "jev-test",
  latencyMs: 1,
  inputTokens: 1,
  category: dist("bug_report", 0.9, ["feature_request"]),
  component: dist("ui", 0.8, ["server"]),
  language: dist("typescript", 0.9, ["python"]),
  inScope: 0.95,
  complete: 0.9,
  agentAuthored: 0.1,
  severity: { score: 1, confidence: 0.7, probabilities: [0.1, 0.8, 0.1] },
  value: null,
  risk: null,
  ...over
})

describe("suggestPlan (issues)", () => {
  it("routes a reproducible bug to bug with labels, priority, and an owner", () => {
    const plan = suggestPlan(item(), assessment(), profile)
    expect(plan.action).toBe("bug")
    expect(plan.labelsToAdd).toEqual(expect.arrayContaining(["bug", "c/ui", "language: typescript", "priority: medium"]))
    expect(plan.labelsToRemove).toEqual(["triage"])
    expect(plan.suggestedAssignees[0]).toBe("ui-owner")
    expect(plan.uncertain).toBe(false)
  })

  it("asks for information when reproducibility is low", () => {
    const plan = suggestPlan(item(), assessment({ complete: 0.2 }), profile)
    expect(plan.action).toBe("needs_info")
    expect(plan.labelsToAdd).toContain("needs information")
  })

  it("closes out-of-scope and promotional items", () => {
    expect(suggestPlan(item(), assessment({ inScope: 0.1 }), profile).action).toBe("close")
    expect(
      suggestPlan(item(), assessment({ category: dist("off_topic_or_promotional", 0.8, ["feature_request"]) }), profile).action
    ).toBe("close")
  })

  it("treats support questions as close-with-message", () => {
    const plan = suggestPlan(item(), assessment({ category: dist("question_or_support", 0.8, ["bug_report"]) }), profile)
    expect(plan.action).toBe("close")
  })

  it("routes feature requests to feature with enhancement label", () => {
    const plan = suggestPlan(item(), assessment({ category: dist("feature_request", 0.8, ["bug_report"]), severity: null, value: { score: 2, confidence: 0.6, probabilities: [0, 0.2, 0.8] } }), profile)
    expect(plan.action).toBe("feature")
    expect(plan.labelsToAdd).toContain("enhancement")
  })

  it("flags low category confidence as uncertain but still suggests", () => {
    const plan = suggestPlan(item(), assessment({ category: dist("bug_report", 0.4, ["feature_request"]) }), profile)
    expect(plan.uncertain).toBe(true)
    expect(plan.action).toBe("bug")
  })

  it("omits weak component / language labels", () => {
    const plan = suggestPlan(
      item(),
      assessment({
        component: dist("ui", 0.3, ["server", "evals"]),
        language: dist("python", 0.5, ["typescript"])
      })
    , profile)
    expect(plan.labelsToAdd).not.toContain("c/ui")
    expect(plan.labelsToAdd).not.toContain("language: python")
  })

  it("does not try to remove triage when it is not present", () => {
    expect(suggestPlan(item({ labels: [] }), assessment(), profile).labelsToRemove).toEqual([])
  })
})

describe("suggestPlan (pull requests)", () => {
  const pr = item({
    kind: "pull_request",
    state: "OPEN",
    pr: {
      isDraft: false,
      merged: false,
      additions: 10,
      deletions: 2,
      changedFiles: 2,
      headRefName: "fix",
      baseRefName: "main",
      files: [{ path: "js/app/src/x.tsx", additions: 10, deletions: 2 }],
      reviewCount: 0,
      reviewers: [],
      requestedReviewers: [],
      linkedIssues: [{ number: 7, title: "x" }],
      checks: "SUCCESS"
    }
  })

  it("routes a described bug fix to review with codeowner teams", () => {
    const plan = suggestPlan(pr, assessment({ kind: "pull_request", category: dist("bug_fix", 0.9, ["feature"]), severity: null, risk: { score: 0, confidence: 0.8, probabilities: [0.9, 0.1, 0] } }), profile)
    expect(plan.action).toBe("review")
    expect(plan.labelsToAdd).toContain("bug")
    expect(plan.suggestedReviewers.teams).toEqual(["oss-javascript"])
    expect(plan.rationale.join(" ")).toContain("#7")
  })

  it("asks for a description when the PR is not described", () => {
    expect(suggestPlan(pr, assessment({ kind: "pull_request", category: dist("feature", 0.9, ["bug_fix"]), complete: 0.1 }), profile).action).toBe("needs_info")
  })

  it("closes promotional PRs", () => {
    expect(suggestPlan(pr, assessment({ kind: "pull_request", category: dist("off_topic_or_promotional", 0.9, ["feature"]) }), profile).action).toBe("close")
  })
})
