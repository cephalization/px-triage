/**
 * A small GitHub-flavored-markdown → ANSI renderer. Covers what shows up in
 * issue forms and PR descriptions: headings, fenced code, lists, quotes,
 * tables, task lists, inline code/bold/italic/links/images, <details>.
 */
import { bold, cyan, dim, gray, green, italic, magenta, underline, visibleLength, wrapText, yellow } from "./ansi.ts"

const inline = (s: string): string =>
  s
    // images before links
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string, url: string) => magenta(`[image: ${alt || "untitled"}]`) + " " + gray(url))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text: string, url: string) => underline(text) + " " + gray(`(${url})`))
    .replace(/`([^`]+)`/g, (_, code: string) => yellow(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t))
    .replace(/__([^_]+)__/g, (_, t: string) => bold(t))
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, pre: string, t: string) => pre + italic(t))
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, (_, pre: string, t: string) => pre + italic(t))
    .replace(/~~([^~]+)~~/g, (_, t: string) => dim(t))
    .replace(/<\/?(details|summary|p|br|b|strong|em|i|img|a|div|span|sub|sup|kbd|picture|source)[^>]*>/gi, (m: string) =>
      /^<summary/i.test(m) ? bold("▸ ") : /^<img/i.test(m) ? magenta("[image]") : ""
    )
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"")
    .replace(/(^|\s)(#\d{2,6})\b/g, (_, pre: string, ref: string) => pre + cyan(ref))
    .replace(/(^|\s)(@[A-Za-z0-9-]+)\b/g, (_, pre: string, who: string) => pre + cyan(who))

const renderTable = (rows: ReadonlyArray<string>, width: number): Array<string> => {
  const cells = rows
    .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
    .map((r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(c.trim())))
  const cols = Math.max(...cells.map((c) => c.length))
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...cells.map((c) => visibleLength(c[i] ?? ""))))
  const total = widths.reduce((a, b) => a + b + 3, 1)
  const scale = total > width ? (width - 1 - cols * 3) / (total - 1 - cols * 3) : 1
  const w = widths.map((x) => Math.max(3, Math.floor(x * scale)))
  const pad = (s: string, n: number) => {
    const len = visibleLength(s)
    return len > n ? [...s].slice(0, n - 1).join("") + "…" : s + " ".repeat(n - len)
  }
  const out: Array<string> = []
  cells.forEach((row, ri) => {
    const line = row.map((c, i) => pad(c, w[i] ?? 3)).join(dim(" │ "))
    out.push(ri === 0 ? bold(line) : line)
    if (ri === 0) out.push(dim(w.map((n) => "─".repeat(n)).join("─┼─")))
  })
  return out
}

export const renderMarkdown = (md: string, width: number): Array<string> => {
  const out: Array<string> = []
  const lines = md.replace(/\r\n/g, "\n").split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    // fenced code
    const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line)
    if (fence) {
      const lang = fence[2] ? dim(` ${fence[2]}`) : ""
      out.push(dim("╭" + "─".repeat(Math.max(0, width - 2))) + lang)
      i++
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}`).test(lines[i] ?? "")) {
        for (const l of wrapText(lines[i] ?? "", width - 4)) out.push(dim("│ ") + green(l))
        i++
      }
      out.push(dim("╰" + "─".repeat(Math.max(0, width - 2))))
      i++
      continue
    }
    // table
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const rows: Array<string> = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) rows.push(lines[i++] ?? "")
      out.push(...renderTable(rows, width))
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1]?.length ?? 1
      const text = inline(h[2] ?? "")
      out.push("")
      out.push(level <= 2 ? bold(cyan(text)) : bold(text))
      if (level === 1) out.push(dim("═".repeat(Math.min(width, visibleLength(text)))))
      i++
      continue
    }
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      out.push(dim("─".repeat(width)))
      i++
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      for (const l of wrapText(inline(quote[1] ?? ""), width - 2)) out.push(dim("│ ") + dim(l))
      i++
      continue
    }
    const task = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      const indent = " ".repeat(task[1]?.length ?? 0)
      const box = task[2] === " " ? dim("☐") : green("☑")
      const body = wrapText(inline(task[3] ?? ""), width - indent.length - 2)
      body.forEach((l, j) => out.push(indent + (j === 0 ? `${box} ` : "  ") + l))
      i++
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      const indent = " ".repeat(bullet[1]?.length ?? 0)
      const body = wrapText(inline(bullet[2] ?? ""), width - indent.length - 2)
      body.forEach((l, j) => out.push(indent + (j === 0 ? `${dim("•")} ` : "  ") + l))
      i++
      continue
    }
    const num = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (num) {
      const indent = " ".repeat(num[1]?.length ?? 0)
      const marker = `${num[2]}.`
      const body = wrapText(inline(num[3] ?? ""), width - indent.length - marker.length - 1)
      body.forEach((l, j) => out.push(indent + (j === 0 ? `${dim(marker)} ` : " ".repeat(marker.length + 1)) + l))
      i++
      continue
    }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i] ?? "")) i++
      i++
      continue
    }
    if (line.trim() === "") {
      if (out[out.length - 1] !== "") out.push("")
      i++
      continue
    }
    out.push(...wrapText(inline(line), width))
    i++
  }
  while (out[0] === "") out.shift()
  while (out[out.length - 1] === "") out.pop()
  return out
}
