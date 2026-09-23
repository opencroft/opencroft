import { createFileRoute } from '@tanstack/react-router'

import { historyEndEvent, SESSION_GONE_KIND } from '@/app/_authed/(agent)/_lib/acp-stream'
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
        const goneFrame = encoder.encode(`data: ${JSON.stringify({ kind: SESSION_GONE_KIND })}\n\n`)
        let unsubscribe = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const window = agentClient.getRecordsWindow(sessionId, { records: INITIAL_HISTORY_RECORDS })
            // Null means the engine holds no such session — not an empty one.
            // A browser tab keeps its session id across a server restart, a
            // stopped process and an idle unload, and its EventSource
            // reconnects on its own; answering that reconnect with an empty
            // history closed at index 0 is what wiped open chats blank. Say
            // so instead, and end the stream: the client reopens the tab's
            // session and connects again under the id that gives it.
            if (!window) {
              controller.enqueue(goneFrame)
              controller.close()
              return
            }
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
            // How many of the replayed events are live-state snapshots rather
            // than log entries. Reported by subscribe before it delivers the
            // first one, so it is known by the time the marker below is built;
            // the marker is what lets the client number the rest correctly.
            let snapshotPrefix = 0
            unsubscribe = agentClient.subscribe(sessionId, (event) => send(withAuthors(event)), {
              fromIndex: window.startIndex,
              onReplay: (info) => {
                snapshotPrefix = info.snapshotPrefix
              },
              // The session this stream reads has stopped being the session:
              // it was unloaded, stopped, deleted, or replaced by a reopen
              // under the same id. Nothing will be emitted into it again, so a
              // stream left open would be a chat that looks live and never
              // moves -- a message sent from it reaches the agent, which
              // works, and none of that ever arrives here. Say so the same way
              // as for an unknown id, behind whatever is still queued, and end.
              onEnd: () => {
                inOrder = inOrder.then(() => {
                  try {
                    controller.enqueue(goneFrame)
                    controller.close()
                  } catch {
                    // Already closed by the reader.
                  }
                })
              },
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
                  window.startIndex,
                  window.hasMore,
                  window.header
                    ? { index: window.header.index, event: await withAuthors(window.header.event) }
                    : undefined,
                  snapshotPrefix,
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
