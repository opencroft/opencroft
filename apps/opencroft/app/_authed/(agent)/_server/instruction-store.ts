// Where an agent's two instruction texts are kept, and the hook that hands
// them to agent-client (`loadInstructionFiles`), which writes them as the
// harness's files. The agent's own text is `data.workspaceInstructions` on
// its node. The shared text belongs to the place the agent runs in — one
// terminal, or this server — and is one Setting row per place, written with
// the row's compare-and-swap version.

import type { InstructionTexts } from 'agent-client/instruction-files'
import type { AgentSelection } from 'agent-client/types'

import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import { agentForMcpIdentity } from '@/app/_authed/(space)/_server/agents-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { getSetting, upsertSettingCas } from '@/server/data'

/**
 * A place agents run in: a terminal by its target. `host` (agents that ran on
 * the server) and `container:<name>` (agents that ran in a Docker container)
 * are the places agents had before terminals, read to carry their text to the
 * terminal an agent moves to (placement-migration.ts); `host` is also the
 * place of the Custom harness, which runs in the server and has no files.
 */
export type InstructionPlace = `terminal:${string}` | `container:${string}` | 'host'

export function instructionPlace(agent: { terminal?: string }): InstructionPlace {
  const terminal = agent.terminal?.trim()
  return terminal ? `terminal:${terminal}` : 'host'
}

export interface SharedInstructions {
  text: string
  // ISO time of the last write, and who made it; absent while nothing was written.
  updatedAt?: string
  updatedBy?: string
  // The file the text was taken from, when it was adopted rather than written.
  adoptedFrom?: string
  // The row's version: what a write passes back to be applied.
  version: number
}

const SETTING_PREFIX = 'agent-shared-instructions:'

export async function readSharedInstructions(place: InstructionPlace): Promise<SharedInstructions> {
  const row = await getSetting(`${SETTING_PREFIX}${place}`)
  if (!row) {
    return { text: '', version: 0 }
  }
  const data = JSON.parse(row.data) as Omit<SharedInstructions, 'version'>
  return { ...data, text: typeof data.text === 'string' ? data.text : '', version: row.version }
}

/**
 * Write a place's shared text if the row is still at `expectedVersion`
 * (0 when there is none). Null when another write landed first: the caller
 * reads the current text and decides again, rather than overwriting it.
 */
export async function writeSharedInstructions(
  place: InstructionPlace,
  text: string,
  by: { updatedBy?: string; adoptedFrom?: string },
  expectedVersion: number,
): Promise<SharedInstructions | null> {
  const data = { text, updatedAt: new Date().toISOString(), ...by }
  const row = await upsertSettingCas(`${SETTING_PREFIX}${place}`, JSON.stringify(data), expectedVersion)
  return row ? { ...data, version: row.version } : null
}

/** The fields of an agent node the instruction texts are read from. */
export interface AgentInstructionData {
  name?: string
  adapterId?: string
  terminal?: string
  terminalFolder?: string
  workspaceInstructions?: string
  systemPrompt?: string
}

export interface AgentInstructionNode {
  nodeId: string
  spaceSlug: string
  data: AgentInstructionData
}

export async function findAgentInstructionNode(nodeId: string): Promise<AgentInstructionNode | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const ref = registry.findByNode(nodeId)
  const node = (ref?.graph.graph.nodes as { id?: string; data?: AgentInstructionData }[] | undefined)?.find(
    (candidate) => candidate.id === nodeId,
  )
  return ref && node ? { nodeId, spaceSlug: ref.space.slug, data: node.data ?? {} } : null
}

/**
 * agent-client's `loadInstructionFiles`: the texts of the agent a session's
 * `mcpIdentity` names, read fresh at every call so an edit reaches the next
 * session open or message. Undefined when the identity names no single agent,
 * and the engine then writes nothing.
 *
 * An adopted text is stored only while its role's text is still empty: two
 * sessions opening at once in one place each adopt the same file, and an
 * edit made meanwhile wins over the file.
 */
export async function loadInstructionTexts(selection: AgentSelection): Promise<InstructionTexts | undefined> {
  const ref = await agentForMcpIdentity(selection.mcpIdentity)
  const agent = ref ? await findAgentInstructionNode(ref.nodeId) : null
  if (!agent) {
    return undefined
  }
  const place = instructionPlace({ terminal: selection.shell })
  const shared = await readSharedInstructions(place)
  return {
    shared: shared.text,
    agent: agent.data.workspaceInstructions ?? '',
    systemPrompt: agent.data.systemPrompt,
    onAdopt: async (role, text, path) => {
      if (role === 'agent') {
        await updateNodeData(agent.spaceSlug, agent.nodeId, (prev) =>
          prev.workspaceInstructions ? prev : { ...prev, workspaceInstructions: text },
        )
        return
      }
      const current = await readSharedInstructions(place)
      if (!current.text) {
        await writeSharedInstructions(place, text, { adoptedFrom: path }, current.version)
      }
    },
  }
}
