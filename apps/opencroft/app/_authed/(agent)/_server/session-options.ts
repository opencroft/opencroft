// A session's command-bar settings applied on its behalf: Effort, Permission
// Mode and Presence, given in the command bar's own vocabulary, resolved
// against what this session's agent offers exactly as the bar resolves them,
// and set through the same calls the bar makes. A value the agent does not
// offer is skipped with the reason and the rest still apply — no setting
// makes this throw.

import type { HostPresence, HostSessionOptions, HostSessionOptionsResult } from '@opencroft/server'
import { commandBarDials } from 'agent-chat/agent-command-bar-configs'

import {
  setLocalConfigOptionImpl,
  setPresenceLocalImpl,
  tabKeyOfSession,
  tabSessions,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'

const PRESENCE_KINDS: ReadonlySet<string> = new Set<HostPresence['kind']>([
  'high-attention',
  'realtime',
  'online',
  'minutes',
  'hourly',
  'daily',
  'custom',
])

/**
 * Apply `options` to an open session, in the order effort, permission mode,
 * presence. Presence goes last because setting it may deliver what is
 * already waiting, and that should reach an agent already on the new effort
 * and mode.
 */
export async function applySessionOptions(
  sessionId: string,
  options: HostSessionOptions,
): Promise<HostSessionOptionsResult> {
  const result: HostSessionOptionsResult = { applied: [], skipped: [] }
  const tab = tabSessions.get(tabKeyOfSession(sessionId) ?? '')
  const adapterId = tab?.adapterId ?? agentClient.listSessions().find((s) => s.id === sessionId)?.adapterId
  const dials = commandBarDials(agentClient.sessionConfigOptions(sessionId) ?? [], adapterId)

  const attempt = async (option: keyof HostSessionOptions, apply: () => Promise<string | null>) => {
    try {
      const refusal = await apply()
      if (refusal) {
        result.skipped.push({ option, reason: refusal })
      } else {
        result.applied.push(option)
      }
    } catch (error) {
      result.skipped.push({ option, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const { effort, permissionMode, presence } = options
  if (effort !== undefined) {
    await attempt('effort', () =>
      setDial(sessionId, effort, { id: dials.effortId, offered: dials.effortValues, back: dials.effortBack }, 'effort'),
    )
  }
  if (permissionMode !== undefined) {
    await attempt('permissionMode', () =>
      setDial(
        sessionId,
        permissionMode,
        { id: dials.modeId, offered: dials.modeValues, back: dials.modeBack },
        'permission mode',
      ),
    )
  }
  if (presence !== undefined) {
    await attempt('presence', async () => {
      const problem = presenceProblem(presence, tab?.canSteer ?? false)
      if (problem) {
        return problem
      }
      await setPresenceLocalImpl({ sessionId, presence })
      return null
    })
  }
  return result
}

/** Set one of the bar's dials to `value`, or say why it was not: null when it was set. */
async function setDial(
  sessionId: string,
  value: string,
  dial: { id: string; offered: string[]; back: Map<string, string> },
  what: string,
): Promise<string | null> {
  if (!dial.offered.includes(value)) {
    return dial.offered.length > 0
      ? `This agent offers no ${what} "${value}" (it offers ${dial.offered.join(', ')})`
      : `This agent offers no ${what} setting`
  }
  const set = await setLocalConfigOptionImpl({ sessionId, configId: dial.id, value: dial.back.get(value) ?? value })
  return set.ok ? null : `The ${what} is pinned while YOLO mode is on`
}

/** Why a presence cannot be set on this session, or null when it can. */
function presenceProblem(presence: HostPresence, canSteer: boolean): string | null {
  if (!PRESENCE_KINDS.has(presence?.kind)) {
    return `"${String(presence?.kind)}" is not a presence`
  }
  if (presence.kind === 'custom' && !(Number.isFinite(presence.intervalMs) && presence.intervalMs > 0)) {
    return 'A custom presence needs a positive interval'
  }
  // The command bar does not offer Realtime to such an agent either: without
  // mid-turn input it would read exactly as Online does.
  if (presence.kind === 'realtime' && !canSteer) {
    return 'This agent does not take messages mid-turn, so it offers no Realtime presence'
  }
  return null
}
