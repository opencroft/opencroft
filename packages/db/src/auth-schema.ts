// Better Auth's tables. The column names and types are Better Auth's contract,
// not ours: its Drizzle adapter resolves tables/fields by these names, so this
// file follows its schema rather than the surrounding house style (quoted
// snake_case columns, `text` ids the library generates itself).
//
// These live in the db package rather than in packages/auth because the app has
// exactly one runtime migrator reading exactly one folder (see connect.ts's
// `migrationsFolder`, and drizzle.config.ts pointing at this package's
// schema.ts). Splitting the auth tables into a second schema + migration source
// would mean teaching that migrator about it for no benefit. packages/auth owns
// the auth behaviour; the tables are declared where every other table is.

import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

const created = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())

const updated = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: created(),
  updatedAt: updated(),
  // Supplied by Better Auth's `admin()` plugin. `role` is what makes the
  // first-run account an administrator.
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true, mode: 'date' }),
  // Set from a databaseHooks.session.create.after hook in packages/auth, not
  // derived from the session table's own updatedAt: banning a user deletes
  // its session rows outright (Better Auth's admin plugin does this on every
  // ban), which would silently erase a derived "last seen" the moment an
  // account is disabled -- exactly the account an administrator most needs
  // this fact about. A column on the user row survives that deletion.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
  // The colour theme the person chose. Declared to Better Auth as an additional
  // user field in packages/auth, which owns the allowed values, so it travels
  // with the session and is written through its update-user endpoint. Null
  // until they choose one.
  theme: text('theme'),
  // When the person last closed the sponsorship thank-you. Declared to Better
  // Auth as an additional user field in packages/auth, like `theme`, so every
  // browser they use knows it was seen. Null until they first close it.
  sponsorPromptSeenAt: timestamp('sponsor_prompt_seen_at', { withTimezone: true, mode: 'date' }),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: created(),
    updatedAt: updated(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true, mode: 'date' }),
    scope: text('scope'),
    // Present for the email/password provider; null for OAuth accounts.
    password: text('password'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const authSchema = { user, session, account, verification }

export type User = typeof user.$inferSelect
export type Session = typeof session.$inferSelect
export type Account = typeof account.$inferSelect
export type Verification = typeof verification.$inferSelect
