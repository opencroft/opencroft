// The app's icons, drawn on request in the instance's brand colour from the
// kit's app icon. Nothing here holds a picture of its own: the tab icon is the
// icon's SVG, and every raster is that SVG rasterized, so a changed mark or a
// changed colour reaches every icon at once.

import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import { AppIcon } from 'ui/app-icon'
import type { BrandColor } from 'ui/logo'

/** The raster icons the manifest and the home screen ask for, by file name.
 *  Full bleed where the platform masks the icon to its own shape. */
export const RASTER_ICONS = {
  'icon-192.png': { size: 192, fullBleed: false },
  'icon-512.png': { size: 512, fullBleed: false },
  'icon-maskable-512.png': { size: 512, fullBleed: true },
  'apple-touch-icon.png': { size: 180, fullBleed: true },
}

export type RasterIconName = keyof typeof RASTER_ICONS

export function isRasterIconName(name: string): name is RasterIconName {
  return Object.hasOwn(RASTER_ICONS, name)
}

export function appIconSvg(color: BrandColor, options: { size?: number; fullBleed?: boolean } = {}): string {
  return renderToStaticMarkup(<AppIcon color={color} {...options} />)
}

// One entry per colour and icon, so the cache is bounded by the palette times
// the icon list. A failed render is dropped rather than kept, so the next
// request tries again.
const rasters = new Map<string, Promise<Buffer>>()

export function appIconPng(color: BrandColor, name: RasterIconName): Promise<Buffer> {
  const key = `${color}/${name}`
  let png = rasters.get(key)
  if (!png) {
    png = sharp(Buffer.from(appIconSvg(color, RASTER_ICONS[name])))
      .png()
      .toBuffer()
    png.catch(() => rasters.delete(key))
    rasters.set(key, png)
  }
  return png
}
