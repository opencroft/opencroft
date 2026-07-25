// Client-reachable (imported by _client/loader.ts and _client/host.ts):
// createServerFn exports ONLY. TanStack's client-build code splitting elides
// a handler *body*, not this file's own top-level imports — a single plain
// export here keeps those imports "live" for the client bundle too, and can
// silently reintroduce a client-bundle build break. Plain server-only helpers go
// in extension-action-impl.ts instead.
import { createServerFn } from '@tanstack/react-start'

import {
  invokeExtensionActionImpl,
  listExtensionManifestsImpl,
} from '@/app/(extension-runtime)/_server/extension-action-impl'
import { ensureExtensionBuilt } from '@/app/(extension-runtime)/_server/loader'
import type { ExtensionManifestInfo } from '@/app/(extension-runtime)/_types'

// Client-callable wrapper — used when the caller is genuinely client-side code (see
// _client/host.ts) or a plain HTTP route handler, both of which need the real
// request/response round trip this provides.
export const invokeExtensionAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; actionName: string; args: unknown[] }) => data)
  .handler(async ({ data }): Promise<unknown> => invokeExtensionActionImpl(data))

export const listExtensionManifests = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ExtensionManifestInfo[]> => listExtensionManifestsImpl(),
)

export const rebuildExtension = createServerFn({ method: 'POST' })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    await ensureExtensionBuilt(extensionId)
  })
