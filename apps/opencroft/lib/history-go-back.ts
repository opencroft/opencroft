/**
 * Steps `steps` entries back through the window's history, then runs `then`
 * there. The browser walks back asynchronously, so `then` waits for it to
 * arrive; navigating at once would race the walk.
 */
export function goBackThen(steps: number, then: () => void) {
  if (steps <= 0) {
    then()
    return
  }
  window.addEventListener('popstate', () => then(), { once: true })
  window.history.go(-steps)
}

/** The router's index of a history entry, which it keeps in the entry's state. */
export function entryIndexOf(state: unknown): number | null {
  const index = (state as { __TSR_index?: unknown } | null | undefined)?.__TSR_index
  return typeof index === 'number' ? index : null
}
