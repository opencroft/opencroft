import { groupByType } from 'ui/layouts/app-launcher-groups'

import type { SpaceApp } from '@/app/_shell/space-navigation'

/**
 * The apps of a space that share the given app's type, the given one among
 * them, by name in the order the App Launcher lists a type's apps.
 */
export function appsOfType(apps: SpaceApp[], app: SpaceApp, spaceSlug: string): SpaceApp[] {
  const sameType = apps.filter((each) => each.type === app.type).map((each) => ({ ...each, spaceSlug }))
  return groupByType(sameType).flatMap((group) => group.apps)
}
