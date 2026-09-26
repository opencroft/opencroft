import { createFileRoute } from '@tanstack/react-router'

import { streamOwnSessionActivity } from '@/app/_authed/(agent)/_server/session-activity'
import { requireSession } from '@/app/_server/require-session'
import type { SSEEvent } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'
import { getAllDockerSnapshots } from '@/server/scheduler/docker-ps-poller'

export const Route = createFileRoute('/_authed/(sse)/api/sse')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const url = new URL(request.url)
        const spaceId = url.searchParams.get('spaceId') ?? undefined

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()

            controller.enqueue(encoder.encode(': connected\n\n'))

            for (const { dockerNodeId, containers } of getAllDockerSnapshots()) {
              const event = { type: 'docker_ps_updated', dockerNodeId, containers }
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            }

            const unsubscribe = toastStore.subscribe((data) => {
              try {
                controller.enqueue(encoder.encode(data))
              } catch {
                unsubscribe()
              }
            }, spaceId)

            // Every connection opens with the person's current picture, so a
            // new tab, a reload and the browser's own reconnect all start
            // from the truth rather than from whatever the page held before.
            const stopActivity = streamOwnSessionActivity(request, (activity) => {
              const event: SSEEvent = { type: 'session_activity', activity }
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              } catch {
                stopActivity()
              }
            })

            const keepalive = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keepalive\n\n'))
              } catch {
                clearInterval(keepalive)
                unsubscribe()
                stopActivity()
              }
            }, 30_000)

            const abortHandler = () => {
              clearInterval(keepalive)
              unsubscribe()
              stopActivity()
              try {
                controller.close()
              } catch {}
            }

            request.signal.addEventListener('abort', abortHandler)
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        })
      },
    },
  },
})
