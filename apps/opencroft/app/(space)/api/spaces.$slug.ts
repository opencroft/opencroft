import { createFileRoute } from '@tanstack/react-router'

import { deleteSpace, loadSpaceGraph, renameSpace, saveSpaceGraph } from '@/app/(space)/_server/actions'
import type { GraphData } from '@/app/(space)/_server/types'

export const Route = createFileRoute('/(space)/api/spaces/$slug')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { slug } = params
        const graph = await loadSpaceGraph({ data: slug })
        if (!graph) {
          return Response.json({ error: 'Space not found' }, { status: 404 })
        }
        return Response.json({ graph })
      },
      PUT: async ({ request, params }) => {
        const { slug } = params
        const body = (await request.json()) as { graph?: GraphData }
        if (!body.graph) {
          return Response.json({ error: 'Missing graph' }, { status: 400 })
        }
        await saveSpaceGraph({ data: { slug, graph: body.graph } })
        return Response.json({ ok: true })
      },
      PATCH: async ({ request, params }) => {
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
      DELETE: async ({ params }) => {
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
