import type { IDisposable, Terminal } from '@xterm/xterm'

/**
 * The attribute a host page reads to tell content that scrolls itself
 * without a native scroll container: while it is set, the terminal takes the
 * wheel even when its viewport has nothing to scroll.
 */
export const SCROLLS_ITSELF = 'data-scrolls-itself'

// The mouse tracking modes in which xterm reports the wheel to the app. X10
// reports button presses only, so the wheel still scrolls the scrollback.
const WHEEL_REPORTING = new Set(['vt200', 'drag', 'any'])

/**
 * Whether the app in `term` takes the wheel itself. In the alternate buffer
 * (a pager, an editor) there is no scrollback, and xterm turns the wheel into
 * arrow keys; with mouse tracking on it reports the wheel to the app.
 */
export function scrollsItself(term: Pick<Terminal, 'buffer' | 'modes'>): boolean {
  return term.buffer.active.type === 'alternate' || WHEEL_REPORTING.has(term.modes.mouseTrackingMode)
}

/**
 * Keeps `SCROLLS_ITSELF` on `el` while the app in `term` takes the wheel
 * itself. Both states change only by output the terminal parses, so the mark
 * is renewed after each write.
 */
export function markScrollsItself(
  term: Pick<Terminal, 'buffer' | 'modes' | 'onWriteParsed'>,
  el: Pick<Element, 'toggleAttribute'>,
): IDisposable {
  const update = () => {
    el.toggleAttribute(SCROLLS_ITSELF, scrollsItself(term))
  }
  update()
  return term.onWriteParsed(update)
}
