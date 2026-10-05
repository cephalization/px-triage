/**
 * Propagate a triage decision across linked items.
 *
 * Issues attract drive-by PRs (often several, from different people), and PRs
 * reference the issue they fix. When the human triages one item, replicate
 * the action to the best linked item and close the remaining links as
 * duplicates of it, with cross-references so nothing gets lost.
 *
 * "Best" = authored by a maintainer (collaborator / member / owner, or on the
 * repo profile roster), otherwise the oldest.
 */
import type { LinkedItem, TriageItem } from "../github/model.js"
import type { ResolvedPlan } from "./executor.js"
import type { ActionKind } from "./plan.js"
import type { RepoProfile } from "./profile.js"
import { TRIAGE_LABEL, workflowLabel } from "./roster.js"

export interface Propagation {
  readonly target: LinkedItem
  /** Why this target gets this plan, for display. */
  readonly why: string
  readonly plan: ResolvedPlan
}

const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

export const isMaintainer = (profile: RepoProfile, author: string, association: string | null): boolean =>
  (association !== null && MAINTAINER_ASSOCIATIONS.has(association)) || profile.teammates.some((t) => t.login === author)

/** Maintainer-authored first, then oldest first. */
export const orderLinks = (profile: RepoProfile, links: ReadonlyArray<LinkedItem>): Array<LinkedItem> =>
  [...links].sort((a, b) => {
    const ma = isMaintainer(profile, a.author, a.authorAssociation) ? 0 : 1
    const mb = isMaintainer(profile, b.author, b.authorAssociation) ? 0 : 1
    return ma - mb || a.createdAt.localeCompare(b.createdAt)
  })

const empty: ResolvedPlan = { comment: null, labelsToAdd: [], labelsToRemove: [], assignees: [], reviewers: { users: [], teams: [] }, close: null }
const removeTriage = (l: LinkedItem) => (l.labels.includes(TRIAGE_LABEL) ? [TRIAGE_LABEL] : [])
const notYet = (l: LinkedItem, labels: ReadonlyArray<string | null>) =>
  [...new Set(labels.filter((x): x is string => x !== null))].filter((x) => !l.labels.includes(x))

export const propagate = (
  item: TriageItem,
  action: ActionKind,
  plan: ResolvedPlan,
  profile: RepoProfile
): ReadonlyArray<Propagation> => {
  const links = orderLinks(profile, item.linked)
  if (links.length === 0 || action === "skip") return []
  const [primary, ...rest] = links as [LinkedItem, ...Array<LinkedItem>]
  const out: Array<Propagation> = []
  const duplicateLabel = workflowLabel(profile, "duplicate")
  const needsInfoLabel = workflowLabel(profile, "needsInfo")
  const ref = `#${item.number}`

  if (item.kind === "issue") {
    // Linked items are PRs that would close this issue.
    switch (action) {
      case "bug":
      case "feature": {
        // The fix is already in flight: route the PR for review with the same labels.
        const reviewers = plan.assignees.length ? plan.assignees : plan.reviewers.users
        out.push({
          target: primary,
          why: `fixes ${ref}; labeled like the issue and sent for review`,
          plan: { ...empty, labelsToAdd: notYet(primary, plan.labelsToAdd), labelsToRemove: removeTriage(primary), reviewers: { users: reviewers, teams: [] } }
        })
        break
      }
      case "review":
        break
      case "needs_info":
        out.push({
          target: primary,
          why: `fixes ${ref}, which is waiting on information`,
          plan: {
            ...empty,
            comment: `Thanks for the PR! We've asked for more information on ${ref} before deciding how to proceed; we'll pick this up once that's resolved.`,
            labelsToAdd: notYet(primary, [needsInfoLabel]),
            labelsToRemove: removeTriage(primary)
          }
        })
        break
      case "close":
        out.push({
          target: primary,
          why: `fixes ${ref}, which is being closed`,
          plan: {
            ...empty,
            comment: `Thanks for the contribution! We're closing ${ref} rather than moving forward with it (see the discussion there), so I'm closing this PR along with it.`,
            labelsToRemove: removeTriage(primary),
            close: "not_planned"
          }
        })
        break
    }
    for (const dup of rest) {
      out.push({
        target: dup,
        why: `duplicate of #${primary.number}`,
        plan: {
          ...empty,
          comment: `Thanks for taking a look at ${ref}! #${primary.number} already addresses it, so I'm closing this one as a duplicate to keep the review in one place.`,
          labelsToAdd: notYet(dup, [duplicateLabel]),
          labelsToRemove: removeTriage(dup),
          close: "not_planned"
        }
      })
    }
    return out
  }

  // item is a PR; linked items are the issues it closes.
  switch (action) {
    case "review": {
      // Someone is reviewing the fix: mirror the labels onto the issue and have the reviewer own it.
      out.push({
        target: primary,
        why: `closed by ${ref}; labeled like the PR and assigned to its reviewer`,
        plan: { ...empty, labelsToAdd: notYet(primary, plan.labelsToAdd), labelsToRemove: removeTriage(primary), assignees: plan.reviewers.users.slice(0, 1) }
      })
      break
    }
    case "needs_info":
    case "close":
    case "bug":
    case "feature":
      // A PR's fate says little about the issue itself; leave the issue alone.
      return []
  }
  for (const dup of rest) {
    out.push({
      target: dup,
      why: `duplicate of #${primary.number}`,
      plan: {
        ...empty,
        comment: `This is tracked in #${primary.number} (both are addressed by ${ref}), so I'm closing this one as a duplicate.`,
        labelsToAdd: notYet(dup, [duplicateLabel]),
        labelsToRemove: removeTriage(dup),
        close: "not_planned"
      }
    })
  }
  return out
}
