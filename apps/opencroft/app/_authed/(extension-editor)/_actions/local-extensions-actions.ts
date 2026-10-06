import { createServerFn } from '@tanstack/react-start'

import {
  checkLocalExtensionRemoteImpl,
  type LocalPullResult,
  type LocalRemoteState,
  pullLocalExtensionImpl,
} from '@/app/_authed/(extension-editor)/_actions/local-extension-remote-impl'
import type { BuildResult } from '@/app/_authed/(extension-runtime)/_types'
import {
  compileLocalExtensionImpl,
  createLocalExtensionImpl,
  deleteLocalExtensionFileImpl,
  deleteLocalExtensionImpl,
  getLocalExtensionImpl,
  type LocalExtensionRecord,
  listLocalExtensionsImpl,
  updateLocalExtensionImpl,
} from './local-extensions-actions-impl'

export type { LocalExtensionRecord, LocalPullResult, LocalRemoteState }

// Every local extension is addressed by its folder, `local.<name>`: the thing
// that is edited, compiled and deleted. Client-callable wrappers — see
// local-extensions-actions-impl.ts for why the plain implementations live in
// their own module.

export const listLocalExtensions = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<LocalExtensionRecord[]> => listLocalExtensionsImpl(),
)

export const getLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<LocalExtensionRecord | null> => getLocalExtensionImpl(folder))

export const updateLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { folder: string; files: Record<string, string> }) => data)
  .handler(async ({ data }): Promise<LocalExtensionRecord> => updateLocalExtensionImpl(data))

export const createLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { folder: string; files: Record<string, string> }) => data)
  .handler(async ({ data }): Promise<LocalExtensionRecord> => createLocalExtensionImpl(data.folder, data.files))

export const deleteLocalExtensionFile = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { folder: string; path: string }) => data)
  .handler(async ({ data }): Promise<LocalExtensionRecord> => deleteLocalExtensionFileImpl(data))

export const deleteLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<void> => deleteLocalExtensionImpl(folder))

// Where a local checkout stands against its branch on origin. A read, and it
// costs a round trip to the remote — so it is asked for a single extension, on
// the page that shows one, rather than for a list of them.
export const checkLocalExtensionRemote = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<LocalRemoteState> => checkLocalExtensionRemoteImpl(folder))

// Fast-forward the checkout to its branch on origin and rebuild it. Refuses a
// tree with uncommitted work: updating would write over somebody's changes.
export const pullLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<LocalPullResult> => pullLocalExtensionImpl(folder))

export const compileLocalExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<BuildResult> => compileLocalExtensionImpl(folder))
