import { describe, expect, it } from "vitest"
import type { LinkedItem } from "../github/model.ts"
import { TriageItem } from "../github/model.ts"
import type { ResolvedPlan } from "./executor.ts"
import { orderLinks, propagate } from "./links.ts"
import type { RepoProfile } from "./profile.ts"

const label = (name: string) => ({ name, color: "aaaaaa", description: null })
const profile: RepoProfile = {
  format: 1,
  repo: "o/r",
  generatedAt: new Date().toISOString(),
  labels: ["bug", "duplicate", "needs information", "triage", "c/ui"].map(label),
  componentLabels: { ui: "c/ui" } as RepoProfile["componentLabels"],
  languageLabels: { python: null, typescript: null, not_applicable: null },
  teammates: [{ login: "maint", areas: ["ui"], languages: [], assigned: 5, reviewed: 5, authored: 5 }],
  codeowners: [],
  sampleSize: 1
}

const link = (over: Partial<LinkedItem>): LinkedItem => ({
  kind: "pull_request",
  number: 1,
  title: "t",
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  author: "someone",
  authorAssociation: "NONE",
  labels: ["triage"],
  ...over
})

const issue = (linked: ReadonlyArray<LinkedItem>) =>
  new TriageItem({
    kind: "issue", id: "I", number: 100, title: "bug", url: "u", body: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    author: "reporter", authorName: null, authorAssociation: "NONE", labels: ["triage"], assignees: [], commentCount: 0, comments: [], reactions: 0,
    state: "OPEN", stateReason: null, linked, pr: null
  })

const bugPlan: ResolvedPlan = { comment: null, labelsToAdd: ["bug", "c/ui"], labelsToRemove: ["triage"], assignees: ["maint"], reviewers: { users: [], teams: [] }, close: null }

describe("orderLinks", () => {
  it("puts maintainer-authored links first, then oldest", () => {
    const ordered = orderLinks(profile, [
      link({ number: 3, createdAt: "2026-10-03T00:00:00Z" }),
      link({ number: 2, createdAt: "2026-10-02T00:00:00Z" }),
      link({ number: 9, createdAt: "2026-10-09T00:00:00Z", author: "maint" }),
      link({ number: 8, createdAt: "2026-10-08T00:00:00Z", authorAssociation: "MEMBER" })
    ])
    expect(ordered.map((l) => l.number)).toEqual([8, 9, 2, 3])
  })
})

describe("propagate (issue → PRs)", () => {
  it("routes the first PR for review and closes the rest as duplicates", () => {
    const out = propagate(issue([link({ number: 1 }), link({ number: 2, createdAt: "2026-10-02T00:00:00Z" })]), "bug", bugPlan, profile)
    expect(out).toHaveLength(2)
    expect(out[0]!.target.number).toBe(1)
    expect(out[0]!.plan.reviewers.users).toEqual(["maint"])
    expect(out[0]!.plan.labelsToAdd).toEqual(["bug", "c/ui"])
    expect(out[0]!.plan.labelsToRemove).toEqual(["triage"])
    expect(out[1]!.target.number).toBe(2)
    expect(out[1]!.plan.close).toBe("not_planned")
    expect(out[1]!.plan.labelsToAdd).toEqual(["duplicate"])
    expect(out[1]!.plan.comment).toContain("#1")
    expect(out[1]!.plan.comment).toContain("#100")
  })

  it("closes linked PRs when the issue is closed", () => {
    const out = propagate(issue([link({ number: 1 })]), "close", { ...bugPlan, close: "not_planned" }, profile)
    expect(out[0]!.plan.close).toBe("not_planned")
    expect(out[0]!.plan.comment).toContain("#100")
  })

  it("does nothing without links or on skip", () => {
    expect(propagate(issue([]), "bug", bugPlan, profile)).toEqual([])
    expect(propagate(issue([link({})]), "skip", bugPlan, profile)).toEqual([])
  })
})

describe("propagate (PR → issues)", () => {
  const pr = new TriageItem({
    kind: "pull_request", id: "P", number: 200, title: "fix", url: "u", body: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    author: "someone", authorName: null, authorAssociation: "NONE", labels: ["triage"], assignees: [], commentCount: 0, comments: [], reactions: 0,
    state: "OPEN", stateReason: null,
    linked: [link({ kind: "issue", number: 10 }), link({ kind: "issue", number: 11, createdAt: "2026-10-02T00:00:00Z" })],
    pr: { isDraft: false, merged: false, additions: 1, deletions: 1, changedFiles: 1, headRefName: "h", baseRefName: "main", files: [], reviewCount: 0, reviewers: [], requestedReviewers: [], linkedIssues: [], checks: null }
  })

  it("mirrors a review onto the first issue and closes the second as duplicate", () => {
    const out = propagate(pr, "review", { ...bugPlan, assignees: [], reviewers: { users: ["maint"], teams: [] } }, profile)
    expect(out[0]!.target.number).toBe(10)
    expect(out[0]!.plan.assignees).toEqual(["maint"])
    expect(out[1]!.target.number).toBe(11)
    expect(out[1]!.plan.close).toBe("not_planned")
  })

  it("leaves issues alone when the PR is closed", () => {
    expect(propagate(pr, "close", { ...bugPlan, close: "not_planned" }, profile)).toEqual([])
  })
})
