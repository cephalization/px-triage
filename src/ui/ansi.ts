/**
 * Tiny zero-dependency ANSI helpers. Effect 4 keeps its own ANSI module
 * internal, so we carry just enough here to render the triage card.
 */
const enabled = Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined

const wrap = (open: number, close: number) => (s: string): string =>
  enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const italic = wrap(3, 23)
export const underline = wrap(4, 24)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const blue = wrap(34, 39)
export const magenta = wrap(35, 39)
export const cyan = wrap(36, 39)
export const gray = wrap(90, 39)

/** Render text on a GitHub label color (6-digit hex, no `#`). */
export const chip = (text: string, hex: string | undefined): string => {
  if (!enabled) return `[${text}]`
  const rgb = hexToRgb(hex ?? "6b7280")
  const fg = luminance(rgb) > 0.5 ? "0;0;0" : "255;255;255"
  return `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m\u001b[38;2;${fg}m ${text} \u001b[0m`
}

const hexToRgb = (hex: string) => {
  const h = hex.replace("#", "").padEnd(6, "0")
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0
  }
}

const luminance = ({ r, g, b }: { r: number; g: number; b: number }) =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g

export const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")
export const visibleLength = (s: string): number => [...stripAnsi(s)].length

export const truncate = (s: string, max: number): string => {
  const chars = [...s]
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("") + "…"
}

/** Soft-wrap plain text to `width` columns, preserving existing newlines. */
export const wrapText = (text: string, width: number): ReadonlyArray<string> => {
  const out: Array<string> = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\t/g, "  ")
    if (visibleLength(line) <= width) {
      out.push(line)
      continue
    }
    let current = ""
    for (const word of line.split(" ")) {
      if (current === "") {
        current = word
      } else if (visibleLength(current) + 1 + visibleLength(word) <= width) {
        current += " " + word
      } else {
        out.push(current)
        current = word
      }
      while (visibleLength(current) > width) {
        out.push([...current].slice(0, width).join(""))
        current = [...current].slice(width).join("")
      }
    }
    out.push(current)
  }
  return out
}

export const hr = (width: number, ch = "─"): string => dim(ch.repeat(Math.max(1, width)))

/** A probability bar like `████░░░░░░` plus a percentage. */
export const bar = (p: number, width = 10): string => {
  const clamped = Math.min(1, Math.max(0, p))
  const filled = Math.round(clamped * width)
  const pct = `${Math.round(clamped * 100)}%`.padStart(4)
  return `${"█".repeat(filled)}${dim("░".repeat(width - filled))} ${pct}`
}

export const terminalWidth = (): number => Math.min(process.stdout.columns ?? 100, 110)
