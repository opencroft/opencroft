import { db, setting } from '@opencroft/db'
import { eq } from 'drizzle-orm'

const PINNED_SETTING_ID = 'dashboards.pinned'

async function readPinned(): Promise<string[]> {
  const row = await db.query.setting.findFirst({ where: eq(setting.id, PINNED_SETTING_ID) })
  if (!row) {
    return []
  }
  const parsed = JSON.parse(row.data) as { slugs?: string[] }
  return Array.isArray(parsed.slugs) ? parsed.slugs : []
}

export async function listPinnedDashboardSlugs(): Promise<string[]> {
  return readPinned()
}

export async function setDashboardPinned(slug: string, pinned: boolean): Promise<string[]> {
  const current = await readPinned()
  const next = pinned ? [...new Set([...current, slug])] : current.filter((s) => s !== slug)
  const data = JSON.stringify({ slugs: next })
  await db
    .insert(setting)
    .values({ id: PINNED_SETTING_ID, data })
    .onConflictDoUpdate({ target: setting.id, set: { data, updatedAt: new Date() } })
  return next
}
