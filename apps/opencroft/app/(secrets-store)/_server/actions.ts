import { createServerFn } from '@tanstack/react-start'

import { secrets } from '@/server/secrets'

export interface SecretEntry {
  id: string
  key: string
  value: string
}

export const getSecrets = createServerFn({ method: 'POST' })
  .inputValidator((storeId: string) => storeId)
  .handler(async ({ data: storeId }): Promise<SecretEntry[]> => {
    const rows = await secrets.list(storeId)
    return rows.map((r) => ({ id: r.id, key: r.key, value: r.value }))
  })

export const getSecretValue = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string }) => data)
  .handler(async ({ data }): Promise<string | null> => {
    return secrets.get(data.storeId, data.key)
  })

export const setSecret = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string; value: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await secrets.set(data.storeId, data.key, data.value)
  })

export const deleteSecret = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await secrets.delete(data.storeId, data.key)
  })

export const deleteStore = createServerFn({ method: 'POST' })
  .inputValidator((storeId: string) => storeId)
  .handler(async ({ data: storeId }): Promise<void> => {
    await secrets.deleteStore(storeId)
  })

export interface SecretStoreSummary {
  storeId: string
  keys: string[]
}

export const listSecretStores = createServerFn().handler(async (): Promise<SecretStoreSummary[]> => {
  return secrets.listStores()
})
