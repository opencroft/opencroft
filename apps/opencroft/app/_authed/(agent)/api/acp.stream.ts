import { createFileRoute } from '@tanstack/react-router'

import { historyEndEvent } from '@/app/_authed/(agent)/_lib/acp-stream'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { withAuthors } from '@/app/_authed/(agent)/_server/attach-authors'
import { requireSession } from '@/app/_server/require-session'

// How much history a cold (re)connect replays before switching to live events.
// Generous enough that opening a chat rarely needs an immediate "load older"
// round-trip, but bounded so a long-dead session's full transcript is never
// pulled into a browser tab (or re-sent on every reconnect) — see
// why it matters: sending the whole replay on every open was the
// actual cause of a server OOM, independent of a separate wire-decode bug.
export const INITIAL_HISTORY_RECORDS = 20

export const Route = createFileRoute('/_authed/(agent)/api/acp/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = await requireSession(request)
        if (denied) return denied
        const sessionId = new URL(request.url).searchParams.get('sessionId')
        if (!sessionId) {
          return new Response('missing sessionId', { status: 400 })
        }
        const encoder = new TextEncoder()
        let unsubscribe = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const window = agentClient.getRecordsWindow(sessionId, { records: INITIAL_HISTORY_RECORDS })
            // Resolving a message's authors reads the database, and `subscribe`
            // hands events over synchronously — so frames are queued onto one
            // promise chain rather than enqueued directly. The chain is what
            // keeps them in order: without it a user event that has to wait for
            // a lookup would arrive after replies that were emitted later, and
            // the transcript would assemble itself wrongly for exactly the
            // sessions with the most to resolve.
            let inOrder = Promise.resolve()
            const send = (frame: unknown | Promise<unknown>) => {
              inOrder = inOrder.then(async () => {
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(await frame)}\n\n`))
                } catch {}
              })
            }
            unsubscribe = agentClient.subscribe(sessionId, (event) => send(withAuthors(event)), {
              fromIndex: window?.startIndex,
            })
            // subscribe() replays only the bounded tail window synchronously before
            // it returns (or is a noop if the session doesn't exist), so every
            // replayed event is already queued above by this point. Ship one more
            // frame marking the boundary (and the pagination cursor for "load
            // older") — the client batches everything before it into a single
            // render instead of one state update per replayed event.
            //
            // The header is resolved like any other user event: it is the same
            // message as the block that replaces it once the rest of its turn
            // loads, so it must not be the one message that draws differently.
            send(
              (async () =>
                historyEndEvent(
                  window?.startIndex ?? 0,
                  window?.hasMore ?? false,
                  window?.header
                    ? { index: window.header.index, event: await withAuthors(window.header.event) }
                    : undefined,
                ))(),
            )
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
