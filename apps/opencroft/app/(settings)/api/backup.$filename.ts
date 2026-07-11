import { readBackupFileBuffer } from '@opencroft/db-backups'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(settings)/api/backup/$filename')({
  server: {
    handlers: {
      GET: async ({ params }) => {
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
