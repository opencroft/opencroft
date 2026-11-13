// Agents run through a terminal picked on their node (agent-placement-shared.ts).
// Agent nodes placed the ways agents ran before — by Docker container name, or
// on the server itself — are moved to the terminal that is that place
// (placement-move.ts decides). Run at server start for every such agent, and
// again for one agent when it opens a session, since an Application's
// terminals are listed only while its container runs. An agent that cannot be
// moved keeps its data and carries the error that says why.
//
// A moved agent works where it worked: its Folder is the directory it worked
// in, its harness home is the one it had, and the shared instruction text of
// its old place is carried to the terminal's place. The Custom harness runs
// inside the server process and uses no terminal, so its agents are left as
// they are.

import { mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { findAdapter } from 'agent-client/resolve'

import {
  type InstructionPlace,
  instructionPlace,
  readSharedInstructions,
  writeSharedInstructions,
} from '@/app/_authed/(agent)/_server/instruction-store'
import { AGENT_NODE_TYPE } from '@/app/_authed/(agent)/_shared/agent-node-shape'
import {
  type PlacementMove,
  planContainerMove,
  planServerMove,
  type UnplacedAgent,
} from '@/app/_authed/(agent)/_shared/placement-move'
import {
  AGENT_PLACEMENT_ERROR_SOURCE,
  agentPlacement,
  agentSlug,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/agent-placement-shared'
import { TERMINAL_CONTEXT_HANDLE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

// The source the move's error is stored under on the agent node.
const ERROR_SOURCE = AGENT_PLACEMENT_ERROR_SOURCE
const LOCALHOST_TYPE = 'builtin.core.localhost'

interface GraphNode {
  id?: string
  type?: string
  data?: Record<string, unknown>
}

interface FoundAgent extends UnplacedAgent {
  spaceSlug: string
  name: string
  // The Localhost nodes on its graph and elsewhere in its space.
  localhost: { inGraph: string[]; inSpace: string[] }
}

/** Whether an agent node still needs a terminal: it names none, and its harness runs through one. */
export function needsTerminal(data: Record<string, unknown> | undefined): boolean {
  const terminal = data?.terminal
  if (typeof terminal === 'string' && terminal.trim()) {
    return false
  }
  const adapterId = typeof data?.adapterId === 'string' && data.adapterId ? data.adapterId : 'claude'
  return findAdapter(adapterId)?.kind !== 'native'
}

/**
 * Move every agent still placed the old ways, or only `nodeId`, and answer
 * one line per agent saying what happened.
 */
export async function migrateAgentPlacements(nodeId?: string): Promise<string[]> {
  const agents = (await unplacedAgents()).filter((agent) => nodeId === undefined || agent.nodeId === nodeId)
  if (agents.length === 0) {
    return []
  }
  const handles = agents.some((agent) => agent.containerName) ? await applicationTerminals() : []
  const lines: string[] = []
  for (const agent of agents) {
    const move = agent.containerName
      ? planContainerMove({ ...agent, containerName: agent.containerName }, handles)
      : planServerMove(agent.localhost, serverWorkspace(agent))
    lines.push(await apply(agent, move))
  }
  return lines
}

/**
 * Whether an agent node still shows the move's error while it no longer
 * needs a terminal: one was picked in its profile, or it uses none. Cleared
 * when its session opens, and by the profile's terminal check.
 */
export function holdsStalePlacementError(data: Record<string, unknown> | undefined): boolean {
  const errors = data?.__errors
  return (
    Array.isArray(errors) &&
    errors.some((error) => (error as { source?: unknown } | null)?.source === ERROR_SOURCE) &&
    !needsTerminal(data)
  )
}

async function unplacedAgents(): Promise<FoundAgent[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const found: FoundAgent[] = []
  for (const summary of registry.list()) {
    const graphs = [...(registry.getBySlug(summary.slug)?.graphs.values() ?? [])].map(
      (graph) => graph.graph.nodes as GraphNode[],
    )
    const localhostOf = (nodes: GraphNode[]) =>
      nodes.filter((node) => node.type === LOCALHOST_TYPE && node.id).map((node) => node.id as string)
    const inSpace = graphs.flatMap(localhostOf)
    for (const nodes of graphs) {
      for (const node of nodes) {
        if (node.type !== AGENT_NODE_TYPE || !node.id || !needsTerminal(node.data)) {
          continue
        }
        const name = typeof node.data?.name === 'string' ? node.data.name : ''
        const containerName = typeof node.data?.containerName === 'string' ? node.data.containerName.trim() : ''
        found.push({
          nodeId: node.id,
          spaceSlug: summary.slug,
          name: name || node.id,
          slug: agentSlug(name) || node.id,
          ...(containerName ? { containerName } : {}),
          localhost: { inGraph: localhostOf(nodes), inSpace },
        })
      }
    }
  }
  return found
}

// The workspace an agent on the server worked in, under the data volume.
function serverWorkspace(agent: FoundAgent): string {
  return join(process.cwd(), 'data', 'agent-workspace', agent.slug)
}

// The live terminals of Application nodes. Imported when used: the host
// module reaches this one back through the agent client instance.
async function applicationTerminals() {
  const { listGraphHandleOwners } = await import('@/app/_authed/(extension-runtime)/_server/host')
  const owners = await listGraphHandleOwners({ handleType: TERMINAL_CONTEXT_HANDLE_TYPE, role: 'source' })
  const lists = await Promise.all(
    owners.filter((owner) => owner.type.endsWith('.application')).map((owner) => owner.handles().catch(() => [])),
  )
  return lists.flat()
}

async function apply(agent: FoundAgent, move: PlacementMove): Promise<string> {
  const { setNodeErrors } = await import('@/app/_authed/(extension-runtime)/_server/host')
  const from = agent.containerName ? `container "${agent.containerName}"` : 'the server'
  if (move.kind === 'stay') {
    await setNodeErrors(agent.nodeId, ERROR_SOURCE, [move.error])
    return `left ${agent.name} (${agent.nodeId}) on ${from}: ${move.error.title}`
  }
  if (!agent.containerName) {
    // An agent that never ran has no workspace yet, and a Folder must exist
    // on its terminal (placementOnTerminal); this server is that terminal.
    await mkdir(move.folder, { recursive: true })
    await keepServerHarnessHome(agent, move.folder)
  }
  await updateNodeData(agent.spaceSlug, agent.nodeId, (prev) => {
    const { containerName: _moved, ...rest } = prev
    return { ...rest, terminal: move.terminal, terminalFolder: move.folder }
  })
  const oldPlace: InstructionPlace = agent.containerName ? `container:${agent.containerName}` : 'host'
  const carried = await carrySharedText(oldPlace, move.terminal)
  await setNodeErrors(agent.nodeId, ERROR_SOURCE, [])
  return `moved ${agent.name} (${agent.nodeId}) from ${from} to terminal ${move.terminal}, folder ${move.folder}${carried ? ', shared text carried' : ''}`
}

// An agent on the server kept its harness home apart from its workspace
// (data/agent-harness-home/<slug>). Through a terminal its home is beside its
// Folder; the directory moves there so a harness's sign-in stays with it.
// Left alone when there is none, or the new place is taken.
async function keepServerHarnessHome(agent: FoundAgent, folder: string): Promise<void> {
  const from = join(process.cwd(), 'data', 'agent-harness-home', agent.slug)
  const to = agentPlacement({ name: agent.name, terminal: 'moved', terminalFolder: folder }, agent.nodeId, {
    cwd: process.cwd(),
    join,
  }).harnessHome
  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )
  if (!(await exists(from)) || (await exists(to))) {
    return
  }
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
}

// The old place's shared instruction text becomes the terminal's, unless the
// terminal's place has a text of its own already. The old row stays, for
// other agents of that place still to move.
async function carrySharedText(oldPlace: InstructionPlace, terminal: string): Promise<boolean> {
  const from = await readSharedInstructions(oldPlace)
  if (!from.text) {
    return false
  }
  const place = instructionPlace({ terminal })
  const to = await readSharedInstructions(place)
  if (to.text) {
    return false
  }
  const written = await writeSharedInstructions(
    place,
    from.text,
    { updatedBy: from.updatedBy, adoptedFrom: from.adoptedFrom },
    to.version,
  )
  return written !== null
}

/** Clear the move's error from an agent that no longer needs a terminal. */
export async function clearStalePlacementError(
  nodeId: string,
  data: Record<string, unknown> | undefined,
): Promise<void> {
  if (holdsStalePlacementError(data)) {
    const { setNodeErrors } = await import('@/app/_authed/(extension-runtime)/_server/host')
    await setNodeErrors(nodeId, ERROR_SOURCE, [])
  }
}
