'use client'

import { type Node, useReactFlow } from '@xyflow/react'
import { useEffect, useRef } from 'react'

import { useSSEEvents } from '@/app/(sse)/_lib/sse-events-store'

interface UseGraphEventsOptions {
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>
  onDismissComment?: (nodeId: string) => void
}

export function useGraphEvents({ setNodes, onDismissComment }: UseGraphEventsOptions) {
  const { focusedNodeId, focusVersion, comments } = useSSEEvents()
  const { getNode, fitView } = useReactFlow()
  const prevFocusedRef = useRef<string>('')
  const onDismissRef = useRef(onDismissComment)
  onDismissRef.current = onDismissComment

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
      setTimeout(() => {
        fitView({
          nodes: [{ id: focusedNodeId }],
          padding: 0.4,
          duration: 400,
        })
      }, 50)
      return
    }
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
  }, [focusedNodeId, focusVersion, getNode, setNodes, fitView])

  useEffect(() => {
    setNodes((nds) => {
      const withoutComments = nds.filter((n) => n.type !== 'comment')
      const commentNodes: Node[] = []
      for (const [, comment] of comments) {
        const target = withoutComments.find((n) => n.id === comment.nodeId)
        if (!target) {
          continue
        }
        const nodeWidth = (target.measured?.width ?? (target.style?.width as number) ?? 200) as number
        commentNodes.push({
          id: `comment-${comment.nodeId}`,
          type: 'comment',
          position: {
            x: target.position.x + nodeWidth / 2,
            y: target.position.y - 16,
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
