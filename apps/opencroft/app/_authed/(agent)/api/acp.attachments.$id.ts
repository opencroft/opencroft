import { createFileRoute } from '@tanstack/react-router'

import { readAttachment } from '@/app/_authed/(agent)/_server/attachment-store'
import { requireSession } from '@/app/_server/require-session'

// One stored picture, as the bytes an <img> draws -- what the transcript shows
// for a message that carried it (see attachmentSrc in _lib/attachment-src).
//
// A URL rather than a server function answering base64: the transcript can
// hold dozens of these, and a browser that fetches, caches and decodes them
// lazily keeps them out of the page's state entirely.
//
// SCOPED EXACTLY AS DELIVERY IS. The key travels with the id and the lookup is
// the store's own readAttachment, so there is one place that decides whether an
// id belongs to a conversation, not a second one here to get wrong. An id from
// another conversation answers 404, the same as a deleted one.
export const Route = createFileRoute('/_authed/(agent)/api/acp/attachments/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const key = new URL(request.url).searchParams.get('key')
        if (!key) {
          return Response.json({ error: 'key is required' }, { status: 400 })
        }
        const picture = await readAttachment(key, params.id)
        if (!picture) {
          return Response.json({ error: 'Attachment not found' }, { status: 404 })
        }
        return new Response(new Uint8Array(Buffer.from(picture.data, 'base64')), {
          headers: {
            // Safe to hand over as stored: saveAttachment admits only the
            // raster types in ATTACHABLE_MIME_TYPES, never SVG.
            'Content-Type': picture.mimeType,
            'X-Content-Type-Options': 'nosniff',
            // A row is never rewritten -- a new picture is a new id -- so the
            // bytes behind this URL cannot change. Private, because it is
            // behind a session.
            'Cache-Control': 'private, max-age=31536000, immutable',
          },
        })
      },
    },
  },
})
