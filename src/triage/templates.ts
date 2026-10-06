/**
 * Comment templates. `{{author}}` etc. are filled in by `renderTemplate`.
 * Edit freely; the CLI always lets you open the result in $EDITOR first.
 */
import type { TriageItem } from "../github/model.ts"

export interface Template {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly body: string
  /** Labels to add alongside this comment (in addition to what the action adds). */
  readonly labels?: ReadonlyArray<string>
  /** Only show for this kind of item. */
  readonly kind?: TriageItem["kind"]
}

/**
 * Placeholders: {{author}}, {{number}}, {{title}}, plus
 * {{docs}} → "The docs at <url> cover this area, and the" (or just "The" when the repo has none)
 * {{community}} → "the community <name> (<url>)" (or "GitHub Discussions on this repository")
 * {{contributing}} → "See <url> for our contribution guidelines." (or "")
 * The URLs come from the repo's config (`repos.<owner/name>.links`).
 */

export const NEEDS_INFO_TEMPLATES: ReadonlyArray<Template> = [
  {
    id: "repro",
    title: "Need reproduction details",
    description: "Version, deployment, steps, expected vs actual",
    kind: "issue",
    body: `Hi @{{author}}, thanks for the report! To look into this we need a bit more information:

- Which Phoenix version are you running (\`pip show arize-phoenix\` or the version in the UI footer)?
- How is Phoenix deployed (self-hosted Docker/Kubernetes, notebook, Phoenix Cloud) and which database (SQLite/PostgreSQL)?
- Minimal steps or a code snippet that reproduces the problem.
- What you expected to happen vs. what actually happened, including any logs or stack traces.

Once we can reproduce it we'll take it from there.`
  },
  {
    id: "logs",
    title: "Need logs / errors",
    description: "Ask for server logs, browser console, network errors",
    kind: "issue",
    body: `Hi @{{author}}, thanks for reporting and sorry you're running into this. Could you share:

- Any errors in the Phoenix server logs around the time this happened
- Any errors in the browser console or failed network requests (if this is a UI problem)
- Your Phoenix version and how it's deployed

That should help us narrow down where this is coming from.`
  },
  {
    id: "clarify-feature",
    title: "Clarify feature request",
    description: "Ask what problem it solves and what the ideal behavior is",
    kind: "issue",
    body: `Thanks for the suggestion, @{{author}}! Before we scope this, could you tell us a bit more about:

- The workflow you're trying to accomplish and where Phoenix currently gets in the way
- What the ideal behavior would look like from your side (UI, API, config?)
- Whether there's a workaround you're using today

That helps us figure out the right shape for this.`
  },
  {
    id: "pr-description",
    title: "PR needs description / linked issue",
    description: "Ask for motivation, verification, and a linked issue",
    kind: "pull_request",
    body: `Thanks for the contribution, @{{author}}! Before we review, could you update the description with:

- The problem this solves (and a link to an issue, or open one if none exists)
- A short summary of the change and any behavior that changes for users
- How you verified it (tests added/run, screenshots for UI changes)

{{contributing}}`
  }
]

export const CLOSE_TEMPLATES: ReadonlyArray<Template> = [
  {
    id: "support",
    title: "Support question → docs/Slack",
    description: "Close as a usage question; point to docs and community",
    labels: ["question"],
    body: `Hi @{{author}}, thanks for reaching out! This looks like a usage question rather than a bug or feature request, so I'm going to close it to keep the tracker focused.

{{docs}} fastest way to get help is {{community}}. If it turns out there's a defect behind this, please open a new issue with reproduction steps and we'll dig in.`
  },
  {
    id: "out-of-scope",
    title: "Out of scope / not planned",
    description: "Thank and explain it doesn't fit Phoenix's direction",
    labels: ["wontfix"],
    body: `Thanks for taking the time to write this up, @{{author}}. After discussing it, this isn't something we plan to pursue in Phoenix: it sits outside the project's current scope and direction.

We really appreciate the input, and if the surrounding context changes we're happy to revisit.`
  },
  {
    id: "third-party",
    title: "Third-party promotion",
    description: "We don't add listings/links for external products on request",
    labels: ["wontfix"],
    body: `Thanks for the submission, @{{author}}. We don't add listings, links, or integration pages for third-party products on request, so we're going to close this.

If you've built a Phoenix/OpenInference-compatible integration, the best path is to publish it in your own repository and documentation so users can find it there.`
  },
  {
    id: "duplicate",
    title: "Duplicate",
    description: "Close as duplicate of another issue (fill in the number)",
    labels: ["duplicate"],
    body: `Thanks @{{author}}! This is being tracked in #NNN, so I'm closing this one as a duplicate. Please follow along (and add any extra details) over there.`
  },
  {
    id: "cannot-reproduce",
    title: "Cannot reproduce / stale",
    description: "No response or not reproducible",
    labels: ["cannot reproduce"],
    body: `We haven't been able to reproduce this, and haven't heard back with more details, so I'm going to close it for now. If you're still seeing the problem on the latest Phoenix release, please reopen with reproduction steps and we'll take another look.`
  },
  {
    id: "spam",
    title: "Invalid / spam",
    description: "Close silently-ish with a one-liner",
    labels: ["invalid"],
    body: `Closing as this doesn't appear to be an actionable issue for Phoenix.`
  },
  {
    id: "pr-not-accepted",
    title: "PR not accepted",
    description: "Thank the contributor; explain we won't merge",
    kind: "pull_request",
    labels: ["wontfix"],
    body: `Thanks for the contribution, @{{author}}! We've decided not to move forward with this change: it doesn't fit the direction we have planned for this area, and we'd rather not take on the maintenance cost.

We appreciate the effort, and welcome future contributions. Opening an issue first to discuss larger changes is usually the fastest route to a merge.`
  },
  {
    id: "pr-superseded",
    title: "PR superseded",
    description: "Another PR / commit already covers this",
    kind: "pull_request",
    body: `Thanks @{{author}}! This has been addressed by another change (#NNN), so I'm closing this one. Appreciate you looking into it.`
  }
]

export interface RepoLinks {
  readonly docsUrl?: string | undefined
  readonly communityUrl?: string | undefined
  readonly communityName?: string | undefined
  readonly contributingUrl?: string | undefined
}

export interface TemplateContext {
  readonly author: string
  readonly number: number
  readonly title: string
  readonly links?: RepoLinks | undefined
}

export const renderTemplate = (template: Template, ctx: TemplateContext): string => {
  const l = ctx.links ?? {}
  const docs = l.docsUrl ? `The docs at ${l.docsUrl} cover this area, and the` : "The"
  const community = l.communityUrl ? `the community ${l.communityName ?? "chat"} (${l.communityUrl})` : "GitHub Discussions on this repository"
  const contributing = l.contributingUrl ? `See ${l.contributingUrl} for our contribution guidelines.` : ""
  return template.body
    .replaceAll("{{author}}", ctx.author)
    .replaceAll("{{number}}", String(ctx.number))
    .replaceAll("{{title}}", ctx.title)
    .replaceAll("{{docs}}", docs)
    .replaceAll("{{community}}", community)
    .replaceAll("{{contributing}}", contributing)
    .replace(/\n\n\n+/g, "\n\n")
    .trimEnd()
}

export const templatesFor = (
  templates: ReadonlyArray<Template>,
  kind: TriageItem["kind"]
): ReadonlyArray<Template> => templates.filter((t) => t.kind === undefined || t.kind === kind)
