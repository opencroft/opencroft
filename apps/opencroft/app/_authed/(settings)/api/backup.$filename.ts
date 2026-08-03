import { readBackupFileBuffer } from '@opencroft/db-backups'
import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'

export const Route = createFileRoute('/_authed/(settings)/api/backup/$filename')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { filename } = params
        let body: Buffer
        try {
          body = await readBackupFileBuffer(filename)
        } catch {
          return Response.json({ error: 'Backup not found' }, { status: 404 })
        }
        return new Response(body, {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`,
          },
        })
      },
    },
  },
})
