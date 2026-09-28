import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

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
    /** LEGACY: the graph this space held before graphs became rows of their
     *  own (see spaceGraph). Read once by the one-time migration that turns
     *  it into the space's default graph, never written after -- whatever it
     *  still holds is inert. */
    data: text().default('{"nodes":[],"edges":[]}').notNull(),
    /** Which of this space's graphs a bare `<space>` address resolves to. */
    defaultGraphSlug: text().default('default').notNull(),
    pinned: boolean().default(false).notNull(),
    /** Small square image as a base64 data URL, like `user.image`; null = no icon. */
    icon: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('Space_slug_key').on(t.slug)],
)

// A space slug that used to reach this space. Written when a rename moves one.
//
// Same contract as the group-chat aliases further down, and for the same
// reason: a space slug is an address, not a label -- it is in the URL of every
// canvas someone has open or bookmarked, in agents' tool calls, and in
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

// An instance of an App (provided by an extension) the user added to a space,
// with the parameter values they entered. The row id is the instance identity:
// the same App can be added to a space several times with different params.
//
// Every instance carries a NAME (required, human-facing) and a SLUG derived
// from it once, at creation -- the instance's public address within its
// space, unique there, in the same grammar graphs use: <space>.<slug>.
// RENAMING MOVES THE SLUG, so an instance's address follows its label and
// previously saved or shared links stop resolving. This reverses the rule
// this comment used to state -- "an address outlives its label" -- and the
// reversal was the maintainer's, made deliberately with that
// consequence put to him. It is not to be softened into an alias table or a
// redirect: a slug that no longer resolves does exactly what a nonexistent
// uuid does. A rename onto a taken slug is refused outright, changing
// nothing, not even the name. A transfer may re-slug on collision in the target
// space, through the same resolution graphs established.
export const spaceApp = pgTable(
  'SpaceApp',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    spaceId: text()
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    extensionId: text().notNull(),
    appSlug: text().notNull(),
    name: text().default('').notNull(),
    slug: text().default('').notNull(),
    /** JSON object: parameter id -> value the user entered. */
    params: text().default('{}').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('SpaceApp_spaceId_idx').on(t.spaceId), uniqueIndex('SpaceApp_spaceId_slug_key').on(t.spaceId, t.slug)],
)

// A graph within a space -- the nodes and edges one canvas draws. Every graph
// is owned by exactly one Graph App instance (the host-registered app): the
// instance is the door to it in the UI and the owner of its lifecycle, so the
// row dies with the instance -- through the app's own hooks, DELIBERATELY not
// through an FK cascade on instanceId. A cascade would delete graph data
// underneath the in-memory registry whenever an instance row went away with
// its onRemoved hook having failed, and a silent deletion is worse than an
// orphaned row someone can still read.
//
// Addressed as `<space-slug>.<slug>`; a bare space slug resolves to the
// space's defaultGraphSlug. The slug is fixed at creation (no aliases, unlike
// spaces): it is an address, and a graph's display name can change without
// moving it.
export const spaceGraph = pgTable(
  'SpaceGraph',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    spaceId: text()
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    instanceId: text().notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    /** JSON: `{"nodes":[...],"edges":[...]}` -- same shape space.data held. */
    data: text().default('{"nodes":[],"edges":[]}').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('SpaceGraph_spaceId_slug_key').on(t.spaceId, t.slug),
    uniqueIndex('SpaceGraph_instanceId_key').on(t.instanceId),
    index('SpaceGraph_spaceId_idx').on(t.spaceId),
  ],
)

// One row per finished agent-chat turn that reported a token spend, written
// by the app from the turn's PromptResponse usage (see
// agent-client's turn_end event). APPEND-ONLY, and deliberately a table of
// its own rather than rows in UsageRollupDay: that table is recomputed in
// full from agent-container transcripts on every rollup tick, so a chat row
// written there would be one un-recomputeable outsider in a recompute model,
// with different provenance (a turn aggregates several API requests, and the
// per-model rows can exceed the main-loop figure). Aggregation is a plain
// group-by over these rows at read time — one day, one harness, one model.
//
// Token counts are bigint for the same reason UsageRollupDay's are: cache
// reads across a day dwarf int32. `model` is nullable because not every
// harness names the model it ran; those rows aggregate under null.
export const chatUsageTurn = pgTable(
  'ChatUsageTurn',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    // UTC date of the turn's end, 'YYYY-MM-DD' — the same bucketing key
    // UsageRollupDay uses, so the two tables answer with one vocabulary.
    day: text().notNull(),
    sessionId: text().notNull(),
    // The session's key, when it has one: what a group-chat thread is bound to.
    // A reopened session can be a new id, so the id alone cannot gather a
    // thread's turns; the key outlives it, as it does for the transcript and
    // the queue. Null for turns recorded before the column existed and for a
    // session with no key.
    sessionKey: text(),
    adapterId: text().notNull(),
    model: text(),
    // The group-chat agent this turn ran under, from the session key's
    // `agentSlug` segment (see partsOfSessionKey) — null for a 1:1 chat
    // session, whose key names no agent. Enables grouping usage by agent
    // without re-deriving it from sessionId at read time.
    agent: text(),
    inputTokens: bigint({ mode: 'number' }).notNull(),
    outputTokens: bigint({ mode: 'number' }).notNull(),
    cacheReadTokens: bigint({ mode: 'number' }).notNull(),
    cacheWriteTokens: bigint({ mode: 'number' }).notNull(),
    totalTokens: bigint({ mode: 'number' }).notNull(),
    // This turn's OWN spend — the increment agent-client's turn_end event
    // carries, already differenced from the harness's cumulative session
    // reading (see SessionCost on ChatEvent). NOT cumulative: summing this
    // column across a session's turns reproduces the session total, which is
    // what makes a plain per-bucket SUM at read time correct.
    costAmount: doublePrecision(),
    costCurrency: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ChatUsageTurn_day_idx').on(t.day),
    index('ChatUsageTurn_sessionId_idx').on(t.sessionId),
    index('ChatUsageTurn_sessionKey_idx').on(t.sessionKey),
  ],
)

// The per-model breakdown behind one ChatUsageTurn row, from the harness's
// `_meta.quota.modelUsage` (see TurnQuota) when it reports one. A claude
// turn's breakdown counts subagents and internal calls the main-loop figure
// on ChatUsageTurn excludes, so THIS table -- not the turn row -- is where
// grouping by model reads its counters (see queryChatUsage). No day/agent/
// cost columns: those are the turn's own and are reached by joining to it —
// the agent of every model row IS its turn's agent, by construction.
//
// Always at least one row per recorded turn, even with no breakdown: the
// write path synthesizes a single row from the turn's own usage and resolved
// model, so a read never needs a fallback branch for "no model rows yet".
// CASCADE on the turn: a model row has no meaning once its turn is gone.
export const chatUsageTurnModel = pgTable(
  'ChatUsageTurnModel',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    turnId: text()
      .notNull()
      .references(() => chatUsageTurn.id, { onDelete: 'cascade' }),
    model: text(),
    inputTokens: bigint({ mode: 'number' }).notNull(),
    outputTokens: bigint({ mode: 'number' }).notNull(),
    cacheReadTokens: bigint({ mode: 'number' }).notNull(),
    cacheWriteTokens: bigint({ mode: 'number' }).notNull(),
    totalTokens: bigint({ mode: 'number' }).notNull(),
  },
  (t) => [index('ChatUsageTurnModel_turnId_idx').on(t.turnId)],
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

// A signed-in person's own bearer credentials — the personal access tokens of
// the account screen. Created by someone who is signed in and dies with the
// account. Personal tokens require an expiry (enforced app-side, not here) — a
// forgotten one in shell history should stop working on its own.
//
// Agents do NOT hold these. An agent's credential is an McpToken, a separate
// kind with its own table: it identifies an agent node on the MCP endpoint and
// nowhere else, while this one identifies a person and never opens the MCP
// endpoint. Two tables rather than a discriminant, because the two are refused
// by each other's surface — a lookup that can only ever find one kind cannot
// be tricked into accepting the other.
//
// Only the hash is stored. We only ever look up by a presented value, so there
// is no reason to be able to read a token back — and a table we cannot read
// back is one that leaks nothing if it is dumped.
//
// Several live tokens per person is deliberate. With a single credential,
// rotation means a window where the old token is dead and the new one is not
// yet configured. Many live tokens make rotation issue → reconfigure → revoke,
// with no gap.
export const apiToken = pgTable(
  'ApiToken',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // Free text set by whoever creates the token, to tell one of theirs from
    // another when revoking — "laptop", "rotation-2026-08". Never a secret.
    name: text().default('').notNull(),
    tokenHash: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true, mode: 'date' }),
    revokedAt: timestamp({ withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('ApiToken_tokenHash_key').on(t.tokenHash), index('ApiToken_userId_idx').on(t.userId)],
)

// An agent's credential on the MCP endpoint, and the only credential that
// endpoint accepts. Each one names the agent NODE it speaks for — by id, not by
// display name, because a name is free text two nodes can share and a rename
// would otherwise move a live credential onto whichever agent took the name.
//
// `agentNodeId` is not a foreign key: an agent is a node in a space graph's
// JSON with no relational row, the same reason it is not one on `Username`.
// A token whose node is gone resolves to nobody and is refused at the endpoint.
//
// Created from the agent node's own settings by a signed-in person; never
// mintable over MCP, so an agent cannot issue itself a second identity.
// `expiresAt` null means the person creating it chose "never" — unlike a
// personal token, where a missing expiry is not an option. Revoking deletes the
// row: there is no revoked state to keep, because a revoked credential answers
// exactly like one that never existed.
//
// Only the hash is stored, for the reason on ApiToken above, and many live
// tokens per agent is deliberate for the same rotation reason.
export const mcpToken = pgTable(
  'McpToken',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    agentNodeId: text().notNull(),
    // Free text, to tell one of an agent's tokens from another when deleting
    // one — "laptop client", "ci". Never a secret.
    name: text().notNull(),
    tokenHash: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp({ withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [uniqueIndex('McpToken_tokenHash_key').on(t.tokenHash), index('McpToken_agentNodeId_idx').on(t.agentNodeId)],
)

// Every username ever held, by either kind of account. ONE TABLE, TWO KINDS
// OF PRINCIPAL, DISCRIMINATED BY `principalType` — the same shape
// `GroupChatMember` already uses, and for the same reason.
//
// A username identifies an account. It is not a name and not a credential:
// the display name stays editable and non-unique, the email stays the login.
// Its grammar and the reserved `agent.` prefix live in the app's own username
// module, which is the single place that rule is written down; this table
// stores the result and enforces the two things a string cannot enforce about
// itself — that it is unique, and that it is never reissued.
//
// ONE TABLE RATHER THAN A COLUMN ON EACH KIND OF ACCOUNT. A person is a row
// in `user`; an agent is a node in a space graph's JSON with no relational
// row at all. A column on each could not be indexed against the other, so
// "one identifier space" would be a convention enforced by whichever code
// path remembered — which is exactly what the reserved prefix exists to avoid
// relying on. `agentNodeId` is not a foreign key for the same reason it is
// not one on `GroupChatMember`.
//
// ROWS ARE NEVER DELETED, ONLY RETIRED. A row with `retiredAt` set is a
// username the account used to hold: it still resolves to that same account,
// so a reference already written into a transcript still lands on whoever
// wrote it, and it can never be taken by anybody else, because the unique
// index below covers retired rows too. Reissuing a freed handle would make an
// old message's author silently become a different account, which is the
// failure the whole identifier split exists to prevent.
export const username = pgTable(
  'Username',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    username: text().notNull(),
    // 'user' | 'agent' — see the table comment. Not an enum, matching the
    // choice already made for GroupChatMember.principalType.
    principalType: text().notNull(),
    userId: text().references(() => user.id, { onDelete: 'cascade' }),
    agentNodeId: text(),
    // Null while this is the account's current handle. Set when it is
    // replaced, and never cleared.
    retiredAt: timestamp({ withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    // Across BOTH kinds and BOTH states. This single index is what makes the
    // two identity spaces incapable of colliding and a freed handle
    // incapable of being reissued.
    uniqueIndex('Username_username_key').on(t.username),
    // One CURRENT username per account, and the two mechanisms below split the
    // job rather than one replacing the other.
    //
    // NULL-distinctness does the same half it does on the membership tables:
    // an agent row's `userId` is null and a person row's `agentNodeId` is
    // null, so each index constrains exactly the principal kind it names and
    // is silently inert for the other.
    //
    // The PARTIAL predicate — the first in this schema, checked 2026-08-26 —
    // does the half that trick cannot. Retired rows must repeat a principal
    // freely, and `retiredAt` being nullable would make every current row
    // distinct from every other rather than colliding, which is the opposite
    // of what is wanted. Restricting the index to live rows is what turns
    // "one per account" into something the database enforces.
    uniqueIndex('Username_current_userId_key').on(t.userId).where(sql`${t.retiredAt} is null`),
    uniqueIndex('Username_current_agentNodeId_key').on(t.agentNodeId).where(sql`${t.retiredAt} is null`),
    index('Username_userId_idx').on(t.userId),
    index('Username_agentNodeId_idx').on(t.agentNodeId),
  ],
)

// DISTINCT (caller, method, tool) COMBINATIONS SEEN ON THE MCP ENDPOINT,
// maintained by the database.
//
// This is not a log with a schema bolted on, and that distinction is the reason
// it is a table at all. "Which clients reach this endpoint, and which of them
// are being refused" is a population question — this stores the material for
// that answer directly, rather than making it a grep over however much log
// happens to still be around. Refused requests are recorded too: a client
// that was configured and has since gone wrong (an expired or deleted token)
// is otherwise visible only in that client's own error.
//
// THE GRAIN IS NOT ONE ROW PER CALLER. `fingerprintOf` keys on credential,
// agent node, method, tool, sourceIp and userAgent together, so one caller
// invoking two different tools is TWO rows here, not one. That is deliberate —
// losing per-tool visibility would hide a caller who is only entitled to some
// tools — but it means "which agents call in" is a query that GROUPS BY
// agentNodeId across these rows, not a count of rows.
//
// `agent` is the node's name as it read when the row was first written, kept
// for a person reading the table; `agentNodeId` is the identity. A renamed
// agent keeps aggregating onto its existing rows under the old name.
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
    agentNodeId: text(),
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

// One row per member. ONE TABLE, THREE KINDS OF PRINCIPAL, DISCRIMINATED BY
// `principalType` — the same shape `ApiToken` already uses for exactly the
// same reason: two membership-check code paths is how one of them gets a bug
// the other's tests do not catch.
//
//   'user'   userId is set (references user.id, cascades on delete); the other
//            id columns are null.
//   'agent'  agentNodeId is set (a graph node id, validated against
//            listAgentNodes() at write time — see the model module). Not a
//            foreign key: agent nodes live in the space graph's own JSON, not
//            a relational table this schema can reference.
//   'system' systemId is set — a reserved `system.`-prefixed sender identifier
//            (validated against isSystemUsername at write time). This is what
//            authorizes an automated pipeline (a schedule's script, the forge
//            webhook) to deliver into a chat's threads: the grant is a ROW,
//            explicit, per-chat, listable and revocable, never a code-side
//            exemption for the prefix — an allow-list in code is invisible in
//            the members panel and unrevocable without a deploy, which is how
//            an automated sender's authority goes unaccounted.
//
// Consistency between principalType and which id column is set is enforced
// application-side, not by a CHECK constraint — the same choice made for
// Username's principalType, so this does not introduce a stricter pattern than
// the one beside it.
//
// The per-kind unique indexes below rely on Postgres treating NULL as distinct
// from every other NULL: the (groupChatId, userId) index only ever collides
// for two rows that are BOTH real users with the same id, because every
// other kind's userId is NULL and NULLs never equal each other. The
// (groupChatId, agentNodeId) and (groupChatId, systemId) indexes work the
// same way for their kinds. Each index constrains exactly the principal kind
// it names and is silently inert for the others — which is what makes one
// index per kind sufficient without a partial-index syntax.
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
    systemId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('GroupChatMember_groupChatId_userId_key').on(t.groupChatId, t.userId),
    uniqueIndex('GroupChatMember_groupChatId_agentNodeId_key').on(t.groupChatId, t.agentNodeId),
    uniqueIndex('GroupChatMember_groupChatId_systemId_key').on(t.groupChatId, t.systemId),
    index('GroupChatMember_groupChatId_idx').on(t.groupChatId),
    index('GroupChatMember_userId_idx').on(t.userId),
    index('GroupChatMember_agentNodeId_idx').on(t.agentNodeId),
    index('GroupChatMember_systemId_idx').on(t.systemId),
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
    // The agent node that started this thread, when an agent did. Exactly one
    // of this and createdByUserId is set for a thread created after this
    // column existed: a person starts a thread through the composer, an agent
    // through its own tool surface, and there is no path where both apply.
    //
    // Unlike createdByUserId this one is provenance AND a permission input:
    // thread deletion from the tool surface admits the agent that started the
    // thread as well as the agent it is addressed to. So it is a plain text
    // column with no reference — an agent lives in the graph, not in this
    // database, so there is no row to point at and nothing to cascade from.
    //
    // NULL means "not known to have been created by an agent", which covers
    // every row that predates this column as well as every person-created
    // thread. Those two are not distinguished and do not need to be: neither
    // grants anyone deletion rights, and the addressed agent can still delete
    // its own thread. A backfill is impossible rather than skipped — nothing
    // anywhere recorded which agent started a thread before this.
    createdByAgentNodeId: text(),
    // The system sender that started this thread, when one did — an
    // extension's own identity, `system.ext.<extension id, dotted>`. Provenance
    // like the two columns above, and what lets an extension read the usage of
    // the threads it opened and of no others (groupChats.usage). NULL for every
    // thread a person or an agent started, and for every row before this column.
    createdBySystemId: text(),
    // When the thread was archived; NULL while it is active. An archived thread
    // keeps its row, its session and its history, leaves the chat's active
    // thread list for the archive list, and refuses every send until it is
    // unarchived. A timestamp rather than a flag because "since when" is the
    // one thing an archive is asked about beyond "is it".
    archivedAt: timestamp({ withTimezone: true, mode: 'date' }),
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

// A prompt an agent session is holding but has not been given yet.
//
// The queue itself lives in memory and is served from there; this is a
// write-behind copy, so nothing here sits on the path a message takes to an
// agent. It exists because a reading cadence stretches how long a message can
// wait from seconds to a day, and a restart in between used to lose everything
// held.
//
// Addressed by SESSION KEY rather than session id: a restart mints a new id, so
// rows keyed by one would name nothing that could ever load or delete them.
//
// `kind` is a real column rather than something inferred from `sender` being
// null. The queue genuinely holds two kinds of entry -- a message somebody
// sent, and a command the application issued on its own behalf -- and the two
// leave differently: messages batch together and wait for the reading window, a
// command is delivered alone and immediately. Restoring messages only would
// turn a held [message, command, message] into one merged batch and drop the
// command, which is a request somebody made being silently forgotten.
//
// `sender` and `sentAt` are null for a 'system' entry, which has neither an
// author nor a meaningful send time — and for a row that is a MARK rather than
// an entry (see `removedAt`), which never carried either. An entry row is the
// one with `removedAt` null, so that is the column to read for "is this a
// queued thing", never the presence of a sender.
//
// `position` orders the queue explicitly rather than ordering by `sentAt`: a
// system row has no send time, and corrective guidance after a rejected
// permission is inserted at the FRONT, so arrival order is not queue order.
// Appends take max+1 and front-inserts min-1, which keeps both O(1) and never
// rewrites the rows already there -- the write amplification a table was chosen
// over a settings blob to avoid.
export const agentQueueEntry = pgTable(
  'AgentQueueEntry',
  {
    // The engine's own entry id, so a delivery forgets exactly what it took.
    // Also what makes forgetting idempotent: the mark and the record of an
    // entry are the same row, found by the same id, in either order.
    id: text().primaryKey().notNull(),
    sessionKey: text().notNull(),
    kind: text().notNull(),
    sender: text(),
    text: text().notNull(),
    sentAt: timestamp({ withTimezone: true, mode: 'date' }),
    position: integer().notNull(),
    createdAt: createdAt(),
    // Set when the entry left the queue — delivered, or taken back by its
    // sender. NULL means still waiting. A row is marked rather than deleted so
    // that the two writes an entry's lifetime consists of commute: whichever
    // of "record it" and "forget it" reaches the database last, a forgotten
    // entry stays forgotten and can never be restored. Marked rows are skipped
    // on load and erased by a sweep once they are old enough that no late
    // write could still name them.
    removedAt: timestamp({ withTimezone: true, mode: 'date' }),
    // What the entry carries beside its text -- references to pictures in
    // ChatAttachment, as the engine's DeliveredAttachment list. Held with the
    // entry because a message that waits must keep its pictures exactly as one
    // that goes straight through does. NULL for an entry carrying none.
    attachments: jsonb(),
  },
  (t) => [index('AgentQueueEntry_sessionKey_position_idx').on(t.sessionKey, t.position)],
)

// One event of an agent session's transcript, as the chat showed it.
//
// The transcript a reader sees is rebuilt from the agent's own history when a
// session is reopened, and that replay is only as complete as the harness's
// persisted transcript happens to be — a delegation to a subagent, for
// instance, is stored by the Claude CLI in a separate file the replay never
// reads, so it comes back with the delegation missing and nothing marking the
// hole. This table is the transcript we know is right, because it is a
// recording of what was actually emitted, taken as it was emitted.
//
// Addressed by SESSION KEY for the same reason the queue is: a reopened
// session can be a new id, so rows filed under one would name nothing that
// could ever load them.
//
// `position` is assigned by the writer rather than derived from a timestamp:
// events within one streaming turn land in the same millisecond by the dozen,
// and their ORDER is the whole content of a transcript. It is also what the cap
// is applied along -- a session left running for weeks would otherwise grow
// this table without bound, so the oldest rows past the cap are dropped as new
// ones arrive.
//
// The event itself is stored as JSON rather than in columns per kind. It is
// read back only by the engine that wrote it, straight into the same union it
// left as, and nothing queries INSIDE an event -- a schema here would be a
// second definition of a shape that already has one, kept in step by hand.
export const agentSessionEvent = pgTable(
  'AgentSessionEvent',
  {
    sessionKey: text().notNull(),
    position: integer().notNull(),
    event: jsonb().notNull(),
    createdAt: createdAt(),
  },
  // The pair is the identity, which makes an append idempotent: a retried
  // write cannot land the same event at the same position twice.
  (t) => [primaryKey({ columns: [t.sessionKey, t.position] })],
)

// One image a reader attached to a message.
//
// ADDRESSED BY SESSION KEY, like the queue and the transcript and for the same
// reason: a reopened session can be a new id, so rows filed under one would
// name nothing that could ever load them. For bytes the second half of that
// matters more than the first — nothing that could ever DELETE them either,
// and an orphaned picture is a leak rather than a missing chip.
//
// The reference a message carries is this row's id, in a tag inside the
// message text (see attachments.ts in agent-client). It has to be in the text:
// a message held by a cadence is one text column, and the transcript is
// rebuilt from the text it delivered.
//
// BASE64 IN A TEXT COLUMN, NOT `bytea`, and deliberately the simple thing:
// drizzle carries no bytea column type, so it would be this schema's first
// hand-written customType, and the backup path serialises every row to JSON,
// where bytes become base64 anyway — two representations of one payload, kept
// in step by hand. This is expected to be replaced once images are large or
// numerous; when it is, this column becomes a key into real storage and
// nothing else in the design moves, because what a message carries is already
// an id and not a payload.
export const chatAttachment = pgTable(
  'ChatAttachment',
  {
    id: text().primaryKey().notNull().$defaultFn(uuid),
    sessionKey: text().notNull(),
    // What the chip says, and what names the file to a harness that cannot
    // take the image itself.
    name: text().notNull(),
    mimeType: text().notNull(),
    /** Base64 with no `data:` prefix — what ACP's image block carries. */
    data: text().notNull(),
    // The decoded size, so a reader and a limit can both be told the truth
    // about the picture without decoding the column to find out.
    byteSize: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ChatAttachment_sessionKey_idx').on(t.sessionKey)],
)

// Work a tool or an action started for a caller and did not wait for: a
// handler nobody awaits, or — for a tool that opted into the background task
// runner — a command left running on a node. What is running, and the handles
// that can stop it, live in the process and die with it; this is the part that
// outlives a restart — what was started, where and for whom, how it ended, and
// whether the caller has been told.
//
// ADDRESSED BY SESSION KEY, like the queue and the transcript: a restart mints
// a new session id, and a task that finishes afterwards must still find the
// conversation it owes its result to. The id the caller had at the start is
// kept beside it as a record, never as the address.
//
// SCOPED BY `instanceId` to the process registry that started it. Several instances
// can share one database, and a row is acted on by whichever process finds
// it — probed, timed out, swept as a restart's leftover, delivered. Unscoped,
// each instance would fail the other's in-process tasks as orphans of a
// restart, and wake the other's sessions to hand them results.
export const backgroundTask = pgTable(
  'BackgroundTask',
  {
    // A UUID, and also the task's `asyncTaskId` in the chat.
    taskId: text().primaryKey().notNull(),
    instanceId: text().notNull(),
    agent: text(),
    // Null when the caller had no session: nobody is told when it ends.
    sessionKey: text(),
    sessionId: text(),
    // WHAT ran: a tool, an app action, a node action.
    kind: text().notNull(),
    // HOW it runs, which the kind no longer says: `in-process`, the handler's
    // own promise, which a restart ends; or `background-task-runner`, a command
    // detached on its node, which a restart does not. Every start names it.
    // The default is for a process still on the code from before the column,
    // sharing this database: its starts are recorded rather than refused —
    // right for its actions, wrong only for a node command it starts meanwhile.
    runner: text().notNull().default('in-process'),
    name: text().notNull(),
    target: text().notNull(),
    summary: text().notNull(),
    state: text().notNull(),
    reason: text(),
    startedAt: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp({ withTimezone: true, mode: 'date' }),
    // Null: no limit. bigint because the limit is the caller's to choose, and
    // int32 milliseconds stop at 24.8 days.
    timeoutMs: bigint({ mode: 'number' }),
    exitCode: integer(),
    outputTail: text(),
    logPath: text(),
    // A runner task's own directory on the node, absolute as the NODE resolved
    // it: its TMPDIR is not ours, and after a restart this is the only way back
    // to the task. Null until the directory exists, and again once
    // housekeeping has removed it.
    nodeDir: text(),
    pid: integer(),
    // When the result reached the calling session. Null: still owed.
    deliveredAt: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [index('BackgroundTask_state_idx').on(t.state), index('BackgroundTask_sessionKey_idx').on(t.sessionKey)],
)

export const schema = {
  setting,
  secret,
  space,
  spaceApp,
  spaceGraph,
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
  chatUsageTurn,
  chatUsageTurnModel,
  agentQueueEntry,
  agentSessionEvent,
  chatAttachment,
  backgroundTask,
  ...authSchema,
}

export type AgentQueueEntry = typeof agentQueueEntry.$inferSelect
export type BackgroundTask = typeof backgroundTask.$inferSelect
export type AgentSessionEvent = typeof agentSessionEvent.$inferSelect
export type ChatAttachment = typeof chatAttachment.$inferSelect
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
export type ChatUsageTurn = typeof chatUsageTurn.$inferSelect
export type ChatUsageTurnModel = typeof chatUsageTurnModel.$inferSelect
export type Username = typeof username.$inferSelect

// Better Auth's tables, declared separately because their shape is the
// library's contract rather than ours — re-exported here so drizzle-kit picks
// them up from this one schema entry point and they share the single
// migrations folder.
export * from './auth-schema'
