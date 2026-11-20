/** The parts of a click on a link that decide where the browser opens it. */
export interface LinkClick {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  currentTarget: { getAttribute: (name: string) => string | null }
}

/**
 * Whether the browser opens this click on a link somewhere other than the
 * current page: a button other than the main one, a modifier key (a new tab,
 * a new window, a download) or a link with a target of its own. A link that
 * moves in place on a plain click leaves these to the browser.
 */
export function opensElsewhere(event: LinkClick): boolean {
  const target = event.currentTarget.getAttribute('target')
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (target !== null && target !== '_self')
  )
}

/**
 * A link's click handler that does `action` on a plain click, in place of
 * following the link, and leaves every other click (a new tab, a new window)
 * to the browser, which opens the link's own address.
 */
export function onPlainClick(action: () => void) {
  return (event: LinkClick & { preventDefault: () => void }) => {
    if (!opensElsewhere(event)) {
      event.preventDefault()
      action()
    }
  }
}
