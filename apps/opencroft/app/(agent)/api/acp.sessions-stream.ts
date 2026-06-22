import { createFileRoute } from '@tanstack/react-router'

import { readSessions, subscribeSessions } from '@/app/(agent)/_server/agent-sessions-store'

// Live session registry over SSE: pushes the full list on connect and again on
// every change, so a session created/renamed/deleted on one device shows up on
// the others immediately — no polling. Mirrors the chat event stream in
// acp.stream.ts.
export const Route = createFileRoute('/(agent)/api/acp/sessions-stream')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const encoder = new TextEncoder()
        let unsubscribe = () => {}
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (list: unknown) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(list)}\n\n`))
              } catch {}
            }
            send(await readSessions())
            unsubscribe = subscribeSessions(send)
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
