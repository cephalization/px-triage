/**
 * A less(1)-style pager drawn on the alternate screen buffer.
 * Keys: j/k or arrows, space/f & b for pages, g/G for top/bottom, q/esc to leave.
 */
import { Effect, Terminal } from "effect"
import { bold, dim, hr, stripAnsi } from "./ansi.js"
import { readKey } from "./keys.js"

const ALT_ON = "\u001b[?1049h\u001b[H"
const ALT_OFF = "\u001b[?1049l"
const CLEAR = "\u001b[2J\u001b[H"

export const page = (title: string, lines: ReadonlyArray<string>): Effect.Effect<void, Terminal.QuitError, Terminal.Terminal> =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal
    const display = (s: string) => terminal.display(s).pipe(Effect.orDie)
    const rowsTotal = Math.max(8, yield* terminal.rows)
    const cols = yield* terminal.columns
    const height = rowsTotal - 3
    let top = 0
    const max = Math.max(0, lines.length - height)

    const draw = Effect.suspend(() => {
      const slice = lines.slice(top, top + height)
      const body = slice.map((l) => (stripAnsi(l).length > cols ? [...l].slice(0, cols).join("") : l)).join("\n")
      const status = dim(`lines ${lines.length === 0 ? 0 : top + 1}-${Math.min(lines.length, top + height)} of ${lines.length}  ·  j/k ↑/↓ scroll · space/b page · g/G top/bottom · q back`)
      return display(`${CLEAR}${bold(title)}\n${hr(cols)}\n${body}${"\n".repeat(Math.max(0, height - slice.length))}\n${status}`)
    })

    yield* display(ALT_ON)
    yield* Effect.gen(function*() {
      while (true) {
        yield* draw
        const k = yield* readKey
        switch (k.name) {
          case "q":
          case "escape":
          case "return":
          case "enter":
            return
          case "j":
          case "down":
            top = Math.min(max, top + 1)
            break
          case "k":
          case "up":
            top = Math.max(0, top - 1)
            break
          case "space":
          case "f":
          case "pagedown":
            top = Math.min(max, top + height)
            break
          case "b":
          case "pageup":
            top = Math.max(0, top - height)
            break
          case "g":
            top = k.shift ? max : 0
            break
          case "G":
            top = max
            break
        }
      }
    }).pipe(Effect.ensuring(display(ALT_OFF)))
  })
