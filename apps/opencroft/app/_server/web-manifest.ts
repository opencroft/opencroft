// The web app manifest. Built per request rather than served as a file
// because its icons are drawn in the instance's brand colour: each icon's
// address carries the colour, so a changed colour is a changed manifest, which
// is what makes a browser fetch the installed app's icons again.

import type { BrandColor } from 'ui/logo'

import { brandIconHref } from '@/app/_lib/brand-icon-href'
import { RASTER_ICONS, type RasterIconName } from '@/app/_server/brand-icons'

export function webManifest(color: BrandColor) {
  const raster = (name: RasterIconName, purpose?: 'any' | 'maskable') => {
    const { size } = RASTER_ICONS[name]
    return {
      src: brandIconHref(`/icons/${name}`, color),
      sizes: `${size}x${size}`,
      type: 'image/png',
      ...(purpose ? { purpose } : {}),
    }
  }
  const shortcutIcons = [raster('icon-192.png')]

  return {
    id: '/',
    name: 'OpenCroft',
    short_name: 'OpenCroft',
    description: 'Platform for your home lab',
    start_url: '/spaces',
    scope: '/',
    display: 'standalone',
    display_override: ['tabbed', 'window-controls-overlay', 'standalone'],
    tab_strip: {
      new_tab_button: { url: '/spaces' },
    },
    icons: [
      raster('icon-192.png', 'any'),
      raster('icon-512.png', 'any'),
      raster('icon-maskable-512.png', 'maskable'),
      { src: brandIconHref('/favicon.svg', color), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
    shortcuts: [
      { name: 'Spaces', url: '/spaces', icons: shortcutIcons },
      { name: 'Settings', url: '/settings', icons: shortcutIcons },
    ],
  }
}
