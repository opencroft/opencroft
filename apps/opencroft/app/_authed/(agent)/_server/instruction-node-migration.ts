// Agent Instruction nodes are not a node type of the core: an agent's
// instructions are its own text (agent-instructions.ts). A graph saved with
// such nodes still holds them, so at server start each one's text is appended
// to the text of every agent it is wired to, under a heading with the node's
// name, and the node and its edges are deleted. Every node gives one report
// line, so nothing is dropped unsaid: one wired to no agent, or holding no
// text, is deleted with a line saying so (the unwired one's text in it).
//
// The text goes where the agent's Instructions tab shows it: the system
// prompt for a harness that takes one, the agent's own instruction file for
// every other. Appending is skipped where the agent's text already holds the
// same block, so a start that stopped between the append and the delete
// appends nothing twice when the next start finishes it. A subgraph port the
// node was wired through stays, with the stored edge on its other side.

import { findAdapter } from 'agent-client/resolve'

import { agentNodeName, isAgentNode } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import { coreType } from '@/app/_authed/(extension-runtime)/_core-types'
import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import { wiredEdgesOf } from '@/app/_authed/(extension-runtime)/_wired-edges'
import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/** The node type graphs stored Agent Instruction nodes under. */
export const INSTRUCTION_NODE_TYPE = coreType('agent-instruction')

const ORIGIN: GraphWriteOrigin = { kind: 'extension', name: 'instruction node migration' }
// The adapter an agent node without one runs (agent-instructions.ts).
const DEFAULT_ADAPTER = 'claude'

interface GraphNode {
  id?: string
  type?: string
  data?: Record<string, unknown>
}

interface GraphEdge {
  source?: string
  target?: string
}

type InstructionField = 'workspaceInstructions' | 'systemPrompt'

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Which of an agent node's texts its Instructions tab shows, and whether its harness reads it. */
export function instructionFieldOf(data: Record<string, unknown> | undefined): {
  field: InstructionField
  read: boolean
} {
  const target = findAdapter(str(data?.adapterId) || DEFAULT_ADAPTER)?.instructions
  if (target?.channel === 'system-prompt') {
    return { field: 'systemPrompt', read: true }
  }
  return { field: 'workspaceInstructions', read: target?.workspace !== undefined }
}

/** An instruction node's text as a section of an agent's text. */
export function instructionSection(name: string, text: string): string {
  return `## ${name}\n\n${text}`
}

/** `existing` with `section` appended after a blank line, or unchanged when it holds the section already. */
export function appendSection(existing: string, section: string): string {
  if (existing.includes(section)) {
    return existing
  }
  const head = existing.trimEnd()
  return head ? `${head}\n\n${section}\n` : `${section}\n`
}

/** Move every Agent Instruction node into its agents and delete it; one line per node. */
export async function migrateInstructionNodes(): Promise<string[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const lines: string[] = []
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const graphs = [...space.graphs.values()]
    const nodes = graphs.flatMap((g) => g.graph.nodes as GraphNode[])
    const instructions = nodes.filter((node) => node.type === INSTRUCTION_NODE_TYPE && node.id)
    if (instructions.length === 0) {
      continue
    }
    const agents = new Map(nodes.filter((node) => isAgentNode(node) && node.id).map((node) => [node.id, node]))
    // Joined through subgraph ports, as the wiring was read when it was delivered.
    const edges = graphs.flatMap((g) => wiredEdgesOf<GraphEdge>(g.graph))
    for (const instruction of instructions) {
      const id = instruction.id as string
      const name = str(instruction.data?.name).trim() || 'Instruction'
      const text = str(instruction.data?.instruction).trim()
      const wiredTo = [
        ...new Set(edges.filter((e) => e.source === id && e.target && agents.has(e.target)).map((e) => e.target)),
      ] as string[]
      const moved: string[] = []
      if (text) {
        for (const agentId of wiredTo) {
          const target = instructionFieldOf(agents.get(agentId)?.data)
          await updateNodeData(space.slug, agentId, (prev) => ({
            ...prev,
            [target.field]: appendSection(str(prev[target.field]), instructionSection(name, text)),
          }))
          const agentName = agentNodeName(agents.get(agentId) ?? {}) || 'Agent'
          const where = target.field === 'systemPrompt' ? 'system prompt' : 'instructions'
          moved.push(`${agentName} (${agentId})'s ${where}${target.read ? '' : ', which its harness does not read'}`)
        }
      }
      const graph = graphs.find((g) => (g.graph.nodes as GraphNode[]).some((node) => node.id === id))
      if (graph) {
        await mutateLiveGraph(
          `${space.slug}.${graph.slug}`,
          ORIGIN,
          (current) => {
            current.nodes = current.nodes.filter((node) => node.id !== id)
            current.edges = current.edges.filter((edge) => edge.source !== id && edge.target !== id)
          },
          { resolveContexts: false },
        )
      }
      const label = `"${name}" (${id}) in ${space.slug}`
      if (moved.length > 0) {
        lines.push(`moved ${label} into ${moved.join(', ')}; the node is deleted`)
      } else if (!text) {
        lines.push(`deleted ${label}: it held no text`)
      } else {
        lines.push(`deleted ${label}: wired to no agent; its text was ${JSON.stringify(text)}`)
      }
    }
  }
  return lines
}
