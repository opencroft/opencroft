// The extension table: where each extension folder came from, and since when.
// See the `extension` table in @opencroft/db for what each column records.

import { db, extension } from '@opencroft/db'
import { eq, inArray } from 'drizzle-orm'

export type ExtensionRow = typeof extension.$inferSelect

/** Credentials for an extension's source, as a Secrets Store reference. */
export interface InstallAuth {
  type: 'secret'
  storeId: string
  usernameKey?: string
  tokenKey?: string
}

/** Where an installed extension came from, as an install records it. */
export interface ExtensionSource {
  url: string
  registryName?: string
  auth?: InstallAuth
  ref: string
  commit: string
}

export async function getExtensionRow(folder: string): Promise<ExtensionRow | null> {
  return (await db.query.extension.findFirst({ where: eq(extension.folder, folder) })) ?? null
}

export function authOf(row: ExtensionRow): InstallAuth | undefined {
  if (!row.authStoreId) {
    return undefined
  }
  return {
    type: 'secret',
    storeId: row.authStoreId,
    ...(row.authUsernameKey ? { usernameKey: row.authUsernameKey } : {}),
    ...(row.authTokenKey ? { tokenKey: row.authTokenKey } : {}),
  }
}

/**
 * Record where a folder's extension came from. A folder that already has a row
 * keeps its `createdAt`: an update is not a new arrival, and `createdAt` orders
 * claims between local folders.
 */
export async function writeExtensionRow(folder: string, source: ExtensionSource | null): Promise<ExtensionRow> {
  const values = {
    sourceUrl: source?.url ?? null,
    registryName: source?.registryName ?? null,
    authStoreId: source?.auth?.storeId ?? null,
    authUsernameKey: source?.auth?.usernameKey ?? null,
    authTokenKey: source?.auth?.tokenKey ?? null,
    ref: source?.ref ?? null,
    commit: source?.commit ?? null,
  }
  const [row] = await db
    .insert(extension)
    .values({ folder, ...values })
    .onConflictDoUpdate({ target: extension.folder, set: { ...values, updatedAt: new Date() } })
    .returning()
  return row
}

export async function deleteExtensionRow(folder: string): Promise<void> {
  await db.delete(extension).where(eq(extension.folder, folder))
}

/**
 * The rows of `folders`, creating one — no source, `createdAt` now — for a folder
 * that has none, such as one copied in by hand. Created the first time the folder
 * is listed, so it can never outrank an extension that was already there.
 */
export async function ensureExtensionRows(folders: string[]): Promise<Map<string, ExtensionRow>> {
  if (folders.length === 0) {
    return new Map()
  }
  await db
    .insert(extension)
    .values(folders.map((folder) => ({ folder })))
    .onConflictDoNothing({ target: extension.folder })
  const rows = await db.query.extension.findMany({ where: inArray(extension.folder, folders) })
  return new Map(rows.map((row) => [row.folder, row]))
}

/** Every row, including those whose folder is gone — a broken install, shown so it can be reinstalled or removed. */
export async function listExtensionRows(): Promise<ExtensionRow[]> {
  return db.query.extension.findMany()
}
