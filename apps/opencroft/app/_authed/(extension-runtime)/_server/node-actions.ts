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
import { requireSessionServerFn } from '@/app/_server/require-session'
import type { NodeActionDescriptor } from '@/app/_authed/(extension-runtime)/_types'

// Client-callable wrapper — see node-actions-impl.ts's listNodeActionsImpl for why
// the plain implementation lives in its own module, separate from this file.
export const listNodeActions = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((nodeId: string) => nodeId)
  .handler(async ({ data: nodeId }): Promise<NodeActionDescriptor[]> => {
    await requireSessionServerFn()
    return listNodeActionsImpl(nodeId)
  })

// Client-callable wrapper — see node-actions-impl.ts's dispatchNodeActionImpl for why
// the plain implementation lives in its own module, separate from this file.
//
// NO CALLER IS PASSED, and there is nowhere in `data` to put one. The validator
// below is an identity function carrying a type annotation, so a key the
// browser adds is not removed by it — which is why the caller is a separate
// PARAMETER of the implementation rather than a field of this payload. Anyone
// tempted to fold it back in should read what that opens: this surface would
// then let a client name any agent it liked and have a message delivered under
// that name. What a person clicking a button is entitled to be attributed as
// is their own account, which is a different question with a different answer.
export const dispatchNodeAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { nodeId: string; actionId: string; params?: Record<string, unknown> }) => data)
  .handler(async ({ data }): Promise<unknown> => {
    await requireSessionServerFn()
    return dispatchNodeActionImpl(data)
  })
