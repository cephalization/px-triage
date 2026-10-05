/**
 * Repo-agnostic roster helpers. The actual people, labels, and CODEOWNERS
 * come from a generated RepoProfile (see profile.ts); this file holds the
 * alias tables that map a repo's labels onto the classifier's fixed component
 * and language keys, plus the ranking logic.
 *
 * Add aliases here when a repo names things differently.
 */
import type { ComponentKey, LanguageKey } from "../classify/questions.ts"
import type { RepoProfile, Teammate } from "./profile.ts"

export const COMPONENT_LABEL_ALIASES: Record<ComponentKey, ReadonlyArray<string>> = {
  ui: ["c/ui", "ui", "area: ui", "frontend", "web", "app"],
  server: ["c/server", "server", "area: server", "backend"],
  evals: ["c/evals", "evals", "evaluation", "evaluators"],
  traces: ["c/traces", "traces", "tracing", "spans"],
  playground: ["c/playground", "playground"],
  client: ["c/client", "client", "sdk", "clients"],
  cli: ["c/cli", "cli"],
  prompts: ["c/prompts", "prompts", "prompt management"],
  datasets: ["c/datasets", "datasets", "dataset"],
  experiments: ["c/experiments", "experiments", "experiment"],
  sessions: ["c/sessions", "sessions"],
  annotations: ["c/annotations", "annotations", "feedback"],
  auth: ["c/auth", "auth", "authentication", "c/rbac", "rbac", "security"],
  otel_instrumentation: ["c/otel", "otel", "instrumentation", "opentelemetry", "openinference"],
  helm_infra: ["c/helm", "helm", "c/infra", "infra", "infrastructure", "kubernetes", "docker", "deployment"],
  mcp: ["c/mcp", "mcp"],
  agents: ["c/agents", "agents", "agent"],
  api: ["c/api", "api", "graphql", "rest"],
  docs: ["documentation", "docs", "c/docs"],
  unclear: []
}

export const LANGUAGE_LABEL_ALIASES: Record<LanguageKey, ReadonlyArray<string>> = {
  python: ["language: python", "python", "lang: python", "py"],
  typescript: ["language: typescript", "typescript", "javascript", "lang: typescript", "ts", "js"],
  not_applicable: []
}

/** Common workflow labels, with fallbacks when the repo spells them differently. */
export const WORKFLOW_LABEL_ALIASES = {
  needsInfo: ["needs information", "needs info", "needs-more-info", "more info needed", "question", "waiting for response"],
  bug: ["bug", "type: bug", "kind/bug"],
  enhancement: ["enhancement", "feature", "feature request", "type: feature", "kind/feature"],
  docs: ["documentation", "docs"],
  question: ["question", "support"],
  wontfix: ["wontfix", "won't fix", "not planned"],
  duplicate: ["duplicate"],
  invalid: ["invalid", "spam"],
  backlog: ["backlog"],
  roadmap: ["roadmap", "planned"],
  cannotReproduce: ["cannot reproduce", "can't reproduce", "unreproducible"]
} as const
export type WorkflowLabelKey = keyof typeof WORKFLOW_LABEL_ALIASES

/** Ordered by severity / value score index (0 = lowest). */
export const PRIORITY_LABEL_ALIASES: ReadonlyArray<ReadonlyArray<string>> = [
  ["priority: low", "p3", "low priority", "priority/low"],
  ["priority: medium", "p2", "medium priority", "priority/medium"],
  ["priority: high", "p1", "high priority", "priority/high"]
]

export const TRIAGE_LABEL = "triage"

const BOT_PATTERNS = [/\[bot\]$/i, /^dependabot/i, /^renovate/i, /^github-actions/i, /^copilot/i, /^claude$/i, /^codecov/i, /^ghost$/i]
export const isBot = (login: string): boolean => BOT_PATTERNS.some((re) => re.test(login))

/** First repo label matching any alias (case-insensitive), else the first alias as a best guess, else null. */
export const resolveLabel = (profile: RepoProfile, aliases: ReadonlyArray<string>): string | null => {
  const lower = new Map(profile.labels.map((l) => [l.name.toLowerCase(), l.name] as const))
  for (const a of aliases) {
    const hit = lower.get(a.toLowerCase())
    if (hit) return hit
  }
  return null
}

export const workflowLabel = (profile: RepoProfile, key: WorkflowLabelKey): string | null =>
  resolveLabel(profile, WORKFLOW_LABEL_ALIASES[key])

export const priorityLabel = (profile: RepoProfile, level: number): string | null => {
  const aliases = PRIORITY_LABEL_ALIASES[Math.min(Math.max(level, 0), PRIORITY_LABEL_ALIASES.length - 1)]
  return aliases ? resolveLabel(profile, aliases) : null
}

/**
 * Rank teammates for a component + language. Primary area match beats a
 * secondary one; language agreement and overall activity break ties.
 */
export const rankTeammates = (profile: RepoProfile, component: ComponentKey, language: LanguageKey): ReadonlyArray<Teammate> => {
  // People the triager actually picked for this component during live sessions.
  const learnedOwners = profile.learned?.owners[component] ?? []
  const scored = profile.teammates.map((t) => {
    const idx = t.areas.indexOf(component)
    const areaScore = idx === -1 ? 0 : 10 - Math.min(idx, 8)
    const langScore = language !== "not_applicable" && t.languages.includes(language) ? 1 : 0
    const activity = Math.min(1, (t.assigned * 3 + t.reviewed * 2 + t.authored) / 100)
    // An explicit, repeated pick by the triager outranks anything inferred from history.
    const learnedIdx = learnedOwners.indexOf(t.login)
    const learnedScore = learnedIdx === -1 ? 0 : 30 - 5 * Math.min(learnedIdx, 4)
    return { t, score: areaScore * 2 + langScore + activity + learnedScore }
  })
  const matched = scored.filter((s) => s.score > 1).sort((a, b) => b.score - a.score).map((s) => s.t)
  // No one owns this component yet: fall back to the most active people.
  return matched.length > 0 ? matched : profile.teammates.slice(0, 3)
}

/** Teams from CODEOWNERS that cover any of the given file paths. */
export const codeownerTeamsFor = (profile: RepoProfile, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const teams = new Set<string>()
  for (const p of paths) {
    for (const rule of profile.codeowners) {
      if (rule.prefix === "" || p.startsWith(rule.prefix)) rule.teams.forEach((t) => teams.add(t))
    }
  }
  return [...teams]
}

export const codeownerUsersFor = (profile: RepoProfile, paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const users = new Set<string>()
  for (const p of paths) {
    for (const rule of profile.codeowners) {
      if (rule.prefix === "" || p.startsWith(rule.prefix)) rule.users.forEach((u) => users.add(u))
    }
  }
  return [...users]
}
