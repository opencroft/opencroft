// The terminal picker's discovery, server-only: reached from server functions
// in actions.ts, which must stay free of plain exports.
import {
  routeTarget,
  type TerminalRouterData,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/terminal-router-shared'
import { TERMINAL_CONTEXT_HANDLE_TYPE, TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { describeGraphRefsImpl, type GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'
import {
  type HandleInfo,
  type HandleOwner,
  listGraphHandleOwners,
} from '@/app/_authed/(extension-runtime)/_server/host'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/** One pickable terminal of a source. */
export interface TerminalSourceTarget {
  /** "node-id/handle-id" -- the form every terminal-taking action accepts. */
  target: string
  handleId: string
  /** What the owning App calls this terminal, when it says. */
  label?: string
  /**
   * On a Terminal Router's route: the terminal the route reaches, and its
   * owner (null when nothing answers to it), so the route is named by it.
   */
  routed?: { target: string; ref: GraphRefInfo | null }
}

/** A node or App instance offering terminals, as the picker lists it. */
export interface TerminalSourceInfo {
  ref: GraphRefInfo
  /**
   * Its terminals; null when listing them asks something at runtime (a docker
   * host, an App), which `listTerminalSourceTargetsImpl` does for this one
   * source alone.
   */
  targets: TerminalSourceTarget[] | null
}

const TERMINAL_SOURCES = { role: 'source', handleType: TERMINAL_CONTEXT_HANDLE_TYPE } as const

// One space's list offers the routes of that space's Terminal Routers: a route
// is how the space reaches a terminal of another space, which its list does
// not offer. The list of every space leaves routers out. The terminals their
// routes reach are on it already under their own names, and it is what a
// router's own picker shows, where a route to a route is refused.
function pickable(owner: HandleOwner, spaceSlug: string | undefined): boolean {
  return spaceSlug !== undefined || owner.type !== TERMINAL_ROUTER_NODE_TYPE
}

function toTargets(handles: HandleInfo[]): TerminalSourceTarget[] {
  return handles.map((handle) => ({
    target: `${handle.nodeId}/${handle.handleId}`,
    handleId: handle.handleId,
    label: handle.liveLabel,
  }))
}

// A router's routes carry the terminal each one reaches, read from the
// router's stored routes.
async function targetsOf(owner: HandleOwner): Promise<TerminalSourceTarget[]> {
  const targets = toTargets(await owner.handles())
  if (owner.type !== TERMINAL_ROUTER_NODE_TYPE) {
    return targets
  }
  const node = getSpacesRegistry()
    .findByNode(owner.id)
    ?.graph.graph.nodes.find((n) => (n as { id?: string }).id === owner.id) as { data?: TerminalRouterData } | undefined
  const reached = targets.map((target) => routeTarget(target.handleId, node?.data ?? {}))
  const refs = await describeGraphRefsImpl(reached.filter((target) => target !== undefined))
  return targets.map((target, i) => {
    const routed = reached[i]
    return routed === undefined ? target : { ...target, routed: { target: routed, ref: refs[routed] ?? null } }
  })
}

/**
 * Every terminal source, optionally of one space, without waiting on any of
 * them: sources whose terminals are declared come with them, the rest with
 * `targets: null`.
 */
export async function listTerminalSourcesImpl(spaceSlug?: string): Promise<TerminalSourceInfo[]> {
  const owners = (await listGraphHandleOwners(TERMINAL_SOURCES, { spaceSlug })).filter((owner) =>
    pickable(owner, spaceSlug),
  )
  const refs = await describeGraphRefsImpl(owners.map((owner) => owner.id))
  const sources = await Promise.all(
    owners.map(async (owner): Promise<TerminalSourceInfo | null> => {
      const ref = refs[owner.id]
      if (!ref) {
        return null
      }
      return { ref, targets: owner.dynamic ? null : await targetsOf(owner) }
    }),
  )
  return sources.filter((source) => source !== null)
}

/**
 * The terminals of one source (a node id or App instance id); [] for an id
 * that offers none. A router is asked here only from a space's list, which
 * offers its routes.
 */
export async function listTerminalSourceTargetsImpl(id: string): Promise<TerminalSourceTarget[]> {
  const [owner] = await listGraphHandleOwners(TERMINAL_SOURCES, { ownerId: id })
  return owner ? targetsOf(owner) : []
}
