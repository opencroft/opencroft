import type { BundleDeclares } from '@/app/_authed/(extension-runtime)/_types'

// Which listed extensions a surface loads. One whose declaration is not known
// is loaded by every surface, so a bundle the server could not read is never
// missing from a page.

/** The listed extensions to load for provider point `point`. */
export function clientsProviding<T extends Pick<BundleDeclares, 'providedPoints'>>(clients: T[], point: string): T[] {
  return clients.filter((client) => client.providedPoints?.includes(point) ?? true)
}

/** The listed extensions to load for the settings menu. */
export function clientsWithSettingsPages<T extends Pick<BundleDeclares, 'hasSettingsPages'>>(clients: T[]): T[] {
  return clients.filter((client) => client.hasSettingsPages ?? true)
}
