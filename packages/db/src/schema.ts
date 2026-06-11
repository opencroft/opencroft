import { customType, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Timestamps are stored on disk as ISO-8601 text while surfacing JS `Date`
// objects, matching what the app expects (it calls `.toISOString()` /
// `.getTime()` on these fields).
const timestamp = customType<{ data: Date; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => value.toISOString(),
  fromDriver: (value) => new Date(value),
})

const uuid = () => crypto.randomUUID()

export const setting = sqliteTable('Setting', {
  id: text().primaryKey().notNull(),
  data: text().default('{}').notNull(),
  createdAt: timestamp()
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp()
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
})

export const secret = sqliteTable(
  'Secret',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    storeId: text().notNull(),
    key: text().notNull(),
    value: text().notNull(),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('Secret_storeId_key_key').on(t.storeId, t.key), index('Secret_storeId_idx').on(t.storeId)],
)

export const appLink = sqliteTable('AppLink', {
  id: text().primaryKey().notNull().$defaultFn(uuid),
  title: text().notNull(),
  url: text().notNull(),
  order: integer().default(0).notNull(),
})

export const space = sqliteTable(
  'Space',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    slug: text().notNull(),
    name: text().notNull(),
    data: text().default('{"nodes":[],"edges":[]}').notNull(),
    pinned: integer({ mode: 'boolean' }).default(false).notNull(),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [uniqueIndex('Space_slug_key').on(t.slug)],
)

export const mcpAuditLog = sqliteTable(
  'McpAuditLog',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    tool: text().notNull(),
    args: text().default('{}').notNull(),
    result: text(),
    error: text(),
    status: text().default('auto-approved').notNull(),
    durationMs: integer().notNull(),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('McpAuditLog_tool_idx').on(t.tool), index('McpAuditLog_status_idx').on(t.status), index('McpAuditLog_createdAt_idx').on(t.createdAt)],
)

export const schema = { setting, secret, appLink, space, mcpAuditLog }

export type Setting = typeof setting.$inferSelect
export type Secret = typeof secret.$inferSelect
export type AppLink = typeof appLink.$inferSelect
export type Space = typeof space.$inferSelect
export type McpAuditLog = typeof mcpAuditLog.$inferSelect
