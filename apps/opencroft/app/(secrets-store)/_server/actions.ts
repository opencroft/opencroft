import { createServerFn } from '@tanstack/react-start'

import { decrypt, encrypt } from '@/server/crypto'
import { prisma } from '@opencroft/db'

export interface SecretEntry {
  id: string
  key: string
  value: string
}

export const getSecrets = createServerFn({ method: 'POST' })
  .inputValidator((storeId: string) => storeId)
  .handler(async ({ data: storeId }): Promise<SecretEntry[]> => {
    const rows = await prisma.secret.findMany({
      where: { storeId },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      value: decrypt(r.value),
    }))
  })

export const getSecretValue = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string }) => data)
  .handler(async ({ data }): Promise<string | null> => {
    const { storeId, key } = data
    const row = await prisma.secret.findUnique({
      where: { storeId_key: { storeId, key } },
    })
    if (!row) {
      return null
    }
    return decrypt(row.value)
  })

export const setSecret = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string; value: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const { storeId, key, value } = data
    const encrypted = encrypt(value)
    await prisma.secret.upsert({
      where: { storeId_key: { storeId, key } },
      create: { storeId, key, value: encrypted },
      update: { value: encrypted },
    })
  })

export const deleteSecret = createServerFn({ method: 'POST' })
  .inputValidator((data: { storeId: string; key: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    const { storeId, key } = data
    await prisma.secret
      .delete({
        where: { storeId_key: { storeId, key } },
      })
      .catch(() => {})
  })

export const deleteStore = createServerFn({ method: 'POST' })
  .inputValidator((storeId: string) => storeId)
  .handler(async ({ data: storeId }): Promise<void> => {
    await prisma.secret.deleteMany({ where: { storeId } })
  })

export interface SecretStoreSummary {
  storeId: string
  keys: string[]
}

export const listSecretStores = createServerFn().handler(async (): Promise<SecretStoreSummary[]> => {
  const rows = await prisma.secret.findMany({
    select: { storeId: true, key: true },
    orderBy: { storeId: 'asc' },
  })
  const map = new Map<string, string[]>()
  for (const row of rows) {
    const list = map.get(row.storeId) ?? []
    list.push(row.key)
    map.set(row.storeId, list)
  }
  return Array.from(map.entries()).map(([storeId, keys]) => ({ storeId, keys }))
})
