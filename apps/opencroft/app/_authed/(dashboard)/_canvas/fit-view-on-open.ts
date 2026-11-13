import { useNodesInitialized, useStoreApi } from '@xyflow/react'
import { useLayoutEffect } from 'react'

/**
 * Whether the canvas fits its view to the nodes a graph opens with: only when
 * there are some.
 *
 * The fit waits until there are measured nodes (useFitWhenMeasured). On a
 * graph that opens empty, that is the first node anyone adds: a paste or a
 * node dropped from the menu would pan the view away from where the person
 * put it.
 */
export function fitViewOnOpen(openingNodes: readonly unknown[]): boolean {
  return openingNodes.length > 0
}

/**
 * Calls `fit` while `pending`, once the canvas's nodes are measured: the first
 * moment their bounds are known. Before that frame is painted, so the
 * unfitted view never shows. `fit` clears `pending`.
 *
 * Call it inside `<ReactFlow>` or in a component above it: layout effects run
 * children first, so the flow has taken this render's nodes before this
 * effect reads them.
 */
export function useFitWhenMeasured(pending: boolean, fit: () => void) {
  const store = useStoreApi()
  // Re-runs the effect when measurement completes. This value alone can't
  // decide: a graph opened in place of another is set in a render that still
  // reads the old graph's nodes as measured. The store's value, read in the
  // effect, is about the nodes the flow holds now.
  const nodesInitialized = useNodesInitialized()
  useLayoutEffect(() => {
    if (pending && nodesInitialized && store.getState().nodesInitialized) {
      fit()
    }
  }, [pending, nodesInitialized, fit, store])
}
