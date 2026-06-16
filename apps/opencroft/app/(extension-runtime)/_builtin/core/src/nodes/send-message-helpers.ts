/**
 * Shared helpers for SendMessage node — used by both client (UI) and server (stream.ts).
 *
 * Routing model: SendMessage receives JSON `{ session, message }` on its `text-in`
 * handle. `session` looks like `agent:<agent-slug>:<job-slug>`. The message is
 * routed only when both an Agent node and an Agent Job node with matching slugs
 * exist on the same opencroft space graph.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface NodeLike {
  id: string
  type?: string
  data?: Record<string, unknown>
}

export interface EdgeLike {
  source: string
  sourceHandle?: string
  target: string
  targetHandle?: string
}

export interface AgentContext {
  agentName: string
  agentNodeId: string
  jobName: string
  jobContext: string
  instructions: string[]
}

export interface ParsedMessage {
  session: string
  message: string
}

// ─── slug / session key ──────────────────────────────────────────────

export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function buildSessionKey(agentName: string, jobName: string): string {
  return `agent:${slug(agentName)}:${slug(jobName)}`
}

export function parseSessionKey(sessionKey: string): { agentSlug: string; jobSlug: string } | null {
  const m = sessionKey.match(/^agent:([^:]+):([^:]+)$/)
  if (!m) {
    return null
  }
  return { agentSlug: m[1], jobSlug: m[2] }
}

// ─── JSON envelope parsing ───────────────────────────────────────────

export function tryParseJsonMessage(text: string): ParsedMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const obj = parsed as { session?: unknown; message?: unknown }
  if (typeof obj.session !== 'string' || !obj.session.trim()) {
    return null
  }
  if (typeof obj.message !== 'string') {
    return null
  }
  return { session: obj.session.trim(), message: obj.message }
}

// ─── Graph lookups ───────────────────────────────────────────────────

function nodeName(node: NodeLike): string {
  return ((node.data?.['name'] as string) || '').trim()
}

export function findAgentBySlug(agentSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (n.type === 'agent' && slug(nodeName(n)) === agentSlug) {
      return n
    }
  }
  return null
}

export function findJobBySlug(jobSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (n.type === 'agent-job' && slug(nodeName(n)) === jobSlug) {
      return n
    }
  }
  return null
}

/**
 * Resolve a sessionKey (`agent:<agent-slug>:<job-slug>`) against the current
 * space graph. Returns the full AgentContext only when BOTH the matching
 * Agent and Agent Job nodes exist; otherwise null.
 */
export function resolveSessionOnGraph(sessionKey: string, nodes: NodeLike[], edges: EdgeLike[]): AgentContext | null {
  const parts = parseSessionKey(sessionKey)
  if (!parts) {
    return null
  }

  const agentNode = findAgentBySlug(parts.agentSlug, nodes)
  if (!agentNode) {
    return null
  }
  const jobNode = findJobBySlug(parts.jobSlug, nodes)
  if (!jobNode) {
    return null
  }

  const instrEdges = edges.filter((e) => e.target === agentNode.id && e.targetHandle === 'instructions-in')
  const instructions: string[] = []
  for (const ie of instrEdges) {
    const instrNode = nodes.find((n) => n.id === ie.source)
    const text = ((instrNode?.data?.['instruction'] as string) || '').trim()
    if (text) {
      instructions.push(text)
    }
  }

  return {
    agentName: nodeName(agentNode),
    agentNodeId: agentNode.id,
    jobName: nodeName(jobNode),
    jobContext: ((jobNode.data?.['context'] as string) || '').trim(),
    instructions,
  }
}

// ─── Inspector helpers ───────────────────────────────────────────────

export function listAgentNames(nodes: NodeLike[]): string[] {
  return nodes
    .filter((n) => n.type === 'agent')
    .map(nodeName)
    .filter(Boolean)
}

export function listJobNames(nodes: NodeLike[]): string[] {
  return nodes
    .filter((n) => n.type === 'agent-job')
    .map(nodeName)
    .filter(Boolean)
}

// ─── Message wrapping ────────────────────────────────────────────────

/**
 * Wrap a message with opencroft XML tags (system, task, instruction),
 * matching the AI overlay transformOutgoing convention.
 */
export function wrapMessageWithContext(
  message: string,
  space: { name: string; slug: string },
  sourceNodeId: string | null,
  jobContext: string,
  instructions: string[],
): string {
  const selectedPart = sourceNodeId ?? 'none'
  const system = `<opencroft-system>Sent from OpenCroft space: ${space.name} (${space.slug}). Selected node: ${selectedPart}.</opencroft-system>`
  let prefix = system
  if (jobContext) {
    prefix += `\n<opencroft-task>${jobContext}</opencroft-task>`
  }
  for (const instr of instructions) {
    prefix += `\n<opencroft-instruction>${instr}</opencroft-instruction>`
  }
  return `${prefix}\n${message}`
}
