// The one definition of what an Agent node's graph data looks like, so call
// sites match its type and read `data.name`/… through these rather than each
// by hand: a renamed field or type then breaks at compile time instead of
// silently giving wrong counts or empty lists.
//
// The types are core's, in the qualified form graphs store.

import { coreType } from '@/app/_authed/(extension-runtime)/_core-types'

export const AGENT_NODE_TYPE = coreType('agent')
export const AGENT_TOOL_NODE_TYPE = coreType('agent-tool')
export const SEND_MESSAGE_NODE_TYPE = coreType('send-message')

export interface AgentGraphNode {
  type?: string
  data?: Record<string, unknown>
}

export function isAgentNode(node: AgentGraphNode): boolean {
  return node.type === AGENT_NODE_TYPE
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An Agent node's display name — also used, slugified, as its session-routing identity. */
export function agentNodeName(node: AgentGraphNode): string {
  return str(node.data?.name).trim()
}

export function agentNodeAvatar(node: AgentGraphNode): string | undefined {
  const value = node.data?.avatar
  return typeof value === 'string' ? value : undefined
}

// Opt-in for the idle-session reaper (default OFF): unloading can kill
// background work an idle session still owns, so this must be a deliberate
// per-agent choice, never a global default.
export function agentAutoUnloadIdleEnabled(node: AgentGraphNode): boolean {
  return node.data?.autoUnloadIdle === true
}

// Idle threshold in minutes for that opt-in; undefined means "use the
// reaper's own default" rather than 0 (which would mean "immediately").
export function agentAutoUnloadIdleMinutes(node: AgentGraphNode): number | undefined {
  const value = node.data?.autoUnloadIdleMinutes
  return typeof value === 'number' && value > 0 ? value : undefined
}
