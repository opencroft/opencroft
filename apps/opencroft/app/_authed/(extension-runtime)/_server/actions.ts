// Client-reachable (imported by _client/loader.ts and _client/host.ts):
// createServerFn exports ONLY. TanStack's client-build code splitting elides
// a handler *body*, not this file's own top-level imports — a single plain
// export here keeps those imports "live" for the client bundle too, and can
// silently reintroduce a client-bundle build break. Plain server-only helpers go
// in extension-action-impl.ts instead.
import { createServerFn } from '@tanstack/react-start'

import { TERMINAL_ROUTER_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import {
  getActionAccess,
  invokeExtensionActionImpl,
  listExtensionManifestsImpl,
} from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { listGraphHandles } from '@/app/_authed/(extension-runtime)/_server/host'
import { ensureExtensionBuilt } from '@/app/_authed/(extension-runtime)/_server/loader'
import type { ExtensionManifestInfo } from '@/app/_authed/(extension-runtime)/_types'
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

export const listExtensionManifests = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ExtensionManifestInfo[]> => {
    await requireSessionServerFn()
    return listExtensionManifestsImpl()
  },
)

export const rebuildExtension = createServerFn({ method: 'POST' })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    await requireSessionServerFn()
    await ensureExtensionBuilt(extensionId)
  })

/** One pickable terminal source, for the TerminalSelector. */
export interface TerminalTargetOption {
  /** "node-id/handle-id" — the form every terminal-taking action accepts. */
  target: string
  /** Display name: the node, qualified by what distinguishes this handle on it. */
  title: string
  spaceSlug: string
}

export const listTerminalTargets = createServerFn({ strict: { output: false } })
  .inputValidator((data: { spaceSlug?: string }) => data)
  .handler(async ({ data }): Promise<TerminalTargetOption[]> => {
    await requireSessionServerFn()
    const handles = await listGraphHandles({ role: 'source', contextType: 'terminal-context' })
    return (
      handles
        .filter((handle) => !data.spaceSlug || handle.spaceSlug === data.spaceSlug)
        // A router's outputs are terminals already on this list under their own
        // name; offering them again would list each routed terminal once per
        // router that carries it.
        .filter((handle) => handle.typeId !== TERMINAL_ROUTER_TYPE)
        .map((handle) => {
          // A dynamic handle's declared id is a prefix; the expanded remainder
          // (a container name, a worktree) is what tells its siblings apart.
          const detail = handle.dynamic ? handle.handleId.slice(handle.declaredId.length) : handle.label
          return {
            target: `${handle.nodeId}/${handle.handleId}`,
            title: detail ? `${handle.nodeName} · ${detail}` : handle.nodeName,
            spaceSlug: handle.spaceSlug,
          }
        })
    )
  })
