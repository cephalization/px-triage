/**
 * GitHub access. One GraphQL search pulls the whole triage queue (issues and
 * PRs, bodies, comments, files) in a single round trip; mutations go through
 * REST. The token comes from GITHUB_TOKEN / GH_TOKEN, falling back to
 * `gh auth token` so the CLI works wherever `gh` is logged in.
 */
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions"
import { Config, Context, Effect, Layer, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Repo, RepoLabel, TriageItem, repoSlug } from "./model.ts"

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
  /** Just the numbers in the queue, oldest first. Fast (no bodies). */
  readonly fetchQueueNumbers: (options: FetchQueueOptions) => Effect.Effect<ReadonlyArray<{ number: number; kind: TriageItem["kind"] }>, GitHubError>
  /** Full details for a batch of numbers in one GraphQL request (≤ 10 recommended). */
  readonly fetchItems: (repo: Repo, numbers: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<TriageItem>, GitHubError>
  readonly fetchItem: (repo: Repo, number: number) => Effect.Effect<TriageItem, GitHubError>
  /** Arbitrary GitHub issue/PR search (same fields as the queue). */
  readonly search: (query: string, limit: number) => Effect.Effect<ReadonlyArray<TriageItem>, GitHubError>
  /** Live labels on one issue/PR (REST, not the lagging search index). */
  readonly fetchLabels: (repo: Repo, number: number) => Effect.Effect<ReadonlyArray<string>, GitHubError>
  /** Repository metadata used to seed the per-repo description. */
  readonly fetchRepoInfo: (repo: Repo) => Effect.Effect<{ description: string | null; topics: ReadonlyArray<string>; language: string | null }, GitHubError>
  /** All labels defined on the repository. */
  readonly listLabels: (repo: Repo) => Effect.Effect<ReadonlyArray<RepoLabel>, GitHubError>
  /** Raw CODEOWNERS content, if the repo has one. */
  readonly fetchCodeowners: (repo: Repo) => Effect.Effect<string | null, GitHubError>
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
      /** Mutations show up in Phoenix as TOOL spans under the apply span. */
      const tool = (name: string) => Effect.fn(name, { attributes: { [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL } })

      const graphql = Effect.fnUntraced(function*<S extends Schema.Top>(
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

      const fetchTriageQueue = Effect.fnUntraced(function*(options: FetchQueueOptions) {
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

      const search = Effect.fnUntraced(function*(q: string, limit: number) {
        const items: Array<TriageItem> = []
        let after: string | null = null
        while (items.length < limit) {
          const first = Math.min(50, limit - items.length)
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

      const fetchLabels = Effect.fnUntraced(function*(repo: Repo, number: number) {
        const res = yield* client.get(`/repos/${repo.owner}/${repo.name}/issues/${number}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ labels: Schema.Array(Schema.Struct({ name: Schema.String })) }))),
          Effect.mapError(fail(`Failed to fetch labels for #${number}`))
        )
        return res.labels.map((l) => l.name)
      })

      const fetchRepoInfo = Effect.fnUntraced(function*(repo: Repo) {
        const res = yield* client.get(`/repos/${repo.owner}/${repo.name}`).pipe(
          Effect.flatMap(
            HttpClientResponse.schemaBodyJson(
              Schema.Struct({
                description: Schema.NullOr(Schema.String),
                topics: Schema.optional(Schema.Array(Schema.String)),
                language: Schema.NullOr(Schema.String)
              })
            )
          ),
          Effect.mapError(fail("Failed to fetch repository info"))
        )
        return { description: res.description, topics: res.topics ?? [], language: res.language }
      })

      const listLabels = Effect.fnUntraced(function*(repo: Repo) {
        const all: Array<RepoLabel> = []
        for (let pageNo = 1; pageNo <= 10; pageNo++) {
          const batch = yield* client.get(`/repos/${repo.owner}/${repo.name}/labels`, { urlParams: { per_page: 100, page: pageNo } }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(RepoLabel))),
            Effect.mapError(fail("Failed to list labels"))
          )
          all.push(...batch)
          if (batch.length < 100) break
        }
        return all
      })

      const fetchCodeowners = Effect.fnUntraced(function*(repo: Repo) {
        for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
          const res = yield* base.get(`/repos/${repo.owner}/${repo.name}/contents/${path}`).pipe(
            Effect.mapError(fail("Failed to read CODEOWNERS"))
          )
          if (res.status === 404) continue
          const body = yield* HttpClientResponse.schemaBodyJson(Schema.Struct({ content: Schema.String }))(res).pipe(
            Effect.mapError(fail("Failed to decode CODEOWNERS"))
          )
          return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8")
        }
        return null
      })

      const fetchHistory = Effect.fnUntraced(function*(options: { readonly repo: Repo; readonly label: string; readonly limit: number }) {
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

      const fetchQueueNumbers = Effect.fnUntraced(function*(options: FetchQueueOptions) {
        const typeFilter = options.only === "issues" ? " is:issue" : options.only === "prs" ? " is:pr" : ""
        const q = `repo:${repoSlug(options.repo)} is:open label:"${options.label}"${typeFilter} sort:created-asc`
        const out: Array<{ number: number; kind: TriageItem["kind"] }> = []
        let after: string | null = null
        while (out.length < options.limit) {
          const first = Math.min(100, options.limit - out.length)
          const data: typeof LightSearchData.Type = yield* graphql(LightSearchData, LIGHT_SEARCH_QUERY, { q, first, after })
          for (const n of data.search.nodes) {
            if (n.__typename === "Issue") out.push({ number: n.number!, kind: "issue" })
            else if (n.__typename === "PullRequest") out.push({ number: n.number!, kind: "pull_request" })
          }
          if (!data.search.pageInfo.hasNextPage) break
          after = data.search.pageInfo.endCursor
        }
        return out
      })

      const fetchItems = Effect.fnUntraced(function*(repo: Repo, numbers: ReadonlyArray<number>) {
        if (numbers.length === 0) return []
        const fields = numbers.map((n, i) => `i${i}: issueOrPullRequest(number: ${n}) { ${ISSUE_FRAGMENT} ${PR_FRAGMENT} }`).join("\n")
        const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`
        const data = yield* graphql(ItemsData, query, { owner: repo.owner, name: repo.name })
        const items: Array<TriageItem> = []
        for (let i = 0; i < numbers.length; i++) {
          const node = data.repository[`i${i}`]
          const item = node ? toItem(node) : null
          if (item) items.push(item)
        }
        return items
      })

      const fetchItem = Effect.fnUntraced(function*(repo: Repo, number: number) {
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

      const addLabels = tool("GitHub.addLabels")(function*(repo: Repo, number: number, labels: ReadonlyArray<string>) {
        if (labels.length === 0) return
        yield* HttpClientRequest.post(`${issuePath(repo, number)}/labels`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ labels }),
          client.execute,
          Effect.mapError(fail(`Failed to add labels ${labels.join(", ")}`))
        )
      })

      const removeLabel = tool("GitHub.removeLabel")(function*(repo: Repo, number: number, label: string) {
        // 404 means the label was already gone, which is fine.
        yield* base.del(`${issuePath(repo, number)}/labels/${encodeURIComponent(label)}`).pipe(
          Effect.flatMap(HttpClientResponse.filterStatus((s) => (s >= 200 && s < 300) || s === 404)),
          Effect.mapError(fail(`Failed to remove label ${label}`))
        )
      })

      const comment = tool("GitHub.comment")(function*(repo: Repo, number: number, body: string) {
        const res = yield* HttpClientRequest.post(`${issuePath(repo, number)}/comments`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Struct({ html_url: Schema.String }))),
          Effect.mapError(fail("Failed to post comment"))
        )
        return res.html_url
      })

      const assign = tool("GitHub.assign")(function*(repo: Repo, number: number, assignees: ReadonlyArray<string>) {
        if (assignees.length === 0) return
        yield* HttpClientRequest.post(`${issuePath(repo, number)}/assignees`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ assignees }),
          client.execute,
          Effect.mapError(fail(`Failed to assign ${assignees.join(", ")}`))
        )
      })

      const close = tool("GitHub.close")(function*(repo: Repo, number: number, reason: "completed" | "not_planned") {
        yield* HttpClientRequest.patch(issuePath(repo, number)).pipe(
          HttpClientRequest.bodyJsonUnsafe({ state: "closed", state_reason: reason }),
          client.execute,
          Effect.mapError(fail("Failed to close issue"))
        )
      })

      const closePullRequest = tool("GitHub.closePullRequest")(function*(repo: Repo, number: number) {
        yield* HttpClientRequest.patch(`/repos/${repo.owner}/${repo.name}/pulls/${number}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ state: "closed" }),
          client.execute,
          Effect.mapError(fail("Failed to close pull request"))
        )
      })

      const requestReviewers = tool("GitHub.requestReviewers")(function*(
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
        search,
        fetchLabels,
        fetchRepoInfo,
        listLabels,
        fetchCodeowners,
        fetchTriageQueue,
        fetchQueueNumbers,
        fetchItems,
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

const LinkNode = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.optional(Schema.Boolean),
  createdAt: Schema.String,
  authorAssociation: Schema.String,
  author: Actor,
  labels: Named
})
const Links = Schema.Struct({ nodes: Schema.Array(LinkNode) })

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
  reactions: Schema.Struct({ totalCount: Schema.Int }),
  closedByPullRequestsReferences: Schema.NullOr(Links)
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
  reviews: Schema.Struct({ totalCount: Schema.Int, nodes: Schema.Array(Schema.Struct({ author: Actor })) }),
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
  closingIssuesReferences: Links,
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

const LightSearchData = Schema.Struct({
  search: Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
    nodes: Schema.Array(Schema.Struct({ __typename: Schema.String, number: Schema.optional(Schema.Int) }))
  })
})

const LIGHT_SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on Issue { number } ... on PullRequest { number } }
  }
}`

const ItemsData = Schema.Struct({
  repository: Schema.Record(Schema.String, Schema.NullOr(SearchNode))
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
    closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number title state createdAt authorAssociation author { login } labels(first: 20) { nodes { name } } isDraft } }
  }`

const PR_FRAGMENT = `
  ... on PullRequest {
    __typename id number title url body createdAt updatedAt authorAssociation
    isDraft merged state additions deletions changedFiles headRefName baseRefName
    author { login ... on User { name } }
    labels(first: 30) { nodes { name } }
    assignees(first: 10) { nodes { login } }
    comments(first: 5) { totalCount nodes { author { login } body createdAt } }
    reviews(first: 20) { totalCount nodes { author { login } } }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
    files(first: 60) { nodes { path additions deletions } }
    closingIssuesReferences(first: 10) { nodes { number title state createdAt authorAssociation author { login } labels(first: 20) { nodes { name } } } }
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

const toLinks = (kind: TriageItem["kind"], nodes: ReadonlyArray<typeof LinkNode.Type>) =>
  nodes
    .filter((l) => l.state === "OPEN")
    .map((l) => ({
      kind,
      number: l.number,
      title: l.title,
      state: l.state,
      isDraft: l.isDraft ?? false,
      createdAt: l.createdAt,
      author: l.author?.login ?? "ghost",
      authorAssociation: l.authorAssociation,
      labels: l.labels.nodes.map((x) => x.name)
    }))

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
      linked: toLinks("pull_request", n.closedByPullRequestsReferences?.nodes ?? []),
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
      linked: toLinks("issue", n.closingIssuesReferences.nodes),
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
        reviewers: [...new Set(n.reviews.nodes.flatMap((r) => (r.author ? [r.author.login] : [])))],
        requestedReviewers: n.reviewRequests.nodes.flatMap((r) => {
          const who = r.requestedReviewer?.login ?? (r.requestedReviewer?.slug ? `team:${r.requestedReviewer.slug}` : null)
          return who ? [who] : []
        }),
        linkedIssues: n.closingIssuesReferences.nodes.map((l) => ({ number: l.number, title: l.title })),
        checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null
      }
    })
  }
  return null
}
