import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// Timestamps are real Postgres `timestamptz` columns surfacing JS `Date`
// objects, matching what the app expects (it calls `.toISOString()` /
// `.getTime()` on these fields). Defaults are computed app-side (as before the
// Postgres port) so behaviour is identical across the PGlite and node-postgres
// drivers.
const createdAt = () =>
  timestamp({ withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())

const updatedAt = () =>
  timestamp({ withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())

const uuid = () => crypto.randomUUID()

export const setting = pgTable('Setting', {
  id: text().primaryKey().notNull(),
  data: text().default('{}').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const secret = pgTable(
  'Secret',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    storeId: text().notNull(),
    key: text().notNull(),
    value: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('Secret_storeId_key_key').on(t.storeId, t.key), index('Secret_storeId_idx').on(t.storeId)],
)

export const appLink = pgTable('AppLink', {
  id: text().primaryKey().notNull().$defaultFn(uuid),
  title: text().notNull(),
  url: text().notNull(),
  order: integer().default(0).notNull(),
})

export const space = pgTable(
  'Space',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    slug: text().notNull(),
    name: text().notNull(),
    data: text().default('{"nodes":[],"edges":[]}').notNull(),
    pinned: boolean().default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('Space_slug_key').on(t.slug)],
)

export const mcpAuditLog = pgTable(
  'McpAuditLog',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    tool: text().notNull(),
    args: text().default('{}').notNull(),
    result: text(),
    error: text(),
    status: text().default('auto-approved').notNull(),
    durationMs: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('McpAuditLog_tool_idx').on(t.tool),
    index('McpAuditLog_status_idx').on(t.status),
    index('McpAuditLog_createdAt_idx').on(t.createdAt),
  ],
)

export const schema = { setting, secret, appLink, space, mcpAuditLog }

export type Setting = typeof setting.$inferSelect
export type Secret = typeof secret.$inferSelect
export type AppLink = typeof appLink.$inferSelect
export type Space = typeof space.$inferSelect
export type McpAuditLog = typeof mcpAuditLog.$inferSelect
