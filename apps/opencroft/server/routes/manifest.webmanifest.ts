import { defineEventHandler } from 'nitro/h3'

import { brandColor } from '@/app/_server/brand-color'
import { webManifest } from '@/app/_server/web-manifest'

// Open without a session: a browser fetches the manifest to decide whether the
// app is installable, on the login page as much as anywhere. A Nitro route for
// the reason the tab icon's route gives -- a browser asks for a manifest with
// a destination of its own, which the dev server takes for a static asset.
export default defineEventHandler(
  () =>
    new Response(JSON.stringify(webManifest(brandColor)), {
      headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
    }),
)
