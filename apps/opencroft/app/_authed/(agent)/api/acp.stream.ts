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

// A frame that could not be prepared, so the chain knows to skip it rather
// than enqueue whatever stood in for it. A symbol because it must not be
// confusable with anything a real frame could be.
const SKIP_FRAME = Symbol('skip-frame')

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
              // Handled WHERE THE PROMISE IS CREATED, not where the chain
              // reaches it. A handler attached inside the chain is attached
              // late -- a frame rejecting while an earlier one is still pending
              // is an unhandled rejection first, and the default response to
              // one of those is to exit the process. So the failure a late
              // handler appears to protect against ("the stream goes quiet, and
              // says so") is really "the server stops, silently". Attaching
              // here is what makes the promise handled from the moment it
              // exists.
              //
              // Unreachable today: frame preparation degrades rather than
              // rejecting. It is here for whoever changes that.
              const prepared = Promise.resolve(frame).catch((err) => {
                console.error(
                  '[acp stream] A frame could not be prepared; this event is skipped:',
                  err instanceof Error ? err.message : String(err),
                )
                return SKIP_FRAME
              })
              inOrder = inOrder.then(async () => {
                // Awaited OUTSIDE the try, deliberately. The catch below is for
                // one thing only, and putting anything that can reject in front
                // of it would silently widen what it swallows.
                const resolved = await prepared
                if (resolved === SKIP_FRAME) {
                  return
                }
                try {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(resolved)}\n\n`))
                } catch {
                  // The reader closed the connection. There is genuinely
                  // nothing to do and nobody to tell.
                }
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
