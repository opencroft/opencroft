import { createServerFn } from '@tanstack/react-start'

import { getSetting, setSetting } from '@/app/(settings)/_server/actions'

const STORAGE_ID = 'app-dashboard-mvp-extension-storage'

type StorageMap = Record<string, unknown>

function nsKey(extensionId: string, key: string): string {
  return `${extensionId}::${key}`
}

async function readAll(): Promise<StorageMap> {
  const setting = await getSetting({ data: STORAGE_ID })
  return setting?.data ?? {}
}

async function writeAll(data: StorageMap): Promise<void> {
  await setSetting({ data: { id: STORAGE_ID, data } })
}

export const extensionStorageGet = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; key: string }) => data)
  .handler(async ({ data }): Promise<unknown | null> => {
    const { extensionId, key } = data
    const all = await readAll()
    return (all[nsKey(extensionId, key)] as unknown | undefined) ?? null
  })

export const extensionStorageSet = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; key: string; value: unknown }) => data)
  .handler(async ({ data }): Promise<void> => {
    const { extensionId, key, value } = data
    const all = await readAll()
    all[nsKey(extensionId, key)] = value
    await writeAll(all)
  })

export const extensionStorageDelete = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; key: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const { extensionId, key } = data
    const all = await readAll()
    delete all[nsKey(extensionId, key)]
    await writeAll(all)
  })

export const extensionStorageList = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<string[]> => {
    const all = await readAll()
    const prefix = `${extensionId}::`
    return Object.keys(all)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  })

export const extensionStorageClear = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    const all = await readAll()
    const prefix = `${extensionId}::`
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) {
        delete all[k]
      }
    }
    await writeAll(all)
  })
