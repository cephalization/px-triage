/**
 * THE file to review.
 *
 * Every TypeSafe (Jev) question the triage CLI asks, plus every threshold
 * the routing code uses, lives here so a human can audit the judgement
 * surface in one place. Question keys are for code only; the model sees the
 * instructions + criteria, so each question must stand on its own.
 */
import { choice, noul, score } from "@typesafe-ai/sdk"

export const DEFAULT_MODEL = "jev-latest"

/**
 * Default project description, used for arize-ai/phoenix and as the example in
 * onboarding. Other repos get theirs from ~/.px-triage/config.json
 * (`repos.<owner/name>.description`), seeded from GitHub on first use.
 */
export const PHOENIX_CONTEXT =
  "Arize Phoenix is an open-source LLM observability and evaluation platform: " +
  "a Python server (FastAPI, SQLAlchemy, SQLite/PostgreSQL) with a React + TypeScript web UI, " +
  "Python and TypeScript client SDKs (arize-phoenix-client, @arizeai/phoenix-client), " +
  "the phoenix-evals library, OpenInference OpenTelemetry instrumentation, a prompt playground, " +
  "datasets and experiments, prompt management, sessions, annotations, a CLI, an MCP server, " +
  "Helm charts, and an in-product agent (PXI)."

// ---------------------------------------------------------------------------
// Choice criteria
// ---------------------------------------------------------------------------

export const ISSUE_CATEGORY = {
  bug_report: "Reports that something in the project behaves incorrectly, errors, or regressed. Includes bug reports written as questions ('why does X crash?').",
  feature_request: "Asks for new functionality, a configuration option, or a change in the project's behavior that is not currently supported.",
  question_or_support: "Asks how to use, configure, deploy, or integrate the project; a support request rather than a defect or a product change.",
  documentation: "Reports missing, wrong, or unclear documentation, or asks for docs/examples to be added or fixed (not promotional).",
  off_topic_or_promotional: "Primarily promotes a third-party product, asks the project to list or advertise an external service, or is unrelated to the project.",
  spam_or_nonsense: "Spam, gibberish, an empty template, or content with no actionable meaning."
} as const
export type IssueCategory = keyof typeof ISSUE_CATEGORY

export const PR_CATEGORY = {
  bug_fix: "Fixes incorrect behavior, an error, or a regression in the project.",
  feature: "Adds new functionality, an option, an endpoint, or a user-visible capability.",
  documentation: "Only changes documentation, docstrings, READMEs, or examples for the project itself.",
  refactor_or_chore: "Internal restructuring, cleanup, tooling, formatting, or CI changes with no intended behavior change.",
  tests_only: "Only adds or changes tests.",
  dependency_update: "Bumps or changes dependencies or lockfiles.",
  off_topic_or_promotional: "Primarily adds, advertises, or links a third-party product or service, or is unrelated to the project."
} as const
export type PrCategory = keyof typeof PR_CATEGORY

export const COMPONENT = {
  ui: "The React/TypeScript web app: pages, tables, charts, forms, navigation, visual rendering, browser behavior.",
  server: "The Python server: database models, migrations, ingestion, GraphQL/REST handlers, background jobs, performance of the backend.",
  evals: "The phoenix-evals library or server-side evaluators: LLM-as-judge, evaluators, scoring, model adapters for evals.",
  traces: "Trace and span ingestion, display, filtering, cost tracking, token counts, span attributes, project views.",
  playground: "The prompt playground: running prompts against LLM providers, provider parameters, tool calls, model lists.",
  client: "The Python or TypeScript client SDKs (arize-phoenix-client, @arizeai/phoenix-client) and their REST calls.",
  cli: "The phoenix / px command-line interface (@arizeai/phoenix-cli or the Python CLI).",
  prompts: "Prompt management: prompt versions, tags, templates, prompt formatting (f-string, mustache).",
  datasets: "Datasets and examples: creating, uploading, editing, exporting datasets.",
  experiments: "Experiments: running experiments, evaluations on experiment runs, comparing experiments, experiment metrics.",
  sessions: "Sessions grouping of traces and the sessions UI/API.",
  annotations: "Human or automated annotations, feedback, labels and scores attached to spans/traces.",
  auth: "Authentication, authorization, RBAC, API keys, OAuth/OIDC, users and roles.",
  otel_instrumentation: "OpenTelemetry / OpenInference instrumentation packages, exporters, collectors, otel configuration.",
  helm_infra: "Helm charts, Kubernetes, Docker images, deployment and infrastructure configuration.",
  mcp: "The Phoenix MCP server or MCP tooling.",
  agents: "The in-product agent (PXI) or terminal agent features for Phoenix data.",
  api: "The public REST or GraphQL API surface itself (schemas, endpoints) independent of a specific client.",
  docs: "Documentation site, guides, tutorials, notebooks, READMEs.",
  unclear: "Cannot tell which component is involved from the text."
} as const
export type ComponentKey = keyof typeof COMPONENT

export const LANGUAGE = {
  python: "The user is primarily working in Python (Python tracebacks, pip, Python SDK, phoenix-evals).",
  typescript: "The user is primarily working in TypeScript/JavaScript (npm, Node, the TS client, the web app code).",
  not_applicable: "No specific programming language is central (UI-only, deployment, docs, or unclear)."
} as const
export type LanguageKey = keyof typeof LANGUAGE

// ---------------------------------------------------------------------------
// Score levels (index 0 = lowest). Levels must describe concrete situations.
// ---------------------------------------------------------------------------

export const SEVERITY_LEVELS = [
  "Cosmetic or minor inconvenience; a workaround exists and no data is wrong or lost.",
  "A workflow is blocked or results are wrong for some users, but the system stays up and data is not lost.",
  "Data loss, corruption, security exposure, a crash/outage, or silently incorrect results that affect many users."
] as const

export const VALUE_LEVELS = [
  "Niche or very specific to one user's setup; little benefit to other Phoenix users.",
  "A useful improvement that a meaningful set of users would appreciate.",
  "Broadly valuable or strategically important; unblocks common workflows or many users."
] as const

export const RISK_LEVELS = [
  "Small, isolated change with tests or obvious correctness; easy to review.",
  "Moderate change touching shared logic, UI state, or multiple files; needs careful review.",
  "Large or risky change to core behavior, database schema, public API, or security; needs a maintainer deep-dive."
] as const

// ---------------------------------------------------------------------------
// Questions. All questions in a set are evaluated in parallel over one state.
// ---------------------------------------------------------------------------

const makeCommonQuestions = (context: string) => ({
  component: choice(
    `Which component of the project does this GitHub item primarily concern? Project: ${context} Use the title, body, file paths, and code snippets.`,
    COMPONENT
  ),
  language: choice(
    "Which programming language is the author primarily working in, based on code, stack traces, package managers, and SDK names mentioned?",
    LANGUAGE
  ),
  in_scope: noul(
    `Is this item within the scope of the project itself? Project: ${context}`,
    {
      true: "It concerns the project's own code, UI, clients, docs, or deployment.",
      false: "It is mainly about a third-party product, asks the project to promote or list an external service, or is unrelated to the project."
    }
  ),
  agent_authored: noul(
    "Was this item most likely written by an automated coding agent rather than directly by a human? Signals: 'Generated with Claude Code', 'Co-Authored-By: Claude', uniform machine-like structure, exhaustive file/line citations with no personal context.",
    { true: "Written by an AI coding agent.", false: "Written by a person." }
  )
})

export const makeIssueQuestions = (context: string) => ({
  ...makeCommonQuestions(context),
  category: choice(
    `What is the primary category of this GitHub issue? Project: ${context}`,
    ISSUE_CATEGORY
  ),
  reproducible: noul(
    "Does the issue give a maintainer enough concrete information to reproduce or verify it: the project version or commit, how it is deployed or installed, concrete steps or code, and the observed vs expected behavior? For a feature request, treat this as whether the request is specific enough to act on.",
    {
      true: "Version/deployment and steps or code are present, or the request is specific and actionable.",
      false: "Key details are missing, so a maintainer would have to ask the author before doing anything."
    }
  ),
  severity: score(
    "If this issue is a bug report, how severe is the defect it describes? If it is not a bug report, pick the lowest level.",
    SEVERITY_LEVELS
  ),
  value: score(
    "If this issue is a feature request or documentation request, how valuable would fulfilling it be to the project's users in general? If it is not a request, pick the lowest level.",
    VALUE_LEVELS
  )
})

export const makePrQuestions = (context: string) => ({
  ...makeCommonQuestions(context),
  category: choice(
    `What is the primary category of this pull request? Project: ${context} Use the title, description, and the list of changed files.`,
    PR_CATEGORY
  ),
  described: noul(
    "Does the pull request description explain what problem it solves, what the change does, and how it was verified (tests, screenshots, manual steps), well enough for a maintainer to start reviewing without asking questions?",
    {
      true: "Problem, change, and verification are all described.",
      false: "The description is empty, boilerplate, or leaves a reviewer guessing about intent or testing."
    }
  ),
  risk: score(
    "How risky is this pull request to review and merge, judging by what it changes (files, size, description)?",
    RISK_LEVELS
  )
})

export type IssueQuestions = ReturnType<typeof makeIssueQuestions>
export type PrQuestions = ReturnType<typeof makePrQuestions>

// ---------------------------------------------------------------------------
// Thresholds used by src/triage/plan.ts. Tune against real triage outcomes.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Below this `category.confidence` the recommendation is flagged uncertain and no default is preselected. */
  categoryConfidenceFloor: 0.5,
  /** `reproducible` / `described` noul below this -> suggest "needs information". */
  needsInfoBelow: 0.4,
  /** `in_scope` noul below this -> suggest closing. */
  outOfScopeBelow: 0.3,
  /** Only add a `c/*` label when the winning component has at least this probability. */
  componentLabelMinProbability: 0.35,
  /** Only add a `language:` label when the winning language has at least this probability. */
  languageLabelMinProbability: 0.6,
  /** Show the "agent-authored" badge above this probability. */
  agentAuthoredAbove: 0.7,
  /** Only add a priority label when the severity score is at least this confident. */
  severityConfidenceFloor: 0.35
} as const

/** Max characters of body / comment text sent as state (keeps us well under the 32k-token state budget). */
export const STATE_LIMITS = {
  bodyChars: 16_000,
  commentChars: 1_500,
  maxComments: 3,
  maxFiles: 40
} as const
