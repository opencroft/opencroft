/**
 * The graph's overlay actions: focusing a node and the comment bubbles drawn
 * over nodes. They persist nothing — each is a broadcast to the canvas showing
 * the graph — but they act on somebody else's screen, so they are not
 * read-only either.
 */

import {
  type GraphNode,
  graphTarget,
  loadOrFail,
  requireArray,
} from '@/app/_authed/(apps)/_server/graph-actions/graph-target'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'
import { fail } from '@/app/_authed/(mcp)/_server/tool-refusal'
import { toastStore } from '@/lib/toast-store'

export const overlayActions: HostAppAction[] = [
  {
    id: 'focusNode',
    description:
      'Focus the camera on a node of this graph and select it, opening the graph first. If `comment` is provided, also attach a floating comment bubble to the node.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The node ID to focus on' },
        comment: { type: 'string', description: 'Optional comment to attach to the node.' },
      },
      required: ['nodeId'],
    },
    run: async (ctx, params) => {
      const nodeId = params.nodeId as string | undefined
      if (!nodeId) {
        fail(-32602, 'Missing required param: nodeId')
      }
      const { address, spaceSlug } = await graphTarget(ctx)
      const { graph } = await loadOrFail(address)
      if (!graph.nodes.some((n) => (n as unknown as GraphNode).id === nodeId)) {
        fail(-32602, `Node not found in ${address}: ${nodeId}`)
      }
      toastStore.broadcast({ type: 'open_space', slug: spaceSlug, nodeId })
      toastStore.broadcast({ type: 'focus_node', nodeId, spaceId: spaceSlug })
      const comment = params.comment as string | undefined
      if (!comment) {
        return `Focused on node ${nodeId} in ${address}`
      }
      toastStore.broadcast({ type: 'comment', message: comment, nodeId, spaceId: spaceSlug })
      return JSON.stringify({ nodeId, comment, graph: address })
    },
  },
  {
    id: 'commentNodes',
    description:
      'Attach floating comment bubbles to one or more nodes of this graph. Each node has at most one comment — subsequent calls replace the previous message.',
    inputSchema: {
      type: 'object',
      properties: {
        comments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'The node ID to attach the comment to' },
              message: { type: 'string', description: 'Comment message text' },
            },
            required: ['nodeId', 'message'],
          },
        },
      },
      required: ['comments'],
    },
    run: async (ctx, params) => {
      const items = requireArray<Record<string, unknown>>(params.comments, 'comments')
      const entries: { nodeId: string; message: string }[] = []
      for (const it of items) {
        const nodeId = it.nodeId as string | undefined
        const message = it.message as string | undefined
        if (!nodeId || !message) {
          fail(-32602, 'Each comment must include "nodeId" and "message"')
        }
        entries.push({ nodeId, message })
      }
      const { spaceSlug } = await graphTarget(ctx)
      for (const entry of entries) {
        toastStore.broadcast({ type: 'comment', message: entry.message, nodeId: entry.nodeId, spaceId: spaceSlug })
      }
      return JSON.stringify(entries, null, 2)
    },
  },
  {
    id: 'uncommentNodes',
    description: 'Remove comment bubbles from one or more nodes of this graph.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs whose comments should be removed.',
        },
      },
      required: ['nodeIds'],
    },
    run: async (ctx, params) => {
      const nodeIds = requireArray<string>(params.nodeIds, 'nodeIds')
      const { spaceSlug } = await graphTarget(ctx)
      for (const nodeId of nodeIds) {
        toastStore.broadcast({ type: 'clear_comment', nodeId, spaceId: spaceSlug })
      }
      return JSON.stringify({ cleared: nodeIds }, null, 2)
    },
  },
]
