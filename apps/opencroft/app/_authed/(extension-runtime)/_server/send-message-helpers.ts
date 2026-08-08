import {
  agentInstructionText,
  agentJobContext,
  agentJobName,
  agentNodeName,
  isAgentJobNode,
  isAgentNode,
} from '@/app/_authed/(agent)/_shared/agent-node-shape'

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
  /**
   * A group-chat thread reference (`<group-slug>:<agent-slug>:<thread-slug>`,
   * a whole session key, or a thread id) instead of an agent:job session.
   * Mutually exclusive with `agent`/`job`/`key`/`session` — carrying both is a
   * caller error, not a preference between them, so it is refused rather than
   * silently resolved one way.
   */
  thread?: string
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
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
    thread: optStr(obj['thread']),
  }
}

function findAgentBySlug(agentSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (isAgentNode(n) && slug(agentNodeName(n)) === agentSlug) {
      return n
    }
  }
  return null
}

function findJobBySlug(jobSlug: string, nodes: NodeLike[]): NodeLike | null {
  for (const n of nodes) {
    if (isAgentJobNode(n) && slug(agentJobName(n)) === jobSlug) {
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
    const text = instrNode ? agentInstructionText(instrNode).trim() : ''
    if (text) {
      instructions.push(text)
    }
  }

  return {
    agentName: agentNodeName(agentNode),
    agentNodeId: agentNode.id,
    jobName: agentJobName(jobNode),
    jobNodeId: jobNode.id,
    jobContext: agentJobContext(jobNode).trim(),
    instructions,
  }
}

// ── Reachability ────────────────────────────────────────────────────────
//
// What a send-message node may route to: an agent/job pair wired into ITS OWN
// space (per the original design note — agents/jobs from other spaces
// are never reachable from a given node). `agent:job` session routing and
// group-chat thread delivery both answer to this same authority, so it lives
// once, here, rather than as a second copy beside each caller.

// Node id -> the slugs of every job wired to it, via edges the agent:job
// session path already relies on (source = job node, target = agent node).
// Factored out of reachableAgentJobs so a caller that only has a NODE ID (a
// thread's target agent, known before its current display name is) can check
// reachability without resolving a name to compare by slug first.
function jobsByAgentNodeId(nodes: NodeLike[], edges: EdgeLike[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const edge of edges) {
    const job = nodes.find((n) => n.id === edge.source && isAgentJobNode(n))
    const jobName = job ? agentJobName(job) : ''
    if (!job || !jobName) {
      continue
    }
    const list = map.get(edge.target) ?? []
    list.push(slug(jobName))
    map.set(edge.target, list)
  }
  return map
}

/** Every agent in this space, with the job slugs wired to it (possibly none —
 *  an agent with no job edge is present but unreachable, since routing a
 *  session needs both halves of the pair). */
export function reachableAgentJobs(nodes: NodeLike[], edges: EdgeLike[]): { agent: string; jobs: string[] }[] {
  const jobsByAgentId = jobsByAgentNodeId(nodes, edges)
  const out: { agent: string; jobs: string[] }[] = []
  for (const node of nodes) {
    if (!isAgentNode(node)) {
      continue
    }
    const name = agentNodeName(node)
    if (!name) {
      continue
    }
    out.push({ agent: slug(name), jobs: jobsByAgentId.get(node.id) ?? [] })
  }
  return out
}

export function reachablePairKey(agent: string, job: string): string {
  return `${agent}::${job}`
}

/** Every `agent:job` pair this space's wiring actually supports. */
export function reachablePairs(nodes: NodeLike[], edges: EdgeLike[]): Set<string> {
  return new Set(reachableAgentJobs(nodes, edges).flatMap((a) => a.jobs.map((j) => reachablePairKey(a.agent, j))))
}

/**
 * Whether an agent NODE (identified by id, not name) has at least one job
 * wired to it in this space — the same authority `reachablePairs` grants the
 * agent:job session path, checked by identity so a caller that only knows a
 * target's node id (a group-chat thread's agent) need not resolve its current
 * display name first. An agent present in the space with zero job edges is
 * not reachable: that is exactly the state that would produce no pairs at
 * all, so a thread send must not be allowed anything a session send could not
 * already reach.
 */
export function isAgentNodeReachable(nodes: NodeLike[], edges: EdgeLike[], agentNodeId: string): boolean {
  return (jobsByAgentNodeId(nodes, edges).get(agentNodeId)?.length ?? 0) > 0
}
