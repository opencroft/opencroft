// Every agent node of every space, read from the space graphs. Plain server
// functions, never a `createServerFn`, so server-side callers (group chats'
// `addMember`, validating an agent principal) call them without nesting one
// server fn inside another's handler.
//
// SERVER-ONLY. Nothing reachable from client code may import this module: its
// live exports would keep the spaces registry, and `@opencroft/db`'s native
// driver tail behind it, in the client build, which fails `vite build`
// outright. A browser reaches agents through a server fn that wraps these,
// such as the group-chat member picker's directory read.

import { agentNodeAvatar, agentNodeName, isAgentNode } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { slug } from '@/app/_authed/(server)/_server/types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

export interface AgentNodeRef {
  nodeId: string
  name: string
  avatar?: string
  spaceSlug: string
  spaceName: string
}

interface NodeShape {
  id?: string
  type?: string
  data?: {
    name?: string
    avatar?: string
  }
}

export async function listAgentNodesImpl(): Promise<AgentNodeRef[]> {
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const out: AgentNodeRef[] = []
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    // Every graph of the space: agents may sit on any of them, and this
    // answers for the space as a whole.
    const nodes = [...space.graphs.values()].flatMap((g) => g.graph.nodes as NodeShape[])
    for (const node of nodes) {
      if (!isAgentNode(node) || !node.id) {
        continue
      }
      out.push({
        nodeId: node.id,
        name: agentNodeName(node) || 'Agent',
        avatar: agentNodeAvatar(node),
        spaceSlug: space.slug,
        spaceName: space.name,
      })
    }
  }
  return out
}

/**
 * The agent a session's `mcpIdentity` names: agent-client hands it over as it
 * was given when the session was opened, the agent node's name slug. Null
 * whenever the answer is not exactly one agent — no identity, no node whose
 * name slugifies to it, or more than one: a caller acting for an ambiguous
 * identity would act for the wrong agent.
 */
export async function agentForMcpIdentity(identity: string | undefined): Promise<AgentNodeRef | null> {
  if (!identity) {
    return null
  }
  const matches = (await listAgentNodesImpl()).filter((node) => slug(node.name) === identity)
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/**
 * One agent as a name and a face: the group chat draws its agents from this,
 * and extensions read it through `host.agents`, so both show the same picture.
 * Three fields, like the people directory — an agent's instructions and space
 * stay out of it.
 */
export interface DirectoryAgent {
  id: string
  name: string
  avatarUrl: string | null
}

/** The directory's view of listed agent nodes, ordered by name. */
export function agentDirectoryOf(nodes: readonly Pick<AgentNodeRef, 'nodeId' | 'name' | 'avatar'>[]): DirectoryAgent[] {
  return nodes
    .map((node) => ({ id: node.nodeId, name: node.name, avatarUrl: node.avatar ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Every agent of every space, ordered by name. Ungated: each caller applies its own gate first. */
export async function listAgentDirectory(): Promise<DirectoryAgent[]> {
  return agentDirectoryOf(await listAgentNodesImpl())
}

/**
 * Every agent in a listing that goes by `agentName` — the one comparison, in
 * one place.
 *
 * IT ANSWERS THE COMPARISON AND NOTHING ELSE. What to do with the result is
 * the caller's, and the callers genuinely differ: a membership lookup takes
 * the first match because agent names are a decided-unique namespace, and an
 * attribution refuses unless there is exactly one, because stamping a message
 * with a name two nodes answer to would deliver it as an agent that did not
 * send it. Folding either policy in here would push the other one out.
 *
 * What must NOT differ is how a name is matched. Trimming, and exact rather
 * than normalised, are the two details that drift when they are retyped — and
 * they drift silently, because each copy keeps agreeing with itself. Three
 * call sites had written them out separately before this existed.
 *
 * Structural in its node type on purpose: a caller that holds the full listing
 * gets its own entries back, and one that holds a narrower shape is not made
 * to import a type it has no other use for.
 */
export function agentNodesNamed<T extends { name?: string }>(nodes: readonly T[], agentName: string): T[] {
  const trimmed = agentName.trim()
  return nodes.filter((node) => node.name === trimmed)
}

/**
 * An agent as the surface that is calling on its behalf identified it.
 *
 * A string is a NAME — what a surface holding no credential can assert (the
 * in-process tool bridge, from its session's bookkeeping) — and is looked up
 * through `agentNodesNamed` wherever it is used. The object is an agent
 * identified by its NODE, from a credential issued to that node; its `name` is
 * the node's name as it read when the credential resolved, carried for display
 * and never used to look the agent up again — two nodes may share it.
 */
export type AgentRef = string | { nodeId: string; name: string }

/** The name to show for an agent, whichever way it was identified. */
export function agentRefName(agent: AgentRef): string {
  return typeof agent === 'string' ? agent.trim() : agent.name
}
