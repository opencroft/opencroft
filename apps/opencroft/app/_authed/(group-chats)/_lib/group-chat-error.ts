// Reading a group-chat refusal on the client.
//
// THE CONTRACT, recorded on GroupChatAccessError in model.ts and verified
// there against the real wire format: `createServerFn` puts a thrown error
// through seroval, which rebuilds it as a PLAIN `Error` — a custom subclass is
// not in seroval's constructor list. So `instanceof GroupChatAccessError` is
// FALSE on the client even for a genuine one. `name` and own-enumerable
// properties (so `code`) do survive.
//
// Hence: branch on `name`, then read `code`. Never `instanceof`. This module
// exists so no component has to remember that.
//
// Client-safe on purpose: it takes the failure union from
// `_shared/access-error.ts`, which depends on nothing. Importing it from
// model.ts instead would put the database and the ACP session machinery behind
// a browser-reachable module.

import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_shared/access-error'

export type { GroupChatAccessFailure }

const FAILURES = [
  'unauthenticated',
  'not-found',
  'agent-not-a-member',
  'last-user-member',
  'pin-limit',
  'slug-taken',
  'slug-unusable',
] as const

// Compile-time proof that the list above still matches the server's union. If
// a fifth code is added to model.ts and not here, this stops compiling rather
// than silently falling through to "unrecognised" at runtime.
type Listed = (typeof FAILURES)[number]
type _ListedCoversServer = GroupChatAccessFailure extends Listed ? true : never
type _ServerCoversListed = Listed extends GroupChatAccessFailure ? true : never
const _assertInSync: [_ListedCoversServer, _ServerCoversListed] = [true, true]
void _assertInSync

function isFailure(value: unknown): value is GroupChatAccessFailure {
  return typeof value === 'string' && (FAILURES as readonly string[]).includes(value)
}

/**
 * The refusal code behind an error, or null if this is not a group-chat
 * access refusal at all (a network failure, a bug, anything else) — those are
 * not this module's to interpret and must not be reported as access problems.
 */
export function groupChatAccessCode(error: unknown): GroupChatAccessFailure | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const candidate = error as { name?: unknown; code?: unknown }
  if (candidate.name !== 'GroupChatAccessError') {
    return null
  }
  return isFailure(candidate.code) ? candidate.code : null
}

/** Whether an error is a group-chat access refusal. */
export function isGroupChatAccessError(error: unknown): boolean {
  return groupChatAccessCode(error) !== null
}

// One entry for "you cannot have this", because the server now sends one code
// for it.
//
// This map used to carry `not-a-member` and `not-found` separately with
// identical text, which read as sufficient and was not: the server was still
// sending two different codes and two different messages, and a browser console
// capture showed them. Matching copy on screen cannot make a distinguishable
// response indistinguishable. The collapse belongs where the refusal is
// created (see _shared/access-error.ts); this map is now the second line of
// defence rather than the only one.
const MESSAGES: Record<GroupChatAccessFailure, string> = {
  unauthenticated: 'Sign in to view group chats.',
  'not-found': 'This group chat is not available.',
  'agent-not-a-member': 'That agent is not part of this group chat.',
  'last-user-member': 'The last person in a group chat cannot be removed.',
  'pin-limit': 'This group chat already holds the maximum number of pins. Unpin one to add another.',
  'slug-taken': 'That name is already taken — please choose another.',
  'slug-unusable': 'That name needs at least one letter or number.',
}

/**
 * User-facing copy for a refusal, or null when the error is not one — the
 * caller then falls back to its own generic failure message rather than
 * claiming an access problem it has no evidence of.
 */
export function groupChatAccessMessage(error: unknown): string | null {
  const code = groupChatAccessCode(error)
  return code ? MESSAGES[code] : null
}

/**
 * The same copy, for a code a loader already resolved.
 *
 * Loaders catch a refusal and carry the CODE forward as ordinary data rather
 * than rethrowing it (see the route files for why), so by render time there is
 * no error object left to read — only the code.
 */
export function groupChatAccessMessageForCode(code: GroupChatAccessFailure): string {
  return MESSAGES[code]
}
