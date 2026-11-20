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
  /** The terminal's one name (see `terminalTitle`). */
  title?: string
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
   * Its terminals, never empty; null when listing them asks something at
   * runtime (a docker host, an App), which `listTerminalSourceTargetsImpl`
   * does for this one source alone.
   */
  targets: TerminalSourceTarget[] | null
}

const TERMINAL_SOURCES = { role: 'source', handleType: TERMINAL_CONTEXT_HANDLE_TYPE } as const

function toTargets(handles: HandleInfo[]): TerminalSourceTarget[] {
  return handles.map((handle) => ({
    target: `${handle.nodeId}/${handle.handleId}`,
    handleId: handle.handleId,
    title: handle.title,
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
 * them: sources whose terminals are known from their manifest and data come
 * with them, the rest with `targets: null`. A source known to have no
 * terminal now (a router with no resolved route) is left out. Every node whose
 * type declares a terminal is a source, a Terminal Router's routes included; a
 * consumer that must not offer some of them leaves them out itself.
 */
export async function listTerminalSourcesImpl(spaceSlug?: string): Promise<TerminalSourceInfo[]> {
  const owners = await listGraphHandleOwners(TERMINAL_SOURCES, { spaceSlug })
  const refs = await describeGraphRefsImpl(owners.map((owner) => owner.id))
  const sources = await Promise.all(
    owners.map(async (owner): Promise<TerminalSourceInfo | null> => {
      const ref = refs[owner.id]
      if (!ref) {
        return null
      }
      if (owner.dynamic) {
        return { ref, targets: null }
      }
      const targets = await targetsOf(owner)
      return targets.length > 0 ? { ref, targets } : null
    }),
  )
  return sources.filter((source) => source !== null)
}

/** The terminals of one source (a node id or App instance id); [] for an id that offers none. */
export async function listTerminalSourceTargetsImpl(id: string): Promise<TerminalSourceTarget[]> {
  const [owner] = await listGraphHandleOwners(TERMINAL_SOURCES, { ownerId: id })
  return owner ? targetsOf(owner) : []
}
