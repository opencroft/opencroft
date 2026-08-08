'use server'

import { db, setting } from '@opencroft/db'
import { eq } from 'drizzle-orm'

// ── Setting CRUD ──

export async function getSetting(id: string) {
  return (await db.query.setting.findFirst({ where: eq(setting.id, id) })) ?? null
}

export async function upsertSetting(id: string, data: string) {
  const [row] = await db
    .insert(setting)
    .values({ id, data })
    .onConflictDoUpdate({ target: setting.id, set: { data, updatedAt: new Date() } })
    .returning()
  return row
}

// Compare-and-swap upsert: writes only if the row's current version matches
// `expectedVersion` (0 for "no row yet"), atomically bumping the version on
// success — one statement, so there is no read-then-write gap for another
// writer to land in. Returns null on a lost race; the caller re-reads and
// retries rather than overwriting a write it never saw.
export async function upsertSettingCas(id: string, data: string, expectedVersion: number) {
  const [row] = await db
    .insert(setting)
    .values({ id, data, version: expectedVersion + 1 })
    .onConflictDoUpdate({
      target: setting.id,
      set: { data, version: expectedVersion + 1, updatedAt: new Date() },
      where: eq(setting.version, expectedVersion),
    })
    .returning()
  return row ?? null
}

export async function deleteSetting(id: string) {
  return (await db.delete(setting).where(eq(setting.id, id)).returning()).length > 0
}
