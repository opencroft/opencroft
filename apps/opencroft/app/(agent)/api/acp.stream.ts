import { createFileRoute } from '@tanstack/react-router'

import { agentClient } from '@/app/(agent)/_server/agent-client-instance'

export const Route = createFileRoute('/(agent)/api/acp/stream')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId')
        if (!sessionId) {
          return new Response('missing sessionId', { status: 400 })
        }
        const encoder = new TextEncoder()
        let unsubscribe = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            unsubscribe = agentClient.subscribe(sessionId, (event) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              } catch {}
            })
          },
          cancel() {
            unsubscribe()
          },
        })
        request.signal.addEventListener('abort', () => unsubscribe())
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
