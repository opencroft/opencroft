import { getSessionUser } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type { GraphInstanceView, RenameSpaceResult } from '@/app/_authed/(space)/_server/actions-impl'
import {
  createSpaceImpl,
  deleteSpaceImpl,
  exportSpaceImpl,
  findSpaceByNodeImpl,
  findTakenGraphIdsImpl,
  getActiveSpaceSlugImpl,
  getGraphViewForInstanceImpl,
  importSpaceImpl,
  listSpacesImpl,
  loadSpaceGraphImpl,
  renameSpaceImpl,
  saveSpaceGraphImpl,
  setActiveSpaceSlugImpl,
  setSpaceIconImpl,
  setSpacePinnedImpl,
} from '@/app/_authed/(space)/_server/actions-impl'
import type { GraphData, SpaceExport, SpaceSummary } from '@/app/_authed/(space)/_server/types'

// The HTTP boundary for every space operation: check the session, then hand
// off to the plain implementation in actions-impl.ts.
//
// WHY THE CHECK IS HERE AND NOT IN THE IMPLEMENTATIONS. The
// _authed layout's beforeLoad guards NAVIGATION; it never runs for a
// createServerFn, which is an individually callable RPC endpoint reachable
// without ever rendering the page that links to it. So the check has to exist
// at this layer. But it must exist ONLY at this layer: (mcp)/_server/tools.ts
// and graph-conflict-retry.ts call the implementations in-process to serve
// MCP tool calls, and /api/mcp is a bearer-token surface carrying no session
// cookie by design. Putting the check in the shared implementation instead
// threw "Not signed in" for every agent tool — including, through
// withGraphConflictRetry's default load/save, all seven graph-write tools.
//
// Every export below is gated, not just the read paths: an unauthenticated
// caller could not list spaces but could still delete one by slug, and slugs
// are guessable, which is worse than the gap this replaced.
//
// Do not re-export anything from actions-impl.ts here as a plain function —
// this module is in the client graph, and an unstubbed plain export ships its
// server-only imports to the browser.
async function requireSession(): Promise<void> {
  const user = await getSessionUser(getRequest())
  if (!user) {
    throw new Error('Not signed in')
  }
}

export const listSpaces = createServerFn({ strict: { output: false } }).handler(async (): Promise<SpaceSummary[]> => {
  await requireSession()
  return listSpacesImpl()
})

export const loadSpaceGraph = createServerFn({ strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<{ graph: GraphData; updatedAt: string } | null> => {
    await requireSession()
    return loadSpaceGraphImpl(slug)
  })

export const findTakenGraphIds = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { ids: string[]; exceptAddress?: string }) => data)
  .handler(async ({ data }): Promise<string[]> => {
    await requireSession()
    return findTakenGraphIdsImpl({
      ids: Array.isArray(data.ids) ? data.ids.map(String) : [],
      exceptAddress: data.exceptAddress,
    })
  })

export const saveSpaceGraph = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; graph: GraphData; expectedUpdatedAt?: string }) => data)
  .handler(async ({ data }): Promise<{ updatedAt: string }> => {
    await requireSession()
    return saveSpaceGraphImpl(data)
  })

export const createSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }): Promise<SpaceSummary> => {
    await requireSession()
    return createSpaceImpl(name)
  })

export const renameSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; name: string }) => data)
  .handler(async ({ data }): Promise<RenameSpaceResult> => {
    await requireSession()
    return renameSpaceImpl(data)
  })

export const deleteSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<boolean> => {
    await requireSession()
    return deleteSpaceImpl(slug)
  })

export const setSpacePinned = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; pinned: boolean }) => data)
  .handler(async ({ data }): Promise<SpaceSummary | null> => {
    await requireSession()
    return setSpacePinnedImpl(data)
  })

// Same contract as an account avatar (packages/auth updateOwnAvatar): a small,
// self-contained image data URL or null to clear. The client re-encodes to a
// small square before sending; this cap is the server's own say, not a copy of
// the client's.
const MAX_ICON_CHARS = 64 * 1024
const ICON_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export const setSpaceIcon = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; icon: string | null }) => data)
  .handler(async ({ data }): Promise<SpaceSummary | null> => {
    await requireSession()
    if (data.icon !== null) {
      if (!ICON_DATA_URL.test(data.icon)) {
        throw new Error('A space icon must be a PNG, JPEG or WebP image.')
      }
      if (data.icon.length > MAX_ICON_CHARS) {
        throw new Error('That image is too large to store. Choose a smaller one.')
      }
    }
    return setSpaceIconImpl(data)
  })

export const exportSpace = createServerFn({ strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<SpaceExport | null> => {
    await requireSession()
    return exportSpaceImpl(slug)
  })

export const importSpace = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((payload: SpaceExport) => payload)
  .handler(async ({ data: payload }): Promise<SpaceSummary> => {
    await requireSession()
    return importSpaceImpl(payload)
  })

export const getActiveSpaceSlug = createServerFn({ strict: { output: false } }).handler(async (): Promise<string> => {
  await requireSession()
  return getActiveSpaceSlugImpl()
})

export const setActiveSpaceSlug = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((slug: string) => slug)
  .handler(async ({ data: slug }): Promise<void> => {
    await requireSession()
    return setActiveSpaceSlugImpl(slug)
  })

export const findSpaceByNode = createServerFn({ strict: { output: false } })
  .inputValidator((nodeId: string) => nodeId)
  .handler(async ({ data: nodeId }): Promise<SpaceSummary | null> => {
    await requireSession()
    return findSpaceByNodeImpl(nodeId)
  })

export const getGraphViewForInstance = createServerFn({ strict: { output: false } })
  .inputValidator((instanceId: string) => instanceId)
  .handler(async ({ data: instanceId }): Promise<GraphInstanceView | null> => {
    await requireSession()
    return getGraphViewForInstanceImpl(instanceId)
  })
