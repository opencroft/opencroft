import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import {
  deleteSession,
  readSessions,
  type SessionEntry,
  upsertSession,
} from '@/app/_authed/(agent)/_server/agent-sessions-store'

// Shared chat session registry, persisted in the settings DB so sessions are
// available on every device (not locked to the browser that created them).
// GET lists; POST applies one operation (upsert/delete) and returns the new list.
export const Route = createFileRoute('/_authed/(agent)/api/acp/sessions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        return Response.json(await readSessions())
      },
      POST: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const body = (await request.json()) as
          | { op: 'upsert'; entry: Partial<SessionEntry> & { key: string } }
          | { op: 'delete'; key: string }
        const list = body.op === 'delete' ? await deleteSession(body.key) : await upsertSession(body.entry)
        return Response.json(list)
      },
    },
  },
})
