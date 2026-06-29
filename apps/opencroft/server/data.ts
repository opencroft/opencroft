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

export async function deleteSetting(id: string) {
  return (await db.delete(setting).where(eq(setting.id, id)).returning()).length > 0
}
