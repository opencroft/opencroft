'use client';

import { useReactFlow, type Node } from '@xyflow/react';
import { useEffect, useRef } from 'react';

import { useSSEEvents } from '@/app/(sse)/stores/sse-events-store';

interface UseGraphEventsOptions {
  /** ReactFlow setNodes callback — used to select/deselect nodes and manage comment nodes. */
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  /** Called when a comment should be dismissed. */
  onDismissComment?: (nodeId: string) => void;
}

/**
 * Hook that wires SSE graph events (focus, comments) into ReactFlow.
 *
 * Comments are rendered as virtual ReactFlow nodes (type='comment')
 * positioned above their target node. This makes them stick to the node
 * during pan/zoom automatically.
 */
export function useGraphEvents({ setNodes, onDismissComment }: UseGraphEventsOptions) {
  const { focusedNodeId, comments } = useSSEEvents();
  const { getNode, fitView } = useReactFlow();
  const prevFocusedRef = useRef<string | null>(null);
  const onDismissRef = useRef(onDismissComment);
  onDismissRef.current = onDismissComment;

  // ── Focus / clear focus ───────────────────────────────────────────────
  useEffect(() => {
    if (focusedNodeId === prevFocusedRef.current) {
      return;
    }
    prevFocusedRef.current = focusedNodeId;

    if (focusedNodeId) {
      const node = getNode(focusedNodeId);
      if (!node) {
        return;
      }

      // Select the focused node, deselect all others
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          selected: n.id === focusedNodeId,
        })),
      );

      // Use fitView to center on the node — handles sidebar offset automatically
      setTimeout(() => {
        fitView({
          nodes: [{ id: focusedNodeId }],
          padding: 0.4,
          duration: 400,
        });
      }, 50);
    } else {
      // Clear focus — deselect all nodes
      setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
    }
  }, [focusedNodeId, getNode, setNodes, fitView]);

  // ── Sync comment nodes into ReactFlow ──────────────────────────────────
  // Create/remove 'comment' nodes that float above their target node.
  // onDismissRef is used instead of onDismissComment to avoid infinite re-render loop.
  useEffect(() => {
    setNodes((nds) => {
      // Remove old comment nodes
      const withoutComments = nds.filter((n) => n.type !== 'comment');

      // Build new comment nodes positioned above their target
      const commentNodes: Node[] = [];
      for (const [, comment] of comments) {
        const target = withoutComments.find((n) => n.id === comment.nodeId);
        if (!target) {
          continue;
        }

        const nodeWidth = (target.measured?.width ?? (target.style?.width as number) ?? 200) as number;
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
        });
      }

      return [...withoutComments, ...commentNodes];
    });
  }, [comments, setNodes]);
}
