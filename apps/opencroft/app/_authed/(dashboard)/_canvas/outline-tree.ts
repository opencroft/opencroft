import type { GraphOutlineItem } from 'ui/nodes/graph-outline'

import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { ancestors, type IsFrame, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'

/** What the Outline shows of one node, beside its place in the tree. */
export type OutlineEntry = Omit<GraphOutlineItem, 'id' | 'members'>

/** Siblings as they are drawn: top to bottom, then left to right. Siblings share a parent, so their positions compare as they are. */
export function drawnOrder(a: TreeNode, b: TreeNode): number {
  return (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0)
}

/**
 * The Outline's tree of `nodes`, every level of the graph: the top level, each
 * frame and subgraph with its members under it, siblings in drawn order (the
 * Outline lists each level's containers first, keeping this order). A
 * frame or a subgraph is given `members` even when it has none, so its row
 * expands; a node holding members is listed as one whatever its type. A
 * subgraph's row is marked as one. A node whose parent is not among `nodes`
 * is at the top level, where the canvas draws it.
 */
export function outlineTree<N extends TreeNode>(
  nodes: readonly N[],
  isFrame: IsFrame<N>,
  describe: (node: N) => OutlineEntry,
): GraphOutlineItem[] {
  const ids = new Set(nodes.map((n) => n.id))
  const children = new Map<string | undefined, N[]>()
  for (const node of nodes) {
    const parentId = node.parentId && ids.has(node.parentId) ? node.parentId : undefined
    children.set(parentId, [...(children.get(parentId) ?? []), node])
  }
  const level = (parentId: string | undefined): GraphOutlineItem[] =>
    [...(children.get(parentId) ?? [])].sort(drawnOrder).map((node) => ({
      id: node.id,
      ...describe(node),
      ...(isSubgraph(node) ? { subgraph: true } : {}),
      ...(isFrame(node) || isSubgraph(node) || children.has(node.id) ? { members: level(node.id) } : {}),
    }))
  return level(undefined)
}

/**
 * Which rows the Outline folds. A frame is expanded until someone collapses
 * it. A subgraph starts collapsed, as its members are another canvas, and is
 * expanded once someone expands it or its canvas, or one inside it, is opened.
 */
export interface OutlineFolds {
  collapsedFrames: ReadonlySet<string>
  expandedSubgraphs: ReadonlySet<string>
}

export const NO_FOLDS: OutlineFolds = { collapsedFrames: new Set(), expandedSubgraphs: new Set() }

/** The rows `folds` shows collapsed, of `nodes`: the Outline's `collapsed`. */
export function collapsedRows(folds: OutlineFolds, nodes: readonly TreeNode[]): Set<string> {
  const out = new Set(folds.collapsedFrames)
  for (const node of nodes) {
    if (isSubgraph(node) && !folds.expandedSubgraphs.has(node.id)) {
      out.add(node.id)
    }
  }
  return out
}

/** `folds` after the Outline asked for `collapsed` (see `collapsedRows`), of `nodes`. */
export function foldsFor(collapsed: ReadonlySet<string>, nodes: readonly TreeNode[]): OutlineFolds {
  const subgraphs = new Set(nodes.filter(isSubgraph).map((n) => n.id))
  return {
    collapsedFrames: new Set([...collapsed].filter((id) => !subgraphs.has(id))),
    expandedSubgraphs: new Set([...subgraphs].filter((id) => !collapsed.has(id))),
  }
}

/**
 * `folds` with the open level's rows shown: `level` (a subgraph's id, or
 * undefined for the top level) and every frame and subgraph it lies in
 * expanded. Returns `folds` itself when they all are.
 */
export function foldsShowingLevel<N extends TreeNode>(
  folds: OutlineFolds,
  level: string | undefined,
  byId: ReadonlyMap<string, N>,
): OutlineFolds {
  const open = level && byId.has(level) ? [byId.get(level) as N, ...ancestors(level, byId)] : []
  const subgraphs = open.filter(isSubgraph).map((n) => n.id)
  const frames = new Set(open.filter((n) => !isSubgraph(n)).map((n) => n.id))
  if (
    subgraphs.every((id) => folds.expandedSubgraphs.has(id)) &&
    ![...frames].some((id) => folds.collapsedFrames.has(id))
  ) {
    return folds
  }
  return {
    collapsedFrames: new Set([...folds.collapsedFrames].filter((id) => !frames.has(id))),
    expandedSubgraphs: new Set([...folds.expandedSubgraphs, ...subgraphs]),
  }
}
