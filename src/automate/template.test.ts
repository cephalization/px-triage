import { describe, expect, it } from "vitest"
import { DEFAULT_WORKFLOW_OPTIONS, renderWorkflow } from "./template.ts"

describe("renderWorkflow", () => {
  it("labels issues and PRs, skipping changesets and bots by default", () => {
    const y = renderWorkflow(DEFAULT_WORKFLOW_OPTIONS)
    expect(y).toContain("issues:\n    types: [opened, reopened]")
    expect(y).toContain("pull_request_target:")
    expect(y).toContain("changeset-release/")
    expect(y).toContain("!endsWith(github.actor, '[bot]')")
    expect(y).toContain('-f "labels[]=triage"')
    expect(y).toContain("Make sure the label exists")
  })
  it("honors a custom label and narrower options", () => {
    const y = renderWorkflow({ label: "needs-triage", issues: true, pullRequests: false, excludeChangesets: false, excludeBots: false, skipDrafts: false, ensureLabel: false })
    expect(y).not.toContain("pull_request_target")
    expect(y).not.toContain("    if:")
    expect(y).not.toContain("Make sure the label exists")
    expect(y).toContain('-f "labels[]=needs-triage"')
  })
  it("adds the draft guard only when asked", () => {
    expect(renderWorkflow({ ...DEFAULT_WORKFLOW_OPTIONS, skipDrafts: true })).toContain("github.event.pull_request.draft")
    expect(renderWorkflow(DEFAULT_WORKFLOW_OPTIONS)).not.toContain("github.event.pull_request.draft")
  })
})
