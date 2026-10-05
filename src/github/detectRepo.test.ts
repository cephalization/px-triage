import { describe, expect, it } from "vitest"
import { repoFromUrl } from "../classify/Classifier.ts"
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

describe("repoFromUrl", () => {
  it("extracts owner/name from issue and PR URLs", () => {
    expect(repoFromUrl("https://github.com/Arize-ai/phoenix/issues/16760")).toBe("Arize-ai/phoenix")
    expect(repoFromUrl("https://github.com/Arize-ai/openinference/pull/12")).toBe("Arize-ai/openinference")
  })
})
