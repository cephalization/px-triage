import { describe, expect, it } from "vitest"
import { argmax } from "./Classifier.ts"

describe("argmax", () => {
  it("picks the most likely level", () => {
    expect(argmax([0.67, 0.25, 0.08])).toBe(0)
    expect(argmax([0.1, 0.8, 0.1])).toBe(1)
    expect(argmax([0, 0.2, 0.8])).toBe(2)
    expect(argmax([])).toBe(0)
  })
})
