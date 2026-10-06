import type { BrandColor } from 'ui/logo'

/** The address of an icon (or of the manifest that lists icons) as the page
 *  links it. The colour rides in the address only to make a changed colour a
 *  new address, which a browser fetches rather than serving what it cached;
 *  the routes themselves read the instance's colour. */
export function brandIconHref(path: string, color: BrandColor): string {
  return `${path}?color=${color}`
}
