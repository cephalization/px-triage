import { describe, expect, it } from "vitest"
import { parseLearnedDescription, renderLearnedDescription } from "./Phoenix.ts"

describe("applied learnings in experiment descriptions", () => {
  const applied = {
    learned: { updatedAt: "2026-10-05T17:13:00.000Z", sampleSize: 144, experimentId: "RXhwZXJpbWVudDo2MzU3", thresholds: { needsInfoBelow: 0.2 }, policy: {}, owners: { server: ["mikeldking", "anticorrelator"] } },
    experimentId: "RXhwZXJpbWVudDo2MzU3",
    appliedBy: "cephalization",
    appliedAt: "2026-10-05T17:20:00.000Z"
  }
  it("round-trips through the description text", () => {
    const text = renderLearnedDescription(applied)
    expect(text.startsWith("px-triage learned settings")).toBe(true)
    expect(parseLearnedDescription(text)).toEqual(applied)
  })
  it("ignores unrelated descriptions", () => {
    expect(parseLearnedDescription("px-triage train: current questions + planner vs. human / inferred outcomes")).toBeNull()
    expect(parseLearnedDescription(null)).toBeNull()
  })
})
