import type { Assessment, Scored } from "../classify/Classifier.js"
import { RISK_LEVELS, SEVERITY_LEVELS, THRESHOLDS, VALUE_LEVELS } from "../classify/questions.js"
import type { TriageItem } from "../github/model.js"
import { ACTION_TITLES, type TriagePlan } from "../triage/plan.js"
import { LABEL_COLORS } from "../triage/roster.js"
import { bar, bold, chip, cyan, dim, gray, green, hr, italic, magenta, red, terminalWidth, truncate, wrapText, yellow } from "./ansi.js"

const ago = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime()
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export const renderHeader = (item: TriageItem, index: number, total: number): string => {
  const width = terminalWidth()
  const kind = item.isPr ? magenta("PR") : cyan("ISSUE")
  const num = bold(`#${item.number}`)
  const pos = dim(`[${index + 1}/${total}]`)
  const lines: Array<string> = []
  lines.push(hr(width, "━"))
  lines.push(`${kind} ${num} ${pos}  ${bold(truncate(item.title, width - 24))}`)
  const who = item.authorName ? `${item.author} (${item.authorName})` : item.author
  const assoc = item.authorAssociation && item.authorAssociation !== "NONE" ? dim(` · ${item.authorAssociation.toLowerCase()}`) : ""
  lines.push(gray(`by ${who}${assoc} · opened ${ago(item.createdAt)} · ${item.commentCount} comments` + (item.reactions ? ` · ${item.reactions} reactions` : "")))
  lines.push(gray(item.url))
  if (item.labels.length) lines.push(item.labels.map((l) => chip(l, LABEL_COLORS[l])).join(" "))
  if (item.assignees.length) lines.push(gray(`assigned: ${item.assignees.map((a) => "@" + a).join(" ")}`))
  if (item.pr) {
    const p = item.pr
    const checks = p.checks === "SUCCESS" ? green("checks ✓") : p.checks === "FAILURE" || p.checks === "ERROR" ? red(`checks ${p.checks.toLowerCase()}`) : p.checks ? yellow(`checks ${p.checks.toLowerCase()}`) : dim("no checks")
    lines.push(
      `${p.isDraft ? yellow("draft · ") : ""}${green(`+${p.additions}`)} ${red(`-${p.deletions}`)} in ${p.changedFiles} files · ${p.headRefName} → ${p.baseRefName} · ${checks} · ${p.reviewCount} reviews`
    )
    if (p.linkedIssues.length) lines.push(gray(`closes ${p.linkedIssues.map((i) => `#${i.number} ${truncate(i.title, 50)}`).join(", ")}`))
    if (p.requestedReviewers.length) lines.push(gray(`review requested: ${p.requestedReviewers.join(", ")}`))
    const files = p.files.slice(0, 8).map((f) => `  ${dim("•")} ${f.path} ${green(`+${f.additions}`)} ${red(`-${f.deletions}`)}`)
    if (p.files.length > 8) files.push(dim(`  … ${p.files.length - 8} more files`))
    lines.push(...files)
  }
  lines.push(hr(width))
  return lines.join("\n")
}

export const renderBody = (item: TriageItem, maxLines = 28): string => {
  const width = terminalWidth()
  const body = item.body.trim() === "" ? italic(dim("(no description)")) : item.body.trim()
  const lines = wrapText(body, width - 2)
  const shown = lines.slice(0, maxLines).map((l) => `  ${styleMarkdownLine(l)}`)
  if (lines.length > maxLines) shown.push(dim(`  … ${lines.length - maxLines} more lines (press v to page the markdown)`))
  const comments = item.comments.slice(0, 2).map((c) =>
    `${hr(width)}\n  ${bold("@" + c.author)} ${dim(ago(c.createdAt))}\n` +
    wrapText(c.body.trim(), width - 4).slice(0, 6).map((l) => `    ${dim(l)}`).join("\n")
  )
  return [...shown, ...comments].join("\n")
}

export const renderFullBody = (item: TriageItem): string => {
  const width = terminalWidth()
  const lines = wrapText(item.body.trim(), width - 2).map((l) => `  ${styleMarkdownLine(l)}`)
  const comments = item.comments.map((c) =>
    `${hr(width)}\n  ${bold("@" + c.author)} ${dim(ago(c.createdAt))}\n` +
    wrapText(c.body.trim(), width - 4).map((l) => `    ${l}`).join("\n")
  )
  return [hr(width), ...lines, ...comments, hr(width)].join("\n")
}

const styleMarkdownLine = (l: string): string => {
  if (/^#{1,6}\s/.test(l)) return bold(l.replace(/^#{1,6}\s/, ""))
  if (/^```/.test(l)) return dim(l)
  if (/^>\s?/.test(l)) return dim(l)
  return l
}

const topN = (d: { readonly probabilities: Readonly<Record<string, number>> }, n: number): Array<[string, number]> =>
  Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).slice(0, n)

const renderScored = (label: string, s: Scored | null, levels: ReadonlyArray<string>): Array<string> => {
  if (!s) return []
  const desc = levels[s.score] ?? ""
  return [`  ${label.padEnd(12)} ${bold(`level ${s.score}`)} ${dim(`(${Math.round(s.confidence * 100)}% conf)`)} ${dim(truncate(desc, terminalWidth() - 40))}`]
}

export const renderAssessment = (a: Assessment, plan: TriagePlan): string => {
  const width = terminalWidth()
  const lines: Array<string> = []
  lines.push(hr(width))
  const conf = a.category.confidence
  const confColor = conf >= THRESHOLDS.categoryConfidenceFloor ? green : yellow
  lines.push(
    `${bold("jev")} ${dim(a.model)} · ${dim(a.cached ? `cached · ${a.inputTokens} tok` : `${a.latencyMs}ms · ${a.inputTokens} tok`)}` +
      (a.agentAuthored >= THRESHOLDS.agentAuthoredAbove ? `  ${chip("agent-authored", "7057ff")}` : "")
  )
  lines.push(`  ${"category".padEnd(12)} ${topN(a.category, 3).map(([k, p], i) => (i === 0 ? bold(k) : dim(k)) + " " + bar(p, 8)).join("   ")}`)
  lines.push(`  ${"".padEnd(12)} ${dim("confidence")} ${confColor(bar(conf, 8))}`)
  lines.push(`  ${"component".padEnd(12)} ${topN(a.component, 3).map(([k, p], i) => (i === 0 ? bold(k) : dim(k)) + " " + bar(p, 8)).join("   ")}`)
  lines.push(`  ${"language".padEnd(12)} ${topN(a.language, 2).map(([k, p], i) => (i === 0 ? bold(k) : dim(k)) + " " + bar(p, 8)).join("   ")}`)
  lines.push(`  ${(a.kind === "pull_request" ? "described" : "reproducible").padEnd(12)} ${noulBar(a.complete, THRESHOLDS.needsInfoBelow)}   ${"in scope".padEnd(9)} ${noulBar(a.inScope, THRESHOLDS.outOfScopeBelow)}`)
  lines.push(...renderScored("severity", a.severity, SEVERITY_LEVELS))
  lines.push(...renderScored("value", a.value, VALUE_LEVELS))
  lines.push(...renderScored("risk", a.risk, RISK_LEVELS))
  lines.push(hr(width))
  const title = plan.uncertain ? yellow(`suggest ${ACTION_TITLES[plan.action]} (uncertain)`) : green(`suggest ${ACTION_TITLES[plan.action]}`)
  lines.push(`  ${bold("→")} ${title}`)
  for (const r of plan.rationale) lines.push(`    ${dim("·")} ${dim(r)}`)
  const labels = plan.labelsToAdd.map((l) => chip(l, LABEL_COLORS[l])).join(" ")
  if (labels) lines.push(`    ${dim("labels")} ${labels}`)
  if (plan.suggestedAssignees.length) lines.push(`    ${dim("owners")} ${plan.suggestedAssignees.slice(0, 4).map((a, i) => (i === 0 ? bold("@" + a) : dim("@" + a))).join(" ")}`)
  return lines.join("\n")
}

const noulBar = (p: number, threshold: number): string => (p < threshold ? red(bar(p, 8)) : green(bar(p, 8)))

export const renderReport = (ok: boolean, number: number, kind: string, summary: string, error?: string): string =>
  ok ? `${green("✔")} ${dim(kind)} #${number} ${summary}` : `${red("✖")} ${dim(kind)} #${number} ${summary}\n    ${red(error ?? "failed")}`
