import type { ParsedLocation } from '@tanstack/react-router'

import { ROOT_PATHS } from '@/app/_shell/roots'
import { isSplitView } from '@/app/_shell/screen-stack'
import { entryIndexOf } from '@/lib/history-go-back'

/**
 * The view transition a navigation plays, named by how it moves through the
 * screen stack (see screen-stack): `stack-push` when it goes on to a newer
 * history entry, `stack-pop` when it goes back to an older one, `root-next`
 * or `root-previous` when it replaces one root with another to its right or
 * left, and `stack-switch` for any other replacement. The animations for each
 * are in globals.css. One rule for every screen, so no screen animates itself.
 *
 * A screen is a path plus the query params that open a level inside it, such
 * as a Settings section. None for a move that stays on the screen (a tab in
 * the query), which happens in place.
 *
 * The stack is the same at every width; only a phone animates it, below the
 * split view's breakpoint (see screen-stack). From there up the page keeps
 * parts that do not change between screens (a sidebar, a menu column), and a
 * snapshot of the whole page would move them too.
 */
const LEVEL_PARAMS = ['section']

function levelsOf(location: ParsedLocation): string[] {
  const search = location.search as Record<string, unknown>
  return LEVEL_PARAMS.filter((key) => search[key] !== undefined).map((key) => `${key}=${String(search[key])}`)
}

function screenOf(location: ParsedLocation): string {
  return [location.pathname, ...levelsOf(location)].join('?')
}

export function stackTransitionTypes({
  fromLocation,
  toLocation,
}: {
  fromLocation?: ParsedLocation
  toLocation: ParsedLocation
}): string[] | false {
  if (!fromLocation || screenOf(fromLocation) === screenOf(toLocation) || isSplitView()) {
    return false
  }
  const from = entryIndexOf(fromLocation.state)
  const to = entryIndexOf(toLocation.state)
  if (from !== null && to !== null && from !== to) {
    return [to > from ? 'stack-push' : 'stack-pop']
  }
  // A replacement on the same path (Back from a section opened by a link)
  // moves by level: closing one reads as going back.
  if (fromLocation.pathname === toLocation.pathname) {
    return [levelsOf(toLocation).length > levelsOf(fromLocation).length ? 'stack-push' : 'stack-pop']
  }
  // A switch between two roots slides the way the bottom navigation reads:
  // toward a root to the right, the new page comes in from the right.
  const fromRoot = ROOT_PATHS.indexOf(fromLocation.pathname)
  const toRoot = ROOT_PATHS.indexOf(toLocation.pathname)
  if (fromRoot !== -1 && toRoot !== -1) {
    return [toRoot > fromRoot ? 'root-next' : 'root-previous']
  }
  return ['stack-switch']
}
