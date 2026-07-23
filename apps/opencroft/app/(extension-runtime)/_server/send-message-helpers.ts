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
  jobNodeId: string
  jobContext: string
  instructions: string[]
}

export interface ParsedMessage {
  /** Message body to deliver. */
  message: string
  /** Explicit target agent slug; falls back to the node's default agent when absent. */
  agent?: string
  /** Explicit target job slug; falls back to the node's default job when absent. */
  job?: string
  /** Optional session discriminator: same agent+job but a distinct key = a distinct stable session. */
  key?: string
  /** Optional session title, applied only when the session is first created. */
  title?: string
  /** Legacy combined key `agent:<agent>:<job>`; honored when `agent`/`job` are absent. */
  session?: string
  /** Cancel an in-flight turn and enqueue this message after whatever's
   *  already queued, instead of waiting behind it. */
  force?: boolean
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function nodeName(node: NodeLike): string {
  return ((node.data?.['name'] as string) || '').trim()
}

export function buildSessionKey(agentName: string, jobName: string, key?: string): string {
  const base = `agent:${slug(agentName)}:${slug(jobName)}`
  const k = (key ?? '').trim()
  return k ? `${base}:${slug(k)}` : base
}

export function parseSessionKey(sessionKey: string): { agentSlug: string; jobSlug: string } | null {
  // The optional third segment is a session discriminator key; it does not affect
  // which agent/job the session binds to, so it is accepted but ignored here.
  const m = sessionKey.match(/^agent:([^:]+):([^:]+)(?::.+)?$/)
  if (!m) {
    return null
  }
  return { agentSlug: m[1], jobSlug: m[2] }
}

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
  const obj = parsed as Record<string, unknown>
  if (typeof obj['message'] !== 'string') {
    return null
  }
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  return {
    message: obj['message'],
    agent: optStr(obj['agent']),
    job: optStr(obj['job']),
    key: optStr(obj['key']),
    title: optStr(obj['title']),
    session: optStr(obj['session']),
    force: obj['force'] === true,
  }
}

function findAgentBySlug(agentSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (n.type === 'agent' && slug(nodeName(n)) === agentSlug) {
      return n
    }
  }
  return null
}

function findJobBySlug(jobSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (n.type === 'agent-job' && slug(nodeName(n)) === jobSlug) {
      return n
    }
  }
  return null
}

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
    jobNodeId: jobNode.id,
    jobContext: ((jobNode.data?.['context'] as string) || '').trim(),
    instructions,
  }
}

