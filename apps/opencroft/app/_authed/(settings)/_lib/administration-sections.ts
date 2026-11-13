import type { SectionSearch } from '@/app/_authed/(settings)/_lib/settings-location'

/**
 * The administration page's sections, in menu order: what configures the
 * instance rather than the signed-in person. Ids only, so the settings route
 * can send these sections' settings addresses on without loading their code;
 * the page maps each id to its component.
 */
export const ADMINISTRATION_SECTION_IDS = [
  'agents',
  'backup',
  'users',
  'extension-registries',
  'unknown-types',
] as const

export type AdministrationSectionId = (typeof ADMINISTRATION_SECTION_IDS)[number]

function isAdministrationSection(id: string | undefined): id is AdministrationSectionId {
  return (ADMINISTRATION_SECTION_IDS as readonly (string | undefined)[]).includes(id)
}

/**
 * Where a settings address of one of these sections leads: the same
 * section and tab on the administration page, or null for an address that
 * stays on Settings. `section=audit` is the audit log, the Agents section's
 * MCP Audit tab.
 */
export function administrationSearch(search: SectionSearch): SectionSearch | null {
  if (search.section === 'audit') {
    return { section: 'agents', tab: 'audit' }
  }
  return isAdministrationSection(search.section) ? search : null
}

const ADMIN_ONLY_PATH = '/administration'

/** Paths only an administrator may open; anyone else is sent to their own settings. */
export function isAdminOnlyPath(pathname: string): boolean {
  return pathname === ADMIN_ONLY_PATH || pathname.startsWith(`${ADMIN_ONLY_PATH}/`)
}
