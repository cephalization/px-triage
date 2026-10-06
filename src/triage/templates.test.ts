import { describe, expect, it } from "vitest"
import { CLOSE_TEMPLATES, NEEDS_INFO_TEMPLATES, renderTemplate } from "./templates.ts"

const support = CLOSE_TEMPLATES.find((t) => t.id === "support")!
const prDescription = NEEDS_INFO_TEMPLATES.find((t) => t.id === "pr-description")!
const ctx = { author: "someone", number: 7, title: "t" }

describe("renderTemplate", () => {
  it("uses configured docs and community links", () => {
    const out = renderTemplate(support, { ...ctx, links: { docsUrl: "https://docs.example", communityUrl: "https://chat.example", communityName: "Discord" } })
    expect(out).toContain("The docs at https://docs.example cover this area, and the fastest way")
    expect(out).toContain("the community Discord (https://chat.example)")
    expect(out).toContain("@someone")
  })
  it("falls back to GitHub Discussions and omits docs when no links are configured", () => {
    const out = renderTemplate(support, ctx)
    expect(out).not.toContain("docs at")
    expect(out).toContain("The fastest way to get help is GitHub Discussions on this repository")
    expect(out).not.toContain("{{")
  })
  it("drops the contributing sentence when there is no URL", () => {
    expect(renderTemplate(prDescription, ctx)).not.toMatch(/See .* for our contribution guidelines/)
    expect(renderTemplate(prDescription, { ...ctx, links: { contributingUrl: "https://c.example" } })).toContain("See https://c.example for our contribution guidelines.")
  })
})
