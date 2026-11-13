// Reading and writing an agent's instruction texts by agent: what the
// `agent_instructions_*` MCP tools and `@opencroft/server/agents` answer. The
// storage is instruction-store.ts; which file each text becomes is the
// harness's, from agent-client.
//
// Not authorised here, like the host's other node writes: each caller applies
// its own gate first. A write is a write to the agent node (or, for the shared
// text, to every agent in its place), so it takes the gate a node edit takes.

import { join } from 'node:path'

import type { InstructionRereads } from 'agent-client/harness-adapters'
import { instructionFilePaths } from 'agent-client/instruction-paths'
import { findAdapter } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'

import {
  type AgentInstructionData,
  type AgentInstructionNode,
  findAgentInstructionNode,
  type InstructionPlace,
  instructionPlace,
  readSharedInstructions,
  writeSharedInstructions,
} from '@/app/_authed/(agent)/_server/instruction-store'
import { agentPlacement } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/agent-placement-shared'
import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import { listGroupChatsOfAgentNode } from '@/app/_authed/(group-chats)/_server/model'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

export type InstructionFileRole = 'shared' | 'agent' | 'system-prompt'

export interface AgentInstructionFile {
  role: InstructionFileRole
  // The file the text is written to, as configured; none for a system prompt.
  path?: string
  // The shared text's place, and the agents in it whose harness reads it.
  place?: InstructionPlace
  sharedWith?: string[]
  rereads?: InstructionRereads
  text: string
  // For the shared text: its row's version, what a write passes back with `place` as `expected`.
  version?: number
}

export interface AgentInstructions {
  agent: { nodeId: string; name: string }
  // The harness's label, or its adapter id when it has none.
  harness: string
  // One entry per text the harness reads; empty for a harness that keeps its own files.
  files: AgentInstructionFile[]
  // The chats the agent is in, whose topic and pinned notes reach it too.
  chats: { id: string; name: string }[]
}

export interface AgentInstructionsWrite {
  agent: string
  role: InstructionFileRole
  place?: InstructionPlace
  sharedWith?: string[]
  // The shared text's version after the write.
  version?: number
  // Nothing was written: another write had moved the shared text past the expected version. This is what it is now.
  conflict?: { text: string; version: number; updatedBy?: string }
}

// Where and at which version a writer read the shared text: a file's `place` and `version`.
export interface SharedTextRead {
  place: string
  version: number
}

export class AgentInstructionsError extends Error {}

const DEFAULT_ADAPTER = 'claude'

/** The agent a node id or an exact agent name names, refusing a name two agents share. */
export async function resolveInstructionAgent(agent: string): Promise<AgentInstructionNode & { name: string }> {
  const agents = await listAgentNodesImpl()
  const byId = agents.find((candidate) => candidate.nodeId === agent)
  const matches = byId ? [byId] : agents.filter((candidate) => candidate.name === agent)
  if (matches.length > 1) {
    throw new AgentInstructionsError(
      `${matches.length} agents are named "${agent}": pass a node id (${matches.map((m) => m.nodeId).join(', ')}).`,
    )
  }
  const found = matches[0] ? await findAgentInstructionNode(matches[0].nodeId) : null
  if (!matches[0] || !found) {
    throw new AgentInstructionsError(`No agent "${agent}": pass an agent node id or an agent's name.`)
  }
  return { ...found, name: matches[0].name }
}

// Enough of a selection to say where the harness reads its files: placement
// and harness, no provider or credential.
function selectionOf(node: AgentInstructionNode): AgentSelection {
  const placement = agentPlacement(node.data, node.nodeId, { cwd: process.cwd(), join })
  return {
    providerId: '',
    adapterId: node.data.adapterId ?? DEFAULT_ADAPTER,
    model: '',
    apiKey: '',
    cwd: placement.cwd,
    harnessHome: placement.harnessHome,
    shell: placement.terminal,
  }
}

/** The names of the agents in a place whose harness reads a shared file there. */
async function agentsSharing(place: InstructionPlace): Promise<string[]> {
  const names: string[] = []
  for (const ref of await listAgentNodesImpl()) {
    const node = await findAgentInstructionNode(ref.nodeId)
    if (node && instructionPlace(node.data) === place && readsSharedFile(node.data)) {
      names.push(ref.name)
    }
  }
  return names.sort((a, b) => a.localeCompare(b))
}

function readsSharedFile(data: AgentInstructionData): boolean {
  return findAdapter(data.adapterId ?? DEFAULT_ADAPTER)?.instructions?.home !== undefined
}

export async function readAgentInstructions(agent: string): Promise<AgentInstructions> {
  const node = await resolveInstructionAgent(agent)
  const selection = selectionOf(node)
  const adapter = findAdapter(selection.adapterId)
  const files: AgentInstructionFile[] = []
  if (adapter?.instructions?.channel === 'system-prompt') {
    files.push({ role: 'system-prompt', text: node.data.systemPrompt ?? '' })
  }
  for (const file of instructionFilePaths(selection)) {
    if (file.role === 'agent') {
      files.push({ ...file, text: node.data.workspaceInstructions ?? '' })
      continue
    }
    const place = instructionPlace(node.data)
    const shared = await readSharedInstructions(place)
    files.unshift({
      ...file,
      place,
      sharedWith: await agentsSharing(place),
      text: shared.text,
      version: shared.version,
    })
  }
  const chats = (await listGroupChatsOfAgentNode(node.nodeId))
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    agent: { nodeId: node.nodeId, name: node.name },
    harness: adapter?.label ?? selection.adapterId,
    files,
    chats,
  }
}

// How often a shared write is retried when another lands between its read and its write.
const SHARED_WRITE_ATTEMPTS = 3

/**
 * Write one of an agent's texts: its own, its system prompt, or the shared
 * text of its place. Answers what was written and, for the shared text, who
 * else reads it. A role the agent's harness does not read is refused.
 *
 * A shared write with `expected` is applied only to the place and version
 * its writer read. When the agent has moved to another place since, it is
 * refused; when another write landed on the place since, nothing is written
 * and the answer carries the current text as `conflict`. Without `expected`,
 * the write applies to whatever is in the agent's place now.
 */
export async function writeAgentInstructions(
  agent: string,
  role: InstructionFileRole,
  text: string,
  options: { updatedBy?: string; expected?: SharedTextRead } = {},
): Promise<AgentInstructionsWrite> {
  const { updatedBy, expected } = options
  const node = await resolveInstructionAgent(agent)
  const adapterId = node.data.adapterId ?? DEFAULT_ADAPTER
  const target = findAdapter(adapterId)?.instructions
  const harness = findAdapter(adapterId)?.label ?? adapterId
  if (target?.channel === 'system-prompt') {
    if (role !== 'system-prompt') {
      throw new AgentInstructionsError(
        `${harness} takes its instructions as a system prompt: write role "system-prompt".`,
      )
    }
    await updateNodeData(node.spaceSlug, node.nodeId, (prev) => ({ ...prev, systemPrompt: text }))
    return { agent: node.name, role }
  }
  if (role === 'system-prompt' || !target?.[role === 'agent' ? 'workspace' : 'home']) {
    throw new AgentInstructionsError(
      role === 'system-prompt'
        ? `${harness} reads instruction files, not a system prompt: write role "agent" or "shared".`
        : `${harness} keeps its own instruction files; OpenCroft does not write them.`,
    )
  }
  if (role === 'agent') {
    await updateNodeData(node.spaceSlug, node.nodeId, (prev) => ({ ...prev, workspaceInstructions: text }))
    return { agent: node.name, role }
  }
  const place = instructionPlace(node.data)
  if (expected) {
    if (expected.place !== place) {
      throw new AgentInstructionsError(
        `${node.name} reads the shared text of ${place} now, not of ${expected.place}: nothing was written.`,
      )
    }
    const written = await writeSharedInstructions(place, text, { updatedBy }, expected.version)
    if (written) {
      return { agent: node.name, role, place, sharedWith: await agentsSharing(place), version: written.version }
    }
    const current = await readSharedInstructions(place)
    return {
      agent: node.name,
      role,
      place,
      conflict: { text: current.text, version: current.version, updatedBy: current.updatedBy },
    }
  }
  for (let attempt = 0; attempt < SHARED_WRITE_ATTEMPTS; attempt += 1) {
    const current = await readSharedInstructions(place)
    const written = await writeSharedInstructions(place, text, { updatedBy }, current.version)
    if (written) {
      return { agent: node.name, role, place, sharedWith: await agentsSharing(place), version: written.version }
    }
  }
  throw new AgentInstructionsError(`The shared text of ${place} kept changing while it was written: try again.`)
}
