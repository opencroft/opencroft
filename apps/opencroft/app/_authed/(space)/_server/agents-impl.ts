// The plain (non-`createServerFn`) implementation behind `listAgentNodes`,
// in its own module rather than alongside the server-fn export in agents.ts.
//
// THAT SEPARATION IS LOAD-BEARING FOR THE CLIENT BUILD, not tidiness.
// agents.ts is imported by browser components (ai-panel.tsx,
// use-chat-list-nodes.ts). It survives there only because its sole export is
// a `createServerFn`: the client build replaces the handler with an RPC stub,
// which leaves agents.ts's top-level imports unused and lets them — the
// spaces registry, and `@opencroft/db`'s native driver tail behind it — drop
// out of the browser bundle.
//
// A plain exported function in that file has no stub, so its live export
// binding keeps that whole import tail alive in the client build and ships
// native `.node` bindings to the browser, which fails `vite build` outright.
// That has broken a build before; the pattern below is the
// fix this file copies: impl in its own module, a thin server-fn-only wrapper
// beside it. Nothing reachable from client code may import THIS module.
//
// Server-side callers that must avoid nesting one `createServerFn` inside
// another's handler (group chats' `addMember`, validating an agent principal)
// therefore import from here.

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

export interface AgentJobRef {
  nodeId: string
  name: string
  context: string
  workingDirectory: string
}

export interface AgentInstructionRef {
  nodeId: string
  name: string
  instruction: string
}

export interface AgentNodeRef {
  nodeId: string
  name: string
  avatar?: string
  spaceSlug: string
  spaceName: string
  jobs: AgentJobRef[]
  instructions: AgentInstructionRef[]
}

interface NodeShape {
  id?: string
  type?: string
  data?: {
    name?: string
    avatar?: string
    context?: string
    workingDirectory?: string
    instruction?: string
  }
}

interface EdgeShape {
  source?: string
  sourceHandle?: string
  target?: string
  targetHandle?: string
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
    const nodes = space.graph.nodes as NodeShape[]
    const edges = space.graph.edges as EdgeShape[]
    const jobsByAgent = new Map<string, AgentJobRef[]>()
    const instructionsByAgent = new Map<string, AgentInstructionRef[]>()
    const jobsById = new Map<string, NodeShape>()
    const instructionsById = new Map<string, NodeShape>()
    for (const node of nodes) {
      if (node.type === 'agent-job' && node.id) {
        jobsById.set(node.id, node)
      }
      if (node.type === 'agent-instruction' && node.id) {
        instructionsById.set(node.id, node)
      }
    }
    for (const edge of edges) {
      if (!edge.source || !edge.target) {
        continue
      }
      // Jobs connected to agent via agent-in handle (skip unnamed jobs)
      const job = jobsById.get(edge.source)
      const jobName = job?.data?.name?.trim()
      if (job && jobName) {
        const list = jobsByAgent.get(edge.target) ?? []
        list.push({
          nodeId: edge.source,
          name: jobName,
          context: job.data?.context ?? '',
          workingDirectory: job.data?.workingDirectory ?? '',
        })
        jobsByAgent.set(edge.target, list)
      }
      // Instructions connected to agent via instructions-in handle
      const instr = instructionsById.get(edge.source)
      if (instr) {
        const list = instructionsByAgent.get(edge.target) ?? []
        list.push({
          nodeId: edge.source,
          name: instr.data?.name?.trim() || 'Instruction',
          instruction: instr.data?.instruction ?? '',
        })
        instructionsByAgent.set(edge.target, list)
      }
    }
    for (const node of nodes) {
      if (node.type !== 'agent' || !node.id) {
        continue
      }
      out.push({
        nodeId: node.id,
        name: node.data?.name?.trim() || 'Agent',
        avatar: node.data?.avatar,
        spaceSlug: space.slug,
        spaceName: space.name,
        jobs: jobsByAgent.get(node.id) ?? [],
        instructions: instructionsByAgent.get(node.id) ?? [],
      })
    }
  }
  return out
}
