import { NodeResizer as FlowNodeResizer, type NodeResizerProps, useNodeId, useStore } from '@xyflow/react'
import { memo, useLayoutEffect } from 'react'

import { cutOutOverNode, keepCutOut } from '@/app/_authed/(dashboard)/_canvas/control-cutouts'
import { useTouchMoveMode } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import { TouchResizeControls } from '@/app/_authed/(dashboard)/_canvas/touch-resize-controls'

/**
 * React Flow's `NodeResizer`, as extensions get it, following the canvas's
 * touch rules (see `useTouchMoveMode`): while move mode is on, the selected
 * node has the finger-sized `TouchResizeControls`, with the same limits; with
 * move mode off, no controls. Elsewhere it is React Flow's, with a hole in its
 * controls over each of the node's connection handles and buttons they lie
 * over (see `cutOutOverNode`), so a press there starts a wire or presses the
 * button rather than resizing. The holes are measured again when the zoom or
 * the node's size changes, and on what `keepCutOut` watches.
 */
export const NodeResizer = memo(function NodeResizer(props: NodeResizerProps) {
  const touchMoveMode = useTouchMoveMode()
  const contextId = useNodeId()
  const id = props.nodeId ?? contextId
  const selected = useStore((state) => (id ? state.nodeLookup.get(id)?.selected === true : false))
  if (touchMoveMode === null) {
    return <PointerNodeResizer {...props} nodeId={id ?? undefined} />
  }
  if (!touchMoveMode || !selected || props.isVisible === false) {
    return null
  }
  const { minWidth, minHeight } = props
  return (
    <TouchResizeControls
      nodeId={props.nodeId}
      maxWidth={props.maxWidth}
      maxHeight={props.maxHeight}
      keepAspectRatio={props.keepAspectRatio}
      shouldResize={props.shouldResize}
      onResizeStart={props.onResizeStart}
      onResize={props.onResize}
      onResizeEnd={props.onResizeEnd}
      limits={() => ({ width: minWidth, height: minHeight })}
    />
  )
})

function PointerNodeResizer(props: NodeResizerProps) {
  const id = props.nodeId
  const flow = useStore((state) => state.domNode)
  const zoom = useStore((state) => state.transform[2])
  const size = useStore((state) => {
    const node = id ? state.nodeLookup.get(id) : undefined
    return node ? `${node.measured.width}x${node.measured.height}` : ''
  })
  // The controls are React Flow's, with no ref to them, so they are found in the node's element.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom and size move what the controls lie over, which the cut reads from the page.
  useLayoutEffect(() => {
    if (!flow || !id || props.isVisible === false) {
      return
    }
    const node = flow.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    if (!node) {
      return
    }
    return keepCutOut(flow, () =>
      cutOutOverNode(node, node.querySelectorAll<HTMLElement>('.react-flow__resize-control')),
    )
  }, [flow, id, zoom, size, props.isVisible])
  return <FlowNodeResizer {...props} />
}
