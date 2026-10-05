/**
 * A RepoProfile is everything repo-specific the triage loop needs, generated
 * from the repository itself and cached on disk:
 *
 *   - labels (names + colors) and which label maps to each classifier component
 *   - teammates: who gets assigned / reviews what, inferred from recent history
 *   - CODEOWNERS teams per path prefix
 *
 * Cached at ~/.px-triage/profiles/<owner>-<name>.json, regenerated when older
 * than PROFILE_TTL_DAYS, on `pxt roster --refresh`, or when the format changes.
 */
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Schema } from "effect"
import type { ComponentKey, LanguageKey } from "../classify/questions.js"
import { COMPONENT } from "../classify/questions.js"
import { CONFIG_DIR } from "../config/AppConfig.js"
import { GitHub } from "../github/GitHub.js"
import { type Repo, RepoLabel, type TriageItem, repoSlug } from "../github/model.js"
import { dim } from "../ui/ansi.js"
import { COMPONENT_LABEL_ALIASES, LANGUAGE_LABEL_ALIASES, isBot } from "./roster.js"

export const PROFILE_TTL_DAYS = 7
export const PROFILE_FORMAT = 1
export const PROFILES_DIR = join(CONFIG_DIR, "profiles")

const ComponentKeySchema = Schema.Literals(Object.keys(COMPONENT) as [ComponentKey, ...Array<ComponentKey>])
const LanguageKeySchema = Schema.Literals(["python", "typescript", "not_applicable"])

export const Teammate = Schema.Struct({
  login: Schema.String,
  /** Components this person works on, strongest first. */
  areas: Schema.Array(ComponentKeySchema),
  languages: Schema.Array(Schema.Literals(["python", "typescript"])),
  /** Evidence counts, for display and debugging. */
  assigned: Schema.Int,
  reviewed: Schema.Int,
  authored: Schema.Int
})
export type Teammate = typeof Teammate.Type

export const RepoProfile = Schema.Struct({
  format: Schema.Int,
  repo: Schema.String,
  generatedAt: Schema.String,
  labels: Schema.Array(RepoLabel),
  /** Classifier component → repo label (or null when the repo has no matching label). */
  componentLabels: Schema.Record(ComponentKeySchema, Schema.NullOr(Schema.String)),
  languageLabels: Schema.Record(LanguageKeySchema, Schema.NullOr(Schema.String)),
  teammates: Schema.Array(Teammate),
  codeowners: Schema.Array(Schema.Struct({ prefix: Schema.String, teams: Schema.Array(Schema.String), users: Schema.Array(Schema.String) })),
  /** How many history items the roster was inferred from. */
  sampleSize: Schema.Int
})
export type RepoProfile = typeof RepoProfile.Type

export class RepoProfiles extends Context.Service<RepoProfiles, {
  /** Cached profile, regenerated when missing or stale. */
  readonly load: (repo: Repo, options?: { readonly refresh?: boolean }) => Effect.Effect<RepoProfile, Error>
}>()("px-triage/triage/RepoProfiles") {
  static readonly layer = Layer.effect(
    RepoProfiles,
    Effect.gen(function*() {
      const github = yield* GitHub
      const fs = yield* FileSystem.FileSystem
      const pathFor = (repo: Repo) => join(PROFILES_DIR, `${repo.owner}-${repo.name}.json`)

      const read = (repo: Repo) =>
        fs.readFileString(pathFor(repo)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RepoProfile))),
          Effect.option
        )

      const write = (profile: RepoProfile, repo: Repo) =>
        fs.makeDirectory(PROFILES_DIR, { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(pathFor(repo), JSON.stringify(profile, null, 2))),
          Effect.ignore
        )

      const isFresh = (p: RepoProfile) =>
        p.format === PROFILE_FORMAT && Date.now() - new Date(p.generatedAt).getTime() < PROFILE_TTL_DAYS * 86_400_000

      const load = Effect.fn("RepoProfiles.load")(function*(repo: Repo, options?: { readonly refresh?: boolean }) {
        if (!options?.refresh) {
          const cached = yield* read(repo)
          if (cached._tag === "Some" && isFresh(cached.value)) return cached.value
        }
        yield* Console.log(dim(`building repo profile for ${repoSlug(repo)} (labels, owners, reviewers, CODEOWNERS)…`))
        const t0 = performance.now()
        const [labels, codeownersText, closedIssues, mergedPrs] = yield* Effect.all(
          [
            github.listLabels(repo),
            github.fetchCodeowners(repo),
            github.search(`repo:${repoSlug(repo)} is:issue is:closed sort:updated-desc`, 250),
            github.search(`repo:${repoSlug(repo)} is:pr is:merged sort:updated-desc`, 150)
          ],
          { concurrency: 4 }
        )
        const profile = buildProfile({ repo, labels, codeownersText, items: [...closedIssues, ...mergedPrs] })
        yield* write(profile, repo)
        yield* Console.log(
          dim(`profile ready in ${Math.round(performance.now() - t0)}ms · ${profile.teammates.length} teammates from ${profile.sampleSize} items · ${profile.labels.length} labels`)
        )
        return profile
      })

      return RepoProfiles.of({ load })
    })
  )
}

// ---------------------------------------------------------------------------
// Pure inference
// ---------------------------------------------------------------------------

export const buildProfile = (input: {
  readonly repo: Repo
  readonly labels: ReadonlyArray<RepoLabel>
  readonly codeownersText: string | null
  readonly items: ReadonlyArray<TriageItem>
}): RepoProfile => {
  const labelNames = input.labels.map((l) => l.name)
  const componentLabels = mapLabels(labelNames, COMPONENT_LABEL_ALIASES) as Record<ComponentKey, string | null>
  const languageLabels = mapLabels(labelNames, LANGUAGE_LABEL_ALIASES) as Record<LanguageKey, string | null>
  const labelToComponent = new Map<string, ComponentKey>()
  for (const [component, label] of Object.entries(componentLabels)) if (label) labelToComponent.set(label.toLowerCase(), component as ComponentKey)
  const labelToLanguage = new Map<string, "python" | "typescript">()
  for (const [lang, label] of Object.entries(languageLabels)) if (label && lang !== "not_applicable") labelToLanguage.set(label.toLowerCase(), lang as "python" | "typescript")

  type Acc = { areas: Map<ComponentKey, number>; languages: Map<"python" | "typescript", number>; assigned: number; reviewed: number; authored: number }
  const people = new Map<string, Acc>()
  const acc = (login: string): Acc => {
    let a = people.get(login)
    if (!a) {
      a = { areas: new Map(), languages: new Map(), assigned: 0, reviewed: 0, authored: 0 }
      people.set(login, a)
    }
    return a
  }
  const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by)

  for (const item of input.items) {
    const components = item.labels.flatMap((l) => {
      const c = labelToComponent.get(l.toLowerCase())
      return c ? [c] : []
    })
    const languages = new Set(item.labels.flatMap((l) => {
      const lang = labelToLanguage.get(l.toLowerCase())
      return lang ? [lang] : []
    }))
    if (item.pr) {
      for (const f of item.pr.files) {
        if (/\.(py|pyi)$/.test(f.path)) languages.add("python")
        if (/\.(ts|tsx|js|jsx|mjs)$/.test(f.path)) languages.add("typescript")
      }
      // Path-based component hints when a PR carries no component label.
      if (components.length === 0) components.push(...componentsFromPaths(item.pr.files.map((f) => f.path)))
    }
    const credit = (login: string, weight: number) => {
      if (isBot(login)) return
      const a = acc(login)
      for (const c of components) bump(a.areas, c, weight)
      for (const l of languages) bump(a.languages, l, weight)
    }
    for (const login of item.assignees) {
      if (isBot(login)) continue
      credit(login, 3)
      acc(login).assigned++
    }
    if (item.pr) {
      for (const login of item.pr.reviewers) {
        if (login === item.author || isBot(login)) continue
        credit(login, 2)
        acc(login).reviewed++
      }
      if ((item.authorAssociation === "MEMBER" || item.authorAssociation === "OWNER") && !isBot(item.author)) {
        credit(item.author, 1)
        acc(item.author).authored++
      }
    }
  }

  const teammates: Array<Teammate> = [...people.entries()]
    .filter(([, a]) => a.assigned + a.reviewed >= 2 || a.authored >= 3)
    .map(([login, a]) => ({
      login,
      areas: [...a.areas.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k),
      languages: [...a.languages.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).map(([k]) => k),
      assigned: a.assigned,
      reviewed: a.reviewed,
      authored: a.authored
    }))
    .sort((x, y) => (y.assigned * 3 + y.reviewed * 2 + y.authored) - (x.assigned * 3 + x.reviewed * 2 + x.authored))

  return {
    format: PROFILE_FORMAT,
    repo: repoSlug(input.repo),
    generatedAt: new Date().toISOString(),
    labels: input.labels,
    componentLabels,
    languageLabels,
    teammates,
    codeowners: parseCodeowners(input.codeownersText),
    sampleSize: input.items.length
  }
}

/** Pick, for each key, the first repo label that matches one of its aliases (case-insensitive, exact). */
const mapLabels = (labelNames: ReadonlyArray<string>, aliases: Record<string, ReadonlyArray<string>>): Record<string, string | null> => {
  const lower = new Map(labelNames.map((n) => [n.toLowerCase(), n] as const))
  const out: Record<string, string | null> = {}
  for (const [key, candidates] of Object.entries(aliases)) {
    out[key] = null
    for (const c of candidates) {
      const hit = lower.get(c.toLowerCase())
      if (hit) {
        out[key] = hit
        break
      }
    }
  }
  return out
}

const PATH_HINTS: ReadonlyArray<readonly [RegExp, ComponentKey]> = [
  [/(^|\/)(app|web|frontend|ui|client-web)\//i, "ui"],
  [/(^|\/)(docs?|documentation)\//i, "docs"],
  [/(^|\/)(helm|charts?|k8s|kubernetes|deploy)\//i, "helm_infra"],
  [/(^|\/)(cli)\//i, "cli"],
  [/(^|\/)(evals?|evaluators?)\//i, "evals"],
  [/(^|\/)(instrumentation|otel|opentelemetry)\//i, "otel_instrumentation"],
  [/(^|\/)(mcp)\//i, "mcp"],
  [/(^|\/)(client|sdk)\//i, "client"],
  [/(^|\/)(server|api|backend|src)\//i, "server"]
]

export const componentsFromPaths = (paths: ReadonlyArray<string>): Array<ComponentKey> => {
  const hits = new Map<ComponentKey, number>()
  for (const p of paths) {
    for (const [re, key] of PATH_HINTS) {
      if (re.test(p)) {
        hits.set(key, (hits.get(key) ?? 0) + 1)
        break
      }
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k)
}

export const parseCodeowners = (text: string | null): Array<{ prefix: string; teams: Array<string>; users: Array<string> }> => {
  if (!text) return []
  const out: Array<{ prefix: string; teams: Array<string>; users: Array<string> }> = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim()
    if (!line) continue
    const [pattern, ...owners] = line.split(/\s+/)
    if (!pattern) continue
    let prefix = pattern.replace(/^\//, "").replace(/\*+$/, "")
    // "/js" in CODEOWNERS means the js directory; keep a trailing slash so
    // "js/" does not also match "jsx-tools/".
    const last = prefix.split("/").pop() ?? ""
    if (prefix !== "" && !prefix.endsWith("/") && !last.includes(".")) prefix += "/"
    const teams = owners.filter((o) => o.includes("/")).map((o) => o.replace(/^@[^/]+\//, ""))
    const users = owners.filter((o) => o.startsWith("@") && !o.includes("/")).map((o) => o.slice(1))
    out.push({ prefix, teams, users })
  }
  return out
}

export const labelColors = (profile: RepoProfile): Record<string, string> =>
  Object.fromEntries(profile.labels.map((l) => [l.name, l.color]))
