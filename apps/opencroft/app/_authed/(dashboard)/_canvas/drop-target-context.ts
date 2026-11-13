import { createContext, useContext } from 'react'

export const NO_DROP_TARGETS: ReadonlySet<string> = new Set()

/**
 * The frame the nodes being dragged on this canvas would be dropped into, the
 * one under the pointer (see `dragDropTarget` in `_frame-tree.ts`): at most
 * one, and empty while nothing is dragged or the drop would go to the top
 * level. Client-only and per tab: it is never written to the graph.
 */
export const DropTargetContext = createContext<ReadonlySet<string>>(NO_DROP_TARGETS)

/** Whether a drop now would put a dragged node into the frame `id`. */
export function useIsDropTarget(id: string): boolean {
  return useContext(DropTargetContext).has(id)
}

/** `next`, or `current` when it holds the same ids, so an unchanged answer re-renders no frame. */
export function updatedTargets(current: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  return current.size === next.size && [...next].every((id) => current.has(id)) ? current : next
}
