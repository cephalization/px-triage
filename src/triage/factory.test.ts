import { describe, expect, it } from "vitest"
import { TriageItem } from "../github/model.ts"
import { factoryFit, factoryIssueOf, factoryLane, factoryStatus, humanRepliedSince, reviewDepth } from "./factory.ts"

const item = (over: Partial<ConstructorParameters<typeof TriageItem>[0]> = {}) =>
  new TriageItem({
    kind: "issue", id: "x", number: 7, title: "t", url: "u", body: "", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    author: "someone", authorName: null, authorAssociation: "NONE", labels: [], assignees: [], commentCount: 0, comments: [], reactions: 0,
    state: "OPEN", stateReason: null, linked: [], pr: null, ...over
  })
const fit = (labels: ReadonlyArray<string>, over: Partial<Parameters<typeof factoryFit>[0]> = {}) =>
  factoryFit({ item: item(), labels, assigned: false, component: "ui", checkable: 0.9, checkableAbove: 0.6, ...over })
const comment = (body: string, createdAt: string, author = "arize-phoenix-factory[bot]") => ({ author, body, createdAt })

describe("factoryLane", () => {
  it("mirrors dispatch.py: documentation, then bug, then enhancement", () => {
    expect(factoryLane(["bug", "documentation"])).toBe("docs")
    expect(factoryLane(["enhancement", "bug"])).toBe("bug")
    expect(factoryLane(["enhancement"])).toBe("feature")
    expect(factoryLane(["question"])).toBeNull()
  })
})

describe("factoryFit", () => {
  it("recommends a typed, small, checkable issue", () => {
    const f = fit(["bug", "size:S"])
    expect(f).toMatchObject({ eligible: true, recommended: true, lane: "bug", reasons: [] })
  })
  it("refuses what dispatch.py refuses", () => {
    expect(fit(["bug", "size:L"]).eligible).toBe(false)
    expect(fit(["bug", "needs information"]).eligible).toBe(false)
    expect(fit(["bug"], { assigned: true }).eligible).toBe(false)
    expect(fit(["question"]).reasons).toContain("it has no bug, enhancement or documentation label")
    const withPr = factoryFit({
      item: item({ linked: [{ kind: "pull_request", number: 9, title: "fix", state: "OPEN", isDraft: false, createdAt: "", author: "a", authorAssociation: null, labels: [] }] }),
      labels: ["bug"], assigned: false, component: "ui", checkable: 0.9, checkableAbove: 0.6
    })
    expect(withPr.reasons[0]).toMatch(/#9/)
  })
  it("refuses what the candidate policy keeps out", () => {
    expect(fit(["bug", "good first issue"]).eligible).toBe(false)
    expect(fit(["bug"], { component: "auth" }).eligible).toBe(false)
    expect(fit(["bug", "factory"]).reasons).toContain("a factory run is already underway")
  })
  it("offers but does not recommend without a size or a sandbox read", () => {
    expect(fit(["bug"])).toMatchObject({ eligible: true, recommended: false })
    expect(fit(["bug", "size:M"], { checkable: 0.3 })).toMatchObject({ eligible: true, recommended: false })
    expect(fit(["bug", "size:M"], { checkable: null })).toMatchObject({ eligible: true, recommended: false })
  })
  it("lets triage's nomination stand in for a missing sandbox read", () => {
    const f = factoryFit({ item: item({ labels: ["factory-candidate"] }), labels: ["bug", "size:M", "factory-candidate"], assigned: false, component: null, checkable: null, checkableAbove: 0.6 })
    expect(f).toMatchObject({ eligible: true, recommended: true, candidate: true })
  })
})

describe("factory comments", () => {
  it("reads the latest run report", () => {
    const started = comment("🏭 The factory started the **bug** lane for this issue (session x).", "2026-10-02T00:00:00Z")
    const done = comment("🏭 The factory's **bug** session x stopped.\n\nOutcome: **manual** · rubric: `satisfied`", "2026-10-03T00:00:00Z")
    expect(factoryStatus([started])?._tag).toBe("started")
    expect(factoryStatus([done, started])).toMatchObject({ _tag: "finished", outcome: "manual" })
    expect(factoryStatus([comment("🏭 The factory skipped this issue: it is assigned to alice.", "2026-10-02T00:00:00Z")])).toMatchObject({ _tag: "skipped", reason: "it is assigned to alice" })
    expect(factoryStatus([comment("thanks!", "2026-10-02T00:00:00Z", "alice")])).toBeNull()
  })
  it("notices a maintainer reply after the report", () => {
    const cs = [comment("🏭 report", "2026-10-03T00:00:00Z"), comment("answered", "2026-10-04T00:00:00Z", "alice")]
    expect(humanRepliedSince(cs, "2026-10-03T00:00:00Z", (l) => l.endsWith("[bot]"))).toBe(true)
    expect(humanRepliedSince(cs.slice(0, 1), "2026-10-03T00:00:00Z", (l) => l.endsWith("[bot]"))).toBe(false)
  })
  it("parses the assessment's review depth and the PR's issue", () => {
    expect(reviewDepth([comment("## Factory assessment\n\n**Review depth:** deep, because it adds a migration", "2026-10-03T00:00:00Z")])).toBe("deep")
    expect(reviewDepth([])).toBeNull()
    const pr = item({ kind: "pull_request", pr: { isDraft: false, merged: false, additions: 1, deletions: 1, changedFiles: 1, headRefName: "factory/issue-15848", baseRefName: "main", files: [], reviewCount: 0, reviewers: [], reviews: [], reviewDecision: null, mergeStateStatus: null, requestedReviewers: [], linkedIssues: [], checks: null } })
    expect(factoryIssueOf(pr)).toBe(15848)
    expect(factoryIssueOf(item())).toBeNull()
  })
})
