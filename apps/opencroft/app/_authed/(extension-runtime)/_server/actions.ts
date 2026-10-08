// Client-reachable (imported by _client/loader.ts and _client/host.ts):
// createServerFn exports ONLY. TanStack's client-build code splitting elides
// a handler *body*, not this file's own top-level imports — a single plain
// export here keeps those imports "live" for the client bundle too, and can
// silently reintroduce a client-bundle build break. Plain server-only helpers go
// in extension-action-impl.ts instead.
import { createServerFn } from '@tanstack/react-start'

import {
  getActionAccess,
  invokeExtensionActionImpl,
  listDeclaredIconNamesImpl,
  listExtensionClientsImpl,
} from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { describeGraphRefsImpl, type GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'
import { ensureExtensionBuilt } from '@/app/_authed/(extension-runtime)/_server/loader'
import { findRegistryExtension } from '@/app/_authed/(extension-runtime)/_server/registry'
import {
  listTerminalSourcesImpl,
  listTerminalSourceTargetsImpl,
  type TerminalSourceInfo,
  type TerminalSourceTarget,
} from '@/app/_authed/(extension-runtime)/_server/terminal-sources'
import type { ExtensionClientInfo } from '@/app/_authed/(extension-runtime)/_types'
import { requireAdminServerFn, requireSessionServerFn } from '@/app/_server/require-session'

// Client-callable wrapper — used when the caller is genuinely client-side code (see
// _client/host.ts) or a plain HTTP route handler, both of which need the real
// request/response round trip this provides.
export const invokeExtensionAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; actionName: string; args: unknown[] }) => data)
  .handler(async ({ data }): Promise<unknown> => {
    await requireSessionServerFn()
    // Per-action authorization: an action the extension declared `admin` is
    // refused for a signed-in non-admin here, at the request-facing entry —
    // the only layer with a request to identify the caller from. Identity is
    // derived from the request, never taken from `data`, so a caller cannot
    // name itself. An undeclared action stays signed-in (the interim gate).
    if ((await getActionAccess(data.extensionId, data.actionName)) === 'admin') {
      await requireAdminServerFn()
    }
    return invokeExtensionActionImpl(data)
  })

export const listExtensionClients = createServerFn().handler(async (): Promise<ExtensionClientInfo[]> => {
  await requireSessionServerFn()
  return listExtensionClientsImpl()
})

export const listDeclaredIconNames = createServerFn().handler(async (): Promise<string[]> => {
  await requireSessionServerFn()
  return listDeclaredIconNamesImpl()
})

export const rebuildExtension = createServerFn({ method: 'POST' })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    await requireSessionServerFn()
    await ensureExtensionBuilt(extensionId)
  })

/**
 * The TerminalSelector's sources, at once: none of them is asked anything at
 * runtime, so one unreachable host cannot hold the list. A source answering
 * `targets: null` is expanded with `listTerminalSourceTargets`.
 */
export const listTerminalSources = createServerFn({ strict: { output: false } })
  .inputValidator((data: { spaceSlug?: string }) => data)
  .handler(async ({ data }): Promise<TerminalSourceInfo[]> => {
    await requireSessionServerFn()
    return listTerminalSourcesImpl(data.spaceSlug)
  })

/** One source's terminals -- a docker host's containers, an App's worktrees. As slow as that source. */
export const listTerminalSourceTargets = createServerFn({ strict: { output: false } })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<TerminalSourceTarget[]> => {
    await requireSessionServerFn()
    return listTerminalSourceTargetsImpl(String(data.id))
  })

/**
 * The registry that lists `extensionId`, for offering to install the extension
 * a node or app instance on this instance belongs to; null when no connected
 * registry lists it. The first registry listing the id is the one an install
 * takes it from.
 */
export const registryListingOf = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<{ registryName: string } | null> => {
    await requireSessionServerFn()
    const listed = await findRegistryExtension(String(extensionId))
    return listed ? { registryName: listed.registryName } : null
  })

/** Names for node / App instance ids, for NodeRef and TerminalRef. */
export const describeGraphRefs = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { ids: string[] }) => data)
  .handler(async ({ data }): Promise<Record<string, GraphRefInfo | null>> => {
    await requireSessionServerFn()
    return describeGraphRefsImpl(Array.isArray(data.ids) ? data.ids.map(String) : [])
  })
