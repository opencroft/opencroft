import { defineEventHandler } from 'nitro/h3'

import { brandColor } from '@/app/_server/brand-color'
import { appIconPng, isRasterIconName } from '@/app/_server/brand-icons'

// The installed app's icons and the home-screen icon, rasterized on request in
// the instance's brand colour. Open without a session for the same reason as
// the tab icon: a browser fetches them while installing, and a phone when the
// page is added to its home screen, neither with a guarantee of one. A Nitro
// route for the reason the tab icon's route gives.
export default defineEventHandler(async (event) => {
  const name = event.context.params?.name
  if (!name || !isRasterIconName(name)) {
    return new Response('Not found', { status: 404 })
  }
  const png = await appIconPng(brandColor, name)
  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' },
  })
})
