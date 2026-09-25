import { readAttachment } from '@/app/_authed/(agent)/_server/attachment-store'
import { requireSession } from '@/app/_server/require-session'
import { ensureServerStarted } from '@/server/startup'

// One stored picture, as the bytes an <img> draws -- what the transcript shows
// for a message that carried it (see attachmentSrc in _lib/attachment-src).
// Served at /api/acp/attachments/<id>?key=<sessionKey> by the Nitro route in
// server/routes/api/acp/attachments; see that file for why it lives there.
//
// A URL rather than a server function answering base64: the transcript can
// hold dozens of these, and a browser that fetches, caches and decodes them
// lazily keeps them out of the page's state entirely.
//
// SCOPED EXACTLY AS DELIVERY IS. The key travels with the id and the lookup is
// the store's own readAttachment, so there is one place that decides whether an
// id belongs to a conversation, not a second one here to get wrong. An id from
// another conversation answers 404, the same as a deleted one.
export async function attachmentResponse(request: Request, id: string): Promise<Response> {
  const denied = await requireSession(request)
  if (denied) return denied
  const key = new URL(request.url).searchParams.get('key')
  if (!key) {
    return Response.json({ error: 'key is required' }, { status: 400 })
  }
  // The key is a thread key, and those are moved to their current form at
  // server start (see ensureServerStarted). A picture asked for before that has
  // finished would be looked up under a key that is about to change, miss, and
  // draw as its name -- so this waits, as the app's own request entry does.
  // After the session gate: who is asking does not depend on thread keys, and
  // a refused request has no reason to start the server's background work.
  await ensureServerStarted()
  const picture = await readAttachment(key, id)
  if (!picture) {
    return Response.json({ error: 'Attachment not found' }, { status: 404 })
  }
  return new Response(new Uint8Array(Buffer.from(picture.data, 'base64')), {
    headers: {
      // Safe to hand over as stored: saveAttachment admits only the raster
      // types in ATTACHABLE_MIME_TYPES, never SVG.
      'Content-Type': picture.mimeType,
      'X-Content-Type-Options': 'nosniff',
      // A row is never rewritten -- a new picture is a new id -- so the bytes
      // behind this URL cannot change. Private, because it is behind a session.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
}
