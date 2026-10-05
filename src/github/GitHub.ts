/**
 * GitHub access. One GraphQL search pulls the whole triage queue (issues and
 * PRs, bodies, comments, files) in a single round trip; mutations go through
 * REST. The token comes from GITHUB_TOKEN / GH_TOKEN, falling back to
 * `gh auth token` so the CLI works wherever `gh` is logged in.
 */
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Repo, TriageItem, repoSlug } from "./model.js"

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export type QueueFilter = "all" | "issues" | "prs"

export interface FetchQueueOptions {
  readonly repo: Repo
  readonly label: string
  readonly limit: number
  readonly only: QueueFilter
}

export class GitHub extends Context.Service<GitHub, {
  /** Login of the authenticated user (cached for the process). */
  readonly viewer: Effect.Effect<string, GitHubError>
  readonly fetchTriageQueue: (options: FetchQueueOptions) => Effect.Effect<ReadonlyArray<TriageItem>, GitHubError>
  readonly fetchItem: (repo: Repo, number: number) => Effect.Effect<TriageItem, GitHubError>
  /** Items that already left the triage queue (for training / calibration). */
  readonly fetchHistory: (options: { readonly repo: Repo; readonly label: string; readonly limit: number }) => Effect.Effect<ReadonlyArray<TriageItem>, GitHubError>
  readonly addLabels: (repo: Repo, number: number, labels: ReadonlyArray<string>) => Effect.Effect<void, GitHubError>
  readonly removeLabel: (repo: Repo, number: number, label: string) => Effect.Effect<void, GitHubError>
  readonly comment: (repo: Repo, number: number, body: string) => Effect.Effect<string, GitHubError>
  readonly assign: (repo: Repo, number: number, assignees: ReadonlyArray<string>) => Effect.Effect<void, GitHubError>
  readonly close: (repo: Repo, number: number, reason: "completed" | "not_planned") => Effect.Effect<void, GitHubError>
  readonly closePullRequest: (repo: Repo, number: number) => Effect.Effect<void, GitHubError>
  readonly requestReviewers: (
    repo: Repo,
    number: number,
    users: ReadonlyArray<string>,
    teams: ReadonlyArray<string>
  ) => Effect.Effect<void, GitHubError>
}>()("px-triage/github/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function*() {
      const token = yield* resolveToken
      const base = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((req) =>
          req.pipe(
            HttpClientRequest.prependUrl("https://api.github.com"),
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setHeaders({
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "px-triage"
            })
          )
        ),
        HttpClient.retryTransient({ schedule: Schedule.exponential(250), times: 3 })
      )
      const client = base.pipe(HttpClient.filterStatusOk)

      const fail = (message: string) => (cause: unknown) => new GitHubError({ message, cause })

      const graphql = Effect.fn("GitHub.graphql")(function*<S extends Schema.Top>(
        schema: S,
        query: string,
        variables: Record<string, unknown>
      ) {
        const res = yield* HttpClientRequest.post("/graphql").pipe(
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphqlEnvelope(schema))),
          Effect.mapError(fail("GitHub GraphQL request failed"))
        )
        if (res.errors && res.errors.length > 0) {
          return yield* new GitHubError({ message: res.errors.map((e) => e.message).join("; ") })
        }
        if (res.data === null || res.data === undefined) {
          return yield* new GitHubError({ message: "GitHub GraphQL returned no data" })
        }
        return res.data as S["Type"]
      })

      const fetchTriageQueue = Effect.fn("GitHub.fetchTriageQueue")(function*(options: FetchQueueOptions) {
        const typeFilter = options.only === "issues" ? " is:issue" : options.only === "prs" ? " is:pr" : ""
        const q = `repo:${repoSlug(options.repo)} is:open label:"${options.label}"${typeFilter} sort:created-asc`
        const items: Array<TriageItem> = []
        let after: string | null = null
        while (items.length < options.limit) {
          const first = Math.min(50, options.limit - items.length)
          const data: typeof SearchData.Type = yield* graphql(SearchData, SEARCH_QUERY, { q, first, after })
          for (const node of data.search.nodes) {
            const item = toItem(node)
            if (item) items.push(item)
          }
          if (!data.search.pageInfo.hasNextPage) break
          after = data.search.pageInfo.endCursor
        }
        return items
      })

      const fetchHistory = Effect.fn("GitHub.fetchHistory")(function*(options: { readonly repo: Repo; readonly label: string; readonly limit: number }) {
        // Everything not currently in the queue, newest activity first. Issue
        // forms auto-apply the triage label, so "no triage label" ≈ "triaged".
        const q = `repo:${repoSlug(options.repo)} -label:"${options.label}" sort:updated-desc`
        const items: Array<TriageItem> = []
        let after: string | null = null
        while (items.length < options.limit) {
          const first = Math.min(50, options.limit - items.length)
          const data: typeof SearchData.Type = yield* graphql(SearchData, SEARCH_QUERY, { q, first, after })
          for (const node of data.search.nodes) {
            const item = toItem(node)
            if (item) items.push(item)
          }
          if (!data.search.pageInfo.hasNextPage) break
          after = data.search.pageInfo.endCursor
        }
        return items
      })

      const fetchItem = Effect.fn("GitHub.fetchItem")(function*(repo: Repo, number: number) {
        const data = yield* graphql(ItemData, ITEM_QUERY, { owner: repo.owner, name: repo.name, number })
        const item = toItem(data.repository.issueOrPullRequest)
        if (!item) return yield* new GitHubError({ message: `#${number} is not an issue or pull request` })
        return item
      })

      const viewer = yield* client.get("/user").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ login: Schema.String }))),
        Effect.map((u) => u.login),
        Effect.mapError(fail("Failed to look up the authenticated GitHub user")),
        Effect.cached
      )

      const issuePath = (repo: Repo, number: number) => `/repos/${repo.owner}/${repo.name}/issues/${number}`

      const addLabels = Effect.fn("GitHub.addLabels")(function*(repo: Repo, number: number, labels: ReadonlyArray<string>) {
        if (labels.length === 0) return
        yield* HttpClientRequest.post(`${issuePath(repo, number)}/labels`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ labels }),
          client.execute,
          Effect.mapError(fail(`Failed to add labels ${labels.join(", ")}`))
        )
      })

      const removeLabel = Effect.fn("GitHub.removeLabel")(function*(repo: Repo, number: number, label: string) {
        // 404 means the label was already gone, which is fine.
        yield* base.del(`${issuePath(repo, number)}/labels/${encodeURIComponent(label)}`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatus((s) => (s >= 200 && s < 300) || s === 404)),
          Effect.mapError(fail(`Failed to remove label ${label}`))
        )
      })

      const comment = Effect.fn("GitHub.comment")(function*(repo: Repo, number: number, body: string) {
        const res = yield* HttpClientRequest.post(`${issuePath(repo, number)}/comments`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ html_url: Schema.String }))),
          Effect.mapError(fail("Failed to post comment"))
        )
        return res.html_url
      })

      const assign = Effect.fn("GitHub.assign")(function*(repo: Repo, number: number, assignees: ReadonlyArray<string>) {
        if (assignees.length === 0) return
        yield* HttpClientRequest.post(`${issuePath(repo, number)}/assignees`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ assignees }),
          client.execute,
          Effect.mapError(fail(`Failed to assign ${assignees.join(", ")}`))
        )
      })

      const close = Effect.fn("GitHub.close")(function*(repo: Repo, number: number, reason: "completed" | "not_planned") {
        yield* HttpClientRequest.patch(issuePath(repo, number)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ state: "closed", state_reason: reason }),
          client.execute,
          Effect.mapError(fail("Failed to close issue"))
        )
      })

      const closePullRequest = Effect.fn("GitHub.closePullRequest")(function*(repo: Repo, number: number) {
        yield* HttpClientRequest.patch(`/repos/${repo.owner}/${repo.name}/pulls/${number}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ state: "closed" }),
          client.execute,
          Effect.mapError(fail("Failed to close pull request"))
        )
      })

      const requestReviewers = Effect.fn("GitHub.requestReviewers")(function*(
        repo: Repo,
        number: number,
        users: ReadonlyArray<string>,
        teams: ReadonlyArray<string>
      ) {
        if (users.length === 0 && teams.length === 0) return
        yield* HttpClientRequest.post(`/repos/${repo.owner}/${repo.name}/pulls/${number}/requested_reviewers`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ reviewers: users, team_reviewers: teams }),
          client.execute,
          Effect.mapError(fail(`Failed to request reviewers ${[...users, ...teams].join(", ")}`))
        )
      })

      return GitHub.of({
        viewer,
        fetchTriageQueue,
        fetchHistory,
        fetchItem,
        addLabels,
        removeLabel,
        comment,
        assign,
        close,
        closePullRequest,
        requestReviewers
      })
    })
  )
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

const resolveToken: Effect.Effect<string, GitHubError, ChildProcessSpawner.ChildProcessSpawner> = Effect.gen(function*() {
  const fromEnv = yield* Config.String("GITHUB_TOKEN").pipe(
    Config.orElse(() => Config.String("GH_TOKEN")),
    Effect.option
  )
  if (fromEnv._tag === "Some" && fromEnv.value.trim() !== "") return fromEnv.value.trim()
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner.string(ChildProcess.make("gh", ["auth", "token"])).pipe(
    Effect.mapError((cause) =>
      new GitHubError({
        message: "No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.",
        cause
      })
    )
  )
  const token = out.trim()
  if (token === "") return yield* new GitHubError({ message: "`gh auth token` returned nothing. Run `gh auth login`." })
  return token
})

// ---------------------------------------------------------------------------
// GraphQL schemas
// ---------------------------------------------------------------------------

const GraphqlEnvelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String })))
  })

const Actor = Schema.NullOr(Schema.Struct({ login: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }))
const Named = Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) })
const Logins = Schema.Struct({ nodes: Schema.Array(Schema.Struct({ login: Schema.String })) })
const Comments = Schema.Struct({
  totalCount: Schema.Int,
  nodes: Schema.Array(Schema.Struct({ author: Actor, body: Schema.String, createdAt: Schema.String }))
})

const IssueNode = Schema.Struct({
  __typename: Schema.Literal("Issue"),
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  author: Actor,
  authorAssociation: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED"]),
  stateReason: Schema.NullOr(Schema.String),
  labels: Named,
  assignees: Logins,
  comments: Comments,
  reactions: Schema.Struct({ totalCount: Schema.Int })
})

const PrNode = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  id: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  isDraft: Schema.Boolean,
  merged: Schema.Boolean,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  additions: Schema.Int,
  deletions: Schema.Int,
  changedFiles: Schema.Int,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  author: Actor,
  authorAssociation: Schema.String,
  labels: Named,
  assignees: Logins,
  comments: Comments,
  reviews: Schema.Struct({ totalCount: Schema.Int }),
  reviewRequests: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        requestedReviewer: Schema.NullOr(
          Schema.Struct({
            login: Schema.optional(Schema.String),
            slug: Schema.optional(Schema.String)
          })
        )
      })
    )
  }),
  files: Schema.NullOr(
    Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ path: Schema.String, additions: Schema.Int, deletions: Schema.Int }))
    })
  ),
  closingIssuesReferences: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ number: Schema.Int, title: Schema.String }))
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String }))
        })
      })
    )
  })
})

/** Search can also return nodes we did not ask for; keep them loose. */
const OtherNode = Schema.Struct({ __typename: Schema.String })

const SearchNode = Schema.Union([IssueNode, PrNode, OtherNode])

const SearchData = Schema.Struct({
  search: Schema.Struct({
    issueCount: Schema.Int,
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
    nodes: Schema.Array(SearchNode)
  })
})

const ItemData = Schema.Struct({
  repository: Schema.Struct({ issueOrPullRequest: SearchNode })
})

const ISSUE_FRAGMENT = `
  ... on Issue {
    __typename id number title url body createdAt updatedAt authorAssociation state stateReason
    author { login ... on User { name } }
    labels(first: 30) { nodes { name } }
    assignees(first: 10) { nodes { login } }
    comments(first: 5) { totalCount nodes { author { login } body createdAt } }
    reactions { totalCount }
  }`

const PR_FRAGMENT = `
  ... on PullRequest {
    __typename id number title url body createdAt updatedAt authorAssociation
    isDraft merged state additions deletions changedFiles headRefName baseRefName
    author { login ... on User { name } }
    labels(first: 30) { nodes { name } }
    assignees(first: 10) { nodes { login } }
    comments(first: 5) { totalCount nodes { author { login } body createdAt } }
    reviews(first: 1) { totalCount }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
    files(first: 60) { nodes { path additions deletions } }
    closingIssuesReferences(first: 5) { nodes { number title } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`

const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_FRAGMENT} ${PR_FRAGMENT} }
  }
}`

const ITEM_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) { ${ISSUE_FRAGMENT} ${PR_FRAGMENT} }
  }
}`

const toItem = (node: typeof SearchNode.Type): TriageItem | null => {
  if (node.__typename === "Issue") {
    const n = node as typeof IssueNode.Type
    return new TriageItem({
      kind: "issue",
      id: n.id,
      number: n.number,
      title: n.title,
      url: n.url,
      body: n.body,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      author: n.author?.login ?? "ghost",
      authorName: n.author?.name ?? null,
      authorAssociation: n.authorAssociation,
      labels: n.labels.nodes.map((l) => l.name),
      assignees: n.assignees.nodes.map((a) => a.login),
      commentCount: n.comments.totalCount,
      comments: n.comments.nodes.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
      reactions: n.reactions.totalCount,
      state: n.state,
      stateReason: n.stateReason,
      pr: null
    })
  }
  if (node.__typename === "PullRequest") {
    const n = node as typeof PrNode.Type
    return new TriageItem({
      kind: "pull_request",
      id: n.id,
      number: n.number,
      title: n.title,
      url: n.url,
      body: n.body,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      author: n.author?.login ?? "ghost",
      authorName: n.author?.name ?? null,
      authorAssociation: n.authorAssociation,
      labels: n.labels.nodes.map((l) => l.name),
      assignees: n.assignees.nodes.map((a) => a.login),
      commentCount: n.comments.totalCount,
      comments: n.comments.nodes.map((c) => ({ author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
      reactions: 0,
      state: n.state,
      stateReason: null,
      pr: {
        isDraft: n.isDraft,
        merged: n.merged,
        additions: n.additions,
        deletions: n.deletions,
        changedFiles: n.changedFiles,
        headRefName: n.headRefName,
        baseRefName: n.baseRefName,
        files: n.files?.nodes ?? [],
        reviewCount: n.reviews.totalCount,
        requestedReviewers: n.reviewRequests.nodes.flatMap((r) => {
          const who = r.requestedReviewer?.login ?? (r.requestedReviewer?.slug ? `team:${r.requestedReviewer.slug}` : null)
          return who ? [who] : []
        }),
        linkedIssues: n.closingIssuesReferences.nodes,
        checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null
      }
    })
  }
  return null
}
