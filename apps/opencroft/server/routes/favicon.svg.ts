import { defineEventHandler } from 'nitro/h3'

import { brandColor } from '@/app/_server/brand-color'
import { appIconSvg } from '@/app/_server/brand-icons'

// The tab icon, drawn on request in the instance's brand colour rather than
// served as a file: a static icon could only ever be one colour. Open without
// a session -- a browser asks for it on the login page too. `no-cache` makes
// the browser revalidate rather than keep a stale colour.
//
// A NITRO ROUTE, NOT A TANSTACK ONE, for the reason the attachment route gives:
// a browser asks for an icon as an image, and under the dev server only a
// route of Nitro's own is reached by such a request.
export default defineEventHandler(
  () =>
    new Response(appIconSvg(brandColor), {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' },
    }),
)
