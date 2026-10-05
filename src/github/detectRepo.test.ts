import { describe, expect, it } from "vitest"
import { parseGitHubRemote } from "./detectRepo.ts"

describe("parseGitHubRemote", () => {
  it("handles ssh and https forms", () => {
    expect(parseGitHubRemote("git@github.com:cephalization/px-triage.git")).toBe("cephalization/px-triage")
    expect(parseGitHubRemote("https://github.com/Arize-ai/phoenix.git")).toBe("Arize-ai/phoenix")
    expect(parseGitHubRemote("https://github.com/Arize-ai/phoenix")).toBe("Arize-ai/phoenix")
    expect(parseGitHubRemote("ssh://git@github.com/owner/repo.git\n")).toBe("owner/repo")
  })
  it("rejects non-GitHub remotes", () => {
    expect(parseGitHubRemote("git@gitlab.com:owner/repo.git")).toBeNull()
  })
})
