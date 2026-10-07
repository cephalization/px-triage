/**
 * Wraps the TypeSafe SDK in an Effect service. One `systemOne` call per item
 * answers every question in parallel (speculative fan-out); the session
 * starts these calls for the whole queue as soon as it loads, so by the time
 * you reach an item its assessment is almost always already there.
 */
import { OtelTracer } from "@effect/opentelemetry"
import { context as otelContext, type Span as OtelSpan, trace as otelTrace } from "@opentelemetry/api"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { AppConfig, CACHE_DIR } from "../config/AppConfig.ts"
import { TypeSafeClient } from "@typesafe-ai/sdk"
import type { TriageItem } from "../github/model.ts"
import {
  type ComponentKey,
  type IssueCategory,
  type LanguageKey,
  type PrCategory,
  DEFAULT_MODEL,
  STATE_LIMITS,
  makeIssueQuestions,
  makePrQuestions
} from "./questions.ts"

export class ClassifyError extends Schema.TaggedError<ClassifyError>()("ClassifyError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export interface Distribution<K extends string = string> {
  readonly choice: K
  readonly confidence: number
  readonly probabilities: Readonly<Record<K, number>>
}

export interface Scored {
  /** TypeSafe's probability-weighted position on the level scale (e.g. 0.41). */
  readonly score: number
  /** Most likely level: index into the level list (0 = lowest). Use this for routing. */
  readonly level: number
  readonly confidence: number
  readonly probabilities: ReadonlyArray<number>
}

export interface Assessment {
  readonly kind: TriageItem["kind"]
  readonly model: string
  readonly latencyMs: number
  readonly inputTokens: number
  readonly category: Distribution<IssueCategory> | Distribution<PrCategory>
  readonly component: Distribution<ComponentKey>
  readonly language: Distribution<LanguageKey>
  /** P(yes) that the item is within Phoenix's scope. */
  readonly inScope: number
  /** P(yes) that enough information is present (reproducible for issues, described for PRs). */
  readonly complete: number
  /** P(yes) that an AI agent wrote it. */
  readonly agentAuthored: number
  /** Issues only: bug severity. */
  readonly severity: Scored | null
  /** Issues only: feature value. */
  readonly value: Scored | null
  /** PRs only: review risk. */
  readonly risk: Scored | null
  /** True when served from the on-disk cache. */
  readonly cached?: boolean
}

const DistributionSchema = Schema.Struct({
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number)
})
const ScoredSchema = Schema.NullOr(Schema.Struct({ score: Schema.Number, level: Schema.optional(Schema.Number), confidence: Schema.Number, probabilities: Schema.Array(Schema.Number) }))
/** Loose on-disk shape; the narrow literal unions are only needed at the call site. */
const CachedAssessment = Schema.Struct({
  kind: Schema.Literals(["issue", "pull_request"]),
  model: Schema.String,
  latencyMs: Schema.Number,
  inputTokens: Schema.Number,
  category: DistributionSchema,
  component: DistributionSchema,
  language: DistributionSchema,
  inScope: Schema.Number,
  complete: Schema.Number,
  agentAuthored: Schema.Number,
  severity: ScoredSchema,
  value: ScoredSchema,
  risk: ScoredSchema
})

export class Classifier extends Context.Service<Classifier, {
  readonly classify: (item: TriageItem) => Effect.Effect<Assessment, ClassifyError>
  readonly model: string
  /** Hash of the question set + project description; changes when either is edited. */
  readonly questionsHash: string
}>()("px-triage/classify/Classifier") {
  static readonly layer = (options: { readonly model: string | undefined; readonly cache?: boolean | undefined; readonly context: string }) =>
    Layer.effect(
      Classifier,
      Effect.gen(function*() {
        const { config } = yield* AppConfig
        const fs = yield* FileSystem.FileSystem
        const useCache = options.cache ?? true
        const issueQuestions = makeIssueQuestions(options.context)
        const prQuestions = makePrQuestions(options.context)
        /** Any change to the questions, criteria, or project description invalidates the cache. */
        const questionsHash = createHash("sha1").update(JSON.stringify({ issueQuestions, prQuestions })).digest("hex").slice(0, 12)
        const apiKey = config.typesafeApiKey
        const model = options.model ?? config.model ?? DEFAULT_MODEL
        const client = new TypeSafeClient({ apiKey, defaultModel: model, logLevel: "off" })

        // Untraced on purpose: the caller owns the span (see session.ts), and
        // the OpenInference instrumentation adds the DECISION child under it.
        const classifyUncached = Effect.fnUntraced(function*(item: TriageItem) {
          const state = toState(item)
          const started = performance.now()
          // Run the SDK call inside the current Effect span's OTel context so the
          // OpenInference instrumentation's DECISION span nests under it.
          const otelSpan = (yield* OtelTracer.currentOtelSpan.pipe(Effect.option)).pipe((o) => (o._tag === "Some" ? o.value : undefined))
          if (item.kind === "pull_request") {
            const result = yield* Effect.tryPromise({
              try: (signal) => inSpanContext(otelSpan, () => client.systemOne({ state, questions: prQuestions }, { signal })),
              catch: (cause) => new ClassifyError({ message: `TypeSafe request failed for #${item.number}: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
            })
            const a = result.answers
            return {
              kind: item.kind,
              model: result.model,
              latencyMs: Math.round(performance.now() - started),
              inputTokens: result.usage.input_tokens,
              category: a.category,
              component: a.component,
              language: a.language,
              inScope: a.in_scope.noul,
              complete: a.described.noul,
              agentAuthored: a.agent_authored.noul,
              severity: null,
              value: null,
              risk: toScored(a.risk)
            } satisfies Assessment
          }
          const result = yield* Effect.tryPromise({
            try: (signal) => inSpanContext(otelSpan, () => client.systemOne({ state, questions: issueQuestions }, { signal })),
            catch: (cause) => new ClassifyError({ message: `TypeSafe request failed for #${item.number}: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
          })
          const a = result.answers
          return {
            kind: item.kind,
            model: result.model,
            latencyMs: Math.round(performance.now() - started),
            inputTokens: result.usage.input_tokens,
            category: a.category,
            component: a.component,
            language: a.language,
            inScope: a.in_scope.noul,
            complete: a.reproducible.noul,
            agentAuthored: a.agent_authored.noul,
            severity: toScored(a.severity),
            value: toScored(a.value),
            risk: null
          } satisfies Assessment
        })

        // Disk cache: same item content (updatedAt), model, and question set → same answer.
        const cachePath = (item: TriageItem) => {
          const key = createHash("sha1")
            .update([item.id, item.updatedAt, model, questionsHash].join("|"))
            .digest("hex")
            .slice(0, 16)
          return join(CACHE_DIR, `${item.kind}-${item.number}-${key}.json`)
        }

        const readCache = (item: TriageItem) =>
          fs.readFileString(cachePath(item)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CachedAssessment))),
            // The on-disk shape is validated structurally; the literal unions were
            // produced by the same question set (hash is part of the cache key).
            Effect.map((a): Assessment => {
              const withLevel = (sc: { readonly score: number; readonly confidence: number; readonly probabilities: ReadonlyArray<number>; readonly level?: number | undefined } | null) =>
                sc ? { ...sc, level: sc.level ?? argmax(sc.probabilities) } : null
              return { ...(a as unknown as Assessment), severity: withLevel(a.severity), value: withLevel(a.value), risk: withLevel(a.risk), latencyMs: 0, cached: true }
            }),
            Effect.option
          )

        const writeCache = (item: TriageItem, a: Assessment) =>
          fs.makeDirectory(CACHE_DIR, { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(cachePath(item), JSON.stringify(a))),
            Effect.ignore
          )

        const classify = (item: TriageItem) =>
          Effect.gen(function*() {
            if (useCache) {
              const hit = yield* readCache(item)
              if (hit._tag === "Some") return hit.value
            }
            const fresh = yield* classifyUncached(item)
            if (useCache) yield* writeCache(item, fresh)
            return fresh
          })

        return Classifier.of({ classify, model, questionsHash })
      })
    )
}

const toScored = (r: {
  readonly score: number
  readonly confidence: number
  readonly probabilities: Readonly<Record<string, number>>
}): Scored => {
  const probabilities = Object.keys(r.probabilities)
    .map(Number)
    .sort((a, b) => a - b)
    .map((k) => r.probabilities[String(k)] ?? 0)
  return { score: r.score, level: argmax(probabilities), confidence: r.confidence, probabilities }
}

export const argmax = (xs: ReadonlyArray<number>): number => xs.reduce((best, x, i) => (x > (xs[best] ?? -Infinity) ? i : best), 0)

const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`)

/** Run `f` with `span` (if any) as the active OpenTelemetry context. */
const inSpanContext = <A>(span: OtelSpan | undefined, f: () => A): A =>
  span ? otelContext.with(otelTrace.setSpan(otelContext.active(), span), f) : f()

/** "owner/name" from a GitHub issue or PR URL. */
export const repoFromUrl = (url: string): string => {
  const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(url)
  return m ? `${m[1]}/${m[2]}` : "unknown"
}

/** Structured state: named fields help the model find what each question needs. */
export const toState = (item: TriageItem) => ({
  kind: item.kind === "pull_request" ? "pull_request" : "issue",
  repository: repoFromUrl(item.url),
  number: item.number,
  title: item.title,
  author: {
    login: item.author,
    association: item.authorAssociation
  },
  existing_labels: [...item.labels],
  body: clip(item.body, STATE_LIMITS.bodyChars),
  comments: item.comments.slice(0, STATE_LIMITS.maxComments).map((c) => ({
    author: c.author,
    body: clip(c.body, STATE_LIMITS.commentChars)
  })),
  ...(item.pr
    ? {
      pull_request: {
        draft: item.pr.isDraft,
        additions: item.pr.additions,
        deletions: item.pr.deletions,
        changed_files: item.pr.changedFiles,
        base_branch: item.pr.baseRefName,
        files: item.pr.files.slice(0, STATE_LIMITS.maxFiles).map((f) => `${f.path} (+${f.additions} -${f.deletions})`),
        linked_issues: item.pr.linkedIssues.map((i) => `#${i.number} ${i.title}`),
        checks: item.pr.checks
      }
    }
    : {})
})
