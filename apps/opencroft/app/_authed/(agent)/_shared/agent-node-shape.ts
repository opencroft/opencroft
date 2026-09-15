// The one definition of what an Agent / Agent Instruction node's graph data
// looks like. Before this existed, call sites independently re-derived it by
// hand — each matching `node.type === 'agent'` (etc.) and reading
// `data.name`/`instruction`/… directly. A renamed field or typeId broke
// whichever copies nobody happened to update, silently: wrong counts or empty
// lists, not a compile error.

export const AGENT_NODE_TYPE = 'agent'
export const AGENT_INSTRUCTION_NODE_TYPE = 'agent-instruction'
export const AGENT_TOOL_NODE_TYPE = 'agent-tool'
export const SEND_MESSAGE_NODE_TYPE = 'send-message'

export interface AgentGraphNode {
  type?: string
  data?: Record<string, unknown>
}

export function isAgentNode(node: AgentGraphNode): boolean {
  return node.type === AGENT_NODE_TYPE
}

export function isAgentInstructionNode(node: AgentGraphNode): boolean {
  return node.type === AGENT_INSTRUCTION_NODE_TYPE
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** An Agent node's display name — also used, slugified, as its session-routing identity. */
export function agentNodeName(node: AgentGraphNode): string {
  return str(node.data?.['name']).trim()
}

export function agentNodeAvatar(node: AgentGraphNode): string | undefined {
  const value = node.data?.['avatar']
  return typeof value === 'string' ? value : undefined
}

/** Which Docker container this agent's harness process runs in, if any (several agents can share one). */
export function agentNodeContainerName(node: AgentGraphNode): string | undefined {
  const value = node.data?.['containerName']
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Opt-in for the idle-session reaper (default OFF): unloading can kill
// background work an idle session still owns, so this must be a deliberate
// per-agent choice, never a global default.
export function agentAutoUnloadIdleEnabled(node: AgentGraphNode): boolean {
  return node.data?.['autoUnloadIdle'] === true
}

// Idle threshold in minutes for that opt-in; undefined means "use the
// reaper's own default" rather than 0 (which would mean "immediately").
export function agentAutoUnloadIdleMinutes(node: AgentGraphNode): number | undefined {
  const value = node.data?.['autoUnloadIdleMinutes']
  return typeof value === 'number' && value > 0 ? value : undefined
}

export function agentInstructionName(node: AgentGraphNode): string {
  return str(node.data?.['name']).trim()
}

export function agentInstructionText(node: AgentGraphNode): string {
  return str(node.data?.['instruction'])
}
