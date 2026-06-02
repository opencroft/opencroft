import { createServerFn } from '@tanstack/react-start'

import { getSpacesRegistry } from '@/app/(space)/_server/store'

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
  backend: 'openclaw' | 'local'
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
    backend?: 'openclaw' | 'local'
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

export const listAgentNodes = createServerFn().handler(async (): Promise<AgentNodeRef[]> => {
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
        backend: node.data?.backend === 'local' ? 'local' : 'openclaw',
        spaceSlug: space.slug,
        spaceName: space.name,
        jobs: jobsByAgent.get(node.id) ?? [],
        instructions: instructionsByAgent.get(node.id) ?? [],
      })
    }
  }
  return out
})
