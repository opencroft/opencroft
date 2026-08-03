import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { authSchema } from './auth-schema'

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

// Machine credentials for the HTTP MCP surface. Humans get cookie sessions;
// agents and external MCP clients get one of these instead.
//
// Only the hash is stored. We only ever look up by a presented value, so there
// is no reason to be able to read a token back — and a table we cannot read
// back is one that leaks nothing if it is dumped.
//
// Several live tokens per agent is deliberate. With a single credential,
// rotation means a window where the old token is dead and the new one is not
// yet configured — downtime on the dispatch path to do routine hygiene. Many
// live tokens make rotation issue → reconfigure → revoke, with no gap.
export const apiToken = pgTable(
  'ApiToken',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    agent: text().notNull(),
    // Free text, to tell one of an agent's live tokens from another when
    // revoking — "laptop", "rotation-2026-08". Never a secret.
    label: text().default('').notNull(),
    tokenHash: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true, mode: 'date' }),
    revokedAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('ApiToken_tokenHash_key').on(t.tokenHash), index('ApiToken_agent_idx').on(t.agent)],
)

// DISTINCT (caller, method, tool) COMBINATIONS SEEN ON THE HTTP MCP SURFACE,
// maintained by the database.
//
// This is not a log with a schema bolted on, and that distinction is the reason
// it is a table at all. Stage A's question is "which clients exist" — this
// stores the material for that answer directly, rather than making it a grep
// over however much log happens to still be around.
//
// THE GRAIN IS NOT ONE ROW PER CALLER. `fingerprintOf` keys on credential,
// agent, method, tool, sourceIp and userAgent together, so one caller invoking
// two different tools is TWO rows here, not one. That is deliberate — losing
// per-tool visibility would hide a caller who is only entitled to some tools —
// but it means the Stage B question ("does the observed agent set match the
// issued set") is answered by a query that GROUPS BY agent across these rows,
// not by counting rows. `SELECT DISTINCT agent FROM "McpCaller"`, not
// `SELECT agent, count(*) ...`.
//
// It still grows boundedly under traffic: the number of rows is bounded by
// (callers × tools actually used), not by request volume, so a caller hitting
// the same tool a thousand times is still one row.
//
// The per-request trace still goes to the application log on `[mcp-caller]`.
// The two answer different questions: the log gives you the sequence of
// individual calls, this gives you the population. Neither substitutes.
//
// This is also NOT McpAuditLog. That records one row per *tool call*, from
// inside handleToolCall — which is shared with the in-process bridge, so it
// mixes the app's own agents in with HTTP callers, carries no caller identity,
// and never sees `initialize` or `tools/list`. A client that connects but has
// not yet called a tool is invisible to it. That argues for a separate table;
// the aggregation above is what argues for a table rather than a log.
//
// `fingerprint` is a hash of the identifying columns because Postgres treats
// NULLs as distinct in a unique index — keying on the nullable columns directly
// would silently insert a fresh row every request instead of aggregating, which
// would quietly turn this back into a log.
export const mcpCaller = pgTable(
  'McpCaller',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    fingerprint: text().notNull(),
    // 'present' | 'absent' | 'unknown'. `unknown` — a token that does not
    // resolve — is deliberately distinct from `absent`: one is a client that
    // was configured and is now wrong, the other is a client nobody has
    // touched yet. They call for opposite responses.
    credential: text().notNull(),
    agent: text(),
    method: text().notNull(),
    tool: text(),
    sourceIp: text(),
    userAgent: text(),
    firstSeenAt: createdAt(),
    lastSeenAt: createdAt(),
    seenCount: integer().default(1).notNull(),
  },
  (t) => [
    uniqueIndex('McpCaller_fingerprint_key').on(t.fingerprint),
    index('McpCaller_credential_idx').on(t.credential),
    index('McpCaller_lastSeenAt_idx').on(t.lastSeenAt),
  ],
)

export const schema = { setting, secret, space, mcpAuditLog, apiToken, mcpCaller, ...authSchema }

export type Setting = typeof setting.$inferSelect
export type Secret = typeof secret.$inferSelect
export type Space = typeof space.$inferSelect
export type McpAuditLog = typeof mcpAuditLog.$inferSelect
export type ApiToken = typeof apiToken.$inferSelect
export type McpCaller = typeof mcpCaller.$inferSelect

// Better Auth's tables, declared separately because their shape is the
// library's contract rather than ours — re-exported here so drizzle-kit picks
// them up from this one schema entry point and they share the single
// migrations folder.
export * from './auth-schema'
