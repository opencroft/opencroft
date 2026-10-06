// The terminal picker's discovery, server-only: reached from server functions
// in actions.ts, which must stay free of plain exports.
import { TERMINAL_CONTEXT_HANDLE_TYPE, TERMINAL_ROUTER_NODE_TYPE } from '@/app/_authed/(extension-runtime)/_core-types'
import { describeGraphRefsImpl, type GraphRefInfo } from '@/app/_authed/(extension-runtime)/_server/graph-refs'
import {
  type HandleInfo,
  type HandleOwner,
  listGraphHandleOwners,
} from '@/app/_authed/(extension-runtime)/_server/host'

/** One pickable terminal of a source. */
export interface TerminalSourceTarget {
  /** "node-id/handle-id" -- the form every terminal-taking action accepts. */
  target: string
  handleId: string
  /** What the owning App calls this terminal, when it says. */
  label?: string
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

// A router's outputs are terminals already on this list under their own name;
// offering them again would list each routed terminal once per router that
// carries it.
function pickable(owner: HandleOwner): boolean {
  return owner.type !== TERMINAL_ROUTER_NODE_TYPE
}

function toTargets(handles: HandleInfo[]): TerminalSourceTarget[] {
  return handles.map((handle) => ({
    target: `${handle.nodeId}/${handle.handleId}`,
    handleId: handle.handleId,
    label: handle.liveLabel,
  }))
}

/**
 * Every terminal source, optionally of one space, without waiting on any of
 * them: sources whose terminals are declared come with them, the rest with
 * `targets: null`.
 */
export async function listTerminalSourcesImpl(spaceSlug?: string): Promise<TerminalSourceInfo[]> {
  const owners = (await listGraphHandleOwners(TERMINAL_SOURCES, { spaceSlug })).filter(pickable)
  const refs = await describeGraphRefsImpl(owners.map((owner) => owner.id))
  const sources = await Promise.all(
    owners.map(async (owner): Promise<TerminalSourceInfo | null> => {
      const ref = refs[owner.id]
      if (!ref) {
        return null
      }
      return { ref, targets: owner.dynamic ? null : toTargets(await owner.handles()) }
    }),
  )
  return sources.filter((source) => source !== null)
}

/** The terminals of one source (a node id or App instance id); [] for an id that offers none. */
export async function listTerminalSourceTargetsImpl(id: string): Promise<TerminalSourceTarget[]> {
  const [owner] = (await listGraphHandleOwners(TERMINAL_SOURCES, { ownerId: id })).filter(pickable)
  return owner ? toTargets(await owner.handles()) : []
}
