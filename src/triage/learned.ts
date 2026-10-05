/** Leaf module: what `pxt train` learns. Kept import-free so Phoenix and profile code can share it. */
import { Schema } from "effect"

export const Learned = Schema.Struct({
  updatedAt: Schema.String,
  sampleSize: Schema.Int,
  experimentId: Schema.optional(Schema.String),
  /** Threshold overrides that beat the defaults by a margin on the training set. */
  thresholds: Schema.Record(Schema.String, Schema.Number),
  /** "<kind>:<category>" → action humans actually chose, when a clear majority exists. */
  policy: Schema.Record(Schema.String, Schema.String),
  /** "<component>" → logins humans assigned (excluding self-assigns), most frequent first. */
  owners: Schema.Record(Schema.String, Schema.Array(Schema.String))
})
export type Learned = typeof Learned.Type
