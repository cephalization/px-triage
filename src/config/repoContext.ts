/**
 * Resolve the project description Jev sees for a repo: config first, else
 * seed from GitHub (description + topics + primary language) and save it so
 * the user has something concrete to edit in ~/.px-triage/config.json.
 */
import { Console, Effect } from "effect"
import { PHOENIX_CONTEXT } from "../classify/questions.ts"
import { GitHub } from "../github/GitHub.ts"
import { type Repo, repoSlug } from "../github/model.ts"
import { dim, yellow } from "../ui/ansi.ts"
import { AppConfig, CONFIG_FILE } from "./AppConfig.ts"

export const resolveRepoContext = Effect.fnUntraced(function*(repo: Repo) {
  const appConfig = yield* AppConfig
  const slug = repoSlug(repo)
  const saved = appConfig.repoConfig(slug).description?.trim()
  if (saved) return saved

  if (slug.toLowerCase() === "arize-ai/phoenix") {
    yield* appConfig.updateRepo(slug, { description: PHOENIX_CONTEXT }).pipe(Effect.ignore)
    return PHOENIX_CONTEXT
  }

  const github = yield* GitHub
  const info = yield* github.fetchRepoInfo(repo).pipe(Effect.orElseSucceed(() => ({ description: null, topics: [], language: null })))
  const parts = [
    `${slug} is an open-source project${info.language ? ` written mainly in ${info.language}` : ""}.`,
    info.description ? info.description.replace(/\.?$/, ".") : null,
    info.topics.length ? `Topics: ${info.topics.join(", ")}.` : null
  ].filter((p): p is string => p !== null)
  const seeded = parts.join(" ")
  yield* appConfig.updateRepo(slug, { description: seeded }).pipe(Effect.ignore)
  yield* Console.log(yellow(`seeded a project description for ${slug} from GitHub; refine it in ${CONFIG_FILE} under repos["${slug.toLowerCase()}"].description`))
  yield* Console.log(dim(`  "${seeded}"`))
  return seeded
})
