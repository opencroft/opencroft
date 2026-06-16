import { getRuntime } from './runtime'

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

// Streams a session's chat events as Server-Sent Events. `agent.subscribe`
// replays the session's recorded history to a new subscriber before streaming
// live events, so a page reload restores the full conversation.
//
// Host wiring: expose this at the route the chat UI subscribes to (its
// `eventsUrl`, default `/api/acp/events`). The session id is taken from the
// `sessionId` query parameter.
export function agentEventsResponse(request: Request): Response {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      if (!sessionId) {
        controller.close()
        return
      }
      unsubscribe = getRuntime().agent.subscribe(sessionId, (event) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          // controller already closed
        }
      })
    },
    cancel() {
      closed = true
      unsubscribe?.()
    },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
