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
  listExtensionManifestsImpl,
} from '@/app/_authed/(extension-runtime)/_server/extension-action-impl'
import { ensureExtensionBuilt } from '@/app/_authed/(extension-runtime)/_server/loader'
import { requireAdminServerFn, requireSessionServerFn } from '@/app/_server/require-session'
import type { ExtensionManifestInfo } from '@/app/_authed/(extension-runtime)/_types'

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
