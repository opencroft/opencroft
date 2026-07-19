import { createFileRoute } from '@tanstack/react-router'

import { HISTORY_END_EVENT } from '@/app/(agent)/_lib/acp-stream'
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
            // subscribe() replays the session's whole stored history synchronously
            // before it returns (or is a noop if the session doesn't exist), so every
            // historical event is already enqueued above by this point. Ship one more
            // frame marking the boundary — the client batches everything before it
            // into a single render instead of one state update per historical event.
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(HISTORY_END_EVENT)}\n\n`))
            } catch {}
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
