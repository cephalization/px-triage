/**
 * Team roster, label mappings, and reviewer routing for arize-ai/phoenix.
 *
 * This file is meant to be edited by humans. The initial entries were derived
 * from who has actually been assigned issues / reviewed PRs per `c/*` label
 * over the last few hundred items, so treat them as a starting point.
 */
import type { ComponentKey, LanguageKey } from "../classify/questions.js"

export interface Teammate {
  readonly login: string
  /** Components this person usually owns. Order matters: first is strongest. */
  readonly areas: ReadonlyArray<ComponentKey>
  readonly languages: ReadonlyArray<Exclude<LanguageKey, "not_applicable">>
  readonly note?: string
}

export const ROSTER: ReadonlyArray<Teammate> = [
  {
    login: "axiomofjoy",
    areas: ["server", "traces", "otel_instrumentation", "agents", "mcp", "api", "evals", "datasets"],
    languages: ["python"],
    note: "Most-assigned maintainer overall; server + Python"
  },
  {
    login: "mikeldking",
    areas: ["ui", "client", "cli", "api", "traces", "playground", "sessions", "annotations"],
    languages: ["typescript", "python"],
    note: "Project lead; UI + TS client"
  },
  {
    login: "cephalization",
    areas: ["ui", "playground", "agents", "evals", "annotations", "client"],
    languages: ["typescript"],
    note: "UI + TypeScript"
  },
  {
    login: "anticorrelator",
    areas: ["server", "traces", "experiments", "prompts", "ui", "client", "otel_instrumentation", "auth"],
    languages: ["python"],
    note: "Server internals, traces, experiments"
  },
  {
    login: "ehutt",
    areas: ["evals", "experiments", "datasets", "client", "docs"],
    languages: ["python"],
    note: "phoenix-evals"
  },
  {
    login: "yfrigui2",
    areas: ["playground", "experiments", "cli", "traces", "agents"],
    languages: ["python", "typescript"]
  },
  {
    login: "rickarize",
    areas: ["ui", "evals", "datasets", "mcp"],
    languages: ["typescript", "python"]
  },
  {
    login: "blindmansion",
    areas: ["cli", "client"],
    languages: ["typescript"]
  },
  {
    login: "MoraVigoMalusardi",
    areas: ["cli", "evals", "docs", "otel_instrumentation", "mcp"],
    languages: ["python"]
  },
  {
    login: "Nancy-Chauhan",
    areas: ["docs", "otel_instrumentation", "mcp"],
    languages: ["python"]
  },
  {
    login: "ArcticFaded",
    areas: ["helm_infra"],
    languages: ["python"]
  }
]

/** `c/*` style label for each classifier component. `null` means "no label". */
export const COMPONENT_LABEL: Record<ComponentKey, string | null> = {
  ui: "c/ui",
  server: "c/server",
  evals: "c/evals",
  traces: "c/traces",
  playground: "c/playground",
  client: "c/client",
  cli: "c/cli",
  prompts: "c/prompts",
  datasets: "c/datasets",
  experiments: "c/experiments",
  sessions: "c/sessions",
  annotations: "c/annotations",
  auth: "c/auth",
  otel_instrumentation: "c/otel",
  helm_infra: "c/helm",
  mcp: "c/mcp",
  agents: "c/agents",
  api: "c/api",
  docs: "documentation",
  unclear: null
}

export const LANGUAGE_LABEL: Record<LanguageKey, string | null> = {
  python: "language: python",
  typescript: "language: typescript",
  not_applicable: null
}

/** Ordered by severity / value score index (0 = lowest). */
export const PRIORITY_LABELS = ["priority: low", "priority: medium", "priority: high"] as const

export const TRIAGE_LABEL = "triage"
export const NEEDS_INFO_LABEL = "needs information"
export const BUG_LABEL = "bug"
export const ENHANCEMENT_LABEL = "enhancement"
export const DOCS_LABEL = "documentation"
export const QUESTION_LABEL = "question"
export const WONTFIX_LABEL = "wontfix"
export const DUPLICATE_LABEL = "duplicate"
export const INVALID_LABEL = "invalid"
export const BACKLOG_LABEL = "backlog"
export const ROADMAP_LABEL = "roadmap"
export const AGENT_LABEL = "agents"

/** Mirrors .github/CODEOWNERS so PR reviewers can fall back to a team. */
export const CODEOWNER_TEAMS: ReadonlyArray<{ readonly prefix: string; readonly teams: ReadonlyArray<string> }> = [
  { prefix: "js/", teams: ["oss-javascript"] },
  { prefix: "app/", teams: ["oss-javascript", "oss-design"] },
  { prefix: "src/", teams: ["oss-python"] },
  { prefix: "packages/", teams: ["oss-python"] },
  { prefix: "examples/", teams: ["dev-rel", "oss-eng"] },
  { prefix: "tutorials/", teams: ["dev-rel", "oss-eng"] }
]

/** Hex colors for the labels we render as chips (from the repo). */
export const LABEL_COLORS: Record<string, string> = {
  bug: "d73a4a",
  documentation: "0075ca",
  duplicate: "cfd3d7",
  enhancement: "a2eeef",
  question: "d876e3",
  wontfix: "ffffff",
  invalid: "e4e669",
  triage: "FBCA04",
  "needs information": "2E4C95",
  backlog: "0E82FA",
  roadmap: "D5B9A6",
  "priority: highest": "FF0000",
  "priority: high": "D93F0B",
  "priority: medium": "FBCA04",
  "priority: low": "0E8A16",
  "language: python": "bc8149",
  "language: typescript": "1d4394",
  "c/ui": "AAB2F4",
  "c/server": "462EB2",
  "c/evals": "A257A1",
  "c/traces": "BEBEAC",
  "c/playground": "C94FF8",
  "c/client": "006b75",
  "c/cli": "1D76DB",
  "c/prompts": "f9d0c4",
  "c/experiments": "34234D",
  "c/agents": "8dbadd",
  "c/api": "7DE9DA",
  "c/auth": "220A13",
  "c/annotations": "FB8B90",
  "c/mcp": "aaaaaa",
  "c/otel": "aaaaaa",
  "c/helm": "aaaaaa",
  "c/datasets": "aaaaaa",
  "c/sessions": "aaaaaa",
  agents: "ededed",
  "DO NOT MERGE": "D93F0B",
  lgtm: "238636"
}

/**
 * Rank teammates for a component + language. Primary area match beats a
 * secondary one; language agreement breaks ties.
 */
export const rankTeammates = (
  component: ComponentKey,
  language: LanguageKey
): ReadonlyArray<Teammate> => {
  const scored = ROSTER.map((t) => {
    const idx = t.areas.indexOf(component)
    const areaScore = idx === -1 ? 0 : 10 - Math.min(idx, 8)
    const langScore = language !== "not_applicable" && t.languages.includes(language) ? 1 : 0
    return { t, score: areaScore * 2 + langScore }
  })
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.t)
}

/** Teams from CODEOWNERS that cover any of the given file paths. */
export const codeownerTeamsFor = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const teams = new Set<string>()
  for (const p of paths) {
    for (const rule of CODEOWNER_TEAMS) {
      if (p.startsWith(rule.prefix)) rule.teams.forEach((t) => teams.add(t))
    }
  }
  return [...teams]
}
