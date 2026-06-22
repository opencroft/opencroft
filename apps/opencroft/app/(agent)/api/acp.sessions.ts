import { createFileRoute } from '@tanstack/react-router'

import {
  deleteSession,
  readSessions,
  type SessionEntry,
  upsertSession,
} from '@/app/(agent)/_server/agent-sessions-store'

// Shared chat session registry, persisted in the settings DB so sessions are
// available on every device (not locked to the browser that created them).
// GET lists; POST applies one operation (upsert/delete) and returns the new list.
export const Route = createFileRoute('/(agent)/api/acp/sessions')({
  server: {
    handlers: {
      GET: async () => Response.json(await readSessions()),
      POST: async ({ request }) => {
        const body = (await request.json()) as
          | { op: 'upsert'; entry: Partial<SessionEntry> & { key: string } }
          | { op: 'delete'; key: string }
        const list = body.op === 'delete' ? await deleteSession(body.key) : await upsertSession(body.entry)
        return Response.json(list)
      },
    },
  },
})
