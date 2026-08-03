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

const FAILURES = ['unauthenticated', 'not-a-member', 'not-found', 'agent-not-a-member'] as const

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

// `not-found` and `not-a-member` MUST read identically.
//
// The server refuses those two the same way on purpose: telling a non-member
// "that id doesn't exist" versus "that exists but you can't see it" reveals
// which ids are real to someone not entitled to know. Giving them different
// copy here would hand back exactly what that care was protecting — the leak
// would just have moved from the API to the screen.
const MESSAGES: Record<GroupChatAccessFailure, string> = {
  unauthenticated: 'Sign in to view group chats.',
  'not-a-member': 'This group chat is not available.',
  'not-found': 'This group chat is not available.',
  'agent-not-a-member': 'That agent is not part of this group chat.',
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
