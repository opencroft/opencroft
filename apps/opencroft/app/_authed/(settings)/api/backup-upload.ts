import { saveUploadedBackup } from '@opencroft/db-backups'
import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'

// Uploading a backup is a raw-body POST rather than a server function because
// a backup is now a ZIP. The server function it replaces took a parsed JSON
// object, which meant the browser had to understand the file's contents to
// hand it over — fine while a backup WAS one JSON document, and impossible for
// an archive.
//
// A sibling of the download route rather than a child of it: `api/backup/…` is
// already the dynamic `$filename`, and a static segment under it would quietly
// claim a filename.
export const Route = createFileRoute('/_authed/(settings)/api/backup-upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const header = request.headers.get('x-filename')
        if (!header) {
          return Response.json({ error: 'Missing x-filename' }, { status: 400 })
        }
        // Percent-encoded by the client: a header field is latin-1, and a
        // backup downloaded and re-uploaded on a non-English system carries a
        // name that is not.
        let filename: string
        try {
          filename = decodeURIComponent(header)
        } catch {
          return Response.json({ error: 'Malformed x-filename' }, { status: 400 })
        }
        try {
          const bytes = Buffer.from(await request.arrayBuffer())
          if (bytes.length === 0) {
            return Response.json({ error: 'Empty upload' }, { status: 400 })
          }
          // Rejects anything that is not a backup before it lands in the
          // list — an unreadable file offered as restorable is worse than a
          // refused upload.
          return Response.json(await saveUploadedBackup(bytes, filename))
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
        }
      },
    },
  },
})
