'use client'

import { type Node, useReactFlow } from '@xyflow/react'
import { useEffect, useRef } from 'react'

import { absolutePosition, byIdOf } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { useSSEEvents } from '@/app/_authed/(sse)/_lib/sse-events-store'

interface UseGraphEventsOptions {
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>
  onDismissComment?: (nodeId: string) => void
  /** Brings a node the server asked to focus into view; it is already selected. */
  onFocusNode: (nodeId: string) => void
}

export function useGraphEvents({ setNodes, onDismissComment, onFocusNode }: UseGraphEventsOptions) {
  const { focusedNodeId, focusVersion, comments } = useSSEEvents()
  const { getNode } = useReactFlow()
  const prevFocusedRef = useRef<string>('')
  const onDismissRef = useRef(onDismissComment)
  onDismissRef.current = onDismissComment
  // In a ref, so a new callback each render does not re-run the focus effect.
  const onFocusNodeRef = useRef(onFocusNode)
  onFocusNodeRef.current = onFocusNode

  useEffect(() => {
    const fingerprint = `${focusedNodeId ?? ''}:${focusVersion}`
    if (fingerprint === prevFocusedRef.current) {
      return
    }
    prevFocusedRef.current = fingerprint

    if (focusedNodeId) {
      const node = getNode(focusedNodeId)
      if (!node) {
        return
      }
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          selected: n.id === focusedNodeId,
        })),
      )
      setTimeout(() => onFocusNodeRef.current(focusedNodeId), 50)
      return
    }
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
  }, [focusedNodeId, focusVersion, getNode, setNodes])

  useEffect(() => {
    setNodes((nds) => {
      const withoutComments = nds.filter((n) => n.type !== 'comment')
      const byId = byIdOf(withoutComments)
      const commentNodes: Node[] = []
      for (const [, comment] of comments) {
        const target = withoutComments.find((n) => n.id === comment.nodeId)
        if (!target) {
          continue
        }
        const nodeWidth = (target.measured?.width ?? (target.style?.width as number) ?? 200) as number
        // A top-level overlay, so at where the node is drawn, frames it is in included.
        const at = absolutePosition(target, byId)
        commentNodes.push({
          id: `comment-${comment.nodeId}`,
          type: 'comment',
          position: {
            x: at.x + nodeWidth / 2,
            y: at.y - 16,
          },
          data: {
            nodeId: comment.nodeId,
            message: comment.message,
            onDismiss: (nodeId: string) => onDismissRef.current?.(nodeId),
          },
          draggable: false,
          selectable: false,
          deletable: false,
          style: { zIndex: 1000 },
        })
      }
      return [...withoutComments, ...commentNodes]
    })
  }, [comments, setNodes])
}
