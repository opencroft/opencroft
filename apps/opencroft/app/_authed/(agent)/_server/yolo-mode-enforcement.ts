import type { BypassRoute } from 'agent-client/harness-adapters'
import { bypassRouteOf } from 'agent-client/resolve'
import { modeIdForCanonical, mostSupervisedModeId } from 'agent-client/session-modes'

import { agentClient, subscribeEngineEvents } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { isYoloMode, subscribeYoloMode } from '@/app/_authed/(mcp)/_server/yolo'

/**
 * YOLO forces every session into its bypass and holds it there. Turning YOLO
 * off puts each session back where it was.
 *
 * How a session reaches bypass is its adapter's declaration (bypassRouteOf):
 * its Bypass mode, or one config option set to a value with the mode left
 * alone (Copilot's `allow_all`). Both go through this one path, and the setting
 * the route holds is the one a session may not change while YOLO is on.
 *
 * The MCP half of YOLO (approving tool calls without asking) lives in
 * resolvePermission and needs nothing here — it is read per request. This half
 * does need state, because forcing bypass destroys the information needed to
 * undo it: without remembering, "off" would have to guess what to return to,
 * and guessing `manual` would silently demote someone who was deliberately in
 * plan.
 *
 * Held in memory, matching YOLO's own runtime override — neither survives a
 * restart, and a remembered setting that outlived the YOLO state that caused
 * it would be worse than forgetting: it would rewrite a choice the user has
 * since made for themselves.
 */
type HeldSetting = { kind: 'mode'; modeId: string } | { kind: 'config-option'; optionId: string; value: string }

const beforeYolo = new Map<string, HeldSetting>()

function routeOf(sessionId: string): BypassRoute {
  return bypassRouteOf(agentClient.listSessions().find((session) => session.id === sessionId)?.adapterId ?? '')
}

function configValue(sessionId: string, optionId: string): string | undefined {
  const option = agentClient.sessionConfigOptions(sessionId)?.find((entry) => entry.id === optionId)
  return option ? String(option.currentValue) : undefined
}

/**
 * True when YOLO holds this config option of this session: its mode option
 * where bypass is a mode, the declared option where it is a config option.
 * Callers that change options consult this so a refusal is a deliberate answer
 * rather than a request the enforcement quietly reverts a moment later.
 */
export function configLockedByYolo(sessionId: string, configId: string): boolean {
  if (!isYoloMode()) {
    return false
  }
  const route = routeOf(sessionId)
  return configId === (route.kind === 'config-option' ? route.optionId : 'mode')
}

/**
 * Put one session into bypass and remember where it was.
 *
 * A session that does not offer its route (no Bypass mode, or no such option)
 * is left alone. That is a real case rather than a defensive branch — Claude
 * Code advertises `bypassPermissions` only when its own ALLOW_BYPASS holds —
 * and the honest outcome is to leave the session as it is: the MCP half of
 * YOLO still applies, and pretending otherwise would mean either an error
 * nobody can act on or a silent switch to something that was not requested.
 */
export async function forceBypass(sessionId: string): Promise<void> {
  const route = routeOf(sessionId)
  if (route.kind === 'config-option') {
    const current = configValue(sessionId, route.optionId)
    if (current === undefined || current === route.value) {
      return
    }
    // Recorded before the switch, and only the FIRST time: a second call while
    // already forced must not overwrite the remembered value with the forced one.
    if (!beforeYolo.has(sessionId)) {
      beforeYolo.set(sessionId, { kind: 'config-option', optionId: route.optionId, value: current })
    }
    await agentClient.setConfigOption(sessionId, route.optionId, route.value)
    return
  }
  const modes = agentClient.sessionModes(sessionId)
  if (!modes) {
    return
  }
  const bypassId = modeIdForCanonical(modes.adapterId, modes.available, 'bypass')
  if (!bypassId || modes.current === bypassId) {
    return
  }
  if (!beforeYolo.has(sessionId)) {
    beforeYolo.set(sessionId, { kind: 'mode', modeId: modes.current })
  }
  await agentClient.setMode(sessionId, bypassId)
}

async function restore(sessionId: string): Promise<void> {
  const previous = beforeYolo.get(sessionId)
  if (!previous) {
    return
  }
  beforeYolo.delete(sessionId)
  if (previous.kind === 'config-option') {
    const current = configValue(sessionId, previous.optionId)
    if (current === undefined || current === previous.value) {
      return
    }
    try {
      await agentClient.setConfigOption(sessionId, previous.optionId, previous.value)
    } catch (error) {
      // The dangerous direction, as for a mode below: the session keeps
      // skipping approvals with YOLO off, and the entry is already dropped.
      // The remembered value is the only supervised one known for an option
      // of the agent's own, so there is nothing to fall back to but saying so.
      console.error(
        'Failed to restore approvals after YOLO was disabled; session may still skip them',
        sessionId,
        error,
      )
    }
    return
  }
  const modes = agentClient.sessionModes(sessionId)
  if (!modes || modes.current === previous.modeId) {
    return
  }
  // Still advertised? A session that resumed against a different model may no
  // longer offer the mode it was in, in which case leaving it in bypass would
  // be the worst answer — fall back to the most supervised mode it does offer.
  // Ranked across the whole family rather than asked for Manual Edits by name:
  // not every agent has one (Codex's most supervised preset is Accept Edits),
  // and a session without it would otherwise have no fallback at all.
  const supervised = mostSupervisedModeId(modes.adapterId, modes.available)
  const target = modes.available.some((mode) => mode.id === previous.modeId) ? previous.modeId : supervised
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
      (enabled ? forceBypass(session.id) : restore(session.id)).catch((error: unknown) => {
        // One agent refusing the switch must not stop the rest — and a session
        // mid-turn is the ordinary reason for it.
        console.error('Failed to apply YOLO mode to session', session.id, error)
      }),
    ),
  )
}

let installed = false

/**
 * Start applying YOLO to sessions. Idempotent, and called from the session
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
  // A route through a config option is held only as long as the agent keeps
  // it: the mode stays the user's to change, and Copilot turns `allow_all` off
  // when it leaves autopilot. So every change to a session's options while
  // YOLO is on is followed by holding it again, whoever made the change. A
  // forced value the agent echoes back finds it already held, so this does
  // not feed itself. The mode route needs no such pass: its mode is locked.
  subscribeEngineEvents((sessionId, event) => {
    if (event.kind !== 'config_options' || !isYoloMode() || routeOf(sessionId).kind !== 'config-option') {
      return
    }
    forceBypass(sessionId).catch((error: unknown) => {
      console.error('Failed to hold YOLO approvals for session', sessionId, error)
    })
  })
}
