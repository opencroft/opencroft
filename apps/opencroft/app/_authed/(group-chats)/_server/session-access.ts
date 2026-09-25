// Who may reach an agent session through the browser's ACP entry points: a
// member of the group chat whose thread owns it. Every one of those entry
// points — the event stream, the attachment route, each server function in
// acp.ts — asks here before it touches a session, and nothing else answers the
// question.
//
// A session is named on the wire either by its id or by its key. An id is
// resolved to a key first and then checked exactly as a key is, so there is one
// membership question (model.ts's requireSessionKeyMember) behind both.
//
// A refusal leaves as an HTTP status, not a thrown error: 401 for a caller who
// is not signed in, 403 for everything else. An id or key that names nothing is
// refused with the same 403 as one naming a chat the caller is not in, so a
// response never says whether a session exists.

import { getRequest } from '@tanstack/react-start/server'

import { findPersistedTabKey } from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  GroupChatAccessError,
  listMemberSessionKeys,
  requireSessionKeyMember,
} from '@/app/_authed/(group-chats)/_server/model'

export { requireSessionKeyMember }

/**
 * The key a session id is addressed by: the engine's own record while the
 * session is loaded, else the persisted tab pointer that still names it after
 * an unload. Null when neither holds the id.
 */
async function sessionKeyOf(sessionId: string): Promise<string | null> {
  const live = agentClient.listSessions().find((session) => session.id === sessionId)?.sessionKey
  return live ?? (await findPersistedTabKey(sessionId))
}

/** The session's key, for a member of the chat that owns it; throws GroupChatAccessError otherwise. */
export async function requireSessionMember(request: Request, sessionId: string): Promise<string> {
  const { sessionKey } = await requireSessionKeyMember(request, await sessionKeyOf(sessionId))
  return sessionKey
}

function refusalFor(error: unknown): Response {
  if (!(error instanceof GroupChatAccessError)) {
    throw error
  }
  return error.code === 'unauthenticated'
    ? Response.json({ error: 'Unauthorized' }, { status: 401 })
    : Response.json({ error: 'Forbidden' }, { status: 403 })
}

/** For a route handler: the refusal to return, or null to go on. */
export async function sessionAccessRefusal(check: Promise<unknown>): Promise<Response | null> {
  try {
    await check
    return null
  } catch (error) {
    return refusalFor(error)
  }
}

// For a server function, which has nowhere to return a Response: it THROWS
// one, and the framework sends a thrown Response as the HTTP response — the
// same mechanism requireSessionServerFn relies on.
async function orRefuse<T>(check: Promise<T>): Promise<T> {
  try {
    return await check
  } catch (error) {
    throw refusalFor(error)
  }
}

/** Server-function gate on a session id. Resolves to the session's key. */
export function requireSessionAccess(sessionId: string): Promise<string> {
  return orRefuse(requireSessionMember(getRequest(), sessionId))
}

/** Server-function gate on a session key. Resolves to the key and the agent its thread runs. */
export function requireSessionKeyAccess(sessionKey: string): Promise<{ sessionKey: string; agentNodeId: string }> {
  return orRefuse(requireSessionKeyMember(getRequest(), sessionKey))
}

/** Server-function gate for a read across sessions: the keys of every thread the caller may reach. */
export function requireMemberSessionKeys(): Promise<Set<string>> {
  return orRefuse(listMemberSessionKeys(getRequest()))
}
