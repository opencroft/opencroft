# Server-sent events

OpenCroft uses a single SSE endpoint, `/api/sse`, to push real-time UI
events from the server to every open browser tab. The bus carries:

- Toast notifications (errors, info, success).
- Camera focus and comment bubbles.
- Graph-update and extension-rebuild signals.
- Cross-tab navigation (`open_space`).
- Doc comment thread updates.

There is no WebSocket fan-out: SSE is enough because the messages are
one-way (server → client) and tiny. The terminal uses its own WebSocket on
a different port.

## The event shape

Defined in [lib/sse-events.ts](../../lib/sse-events.ts):

```ts
type SSEEvent = { spaceId?: string } & (
  | { type: 'toast'; message: string; toastType: 'info' | 'success' | 'warning' | 'error' }
  | { type: 'focus_node'; nodeId: string; panToNode?: boolean }
  | { type: 'clear_focus' }
  | { type: 'comment'; nodeId: string; message: string }
  | { type: 'clear_comment'; nodeId: string }
  | { type: 'graph_updated' }
  | { type: 'extensions_updated' }
  | { type: 'open_space'; slug: string; nodeId?: string }
  | { type: 'doc_comments_updated'; docPath: string }
);
```

`spaceId` scopes an event to one space (so a focus event in `homelab`
doesn't ripple through the `playground` tab in another window). Events
without `spaceId` are global and reach every subscriber.

## The bus

[`lib/toast-store.ts`](../../lib/toast-store.ts) is a tiny in-memory pub/sub
attached to `globalThis.__TOAST_STORE__` (so Turbopack's per-route module
isolation doesn't fragment subscribers). Two operations:

```ts
toastStore.subscribe(fn, spaceId?)  // returns unsubscribe()
toastStore.broadcast(event)
```

Routing: a subscriber with `spaceId` receives events whose `spaceId` is
either unset (global) or equal to its own. A subscriber without a
`spaceId` receives everything.

## The endpoint

[`/api/sse/route.ts`](../%28sse%29/api/sse/route.ts) opens a
`ReadableStream`, sends `: connected` immediately, subscribes to the bus
(scoped to `?spaceId=<slug>` if present), pumps every event as
`data: <json>\n\n` and emits a `: keepalive` comment every 30 s. When the
client aborts, it unsubscribes.

The route uses `dynamic = 'force-dynamic'` so Next.js doesn't try to cache
or statically render it.

## The client

[`SSEProvider`](../%28sse%29/components/sse-provider.tsx) sits at the root
of `app/layout.tsx`. It wraps the tree in `SSEEventsProvider` (a Zustand-ish
context) and mounts a `useSSE()` hook
([app/(sse)/hooks/use-sse.ts](../%28sse%29/hooks/use-sse.ts)) that:

1. Reads the current pathname; if the URL is `/space/<slug>`, the slug is
   passed as `?spaceId=<slug>` so this tab only gets events for that space.
2. Opens an `EventSource`. The browser auto-reconnects on errors.
3. Surfaces every event two ways:
   - `toast` events go straight to sonner via `toast.<type>(message, ...)`.
   - `open_space` events trigger `router.push('/space/<slug>')`.
   - **Every** event (including the above) is dispatched into the
     `SSEEventsProvider` store, so `useSSEEvents()` and `useGraphEvents()`
     can react.

## Where events come from

- `send_toast` MCP tool → `toastStore.broadcast({ type: 'toast', ... })`.
- `focus_node` / `comment_nodes` / `uncomment_nodes` MCP tools broadcast
  the matching event types so every open tab animates the camera or shows
  the bubble in sync.
- `compileLocalExtension` and `updateLocalExtension` →
  `{ type: 'extensions_updated' }` so every canvas calls
  `loadAllExtensions()` again.
- The graph context resolver fires `{ type: 'toast', toastType: 'error',
  ... }` if an extension fails to build.
- Doc comment server actions broadcast
  `{ type: 'doc_comments_updated', docPath }` when an agent posts a reply.

## Where events are consumed

- The toast layer in `useSSE()` itself.
- `useGraphEvents()` ([app/(dashboard)/_canvas/use-graph-events.ts](../%28dashboard%29/_canvas/use-graph-events.ts))
  reads from the SSE store and translates focus / comment / extensions
  events into canvas operations.
- The doc viewer's comment thread refreshes its data on
  `doc_comments_updated`.
- Anywhere else that calls `useSSEEvents()` to subscribe to a slice of the
  history.

## Adding a new event

1. Add a discriminated case to `SSEEvent` in `lib/sse-events.ts`.
2. Broadcast it from server code: `toastStore.broadcast({ type: '...',
   ... })`. Include `spaceId` if the event is space-scoped.
3. Handle it on the client: add a branch to `useGraphEvents` (canvas), add
   a hook in the doc viewer, or read it directly from `useSSEEvents()`
   wherever it matters.

That's the whole bus. There's no message ordering guarantee beyond the order
each subscriber receives them, but for the UI feedback it's been enough.
