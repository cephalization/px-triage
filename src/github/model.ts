import { Schema } from "effect"

export const Comment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.String
})
export type Comment = typeof Comment.Type

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int
})
export type ChangedFile = typeof ChangedFile.Type

/** Another issue/PR connected to this one (closing references, either direction). */
export const LinkedItem = Schema.Struct({
  kind: Schema.Literals(["issue", "pull_request"]),
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  author: Schema.String,
  authorAssociation: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String)
})
export type LinkedItem = typeof LinkedItem.Type

export const PrDetails = Schema.Struct({
  isDraft: Schema.Boolean,
  merged: Schema.Boolean,
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  files: Schema.Array(ChangedFile),
  reviewCount: Schema.Int,
  /** Logins of people who have left a review. */
  reviewers: Schema.Array(Schema.String),
  requestedReviewers: Schema.Array(Schema.String),
  linkedIssues: Schema.Array(Schema.Struct({ number: Schema.Int, title: Schema.String })),
  checks: Schema.NullOr(Schema.String)
})
export type PrDetails = typeof PrDetails.Type

export class TriageItem extends Schema.Class<TriageItem>("TriageItem")({
  kind: Schema.Literals(["issue", "pull_request"]),
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  author: Schema.String,
  authorName: Schema.NullOr(Schema.String),
  authorAssociation: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  assignees: Schema.Array(Schema.String),
  commentCount: Schema.Int,
  comments: Schema.Array(Comment),
  reactions: Schema.Int,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  stateReason: Schema.NullOr(Schema.String),
  /** Open items linked by closing references: PRs that close this issue, or issues this PR closes. */
  linked: Schema.Array(LinkedItem),
  pr: Schema.NullOr(PrDetails)
}) {
  get isPr(): boolean {
    return this.kind === "pull_request"
  }
  get shortKind(): string {
    return this.kind === "pull_request" ? "PR" : "issue"
  }
}

export const RepoLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.NullOr(Schema.String)
})
export type RepoLabel = typeof RepoLabel.Type

export interface Repo {
  readonly owner: string
  readonly name: string
}

export const parseRepo = (slug: string): Repo => {
  const [owner, name] = slug.split("/")
  if (!owner || !name) throw new Error(`Expected owner/name, got "${slug}"`)
  return { owner, name }
}

export const repoSlug = (repo: Repo): string => `${repo.owner}/${repo.name}`
