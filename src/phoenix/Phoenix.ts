/**
 * Phoenix as the training backend. When Phoenix is not configured every
 * method is a no-op and `enabled` is null, so callers can skip training
 * features and point the user at setup docs instead.
 */
import { createClient } from "@arizeai/phoenix-client"
import { appendDatasetExamples, createDataset, getDataset, getDatasetInfo } from "@arizeai/phoenix-client/datasets"
import { addSpanAnnotation, getSpanAnnotations, getSpans } from "@arizeai/phoenix-client/spans"
import type { Example } from "@arizeai/phoenix-client/types/datasets"
import { Context, Effect, Layer, Schema } from "effect"
import type { PhoenixConfig } from "../config/AppConfig.ts"
import { Learned } from "../triage/learned.ts"
export { PHOENIX_SETUP_HINT, PHOENIX_SETUP_URL } from "./constants.ts"
import { PHOENIX_SETUP_HINT } from "./constants.ts"

/** Where applied learnings live in Phoenix: the experiment description, as a fenced JSON block. */
const LEARNED_MARKER = "px-triage learned settings"
export const AppliedLearned = Schema.Struct({
  learned: Learned,
  experimentId: Schema.String,
  appliedBy: Schema.NullOr(Schema.String),
  appliedAt: Schema.String
})
export type AppliedLearned = typeof AppliedLearned.Type

export const renderLearnedDescription = (a: AppliedLearned): string =>
  `${LEARNED_MARKER} (applied by ${a.appliedBy ? "@" + a.appliedBy : "unknown"} at ${a.appliedAt}). px-triage reads this on boot.\n\n\`\`\`json\n${JSON.stringify({ learned: a.learned, experimentId: a.experimentId, appliedBy: a.appliedBy, appliedAt: a.appliedAt }, null, 2)}\n\`\`\``

export const parseLearnedDescription = (description: string | null | undefined): AppliedLearned | null => {
  if (!description || !description.startsWith(LEARNED_MARKER)) return null
  const m = /```json\n([\s\S]*?)\n```/.exec(description)
  if (!m) return null
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AppliedLearned))(m[1] ?? "")
  return decoded._tag === "Some" ? decoded.value : null
}


export class PhoenixError extends Schema.TaggedError<PhoenixError>()("PhoenixError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export type PhoenixClient = ReturnType<typeof createClient>

export interface HumanFeedback {
  readonly chosen: string
  readonly suggested: string | null
  readonly accepted: boolean
  readonly labels: ReadonlyArray<string>
  readonly assignees: ReadonlyArray<string>
  readonly selfAssigned: boolean
  /** GitHub login of the person triaging, or "agent:<name>" for non-interactive runs. */
  readonly triager: string | null
  /** HUMAN for the interactive TUI; LLM when an agent drove the decision. */
  readonly annotatorKind?: "HUMAN" | "LLM"
}

/** A human decision read back from Phoenix (the shared source of truth). */
export interface RemoteDecision {
  /** owner/name, lower-cased; from the span's `repo` attribute or its metadata URL. */
  readonly repo: string | null
  readonly number: number
  readonly kind: "issue" | "pull_request" | null
  readonly chosen: string
  readonly suggested: string | null
  readonly accepted: boolean
  readonly labels: ReadonlyArray<string>
  readonly assignees: ReadonlyArray<string>
  readonly selfAssigned: boolean
  readonly triager: string | null
  readonly annotatorKind: "HUMAN" | "LLM" | "CODE"
  readonly spanId: string
  readonly at: string
}

export class Phoenix extends Context.Service<Phoenix, {
  /** Null when Phoenix is not configured. */
  readonly enabled: PhoenixConfig | null
  readonly client: PhoenixClient | null
  /** Record what the human chose on the classification span (HUMAN annotation). No-op when disabled. */
  readonly annotateClassification: (spanId: string, feedback: HumanFeedback) => Effect.Effect<void>
  /** Create the dataset if needed and append examples not already present (by metadata.number). */
  readonly upsertDataset: (name: string, description: string, examples: ReadonlyArray<Example>) => Effect.Effect<{ datasetId: string; added: number; total: number }, PhoenixError>
  /** Every `triage.human` annotation in the project for one repo, newest first, from all users. */
  readonly listHumanDecisions: (repoSlug: string) => Effect.Effect<ReadonlyArray<RemoteDecision>, PhoenixError>
  /** Record learned settings as "applied" on the experiment they came from (shared with the team). */
  readonly publishLearned: (applied: AppliedLearned) => Effect.Effect<void, PhoenixError>
  /** Newest applied learnings for a dataset, or null. */
  readonly fetchAppliedLearned: (datasetName: string) => Effect.Effect<AppliedLearned | null, PhoenixError>
  /** UI link for a dataset. */
  readonly datasetUrl: (datasetId: string) => string
}>()("px-triage/phoenix/Phoenix") {
  static readonly layer = (config: PhoenixConfig | undefined) =>
    Layer.sync(Phoenix, () => {
      if (!config) {
        return Phoenix.of({
          enabled: null,
          client: null,
          annotateClassification: () => Effect.void,
          upsertDataset: () => Effect.fail(new PhoenixError({ message: PHOENIX_SETUP_HINT })),
          listHumanDecisions: () => Effect.succeed([]),
          publishLearned: () => Effect.fail(new PhoenixError({ message: PHOENIX_SETUP_HINT })),
          fetchAppliedLearned: () => Effect.succeed(null),
          datasetUrl: () => ""
        })
      }
      const baseUrl = config.url.replace(/\/+$/, "")
      const headers: Record<string, string> = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
      const client = createClient({ options: { baseUrl, headers } })

      const annotateClassification = (spanId: string, f: HumanFeedback) =>
        Effect.tryPromise(() =>
          addSpanAnnotation({
            client,
            spanAnnotation: {
              spanId,
              name: "triage.human",
              annotatorKind: f.annotatorKind ?? "HUMAN",
              label: f.chosen,
              score: f.accepted ? 1 : 0,
              explanation: f.suggested ? `suggested ${f.suggested}, chose ${f.chosen}` : `no suggestion, chose ${f.chosen}`,
              metadata: { suggested: f.suggested, labels: [...f.labels], assignees: [...f.assignees], selfAssigned: f.selfAssigned, triager: f.triager }
            }
          })
        ).pipe(Effect.ignore)

      const upsertDataset = (name: string, description: string, examples: ReadonlyArray<Example>) =>
        Effect.tryPromise({
          try: async () => {
            const existing = await getDatasetInfo({ client, dataset: { datasetName: name } }).catch(() => null)
            if (!existing) {
              const created = await createDataset({ client, name, description, examples: [...examples] })
              return { datasetId: created.datasetId, added: examples.length, total: examples.length }
            }
            const current = await getDataset({ client, dataset: { datasetId: existing.id } })
            const seen = new Set(current.examples.map((e) => String((e.metadata as Record<string, unknown> | null)?.["number"] ?? "")))
            const fresh = examples.filter((e) => !seen.has(String(e.metadata?.["number"] ?? "")))
            if (fresh.length > 0) await appendDatasetExamples({ client, dataset: { datasetId: existing.id }, examples: fresh })
            return { datasetId: existing.id, added: fresh.length, total: current.examples.length + fresh.length }
          },
          catch: (cause) => new PhoenixError({ message: `Phoenix dataset "${name}" could not be updated: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
        })

      const project = { projectName: config.projectName }

      const listHumanDecisions = (repoSlug: string) => Effect.tryPromise({
        try: async () => {
          const wanted = repoSlug.toLowerCase()
          // Classify spans carry github.number and repo; annotations hang off them.
          const spans: Array<{ spanId: string; number: number; kind: "issue" | "pull_request" | null; repo: string | null }> = []
          for (const name of ["triage.classify", "Classifier.classify"]) {
            let cursor: string | null = null
            do {
              const res = await getSpans({ client, project, name, limit: 100, cursor })
              for (const sp of res.spans) {
                const attrs = (sp.attributes ?? {}) as Record<string, unknown>
                const n = attrs["github.number"] ?? attrs["number"]
                if (typeof n !== "number") continue
                // Older spans only carried the kind (and the URL) inside the metadata JSON.
                let kind = attrs["github.kind"] ?? attrs["kind"]
                let repo: string | null = typeof attrs["repo"] === "string" ? attrs["repo"].toLowerCase() : null
                if (typeof attrs["metadata"] === "string") {
                  try {
                    const meta = JSON.parse(attrs["metadata"]) as Record<string, unknown>
                    if (kind === undefined) kind = meta["kind"]
                    if (repo === null && typeof meta["url"] === "string") {
                      const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(meta["url"])
                      if (m) repo = `${m[1]}/${m[2]}`.toLowerCase()
                    }
                  } catch { /* ignore */ }
                }
                // Spans from before repo tagging are assumed to belong to the requested repo only
                // when it is the original default; otherwise they are skipped.
                if (repo === null && wanted !== "arize-ai/phoenix") continue
                if (repo !== null && repo !== wanted) continue
                spans.push({ spanId: sp.context.span_id, number: n, kind: kind === "issue" || kind === "pull_request" ? kind : null, repo })
              }
              cursor = res.nextCursor ?? null
            } while (cursor)
          }
          const byId = new Map(spans.map((sp) => [sp.spanId, sp] as const))
          const out: Array<RemoteDecision> = []
          const ids = [...byId.keys()]
          for (let i = 0; i < ids.length; i += 50) {
            let cursor: string | null = null
            do {
              const res = await getSpanAnnotations({ client, project, spanIds: ids.slice(i, i + 50), includeAnnotationNames: ["triage.human"], limit: 500, cursor })
              for (const a of res.annotations) {
                const sp = byId.get(a.span_id)
                if (!sp || !a.result?.label) continue
                const m = (a.metadata ?? {}) as Record<string, unknown>
                out.push({
                  repo: sp.repo ?? wanted,
                  number: sp.number,
                  kind: sp.kind,
                  chosen: a.result.label,
                  suggested: typeof m["suggested"] === "string" ? m["suggested"] : null,
                  accepted: a.result.score === 1,
                  labels: Array.isArray(m["labels"]) ? (m["labels"] as Array<string>) : [],
                  assignees: Array.isArray(m["assignees"]) ? (m["assignees"] as Array<string>) : [],
                  selfAssigned: m["selfAssigned"] === true,
                  triager: typeof m["triager"] === "string" ? m["triager"] : null,
                  annotatorKind: a.annotator_kind,
                  spanId: a.span_id,
                  at: a.created_at
                })
              }
              cursor = res.nextCursor ?? null
            } while (cursor)
          }
          return out.sort((x, y) => y.at.localeCompare(x.at))
        },
        catch: (cause) => new PhoenixError({ message: `Could not read decisions from Phoenix: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
      })

      const publishLearned = (applied: AppliedLearned) =>
        Effect.tryPromise({
          try: async () => {
            const res = await client.PATCH("/v1/experiments/{experiment_id}", {
              params: { path: { experiment_id: applied.experimentId } },
              body: { description: renderLearnedDescription(applied) }
            })
            if (res.error) throw new Error(String(res.error))
          },
          catch: (cause) => new PhoenixError({ message: `Could not publish learned settings to Phoenix: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
        })

      const fetchAppliedLearned = (datasetName: string) =>
        Effect.tryPromise({
          try: async () => {
            const info = await getDatasetInfo({ client, dataset: { datasetName } }).catch(() => null)
            if (!info) return null
            const list = await client.GET("/v1/datasets/{dataset_id}/experiments", { params: { path: { dataset_id: info.id } } })
            const experiments = [...(list.data?.data ?? [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            // Only recent experiments can carry an "applied" stamp; check a handful.
            for (const e of experiments.slice(0, 12)) {
              const full = await client.GET("/v1/experiments/{experiment_id}", { params: { path: { experiment_id: e.id } } })
              const parsed = parseLearnedDescription(full.data?.data?.description)
              if (parsed) return parsed
            }
            return null
          },
          catch: (cause) => new PhoenixError({ message: `Could not read learned settings from Phoenix: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
        })

      return Phoenix.of({
        enabled: config,
        client,
        annotateClassification,
        upsertDataset,
        listHumanDecisions,
        publishLearned,
        fetchAppliedLearned,
        datasetUrl: (datasetId) => `${baseUrl}/datasets/${datasetId}`
      })
    })
}
