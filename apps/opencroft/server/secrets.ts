import { db, secret } from '@opencroft/db'
import type { HostSecretsApi, SecretRecord } from '@opencroft/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { decrypt, encrypt } from '@/server/crypto'

type Row = typeof secret.$inferSelect

function toRecord(row: Row): SecretRecord {
  return { id: row.id, storeId: row.storeId, key: row.key, value: decrypt(row.value), updatedAt: row.updatedAt }
}

/** Extends the extension-facing {@link HostSecretsApi} with store-level operations used by the app. */
interface SecretsService extends HostSecretsApi {
  deleteStore(storeId: string): Promise<void>
  listStores(): Promise<{ storeId: string; keys: string[] }[]>
}

export const secrets: SecretsService = {
  async resolve(key) {
    const row = await db.query.secret.findFirst({ where: eq(secret.key, key), orderBy: asc(secret.createdAt) })
    return row ? decrypt(row.value) : null
  },
  async get(storeId, key) {
    const row = await db.query.secret.findFirst({ where: and(eq(secret.storeId, storeId), eq(secret.key, key)) })
    return row ? decrypt(row.value) : null
  },
  async list(storeId) {
    const rows = await db.query.secret.findMany({ where: eq(secret.storeId, storeId), orderBy: asc(secret.createdAt) })
    return rows.map(toRecord)
  },
  async listAll() {
    const rows = await db.query.secret.findMany({ orderBy: desc(secret.updatedAt) })
    return rows.map(toRecord)
  },
  async set(storeId, key, value) {
    const encrypted = encrypt(value)
    db.insert(secret)
      .values({ storeId, key, value: encrypted })
      .onConflictDoUpdate({ target: [secret.storeId, secret.key], set: { value: encrypted, updatedAt: new Date() } })
      .run()
  },
  async delete(storeId, key) {
    db.delete(secret)
      .where(and(eq(secret.storeId, storeId), eq(secret.key, key)))
      .run()
  },
  async deleteById(id) {
    db.delete(secret).where(eq(secret.id, id)).run()
  },
  async deleteStore(storeId) {
    db.delete(secret).where(eq(secret.storeId, storeId)).run()
  },
  async listStores() {
    const rows = await db.query.secret.findMany({ columns: { storeId: true, key: true }, orderBy: asc(secret.storeId) })
    const map = new Map<string, string[]>()
    for (const row of rows) {
      const keys = map.get(row.storeId) ?? []
      keys.push(row.key)
      map.set(row.storeId, keys)
    }
    return Array.from(map.entries()).map(([storeId, keys]) => ({ storeId, keys }))
  },
}
