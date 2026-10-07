import { describe, expect, it } from "vitest"
import { TriageItem } from "../github/model.ts"
import type { RepoProfile } from "../triage/profile.ts"
import { bucketTeamItems, classifyTeamItem } from "./buckets.ts"

const profile: RepoProfile = {
  format: 1, repo: "o/r", generatedAt: "2026-10-01T00:00:00Z", labels: [], sampleSize: 1, codeowners: [],
  componentLabels: {} as RepoProfile["componentLabels"], languageLabels: { python: null, typescript: null, not_applicable: null },
  teammates: [{ login: "me", areas: [], languages: [], assigned: 1, reviewed: 1, authored: 1 }, { login: "alice", areas: [], languages: [], assigned: 1, reviewed: 1, authored: 1 }]
}
const now = new Date("2026-10-07T12:00:00Z")
const o = { me: "me", queueLabel: "triage", now }

const base = (over: Partial<ConstructorParameters<typeof TriageItem>[0]> = {}) =>
  new TriageItem({
    kind: "issue", id: "x", number: 1, title: "t", url: "u", body: "", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T12:00:00Z",
    author: "alice", authorName: null, authorAssociation: "MEMBER", labels: [], assignees: [], commentCount: 0, comments: [], reactions: 0,
    state: "OPEN", stateReason: null, linked: [], pr: null, ...over
  })
const pr = (over: Partial<NonNullable<TriageItem["pr"]>> = {}, item: Partial<ConstructorParameters<typeof TriageItem>[0]> = {}) =>
  base({
    kind: "pull_request",
    pr: { isDraft: false, merged: false, additions: 1, deletions: 1, changedFiles: 1, headRefName: "h", baseRefName: "main", files: [], reviewCount: 0, reviewers: [], reviews: [], reviewDecision: null, mergeStateStatus: null, requestedReviewers: [], linkedIssues: [], checks: "SUCCESS", ...over },
    ...item
  })

describe("classifyTeamItem", () => {
  it("ignores outsiders and items still in the triage queue", () => {
    expect(classifyTeamItem(base({ author: "stranger", authorAssociation: "NONE" }), profile, o)).toBeNull()
    expect(classifyTeamItem(base({ labels: ["triage"] }), profile, o)).toBeNull()
  })
  it("puts review requests from teammates first", () => {
    expect(classifyTeamItem(pr({ requestedReviewers: ["me"] }), profile, o)?.bucket).toBe("review_requested")
  })
  it("flags teammate PRs nobody is reviewing", () => {
    const t = classifyTeamItem(pr(), profile, o)
    expect(t?.bucket).toBe("needs_review")
    expect(t?.waitingOn).toBe("you")
  })
  it("surfaces re-review when the author pushed after your changes request", () => {
    const t = classifyTeamItem(pr({ reviews: [{ author: "me", state: "CHANGES_REQUESTED", submittedAt: "2026-10-06T10:00:00Z" }] }), profile, o)
    expect(t?.bucket).toBe("re_review")
  })
  it("stays quiet while the author is working on requested changes", () => {
    expect(classifyTeamItem(pr({ reviews: [{ author: "me", state: "CHANGES_REQUESTED", submittedAt: "2026-10-06T13:00:00Z" }] }), profile, o)).toBeNull()
  })
  it("flags approved-but-unmerged and failing checks", () => {
    expect(classifyTeamItem(pr({ reviewDecision: "APPROVED", reviews: [{ author: "me", state: "APPROVED", submittedAt: "2026-10-06T13:00:00Z" }] }), profile, o)?.bucket).toBe("ready_to_merge")
    expect(classifyTeamItem(pr({ checks: "FAILURE" }), profile, o)?.bucket).toBe("ci_failing")
  })
  it("shows your own PR only when it is blocked on you", () => {
    expect(classifyTeamItem(pr({}, { author: "me" }), profile, o)).toBeNull()
    expect(classifyTeamItem(pr({ reviews: [{ author: "alice", state: "CHANGES_REQUESTED", submittedAt: "2026-10-06T13:00:00Z" }] }, { author: "me" }), profile, o)?.bucket).toBe("mine")
  })
  it("flags unowned teammate issues and your assignments", () => {
    expect(classifyTeamItem(base(), profile, o)?.bucket).toBe("needs_owner")
    expect(classifyTeamItem(base({ assignees: ["me"] }), profile, o)?.bucket).toBe("mine")
    expect(classifyTeamItem(base({ assignees: ["alice"] }), profile, o)).toBeNull()
  })
})

describe("bucketTeamItems", () => {
  it("orders by bucket, then oldest activity first", () => {
    const items = [
      base({ number: 1 }),
      pr({ requestedReviewers: ["me"] }, { number: 2, updatedAt: "2026-10-07T00:00:00Z" }),
      pr({ requestedReviewers: ["me"] }, { number: 3, updatedAt: "2026-10-05T00:00:00Z" }),
      pr({}, { number: 4 })
    ]
    expect(bucketTeamItems(items, profile, o).map((t) => t.item.number)).toEqual([3, 2, 4, 1])
  })
  it("puts review work before your own plate and lists your plate newest first", () => {
    const items = [
      base({ number: 1, assignees: ["me"], updatedAt: "2026-10-01T00:00:00Z" }),
      base({ number: 2, assignees: ["me"], updatedAt: "2026-10-07T00:00:00Z" }),
      pr({}, { number: 3 })
    ]
    expect(bucketTeamItems(items, profile, o).map((t) => t.item.number)).toEqual([3, 2, 1])
  })
  it("drops unowned issues opened before the window", () => {
    expect(classifyTeamItem(base({ createdAt: "2026-09-01T00:00:00Z" }), profile, o)).toBeNull()
    expect(classifyTeamItem(base({ createdAt: "2026-09-01T00:00:00Z" }), profile, { ...o, windowDays: 60 })?.bucket).toBe("needs_owner")
  })
})
