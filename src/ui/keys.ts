/**
 * Single-keypress input on top of the Effect Terminal service. `readInput`
 * puts stdin in raw mode for the duration of the scope and streams key
 * events; Ctrl+C ends the queue, which we surface as a QuitError.
 */
import { Cause, Effect, Queue, Terminal } from "effect"

export interface Key {
  readonly name: string
  readonly char: string | undefined
  readonly ctrl: boolean
  readonly shift: boolean
  readonly meta: boolean
}

export const readKey: Effect.Effect<Key, Terminal.QuitError, Terminal.Terminal> = Effect.scoped(
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal
    const queue = yield* terminal.readInput
    const input = yield* Queue.take(queue).pipe(
      Effect.catchIf(Cause.isDone, () => Effect.fail(new Terminal.QuitError()))
    )
    const key: Key = {
      name: input.key.name,
      char: input.input._tag === "Some" ? input.input.value : undefined,
      ctrl: input.key.ctrl,
      shift: input.key.shift,
      meta: input.key.meta
    }
    if (key.ctrl && (key.name === "c" || key.name === "d")) return yield* new Terminal.QuitError()
    return key
  })
)

export interface Hotkey<A> {
  /** Key name as reported by node's keypress parser (single chars are themselves). */
  readonly key: string
  readonly label: string
  readonly value: A
  readonly hint?: string
}

/**
 * Print a one-line hotkey legend and wait for a matching key. `Enter` picks
 * `defaultValue` when one is given.
 */
export const hotkeyMenu = <A>(options: {
  readonly keys: ReadonlyArray<Hotkey<A>>
  readonly defaultValue?: A | undefined
  readonly render: (keys: ReadonlyArray<Hotkey<A>>, defaultValue: A | undefined) => string
}): Effect.Effect<A, Terminal.QuitError, Terminal.Terminal> =>
  Effect.gen(function*() {
    const terminal = yield* Terminal.Terminal
    yield* terminal.display(options.render(options.keys, options.defaultValue) + "\n").pipe(Effect.orDie)
    while (true) {
      const k = yield* readKey
      if ((k.name === "return" || k.name === "enter") && options.defaultValue !== undefined) return options.defaultValue
      const match = options.keys.find((h) => h.key === k.name || h.key === k.char)
      if (match) return match.value
    }
  })
