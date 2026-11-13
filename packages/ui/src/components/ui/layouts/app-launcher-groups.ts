import type { AppLauncherApp } from './app-launcher'
import type { SelectorSpace } from './space-selector'

/** Names in the order a reader expects: case and accents aside, numbers by value ("Docs 2" before "Docs 10"). */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

/** The apps of one type, headed by the type's name. */
export interface TypeGroup {
  type: string
  apps: AppLauncherApp[]
}

/** A space's part of the search results: the space itself when it matches, then its matching apps by type. */
export interface SpaceResults {
  space: SelectorSpace
  spaceMatches: boolean
  types: TypeGroup[]
}

/** A row's keywords lead with its own two (name, then kind or slug); the rest are where it is. */
const OWN_KEYWORDS = 2

const wordsOf = (keywords: string[]) => keywords.flatMap((keyword) => keyword.toLowerCase().split(/[\s\-_.]+/))

/**
 * Whether a row is found by what is typed: every word typed starts a word of
 * its keywords and at least one starts a word of its own (`OWN_KEYWORDS`, the
 * name and kind). An app's space only narrows ("doc test" finds Documentation
 * in Testing), so a space's name alone finds the space rather than all of its
 * apps.
 */
export function matchesSearch(search: string, keywords: string[]) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const own = wordsOf(keywords.slice(0, OWN_KEYWORDS))
  const all = [...own, ...wordsOf(keywords.slice(OWN_KEYWORDS))]
  const starts = (parts: string[]) => (word: string) => parts.some((part) => part.startsWith(word))
  return words.every(starts(all)) && words.some(starts(own))
}

/** What an app is found by: its name, its type, then its space's name. */
export const appKeywords = (app: AppLauncherApp, spaceName: string) => [app.label, app.type, spaceName]

/** What a space is found by: its name and slug, then the word "space". */
export const spaceKeywords = (space: SelectorSpace) => [space.name, space.slug, 'space']

/** The apps of each space, in their order, by the space's slug; the spaces in the order their first app comes. */
export function groupBySpace(apps: AppLauncherApp[]) {
  const bySpace = new Map<string, AppLauncherApp[]>()
  for (const app of apps) {
    const group = bySpace.get(app.spaceSlug)
    if (group) {
      group.push(app)
    } else {
      bySpace.set(app.spaceSlug, [app])
    }
  }
  return bySpace
}

/** The apps by type: the types in alphabetical order of their names, each one's apps by name. */
export function groupByType(apps: AppLauncherApp[]): TypeGroup[] {
  const byType = new Map<string, AppLauncherApp[]>()
  for (const app of apps) {
    const group = byType.get(app.type)
    if (group) {
      group.push(app)
    } else {
      byType.set(app.type, [app])
    }
  }
  return [...byType]
    .map(([type, group]) => ({ type, apps: [...group].sort((a, b) => byName(a.label, b.label)) }))
    .sort((a, b) => byName(a.type, b.type))
}

/**
 * The search results among the spaces, in the spaces' order: each space that
 * matches or has a matching app, with its matching apps by type.
 */
export function searchSpaces(
  spaces: SelectorSpace[],
  appsBySpace: Map<string, AppLauncherApp[]>,
  search: string,
): SpaceResults[] {
  return spaces.flatMap((space) => {
    const spaceMatches = matchesSearch(search, spaceKeywords(space))
    const found = (appsBySpace.get(space.slug) ?? []).filter((app) =>
      matchesSearch(search, appKeywords(app, space.name)),
    )
    return spaceMatches || found.length > 0 ? [{ space, spaceMatches, types: groupByType(found) }] : []
  })
}
