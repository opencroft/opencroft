import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { authSchema, user } from './auth-schema'

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
  // Bumped on every successful write, and the compare-and-swap token a
  // read-modify-write cycle checks against before committing -- see
  // upsertSettingCas. A plain read-then-write over this row (as extension
  // storage used to do) loses whichever write lands second when two calls
  // interleave.
  version: integer().default(0).notNull(),
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

// A space slug that used to reach this space. Written when a rename moves one.
//
// Same contract as the group-chat aliases further down, and for the same
// reason: a space slug is an address, not a label -- it is in the URL of every
// canvas someone has open or bookmarked, in the active-space setting, and in
// whatever an extension was configured with. A live space outranks an alias,
// and taking a slug live deletes the alias on it, so one address never has two
// answers.
export const spaceSlugAlias = pgTable(
  'SpaceSlugAlias',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    slug: text().notNull(),
    spaceId: text()
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('SpaceSlugAlias_slug_key').on(t.slug), index('SpaceSlugAlias_spaceId_idx').on(t.spaceId)],
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

// One row per (day, agent, model), recomputed in full on every rollup tick —
// not accumulated incrementally — from the agent-container's own Claude Code
// JSONL transcripts (billed-equivalent usage, not ACP context-size events).
// Token counts are bigint: a single agent's cache-read total for one day has
// already been observed in the tens of billions, well past int32 range.
export const usageRollupDay = pgTable(
  'UsageRollupDay',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    day: text().notNull(),
    agent: text().notNull(),
    model: text().notNull(),
    requests: integer().notNull(),
    rawInputTokens: bigint({ mode: 'number' }).notNull(),
    cacheWriteTokens: bigint({ mode: 'number' }).notNull(),
    cacheReadTokens: bigint({ mode: 'number' }).notNull(),
    outputTokens: bigint({ mode: 'number' }).notNull(),
    // Requests whose cache write alone exceeded the cold-re-prime threshold —
    // see usage-rollup's rollup-script for the exact value.
    coldPrimeRequests: integer().notNull(),
    coldPrimeTokens: bigint({ mode: 'number' }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('UsageRollupDay_day_agent_model_key').on(t.day, t.agent, t.model),
    index('UsageRollupDay_day_idx').on(t.day),
  ],
)

// Bearer credentials for the API surfaces. Humans also get cookie sessions;
// this is the credential for everything a cookie cannot reach — agents,
// external MCP clients, and now a signed-in person's own personal tokens.
//
// Only the hash is stored. We only ever look up by a presented value, so there
// is no reason to be able to read a token back — and a table we cannot read
// back is one that leaks nothing if it is dumped.
//
// ONE TABLE, TWO KINDS OF PRINCIPAL, DISCRIMINATED BY `subjectType` — not two
// mechanisms. Two code paths answering "is this bearer valid" is how one of
// them gets a bug the other's tests do not catch.
//
//   'user'   userId is set (references user.id, cascades on delete), agentName
//            is null. Created by someone who is signed in; dies with the
//            account. Personal tokens require an expiry (enforced app-side,
//            not here) — a forgotten one in shell history should stop working
//            on its own.
//
//   'agent'  agentName is set, userId is null. Has to be mintable WITHOUT a
//            session: on a fail-closed deployment there is no session until
//            BETTER_AUTH_SECRET is provisioned and setup is done, so if agent
//            credentials were personal tokens, issuing the first one would
//            need the auth the token exists to bootstrap. No expiry by
//            default — an unattended credential expiring on a date nobody
//            remembers takes out dispatch; rotation is the answer instead.
//
// Several live tokens per subject is deliberate either way. With a single
// credential, rotation means a window where the old token is dead and the new
// one is not yet configured. Many live tokens make rotation
// issue → reconfigure → revoke, with no gap.
export const apiToken = pgTable(
  'ApiToken',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    // 'user' | 'agent' — see the table comment. Not an enum: this is an
    // application-level discriminant, and Postgres enums are painful to widen
    // later if a third kind ever shows up.
    subjectType: text().notNull(),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    agentName: text(),
    // Free text set by whoever creates the token, to tell one of theirs from
    // another when revoking — "laptop", "rotation-2026-08". Never a secret.
    name: text().default('').notNull(),
    tokenHash: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true, mode: 'date' }),
    revokedAt: timestamp({ withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [
    uniqueIndex('ApiToken_tokenHash_key').on(t.tokenHash),
    index('ApiToken_agentName_idx').on(t.agentName),
    index('ApiToken_userId_idx').on(t.userId),
  ],
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

// A topic-scoped container of threads. Holds no messages of
// its own — a thread is where a conversation actually happens, bound to an
// ACP session exactly the way a 1:1 agent chat is. This table is the
// container and its membership; a group chat's own row carries only the
// topic, not any conversation content.
//
// createdByUserId is provenance, not ownership: it is nullable with
// onDelete 'set null' rather than 'cascade' on purpose. A group chat's
// lifetime belongs to its membership (GroupChatMember.userId keeps
// 'cascade' — that column genuinely means "this person is no longer a
// member"), not to whoever happened to create it. Deleting the creator
// must not delete a chat every other member still uses.
// `name` and `topic` are two different audiences, which is why they are two
// columns and not one.
//
//   name   what PEOPLE read — lists, headers, the sidebar. Pure presentation:
//          renaming reaches every screen at once and no agent ever sees it.
//   topic  what AGENTS read — it is composed into a thread's session-init
//          context when that thread is created (see the model module). So
//          editing it changes what the NEXT thread is told, and changes
//          nothing for sessions already open, which keep the context they
//          were opened with.
//
// They start out equal (creation asks for one string and seeds both) and
// diverge only when someone edits one of them. Both are notNull: a chat with
// no name has nothing to render, and a chat with no topic would hand an agent
// an empty statement of purpose, which reads worse than a redundant one.
export const groupChat = pgTable(
  'GroupChat',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    // The readable half of every session key this chat's threads are opened
    // under, derived from `name` when the chat is created and MOVED when the
    // chat is renamed.
    //
    // It moves because it is an ADDRESS rather than a label — extension
    // surfaces and agents both reach a chat by it, so a slug left behind meant a
    // chat answering to something it was no longer called. It was immutable for
    // the opposite reason, that a key which changes stops finding its session;
    // renaming now migrates every key derived from it, and records the freed
    // slug in `GroupChatSlugAlias` so references already written down still land
    // here. The model module holds the ordering that makes a half-finished move
    // harmless.
    slug: text().notNull(),
    name: text().notNull(),
    topic: text().notNull(),
    createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('GroupChat_slug_key').on(t.slug)],
)

// One row per member, agent or user. ONE TABLE, TWO KINDS OF PRINCIPAL,
// DISCRIMINATED BY `principalType` — the same shape `ApiToken` already uses
// for exactly the same reason: two membership-check code paths is how one of
// them gets a bug the other's tests do not catch.
//
//   'user'  userId is set (references user.id, cascades on delete),
//           agentNodeId is null.
//   'agent' agentNodeId is set (a graph node id, validated against
//           listAgentNodes() at write time — see the model module), userId is
//           null. Not a foreign key: agent nodes live in the space graph's own
//           JSON, not a relational table this schema can reference.
//
// Consistency between principalType and which id column is set is enforced
// application-side, not by a CHECK constraint — the same choice already made
// for ApiToken's subjectType/userId/agentName triple, so this does not
// introduce a stricter pattern than the one beside it.
//
// The two unique indexes below rely on Postgres treating NULL as distinct
// from every other NULL: the (groupChatId, userId) index only ever collides
// for two rows that are BOTH real users with the same id, because every
// agent row's userId is NULL and NULLs never equal each other. The
// (groupChatId, agentNodeId) index works the same way in the other
// direction. Each index constrains exactly the principal kind it names and
// is silently inert for the other kind — which is what makes two indexes
// sufficient without a partial-index syntax.
export const groupChatMember = pgTable(
  'GroupChatMember',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    groupChatId: text()
      .notNull()
      .references(() => groupChat.id, { onDelete: 'cascade' }),
    principalType: text().notNull(),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    agentNodeId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('GroupChatMember_groupChatId_userId_key').on(t.groupChatId, t.userId),
    uniqueIndex('GroupChatMember_groupChatId_agentNodeId_key').on(t.groupChatId, t.agentNodeId),
    index('GroupChatMember_groupChatId_idx').on(t.groupChatId),
    index('GroupChatMember_userId_idx').on(t.userId),
    index('GroupChatMember_agentNodeId_idx').on(t.agentNodeId),
  ],
)

// A pinned note on a group chat: standing guidance every thread's agent is
// told, kept apart from the topic because a topic is one statement of purpose
// and these are a list that changes.
//
// `position` orders them and is assigned at insert (max + 1). It is an integer
// rather than a fractional rank because nothing reorders pins today; when
// something does, that is the moment to decide between renumbering and a rank
// scheme, and guessing now would bake in whichever guess was wrong.
//
// No cap in the schema. The limit exists to keep what is injected into an
// agent's context bounded, which is a rule about delivery, and it is enforced
// where the refusal can be explained to the person adding one.
export const groupChatPin = pgTable(
  'GroupChatPin',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    groupChatId: text()
      .notNull()
      .references(() => groupChat.id, { onDelete: 'cascade' }),
    text: text().notNull(),
    position: integer().notNull(),
    // Provenance, not ownership — same reasoning as GroupChat.createdByUserId.
    // Any member may edit or unpin any pin, so who wrote it decides nothing.
    createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('GroupChatPin_groupChatId_idx').on(t.groupChatId)],
)

// A thread: one agent, fixed at creation, bound to the same kind of ACP
// session a 1:1 agent chat uses. `sessionKey` is that session's tabKey —
// globally unique the same way the existing chat registry's session keys are,
// and namespaced (`group-chat:<chat-slug>:<agent-slug>:<thread-slug>`, minted
// in the model module) so it can never collide with a 1:1 chat's key. Threads
// created before slugs existed carry ids in those three positions instead and
// keep working: nothing derives them, so no rename can stale them.
//
// THE KEY MOVES when the chat or the thread is renamed, since two of its
// segments are slugs that move. That is a migration rather than an update —
// everything filed under the key travels with it — and the model module is
// where the ordering that makes it safe is written down.
//
// No message content lives here either — the ACP session (agentClient's own
// history, resumable via session/load) is still the one place a
// conversation's turns are stored, exactly as for today's agent chat. This
// row is the durable binding a membership check can be run against before
// that session is ever touched.
export const groupChatThread = pgTable(
  'GroupChatThread',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    groupChatId: text()
      .notNull()
      .references(() => groupChat.id, { onDelete: 'cascade' }),
    agentNodeId: text().notNull(),
    sessionKey: text().notNull(),
    // The readable last segment of this thread's session key: a short hash for
    // an ad-hoc thread, or the slugified title when one was given.
    //
    // NULLABLE because threads created before slugs existed have none, and
    // their uuid keys keep resolving — nothing has ever parsed a group-chat
    // key, so an old key works for the same reason it always did. The unique
    // index below relies on Postgres treating NULLs as distinct, so any number
    // of legacy rows coexist without colliding.
    slug: text(),
    title: text(),
    // A signature of the STANDING CONTEXT this thread's agent was last told --
    // the chat's topic and its pins together, because they are one block from
    // the agent's point of view and either changing is a change worth
    // re-delivering. See the model module for how it is computed.
    //
    // NULL means "nothing has been delivered into this thread yet", which is
    // deliberately distinct from the signature of an empty pin set: a thread
    // that has never carried context and one whose pins were all removed are
    // different states, and only the second has something to say.
    //
    // This lives on the thread rather than in a join table because the
    // question it answers is per-thread and single-valued -- "is what this
    // agent holds still current?" -- and a table would store one row per
    // thread to answer it.
    deliveredContextSignature: text(),
    // Unsent composer text for this thread, persisted so it survives
    // navigating away, switching threads, and a page reload — the same
    // draft mechanism SessionEntry.draft gives the 1:1 chat, kept per-thread
    // here rather than in that settings-row list, since a thread is not a
    // chat tab and does not belong in that registry.
    draft: text(),
    // Provenance, not ownership — same reasoning as GroupChat.createdByUserId
    // above. Deleting the user who started a thread must not delete the
    // binding row while the ACP session it points at keeps existing.
    createdByUserId: text().references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('GroupChatThread_sessionKey_key').on(t.sessionKey),
    // Scoped to (chat, agent) because that is the key path: two threads with
    // the same agent in the same chat would mint the same session key.
    uniqueIndex('GroupChatThread_groupChatId_agentNodeId_slug_key').on(t.groupChatId, t.agentNodeId, t.slug),
    index('GroupChatThread_groupChatId_idx').on(t.groupChatId),
    index('GroupChatThread_agentNodeId_idx').on(t.agentNodeId),
  ],
)

// ── Freed addresses ──────────────────────────────────────────────────────
//
// Renaming moves a slug, and a slug is an ADDRESS: it is embedded in session
// keys, written into extension configuration, and stored by agents that were
// told where to write. The two tables below are what keeps every one of those
// references working after the thing they name has moved — they record the
// address a rename freed, pointing at whatever now answers to it.
//
// THE ONE RULE THEY BOTH OBEY: a live binding outranks an alias, always. Every
// lookup tries the real row first, and taking an address live DELETES the alias
// on it, so the two never both claim one address. That ordering is not a
// preference — an alias that outranked a real row is the one failure a
// membership check cannot catch, because it delivers to the wrong recipient
// while every gate passes.
//
// Nothing here is presentation. A row exists only because an address moved, and
// it disappears when the thing it points at is deleted (cascade) or when
// something takes the address back.

// A group-chat slug that used to reach this chat.
export const groupChatSlugAlias = pgTable(
  'GroupChatSlugAlias',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    // Unique across the whole table for the same reason GroupChat.slug is:
    // together they form ONE address space, and an address that resolved two
    // ways would have to pick one.
    slug: text().notNull(),
    groupChatId: text()
      .notNull()
      .references(() => groupChat.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('GroupChatSlugAlias_slug_key').on(t.slug),
    index('GroupChatSlugAlias_groupChatId_idx').on(t.groupChatId),
  ],
)

// An address that used to reach this thread. One row per rename that moved one,
// so a thread renamed twice keeps both of its former addresses working.
//
// TWO ADDRESSES, TWO NULLABLE COLUMNS, because a thread is addressed two ways
// and a rename does not always free both:
//
//   sessionKey            the whole readable address a send names. Freed when
//                         EITHER the chat or the thread is renamed, since the
//                         chat's slug is a segment of it.
//   (chat, agent, slug)   the thread slug an embedded surface names, scoped the
//                         way the live unique index is. Freed only by a THREAD
//                         rename — a chat rename leaves every thread slug where
//                         it was.
//
// Each column is NULL when that dimension did not move: a chat rename writes a
// row with no `slug`, and a thread whose key was never derived from its slug
// writes one with no `sessionKey`. NULL is the statement that nothing was freed
// there, and Postgres treating NULLs as distinct in a unique index — the same
// property GroupChatThread.slug and GroupChatMember already rely on — is what
// lets any number of such rows coexist without colliding with each other or
// with the live binding they still share the other half of. A row with both
// NULL would say nothing and is never written.
//
// `groupChatId`/`agentNodeId` are copied from the thread rather than joined for
// that second index's sake, and copying them is safe precisely because neither
// can ever change: a thread's agent is fixed at creation and a thread never
// moves between chats.
export const groupChatThreadAlias = pgTable(
  'GroupChatThreadAlias',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    threadId: text()
      .notNull()
      .references(() => groupChatThread.id, { onDelete: 'cascade' }),
    groupChatId: text()
      .notNull()
      .references(() => groupChat.id, { onDelete: 'cascade' }),
    agentNodeId: text().notNull(),
    sessionKey: text(),
    slug: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('GroupChatThreadAlias_sessionKey_key').on(t.sessionKey),
    uniqueIndex('GroupChatThreadAlias_groupChatId_agentNodeId_slug_key').on(t.groupChatId, t.agentNodeId, t.slug),
    index('GroupChatThreadAlias_threadId_idx').on(t.threadId),
  ],
)

// A note an agent leaves on a thread after doing work, and revises on a later
// iteration. Markdown, rendered the same way the conversation's own messages
// are — an artifact is the agent still talking about work it just did.
//
// Thread-scoped rather than chat-scoped, and that is the distinction from
// GroupChatPin above: a pin is standing guidance a PERSON writes and every
// thread's agent is told, delivered into context. An artifact is output an
// AGENT writes about one thread's work, and is never delivered anywhere — it is
// read by whoever opens it. The two look alike (both are notes on a group chat)
// and behave oppositely, which is why they are separate tables rather than one
// with a `kind`.
//
// No author column: a thread has exactly one agent, fixed at creation, so the
// author is already recorded by the thread this row belongs to. Storing it
// again would be a second answer to the same question, free to disagree.
//
// `updatedAt` is the whole point of the edit path — an artifact revised on a
// later iteration is the same note, not a new one, and the reader is shown when
// it last changed.
export const groupChatThreadArtifact = pgTable(
  'GroupChatThreadArtifact',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    threadId: text()
      .notNull()
      .references(() => groupChatThread.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    content: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('GroupChatThreadArtifact_threadId_idx').on(t.threadId)],
)

export const schema = {
  setting,
  secret,
  space,
  spaceSlugAlias,
  mcpAuditLog,
  apiToken,
  mcpCaller,
  groupChat,
  groupChatMember,
  groupChatPin,
  groupChatSlugAlias,
  groupChatThread,
  groupChatThreadAlias,
  groupChatThreadArtifact,
  usageRollupDay,
  ...authSchema,
}

export type Setting = typeof setting.$inferSelect
export type Secret = typeof secret.$inferSelect
export type Space = typeof space.$inferSelect
export type SpaceSlugAlias = typeof spaceSlugAlias.$inferSelect
export type McpAuditLog = typeof mcpAuditLog.$inferSelect
export type ApiToken = typeof apiToken.$inferSelect
export type McpCaller = typeof mcpCaller.$inferSelect
export type GroupChat = typeof groupChat.$inferSelect
export type GroupChatPin = typeof groupChatPin.$inferSelect
export type GroupChatMember = typeof groupChatMember.$inferSelect
export type GroupChatThread = typeof groupChatThread.$inferSelect
export type GroupChatSlugAlias = typeof groupChatSlugAlias.$inferSelect
export type GroupChatThreadAlias = typeof groupChatThreadAlias.$inferSelect
export type UsageRollupDay = typeof usageRollupDay.$inferSelect

// Better Auth's tables, declared separately because their shape is the
// library's contract rather than ours — re-exported here so drizzle-kit picks
// them up from this one schema entry point and they share the single
// migrations folder.
export * from './auth-schema'
