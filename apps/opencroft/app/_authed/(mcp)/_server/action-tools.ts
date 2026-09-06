/** The node-action family: discovering the actions a node exposes, and invoking one. */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import {
  dispatchNodeActionImpl,
  listNodeActionsImpl,
} from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'

export const definitions = [
  {
    name: 'list_actions',
    description:
      'List the actions available on a node (e.g. lifecycle actions like deploy/start/stop on a container-backed node, run on a script node). Use this to discover what actions a node exposes before calling them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'Target node ID.' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'call',
    description:
      'Invoke an action on a node — equivalent to clicking the corresponding button in the UI. Same code path, no duplication. Use list_actions first to discover available action IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'Target node ID.' },
        action: { type: 'string', description: 'Action ID from the node manifest (e.g. "start", "stop", "run").' },
        params: {
          type: 'object',
          description: 'Optional parameters for the action. Shape depends on the action.',
          additionalProperties: true,
        },
      },
      required: ['nodeId', 'action'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── list_actions ─────────────────────────────────────────────────
  list_actions: async (args) => {
    const nodeId = args.nodeId as string | undefined
    if (!nodeId) {
      fail(-32602, 'Missing required param: nodeId')
    }
    const actions = await listNodeActionsImpl(nodeId)
    return textResult(JSON.stringify(actions, null, 2))
  },

  // ── call ─────────────────────────────────────────────────────────
  call: withApprovalRequired(
    async (args, caller) => {
      const nodeId = args.nodeId as string | undefined
      const action = args.action as string | undefined
      if (!nodeId || !action) {
        fail(-32602, 'Missing required params: nodeId, action')
      }
      const params = (args.params as Record<string, unknown> | undefined) ?? {}
      // Handed over, never required. Most actions deploy a container or
      // rotate a key and have no use for it, so `requireCallingAgent` here
      // would close every one of them to a surface that cannot name its
      // caller. An action that acts AS the caller refuses for itself, where
      // the consequence of not knowing is known.
      const result = await dispatchNodeActionImpl({ nodeId, actionId: action, params }, caller.agent ?? undefined)
      const text = result === undefined ? `Action ${action} completed.` : JSON.stringify(result, null, 2)
      return textResult(text)
    },
    { view: 'call' },
  ),
}
