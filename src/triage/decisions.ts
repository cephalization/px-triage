/**
 * Append-only log of what Jev suggested vs. what the human chose. This is the
 * feedback signal `px-triage train` uses to report acceptance and to find the
 * cases where the questions or thresholds need work.
 */
import { Effect, FileSystem, Schema } from "effect"
import type { Assessment } from "../classify/Classifier.js"
import { CONFIG_DIR, DECISIONS_FILE } from "../config/AppConfig.js"
import type { TriageItem } from "../github/model.js"
import type { ActionKind, TriagePlan } from "./plan.js"

export const Decision = Schema.Struct({
  ts: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  kind: Schema.Literals(["issue", "pull_request"]),
  title: Schema.String,
  suggested: Schema.NullOr(Schema.String),
  uncertain: Schema.Boolean,
  chosen: Schema.String,
  accepted: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
  category: Schema.NullOr(Schema.String),
  categoryConfidence: Schema.NullOr(Schema.Number),
  complete: Schema.NullOr(Schema.Number),
  inScope: Schema.NullOr(Schema.Number),
  labelsAdded: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  dryRun: Schema.Boolean
})
export type Decision = typeof Decision.Type

export const makeDecision = (input: {
  repo: string
  item: TriageItem
  assessment: Assessment | null
  plan: TriagePlan | null
  chosen: ActionKind
  labelsAdded: ReadonlyArray<string>
  assignees: ReadonlyArray<string>
  dryRun: boolean
}): Decision => ({
  ts: new Date().toISOString(),
  repo: input.repo,
  number: input.item.number,
  kind: input.item.kind,
  title: input.item.title,
  suggested: input.plan?.action ?? null,
  uncertain: input.plan?.uncertain ?? true,
  chosen: input.chosen,
  accepted: input.plan !== null && input.plan.action === input.chosen,
  model: input.assessment?.model ?? null,
  category: input.assessment?.category.choice ?? null,
  categoryConfidence: input.assessment?.category.confidence ?? null,
  complete: input.assessment?.complete ?? null,
  inScope: input.assessment?.inScope ?? null,
  labelsAdded: [...input.labelsAdded],
  assignees: [...input.assignees],
  dryRun: input.dryRun
})

export const appendDecision = (decision: Decision) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(CONFIG_DIR, { recursive: true })
    const existing = yield* fs.readFileString(DECISIONS_FILE).pipe(Effect.orElseSucceed(() => ""))
    yield* fs.writeFileString(DECISIONS_FILE, existing + JSON.stringify(decision) + "\n")
  }).pipe(Effect.ignore)

export const readDecisions = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(DECISIONS_FILE).pipe(Effect.orElseSucceed(() => ""))
  const out: Array<Decision> = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Decision))(line)
    if (parsed._tag === "Some") out.push(parsed.value)
  }
  return out
})
