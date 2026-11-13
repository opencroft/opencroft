// Agents run through a terminal picked on their node, and nowhere else. An
// agent node placed the ways agents ran before — in a Docker container by name
// (`containerName`), or on the server itself (no place set at all) — is moved
// to the terminal that is that place: the container's Application terminal,
// or the server's Localhost node. Only an unambiguous match moves it;
// otherwise it stays as it is, with an error that says why. This module is
// the decision alone, so it can be tested without a Docker host or a graph.

import type { NodeError } from '@opencroft/core'

/** An agent node still placed the way agents ran before terminals. */
export interface UnplacedAgent {
  nodeId: string
  // The container it ran in; absent for an agent that ran on the server.
  containerName?: string
  // Its slug (agent-placement-shared.ts), which names its directories.
  slug: string
}

/** A live terminal handle, as the graph lists it. */
export interface TerminalHandle {
  nodeId: string
  handleId: string
  // The owner's stored type, and its name for messages.
  type: string
  nodeName: string
}

/** The Localhost nodes an agent on the server can be moved to. */
export interface LocalhostNodes {
  // On the agent's own graph, and elsewhere in its space.
  inGraph: readonly string[]
  inSpace: readonly string[]
}

export type PlacementMove = { kind: 'move'; terminal: string; folder: string } | { kind: 'stay'; error: NodeError }

// The Application node type, whose terminal handles are one per replica,
// running or not, `instance-terminal-<container name>`.
const APPLICATION_TYPE = /\.application$/
const CONTAINER_TERMINAL_PREFIX = 'instance-terminal-'
/** The Localhost node's terminal handle. */
export const LOCALHOST_TERMINAL_HANDLE = 'terminal'

/**
 * Where an agent that ran in a Docker container goes: the one Application
 * whose container has that name, in the workdir it had there.
 */
export function planContainerMove(
  agent: UnplacedAgent & { containerName: string },
  handles: readonly TerminalHandle[],
): PlacementMove {
  const matches = handles.filter(
    (handle) =>
      APPLICATION_TYPE.test(handle.type) && handle.handleId === `${CONTAINER_TERMINAL_PREFIX}${agent.containerName}`,
  )
  const [only] = matches
  if (only && matches.length === 1) {
    return { kind: 'move', terminal: `${only.nodeId}/${only.handleId}`, folder: `/agents/${agent.slug}` }
  }
  const several = matches.length > 1
  return {
    kind: 'stay',
    error: {
      title: several
        ? 'Container placement is gone: several Applications found'
        : 'Container placement is gone: no Application found',
      detail: several
        ? `This agent ran in the Docker container "${agent.containerName}", and several Application nodes offer a terminal of that name (${matches.map((match) => match.nodeName).join(', ')}), so it was not moved.`
        : `This agent ran in the Docker container "${agent.containerName}", and no Application node offers that container's terminal, so it was not moved.`,
      next: several
        ? "Choose the Terminal in the agent's profile."
        : "Choose a Terminal in the agent's profile, such as one of an Application's instances.",
      path: 'containerName',
    },
  }
}

/**
 * Where an agent that ran on the server goes: the one Localhost node on its
 * graph, else the one in its space, in the workspace directory it had
 * (`workspace`, the server's own path).
 */
export function planServerMove(localhost: LocalhostNodes, workspace: string): PlacementMove {
  const candidates = localhost.inGraph.length > 0 ? localhost.inGraph : localhost.inSpace
  const [only] = candidates
  if (only && candidates.length === 1) {
    return { kind: 'move', terminal: `${only}/${LOCALHOST_TERMINAL_HANDLE}`, folder: workspace }
  }
  const several = candidates.length > 1
  return {
    kind: 'stay',
    error: {
      title: several
        ? 'Running on the server is gone: several Localhost nodes found'
        : 'Running on the server is gone: no Localhost node found',
      detail: several
        ? `This agent ran on the server itself, and its ${localhost.inGraph.length > 1 ? 'graph' : 'space'} has ${candidates.length} Localhost nodes, so it was not moved.`
        : 'This agent ran on the server itself, and its space has no Localhost node to run it through, so it was not moved.',
      next: several
        ? `Choose the Terminal in the agent's profile; its Folder is ${workspace}.`
        : `Add a Localhost node, or choose a Terminal in the agent's profile; its Folder was ${workspace}.`,
      path: 'terminal',
    },
  }
}
