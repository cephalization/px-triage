/**
 * `pxt automate`: write the triage-label workflow into the repo you are in,
 * optionally on a new branch with a PR.
 */
import { spawnSync } from "node:child_process"
import { join, relative } from "node:path"
import { Console, Effect, FileSystem, Option, Schema } from "effect"
import { Prompt } from "effect/cli"
import { parseGitHubRemote } from "../github/detectRepo.ts"
import { bold, cyan, dim, green, yellow } from "../ui/ansi.ts"
import { DEFAULT_WORKFLOW_OPTIONS, WORKFLOW_FILE, type WorkflowOptions, renderWorkflow } from "./template.ts"

export class AutomateError extends Schema.TaggedError<AutomateError>()("AutomateError", {
  message: Schema.String
}) {}

const git = (args: ReadonlyArray<string>, cwd: string) => {
  const r = spawnSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() }
}

const gh = (args: ReadonlyArray<string>, cwd: string) => {
  const r = spawnSync("gh", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() }
}

export interface AutomateOptions {
  readonly label: Option.Option<string>
  readonly yes: boolean
}

export const runAutomate = Effect.fnUntraced(function*(options: AutomateOptions) {
  const fs = yield* FileSystem.FileSystem
  const cwd = process.cwd()
  const top = git(["rev-parse", "--show-toplevel"], cwd)
  if (!top.ok) return yield* new AutomateError({ message: "Run this inside a git checkout of the repository you want to automate." })
  const root = top.out
  const origin = git(["remote", "get-url", "origin"], root)
  const slug = origin.ok ? parseGitHubRemote(origin.out) : null
  yield* Console.log(`${bold(cyan("pxt automate"))} ${dim(`· ${slug ?? root}`)}`)
  yield* Console.log(dim("Writes a GitHub Actions workflow that labels new issues and PRs so they appear in the px-triage queue.\n"))

  // ---- Questions ---------------------------------------------------------
  const defaults = { ...DEFAULT_WORKFLOW_OPTIONS, label: Option.getOrElse(options.label, () => DEFAULT_WORKFLOW_OPTIONS.label) }
  const wf: WorkflowOptions = options.yes ? defaults : yield* ask(defaults)

  const dir = join(root, ".github", "workflows")
  const file = join(dir, WORKFLOW_FILE)
  const rel = relative(root, file)
  const content = renderWorkflow(wf)
  const exists = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
  if (exists && !options.yes) {
    const overwrite = yield* Prompt.Confirm({ message: `${rel} already exists. Overwrite it?`, initial: false })
    if (!overwrite) {
      yield* Console.log(yellow("left the existing workflow alone"))
      return
    }
  }
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.mapError((e) => new AutomateError({ message: `Could not create ${dir}: ${String(e)}` })))
  yield* fs.writeFileString(file, content).pipe(Effect.mapError((e) => new AutomateError({ message: `Could not write ${file}: ${String(e)}` })))
  yield* Console.log(`${green("✔")} wrote ${bold(rel)}`)
  yield* Console.log(content.split("\n").map((l) => dim("  │ ") + l).join("\n"))

  // ---- Branch + PR -------------------------------------------------------
  const wantPr = options.yes ? true : yield* Prompt.Confirm({ message: "Commit this on a new branch and open a pull request?", initial: true })
  if (!wantPr) {
    yield* Console.log(dim(`\nnot committed; review ${rel} and commit when ready`))
    return
  }
  const dirty = git(["status", "--porcelain", "--", "."], root).out.split("\n").filter((l) => l.trim() && !l.endsWith(rel))
  if (dirty.length > 0) {
    yield* Console.log(yellow(`  note: ${dirty.length} other uncommitted change${dirty.length === 1 ? "" : "s"} stay in your working tree; only ${rel} is committed`))
  }
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], root).out
  const branch = `px-triage/label-new-items`
  const who = git(["config", "user.name"], root).out || "you"
  const steps: Array<[string, ReadonlyArray<string>]> = [
    ["create branch", ["checkout", "-b", branch]],
    ["stage workflow", ["add", "--", rel]],
    ["commit", ["commit", "-m", `ci: label new issues and PRs with "${wf.label}" for triage\n\nGenerated with pxt automate.`, "--", rel]],
    ["push", ["push", "-u", "origin", branch]]
  ]
  for (const [name, args] of steps) {
    const r = git(args, root)
    if (!r.ok) {
      git(["checkout", current], root)
      return yield* new AutomateError({ message: `git ${name} failed: ${r.err || r.out}` })
    }
  }
  yield* Console.log(`${green("✔")} pushed ${bold(branch)} as ${who}`)

  const body = [
    `Adds a workflow that applies the \`${wf.label}\` label to new ${[wf.issues ? "issues" : null, wf.pullRequests ? "pull requests" : null].filter(Boolean).join(" and ")} so they appear in the [px-triage](https://github.com/cephalization/px-triage) queue.`,
    "",
    wf.excludeChangesets ? "- Skips the changesets \"Version Packages\" release PR" : null,
    wf.excludeBots ? "- Skips items opened by bots" : null,
    wf.skipDrafts ? "- Labels PRs only once they leave draft" : null,
    wf.ensureLabel ? `- Creates the \`${wf.label}\` label if the repository does not have it` : null,
    "",
    "Generated with `pxt automate`."
  ].filter((l): l is string => l !== null).join("\n")
  const pr = gh(["pr", "create", "--title", `ci: label new issues and PRs for triage`, "--body", body, "--head", branch, "--base", current], root)
  if (pr.ok) {
    yield* Console.log(`${green("✔")} opened ${bold(pr.out.split("\n").pop() ?? "pull request")}`)
  } else {
    const compare = slug ? `https://github.com/${slug}/compare/${current}...${branch}?expand=1` : branch
    yield* Console.log(yellow(`  could not open a PR with gh (${pr.err.split("\n")[0] ?? "unknown error"}). Open it here: ${compare}`))
  }
  git(["checkout", current], root)
  yield* Console.log(dim(`back on ${current}`))
})

const ask = Effect.fnUntraced(function*(d: WorkflowOptions) {
  const label = yield* Prompt.String({ message: "Label that puts an item in the triage queue", default: d.label })
  const targets = yield* Prompt.MultiSelect<"issues" | "prs">({
    message: "Label which new items?",
    choices: [
      { title: "Issues", value: "issues", selected: d.issues },
      { title: "Pull requests", value: "prs", selected: d.pullRequests }
    ],
    min: 1
  })
  const pullRequests = targets.includes("prs")
  const exclusions = yield* Prompt.MultiSelect<"changesets" | "bots" | "drafts">({
    message: "Skip which items?",
    choices: [
      { title: "changesets \"Version Packages\" release PRs", value: "changesets", selected: d.excludeChangesets, description: "github-actions[bot] on a changeset-release/* branch" },
      { title: "Anything opened by a bot", value: "bots", selected: d.excludeBots, description: "dependabot, renovate, github-actions, …" },
      ...(pullRequests ? [{ title: "Draft PRs until they are ready for review", value: "drafts" as const, selected: d.skipDrafts }] : [])
    ]
  })
  const ensureLabel = yield* Prompt.Confirm({ message: `Create the "${label}" label if the repository does not have it?`, initial: d.ensureLabel })
  return {
    label: label.trim() || d.label,
    issues: targets.includes("issues"),
    pullRequests,
    excludeChangesets: exclusions.includes("changesets"),
    excludeBots: exclusions.includes("bots"),
    skipDrafts: exclusions.includes("drafts"),
    ensureLabel
  } satisfies WorkflowOptions
})
