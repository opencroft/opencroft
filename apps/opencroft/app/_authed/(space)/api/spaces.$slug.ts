import { createFileRoute } from '@tanstack/react-router'

import { requireSession } from '@/app/_server/require-session'
import { deleteSpace, loadSpaceGraph, renameSpace, saveSpaceGraph } from '@/app/_authed/(space)/_server/actions'
import { GraphConflictError } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

export const Route = createFileRoute('/_authed/(space)/api/spaces/$slug')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const result = await loadSpaceGraph({ data: slug })
        if (!result) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return Response.json(result)
      },
      PUT: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const body = (await request.json()) as { graph?: GraphData; expectedUpdatedAt?: string }
        if (!body.graph) {
          return Response.json({ error: 'Missing graph' }, { status: 400 })
        }
        try {
          const { updatedAt } = await saveSpaceGraph({
            data: { slug, graph: body.graph, expectedUpdatedAt: body.expectedUpdatedAt },
          })
          return Response.json({ ok: true, updatedAt })
        } catch (err) {
          if (err instanceof GraphConflictError) {
            return Response.json({ error: 'conflict' }, { status: 409 })
          }
          throw err
        }
      },
      PATCH: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const body = (await request.json()) as { name?: string }
        if (!body.name) {
          return Response.json({ error: 'Missing name' }, { status: 400 })
        }
        const space = await renameSpace({ data: { slug, name: body.name } })
        if (!space) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return Response.json({ space })
      },
      DELETE: async ({ request, params }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const { slug } = params
        const ok = await deleteSpace({ data: slug })
        if (!ok) {
          return Response.json({ error: 'Cannot delete' }, { status: 400 })
        }
        return Response.json({ ok: true })
      },
    },
  },
})
