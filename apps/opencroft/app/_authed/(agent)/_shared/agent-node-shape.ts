// The one definition of what an Agent / Agent Job / Agent Instruction node's
// graph data looks like. Before this existed, three call sites independently
// re-derived it by hand — host.ts's reachableAgentJobs, send-message-helpers.ts's
// findAgentBySlug/findJobBySlug, and agents-impl.ts's listAgentNodesImpl — each
// matching `node.type === 'agent'` (etc.) and reading `data.name`/`context`/…
// directly. A renamed field or typeId broke whichever copies nobody happened
// to update, silently: wrong counts or empty lists, not a compile error.

export const AGENT_NODE_TYPE = 'agent'
export const AGENT_JOB_NODE_TYPE = 'agent-job'
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

export function isAgentJobNode(node: AgentGraphNode): boolean {
  return node.type === AGENT_JOB_NODE_TYPE
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

/** An Agent Job node's display name — also used, slugified, as its session-routing identity. */
export function agentJobName(node: AgentGraphNode): string {
  return str(node.data?.['name']).trim()
}

export function agentJobContext(node: AgentGraphNode): string {
  return str(node.data?.['context'])
}

export function agentJobWorkingDirectory(node: AgentGraphNode): string {
  return str(node.data?.['workingDirectory'])
}

export function agentInstructionName(node: AgentGraphNode): string {
  return str(node.data?.['name']).trim()
}

export function agentInstructionText(node: AgentGraphNode): string {
  return str(node.data?.['instruction'])
}
