import { createFileRoute } from '@tanstack/react-router'

import { historyEndEvent } from '@/app/(agent)/_lib/acp-stream'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'

// How much history a cold (re)connect replays before switching to live events.
// Generous enough that opening a chat rarely needs an immediate "load older"
// round-trip, but bounded so a long-dead session's full transcript is never
// pulled into a browser tab (or re-sent on every reconnect) — see
// why it matters: sending the whole replay on every open was the
// actual cause of a server OOM, independent of a separate wire-decode bug.
export const INITIAL_HISTORY_RECORDS = 10

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
            const window = agentClient.getRecordsWindow(sessionId, { records: INITIAL_HISTORY_RECORDS })
            unsubscribe = agentClient.subscribe(
              sessionId,
              (event) => {
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                } catch {}
              },
              { fromIndex: window?.startIndex },
            )
            // subscribe() replays only the bounded tail window synchronously before
            // it returns (or is a noop if the session doesn't exist), so every
            // replayed event is already enqueued above by this point. Ship one more
            // frame marking the boundary (and the pagination cursor for "load
            // older") — the client batches everything before it into a single
            // render instead of one state update per replayed event.
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(
                    historyEndEvent(window?.startIndex ?? 0, window?.hasMore ?? false, window?.header),
                  )}\n\n`,
                ),
              )
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
            // Without this, a buffering reverse proxy in front of the app can hold
            // the entire (open-ended) SSE response in its own memory waiting for a
            // close that never comes instead of forwarding it live.
            'X-Accel-Buffering': 'no',
          },
        })
      },
    },
  },
})
