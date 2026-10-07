import { describe, expect, it } from "vitest"
import { TriageItem } from "../github/model.ts"
import { stripAnsi } from "./ansi.ts"
import { renderBody, renderFullBody } from "./render.ts"

const item = new TriageItem({
  kind: "pull_request", id: "x", number: 1, title: "t", url: "u", body: "hello", createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z",
  author: "alice", authorName: null, authorAssociation: "MEMBER", labels: [], assignees: [], commentCount: 2, reactions: 0, state: "OPEN", stateReason: null, linked: [], pr: null,
  comments: [
    { author: "mintlify", body: "Preview deployment for your docs.", createdAt: "2026-10-06T00:00:00Z" },
    { author: "bob", body: "Looks good, one question inline.", createdAt: "2026-10-06T01:00:00Z" }
  ]
})

describe("renderBody", () => {
  it("hides bot comments from the preview but keeps humans", () => {
    const out = stripAnsi(renderBody(item))
    expect(out).not.toContain("Preview deployment")
    expect(out).toContain("@bob")
  })
  it("keeps everything in the full view", () => {
    expect(stripAnsi(renderFullBody(item))).toContain("Preview deployment")
  })
})
