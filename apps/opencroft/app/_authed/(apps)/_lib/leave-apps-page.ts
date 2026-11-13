import type { RouterHistory } from '@tanstack/react-router'

/**
 * Goes from the Apps page to `href`, first rewriting the page's own entry as
 * `appsHref` (the page with the space it should open on), so Back returns to
 * the page as it was left.
 *
 * The history holds writes made in one tick and sends the browser only the
 * last, as a push if any of them was one, so a replace followed by a push
 * would make one new entry and leave the page's entry as it was. The replace
 * is flushed to the browser before the push.
 */
export function leaveAppsPage(history: RouterHistory, appsHref: string, href: string) {
  history.replace(appsHref)
  history.flush()
  history.push(href)
}
