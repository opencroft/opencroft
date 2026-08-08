import { createServerFn } from '@tanstack/react-start'

import type { BuildResult } from '@/app/_authed/(extension-runtime)/_types'
import {
  compileLocalExtensionImpl,
  createLocalExtensionImpl,
  deleteLocalExtensionImpl,
  getLocalExtensionImpl,
  type LocalExtensionRecord,
  listLocalExtensionsImpl,
  updateLocalExtensionImpl,
} from './local-extensions-actions-impl'

export type { LocalExtensionRecord }

// Client-callable wrapper — see local-extensions-actions-impl.ts's listLocalExtensionsImpl
// for why the plain implementation lives in its own module, separate from this file.
export const listLocalExtensions = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<LocalExtensionRecord[]> => listLocalExtensionsImpl(),
)

export const getLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<LocalExtensionRecord | null> => getLocalExtensionImpl(extensionId))

export const updateLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; files: Record<string, string> }) => data)
  .handler(async ({ data }): Promise<LocalExtensionRecord> => updateLocalExtensionImpl(data))

export const createLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((files: Record<string, string>) => files)
  .handler(async ({ data: files }): Promise<LocalExtensionRecord> => createLocalExtensionImpl(files))

export const deleteLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => deleteLocalExtensionImpl(extensionId))

// A bare id still means "compile it", so existing callers keep working; the
// object form is how a caller opts into building a checkout the guard would
// otherwise decline.
export const compileLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: string | { extensionId: string; allowUnclean?: boolean }) => data)
  .handler(
    async ({ data }): Promise<BuildResult> =>
      typeof data === 'string'
        ? compileLocalExtensionImpl(data)
        : compileLocalExtensionImpl(data.extensionId, { allowUnclean: data.allowUnclean }),
  )
