// Client-reachable (imported by _client/host.ts): createServerFn exports
// ONLY. TanStack's client-build code splitting elides a handler *body*, not
// this file's own top-level imports — a single plain export here keeps those
// imports "live" for the client bundle too, and can silently reintroduce
// a client-bundle build break. Plain server-only helpers go in
// node-actions-impl.ts instead.
import { createServerFn } from '@tanstack/react-start'

import {
  dispatchNodeActionImpl,
  listNodeActionsImpl,
} from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import type { NodeActionDescriptor } from '@/app/_authed/(extension-runtime)/_types'

// Client-callable wrapper — see node-actions-impl.ts's listNodeActionsImpl for why
// the plain implementation lives in its own module, separate from this file.
export const listNodeActions = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((nodeId: string) => nodeId)
  .handler(async ({ data: nodeId }): Promise<NodeActionDescriptor[]> => listNodeActionsImpl(nodeId))

// Client-callable wrapper — see node-actions-impl.ts's dispatchNodeActionImpl for why
// the plain implementation lives in its own module, separate from this file.
export const dispatchNodeAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { nodeId: string; actionId: string; params?: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<unknown> => dispatchNodeActionImpl(data))
