import { db, user, username as usernames } from '@opencroft/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'
import {
  AGENT_USERNAME_PREFIX,
  checkUsername,
  type UsernameRefusal,
  usernameFromDisplayName,
} from '@/app/_shared/username'

/**
 * The store behind account usernames: who holds which handle, who used to,
 * and what happens when one changes.
 *
 * Server-only, and never a `createServerFn` itself — this module reaches the
 * database and the space graph, and the surfaces that expose it wrap these
 * functions in their own server functions. Keeping it out of any file a
 * component imports is what keeps the database out of the client bundle.
 *
 * The GRAMMAR lives in `app/_shared/username.ts` and is read from there, not
 * restated here. This file owns only what a string cannot know about itself:
 * whether it is taken, and who by.
 */

/**
 * An account of either kind, named the way the group-chat read model already
 * names one, so the two do not need translating between.
 *
 * `id` is a `user.id` for a person and a graph node id for an agent.
 */
export interface Principal {
  kind: 'user' | 'agent'
  id: string
}

function toPrincipal(row: {
  principalType: string
  userId: string | null
  agentNodeId: string | null
}): Principal | null {
  if (row.principalType === 'agent' && row.agentNodeId) {
    return { kind: 'agent', id: row.agentNodeId }
  }
  if (row.principalType === 'user' && row.userId) {
    return { kind: 'user', id: row.userId }
  }
  // A row whose discriminant and id columns disagree. Consistency between
  // them is application-side here, as it is for GroupChatMember, so a
  // contradictory row is possible and is treated as
  // unresolvable rather than guessed at.
  return null
}

/**
 * Which account holds — or used to hold — this username.
 *
 * RETIRED HANDLES STILL RESOLVE, and to the same account they always did.
 * A reference written into a transcript when someone was `ada` keeps landing
 * on that person after they become `ada.l`; what the reader sees is that
 * account's CURRENT display name and avatar, because the durable text was
 * never the name. The same reasoning as `GroupChatSlugAlias`, which exists so
 * addresses already written down still arrive.
 *
 * Null means no account ever held it — an old tag carrying a bare display
 * name, or a handle from before this field existed.
 */
export async function resolveUsername(value: string): Promise<Principal | null> {
  const [row] = await db
    .select({ principalType: usernames.principalType, userId: usernames.userId, agentNodeId: usernames.agentNodeId })
    .from(usernames)
    .where(eq(usernames.username, value))
    .limit(1)
  return row ? toPrincipal(row) : null
}

/**
 * The same question as `resolveUsername`, asked about many handles at once.
 *
 * One delivered turn can carry a dozen messages from a handful of senders, and
 * a page of history several dozen — a query each would make what a reader sees
 * depend on how much of the transcript they scrolled past. Handles that no
 * account has ever held are simply absent from the result, which is the same
 * answer `resolveUsername` gives as null.
 */
export async function resolveUsernames(values: string[]): Promise<Map<string, Principal>> {
  const wanted = [...new Set(values)]
  if (wanted.length === 0) {
    return new Map()
  }
  const rows = await db
    .select({
      username: usernames.username,
      principalType: usernames.principalType,
      userId: usernames.userId,
      agentNodeId: usernames.agentNodeId,
    })
    .from(usernames)
    .where(inArray(usernames.username, wanted))
  const found = new Map<string, Principal>()
  for (const row of rows) {
    const principal = toPrincipal(row)
    if (principal) {
      found.set(row.username, principal)
    }
  }
  return found
}

/** The handle an account goes by now, or null if it has not been given one yet. */
export async function currentUsername(principal: Principal): Promise<string | null> {
  const [row] = await db
    .select({ username: usernames.username })
    .from(usernames)
    .where(and(ownerMatches(principal), isNull(usernames.retiredAt)))
    .limit(1)
  return row?.username ?? null
}

function ownerMatches(principal: Principal) {
  return principal.kind === 'agent' ? eq(usernames.agentNodeId, principal.id) : eq(usernames.userId, principal.id)
}

export type ChangeUsernameResult = { ok: true } | { ok: false; refusal: UsernameRefusal | 'taken' }

/**
 * Postgres' unique-violation SQLSTATE, and the only database error either
 * writer below is entitled to interpret.
 *
 * Catching everything instead would let an outage answer a question it was
 * never asked: "the database is unreachable" would reach a person as "that
 * username is taken", and a systematic failure during backfill would report
 * the same nothing-to-do as the ordinary quiet case.
 *
 * Checked on the cause as well as the error, because a driver may wrap the
 * original before it surfaces.
 */
const UNIQUE_VIOLATION = '23505'

export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return code === UNIQUE_VIOLATION || causeCode === UNIQUE_VIOLATION
}

/**
 * Give an account a different handle, retiring the one it had.
 *
 * The old row is kept and marked retired rather than deleted, so references
 * already written against it still resolve here, and so nobody else can ever
 * take it — the unique index spans retired rows too.
 *
 * Both writes happen in one transaction. Half of this applied would leave an
 * account with two current handles or none, and the partial unique index
 * would reject the first of those outright, which is the point of having it.
 */
export async function changeUsername(principal: Principal, next: string): Promise<ChangeUsernameResult> {
  const check = checkUsername(next, principal.kind)
  if (!check.ok && check.refusal) {
    return { ok: false, refusal: check.refusal }
  }

  const holder = await resolveUsername(next)
  const heldByThisAccount = holder?.kind === principal.kind && holder?.id === principal.id
  if (holder && !heldByThisAccount) {
    return { ok: false, refusal: 'taken' }
  }

  // Already this account's current handle: nothing to do, and reporting it as
  // taken would be a confusing way to say "that is already yours".
  const current = await currentUsername(principal)
  if (current === next) {
    return { ok: true }
  }

  try {
    await db.transaction(async (tx) => {
      // Retire the current one FIRST. One-current-per-account is a unique
      // index, so bringing the replacement back before this ran would collide
      // with the row it is replacing.
      await tx
        .update(usernames)
        .set({ retiredAt: new Date() })
        .where(and(ownerMatches(principal), isNull(usernames.retiredAt)))

      if (heldByThisAccount) {
        // Taking back a handle this account used to hold -- someone undoing a
        // typo a minute later, which is when this happens. The existing row
        // comes out of retirement rather than a second one being inserted:
        // `username` is unique across retired rows too, which is exactly the
        // guarantee that stops anyone else ever holding it, so there is only
        // ever one row per handle to bring back.
        await tx.update(usernames).set({ retiredAt: null }).where(eq(usernames.username, next))
        return
      }
      await tx.insert(usernames).values({
        username: next,
        principalType: principal.kind,
        userId: principal.kind === 'user' ? principal.id : null,
        agentNodeId: principal.kind === 'agent' ? principal.id : null,
      })
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Somebody claimed the handle between the check above and the write.
      // That is the index doing its job; report it as any other taken handle.
      return { ok: false, refusal: 'taken' }
    }
    // Anything else is not an answer about this username, so it must not be
    // dressed up as one.
    throw error
  }
  return { ok: true }
}

/**
 * A handle for an account that has none, derived once from its display name.
 *
 * `taken` is the set of handles already spoken for, passed in so a whole
 * backfill can be decided against one read instead of a query per account.
 * Mutated as candidates are settled, so two accounts in the same pass cannot
 * both be handed the same one.
 *
 * The suffix on collision is `.2`, `.3` and so on, in the identifier alphabet
 * rather than the hyphen a slug would use. The fallback when a display name
 * holds nothing usable at all — punctuation, or emoji — is derived from the
 * account's own id, which is opaque but real and can be changed afterwards.
 * Backfill has to produce something for everybody: a person should not have
 * to choose a handle before the product works for them again.
 */
export function claimUsername(
  displayName: string,
  accountId: string,
  kind: 'user' | 'agent',
  taken: Set<string>,
): string {
  const prefix = kind === 'agent' ? AGENT_USERNAME_PREFIX : ''
  const stem = usernameFromDisplayName(displayName) || usernameFromDisplayName(accountId) || 'account'
  const base = `${prefix}${stem}`
  let candidate = base
  let n = 1
  while (taken.has(candidate)) {
    n += 1
    candidate = `${base}.${n}`
  }
  taken.add(candidate)
  return candidate
}

/**
 * Make sure ONE person has a handle, at the moment something needs to name
 * them.
 *
 * `ensureUsernames` below runs at startup, which covers every account that
 * existed when the process began — and misses anyone who signs up afterwards.
 * That gap is invisible until an identifier is required, and then it is total:
 * a person who registered five minutes ago cannot be attributed at all, so
 * their first message would be refused until the next restart.
 *
 * Hooked here rather than onto registration because the handle rules live in
 * this application and the sign-up path lives in a package that must not know
 * about them. Reconciling at the point of need is also what the startup pass
 * already is — this is the same guarantee, asked about one account.
 *
 * Null when the account does not exist. Losing the insert race is not a
 * failure: the account has a handle either way, which is all this promises, so
 * the winner's row is re-read rather than guessed at.
 */
export async function ensureUsernameForUser(userId: string): Promise<string | null> {
  const principal: Principal = { kind: 'user', id: userId }
  const current = await currentUsername(principal)
  if (current) {
    return current
  }
  const [row] = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  if (!row) {
    return null
  }
  const taken = new Set((await db.select({ username: usernames.username }).from(usernames)).map((r) => r.username))
  const candidate = claimUsername(row.name, userId, 'user', taken)
  try {
    await db.insert(usernames).values({ username: candidate, principalType: 'user', userId, agentNodeId: null })
    return candidate
  } catch (error) {
    if (isUniqueViolation(error)) {
      return await currentUsername(principal)
    }
    throw error
  }
}

/**
 * Make sure ONE agent has a handle, at the moment something needs to name it.
 *
 * The counterpart to `ensureUsernameForUser`, and the gap it closes is WIDER
 * for an agent than for a person, not narrower. The note below says agents have
 * no account-creation path to hook because they are made by editing a space
 * graph — which is true, and is exactly why the startup pass alone leaves an
 * agent added since the last restart unable to be attributed at all. For a
 * person that window opens at sign-up; for an agent it opens every time
 * somebody drops a node on a canvas.
 *
 * The point of NEED is the hook, the same one a person's handle uses. The
 * display name seeds the handle once and is never the stamp itself: it is free
 * text that a rename changes, and a message must carry something that survives
 * being renamed.
 *
 * Null when nothing could be claimed. Losing the insert race is not a failure —
 * the agent has a handle either way, which is all this promises.
 */
export async function ensureUsernameForAgent(agentNodeId: string, displayName: string): Promise<string | null> {
  const principal: Principal = { kind: 'agent', id: agentNodeId }
  const current = await currentUsername(principal)
  if (current) {
    return current
  }
  const taken = new Set((await db.select({ username: usernames.username }).from(usernames)).map((r) => r.username))
  const candidate = claimUsername(displayName, agentNodeId, 'agent', taken)
  try {
    await db.insert(usernames).values({ username: candidate, principalType: 'agent', userId: null, agentNodeId })
    return candidate
  } catch (error) {
    if (isUniqueViolation(error)) {
      return await currentUsername(principal)
    }
    throw error
  }
}

/**
 * Make sure every account of either kind has a handle.
 *
 * Idempotent, and a reconciliation rather than a one-time migration on
 * purpose: agents are created by editing a space graph, with no account-
 * creation path to hook, so "every agent has a username" has to be something
 * that becomes true again rather than something done once. Running it twice
 * changes nothing.
 *
 * Returns what it assigned AND what it could not, because this function's
 * whole promise is that "every account has a handle" is true when it returns.
 * A count alone cannot carry that: a systematic failure and an ordinary quiet
 * boot both assign nothing, and reporting only `assigned` would make total
 * failure indistinguishable from success at the one place the guarantee is
 * supposed to be established.
 *
 * A concurrent instance claiming a handle first is NOT a failure -- the
 * account ends up with one either way, which is all this promises. It can
 * still leave an account handle-less if both instances lose different races in
 * the same pass; that is survivable precisely because this re-runs on every
 * boot, which is a reason to keep it a reconciliation rather than turn it into
 * a one-time migration.
 */
export async function ensureUsernames(): Promise<{ assigned: number; failed: number }> {
  const existing = await db
    .select({
      username: usernames.username,
      principalType: usernames.principalType,
      userId: usernames.userId,
      agentNodeId: usernames.agentNodeId,
      retiredAt: usernames.retiredAt,
    })
    .from(usernames)

  const taken = new Set(existing.map((row) => row.username))
  const hasCurrent = new Set(
    existing
      .filter((row) => row.retiredAt === null)
      .map((row) => `${row.principalType}:${row.agentNodeId ?? row.userId}`),
  )

  const people = await db.select({ id: user.id, name: user.name }).from(user)
  const agents = await listAgentNodesImpl()

  const pending: Array<{ username: string; principalType: string; userId: string | null; agentNodeId: string | null }> =
    []

  for (const person of people) {
    if (hasCurrent.has(`user:${person.id}`)) {
      continue
    }
    pending.push({
      username: claimUsername(person.name, person.id, 'user', taken),
      principalType: 'user',
      userId: person.id,
      agentNodeId: null,
    })
  }

  for (const agent of agents) {
    if (hasCurrent.has(`agent:${agent.nodeId}`)) {
      continue
    }
    pending.push({
      username: claimUsername(agent.name, agent.nodeId, 'agent', taken),
      principalType: 'agent',
      userId: null,
      agentNodeId: agent.nodeId,
    })
  }

  let assigned = 0
  let failed = 0
  for (const row of pending) {
    try {
      await db.insert(usernames).values(row)
      assigned += 1
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another instance got there first. The unique indexes are the
        // authority on who holds what, and losing that race means the account
        // has a handle -- which is all this promised.
        continue
      }
      // Anything else means this account came out of the pass without one.
      // Counted rather than swallowed, so the caller can say so.
      failed += 1
    }
  }
  return { assigned, failed }
}
