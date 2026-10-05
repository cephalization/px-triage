import { bold, chip, cyan, dim, hr, terminalWidth } from "../ui/ansi.ts"
import { PROFILE_TTL_DAYS, type RepoProfile, labelColors } from "./profile.ts"

export const renderProfile = (p: RepoProfile): string => {
  const width = terminalWidth()
  const colors = labelColors(p)
  const age = Math.round((Date.now() - new Date(p.generatedAt).getTime()) / 3_600_000)
  const lines: Array<string> = []
  lines.push(`${bold(cyan(p.repo))} ${dim(`· profile generated ${age}h ago from ${p.sampleSize} items · refreshes after ${PROFILE_TTL_DAYS}d or with --refresh`)}`)
  lines.push(hr(width))
  lines.push(bold("Teammates") + dim("  (areas strongest first · assigned / reviewed / authored)"))
  for (const t of p.teammates) {
    lines.push(`  ${bold(("@" + t.login).padEnd(22))} ${dim(`${String(t.assigned).padStart(3)} / ${String(t.reviewed).padStart(3)} / ${String(t.authored).padStart(3)}`)}  ${t.areas.slice(0, 6).join(", ")}${t.languages.length ? dim(`  [${t.languages.join(", ")}]`) : ""}`)
  }
  if (p.teammates.length === 0) lines.push(dim("  none inferred; assign/review some issues and run `roster --refresh`"))
  lines.push(hr(width))
  lines.push(bold("Component → label"))
  const comps = Object.entries(p.componentLabels)
  for (let i = 0; i < comps.length; i += 3) {
    lines.push("  " + comps.slice(i, i + 3).map(([k, v]) => `${k.padEnd(22)} ${v ? chip(v, colors[v]) : dim("—")}`.padEnd(48)).join(""))
  }
  lines.push(`  ${"language".padEnd(22)} ${Object.entries(p.languageLabels).map(([k, v]) => `${k}: ${v ? chip(v, colors[v]) : dim("—")}`).join("  ")}`)
  if (p.codeowners.length) {
    lines.push(hr(width))
    lines.push(bold("CODEOWNERS"))
    for (const c of p.codeowners) lines.push(`  ${(c.prefix || "(all)").padEnd(22)} ${[...c.teams.map((t) => "@" + p.repo.split("/")[0] + "/" + t), ...c.users.map((u) => "@" + u)].join(" ")}`)
  }
  return lines.join("\n")
}
