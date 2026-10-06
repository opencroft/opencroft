// The colour this instance draws its brand in, part of the instance's
// configuration rather than anything a user can change. Every drawing of the
// mark reads it: the root document hands it to the page as the brand variable,
// and the icon routes draw the tab icon, the installed app's icons and the
// manifest in it.

import { type BrandColor, DEFAULT_BRAND_COLOR, isBrandColor } from 'ui/logo'

/** A palette name (`green`, `lime`, ...). Unset means the default blue. */
export const BRAND_COLOR_ENV = 'OPENCROFT_BRAND_COLOR'

export interface ResolvedBrandColor {
  color: BrandColor
  /** The variable held something that is not a palette name; the default is used instead. */
  unknown?: string
}

/** Unset or blank is the default; a palette name in any letter case is that colour; anything else is the default too. */
export function resolveBrandColor(value: string | undefined): ResolvedBrandColor {
  const name = value?.trim().toLowerCase()
  if (!name) {
    return { color: DEFAULT_BRAND_COLOR }
  }
  return isBrandColor(name) ? { color: name } : { color: DEFAULT_BRAND_COLOR, unknown: value }
}

// Read once: the colour is fixed for the life of the process, and changing it
// is a restart with the variable set.
const resolved = resolveBrandColor(process.env[BRAND_COLOR_ENV])

export const brandColor: BrandColor = resolved.color

/** Logs a warning when the variable names no palette colour, so a typo does not pass as the default. */
export function warnOnUnknownBrandColor(): void {
  if (resolved.unknown !== undefined) {
    console.warn(
      `[startup] ${BRAND_COLOR_ENV}=${JSON.stringify(resolved.unknown)} is not a palette colour; using ${DEFAULT_BRAND_COLOR}`,
    )
  }
}
