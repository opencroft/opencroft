import { modeIdForCanonical } from 'agent-client/session-modes'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { isYoloMode, subscribeYoloMode } from '@/app/_authed/(mcp)/_server/yolo'

/**
 * YOLO mode forces every session into its bypass permission mode and holds it
 * there. Turning YOLO off puts each session back where it was.
 *
 * The MCP half of YOLO (approving tool calls without asking) lives in
 * resolvePermission and needs nothing here — it is read per request. The mode
 * half does need state, because forcing bypass destroys the information needed
 * to undo it: without remembering, "off" would have to guess a mode to return
 * to, and guessing `manual` would silently demote someone who was deliberately
 * in plan.
 *
 * Held in memory, matching YOLO's own runtime override — neither survives a
 * restart, and a remembered mode that outlived the YOLO state that caused it
 * would be worse than forgetting: it would rewrite a mode the user has since
 * chosen for themselves.
 */
const modeBeforeYolo = new Map<string, string>()

/**
 * True when the session's mode is currently locked. Callers that change modes
 * consult this so a refusal is a deliberate answer rather than a request the
 * agent quietly reverts a moment later.
 */
export function modeLockedByYolo(): boolean {
  return isYoloMode()
}

/**
 * Put one session into bypass and remember where it was.
 *
 * A session whose agent does not offer bypass is left alone. That is a real
 * case rather than a defensive branch — Claude Code advertises
 * `bypassPermissions` only when its own ALLOW_BYPASS holds — and the honest
 * outcome is to leave the mode as it is: the MCP half of YOLO still applies,
 * and pretending otherwise would mean either an error nobody can act on or a
 * silent switch to a mode that is not the one requested.
 */
export async function forceBypassMode(sessionId: string): Promise<void> {
  const modes = agentClient.sessionModes(sessionId)
  if (!modes) {
    return
  }
  const bypassId = modeIdForCanonical(modes.adapterId, modes.available, 'bypass')
  if (!bypassId || modes.current === bypassId) {
    return
  }
  // Recorded before the switch, and only the FIRST time: a second call while
  // already forced must not overwrite the remembered mode with `bypass` itself.
  if (!modeBeforeYolo.has(sessionId)) {
    modeBeforeYolo.set(sessionId, modes.current)
  }
  await agentClient.setMode(sessionId, bypassId)
}

async function restoreMode(sessionId: string): Promise<void> {
  const previous = modeBeforeYolo.get(sessionId)
  if (!previous) {
    return
  }
  modeBeforeYolo.delete(sessionId)
  const modes = agentClient.sessionModes(sessionId)
  if (!modes || modes.current === previous) {
    return
  }
  // Still advertised? A session that resumed against a different model may no
  // longer offer the mode it was in, in which case leaving it in bypass would
  // be the worst answer — fall back to the most supervised mode it does offer.
  const supervised = modeIdForCanonical(modes.adapterId, modes.available, 'manual-edits')
  const target = modes.available.some((mode) => mode.id === previous) ? previous : supervised
  if (!target) {
    return
  }
  try {
    await agentClient.setMode(sessionId, target)
  } catch (error) {
    // The two directions are NOT symmetric, and this is the dangerous one.
    // Failing to force leaves a session more supervised than asked — harmless.
    // Failing to restore leaves it in bypass with YOLO off: the approval gate
    // is gone, entered by the user asking for MORE safety, and the entry has
    // already been dropped so no later toggle will retry it. A rejected
    // setMode is ordinary (a turn in flight is the usual cause), so this is a
    // path that will be taken, not a defensive branch.
    //
    // So fail toward supervision: try the most supervised mode on offer before
    // giving up. Only if that also fails is there nothing left but to say so
    // loudly — at that point the session is genuinely stuck and silence would
    // hide an open gate.
    if (supervised && supervised !== target) {
      try {
        await agentClient.setMode(sessionId, supervised)
        return
      } catch {}
    }
    console.error('Failed to restore mode after YOLO was disabled; session may still be in bypass', sessionId, error)
  }
}

async function applyToAllSessions(enabled: boolean): Promise<void> {
  const sessions = agentClient.listSessions()
  await Promise.all(
    sessions.map((session) =>
      (enabled ? forceBypassMode(session.id) : restoreMode(session.id)).catch((error: unknown) => {
        // One agent refusing the switch must not stop the rest — and a session
        // mid-turn is the ordinary reason for it.
        console.error('Failed to apply YOLO mode to session', session.id, error)
      }),
    ),
  )
}

let installed = false

/**
 * Start applying YOLO to session modes. Idempotent, and called from the session
 * open path rather than at import time so nothing subscribes in a process that
 * never opens a session.
 */
export function installYoloModeEnforcement(): void {
  if (installed) {
    return
  }
  installed = true
  subscribeYoloMode((enabled) => {
    void applyToAllSessions(enabled)
  })
}
