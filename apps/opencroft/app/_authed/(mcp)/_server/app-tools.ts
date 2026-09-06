/** The App family: listing, calling, transferring, finding and adding App instances. */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import {
  addSpaceAppImpl,
  callAppAction,
  listAppCatalog,
  listSpaceAppInfos,
  transferSpaceAppImpl,
} from '@/app/_authed/(apps)/_server/runtime'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, resolveSpace, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'
import { resolveSpaceSlugImpl } from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { parseGraphAddress } from '@/app/_authed/(space)/_server/types'

export const definitions = [
  {
    name: 'app_list',
    description:
      'List the App instances added to a space — an App is an extension-provided application a user adds to a space with its own parameters and private data. Each entry names the instance (instanceId), its App, its space, the parameter values it was added with, and the actions it exposes (with input schemas). Use this to discover which instance to target before app_call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: {
          type: 'string',
          description: 'Space slug. Omit to target the currently active space. Pass "*" to list every space.',
        },
      },
    },
  },
  {
    name: 'app_call',
    description:
      'Invoke an action on one App instance. The action runs server-side in the providing extension, scoped to that instance (its parameters and private data). Use app_list first to discover instances and their action IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instanceId: { type: 'string', description: 'App instance ID from app_list.' },
        action: { type: 'string', description: 'Action ID from the instance’s actions list.' },
        params: {
          type: 'object',
          description: 'Parameters for the action. Shape is the action’s inputSchema.',
          additionalProperties: true,
        },
      },
      required: ['instanceId', 'action'],
    },
  },
  {
    name: 'app_transfer',
    description:
      'Move one App instance to another space, with whatever space-scoped data its App owns — a Graph instance moves its whole graph (the graph keeps its slug when free in the target, otherwise takes its donor space’s name and slug). A transfer the App refuses (e.g. a Graph that is its space’s default while other graphs remain) rolls back whole. Use app_list to find the instanceId.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        instanceId: { type: 'string', description: 'The App instance to move — see app_list.' },
        target: { type: 'string', description: 'Slug of the space to move it to.' },
      },
      required: ['instanceId', 'target'],
    },
  },
  {
    name: 'app_find',
    description:
      'Find Apps available to add to a space, with the parameters an add takes. Searches the Apps installed extensions provide; later it will also reach extensions not yet installed. Omit the query to see everything. Pair with app_add; for the instances already added, use app_list.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Narrow by title, slug, extension or description. Omit for all.' },
      },
    },
  },
  {
    name: 'app_add',
    description:
      'Add an App instance to a space. The same App can be added many times with different parameter values — each add is a new instance. Declared required parameters must be non-empty; an add the App refuses (a throwing hook) rolls back whole. Adding the builtin/core "graph" App creates a new graph in the space — its address comes back in the result. See app_find for what can be added.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug. Omit to target the currently active space.' },
        extensionId: { type: 'string', description: 'The providing extension — see app_find.' },
        appSlug: { type: 'string', description: 'The App within that extension — see app_find.' },
        params: {
          type: 'object',
          description: 'Parameter values by parameter id, as declared in the catalog entry.',
        },
      },
      required: ['extensionId', 'appSlug'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── app_list ─────────────────────────────────────────────────────
  app_list: async (args) => {
    const space = args.space === '*' ? undefined : await resolveSpace(args)
    const infos = await listSpaceAppInfos(space)
    return textResult(JSON.stringify(infos, null, 2))
  },

  // ── app_call ─────────────────────────────────────────────────────
  app_call: withApprovalRequired(
    async (args, caller) => {
      const instanceId = args.instanceId as string | undefined
      const action = args.action as string | undefined
      if (!instanceId || !action) {
        fail(-32602, 'Missing required params: instanceId, action')
      }
      const params = (args.params as Record<string, unknown> | undefined) ?? {}
      // Caller handed over, never required — same reasoning as `call` above.
      const result = await callAppAction(instanceId, action, params, caller.agent ?? undefined)
      const text =
        result === undefined
          ? `Action ${action} completed.`
          : typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2)
      return textResult(text)
    },
    { view: 'app_call' },
  ),

  // ── app_transfer ─────────────────────────────────────────────────
  app_transfer: withApprovalRequired(async (args) => {
    const instanceId = args.instanceId as string | undefined
    const target = args.target as string | undefined
    if (!instanceId || !target) {
      fail(-32602, 'Missing required params: instanceId, target')
    }
    const targetSlug = await resolveSpaceSlugImpl(target)
    if (!targetSlug) {
      fail(-32602, `Space not found: ${target} (use a slug — see list_spaces)`)
    }
    await transferSpaceAppImpl(instanceId, targetSlug)
    const registry = getSpacesRegistry()
    const graph = registry.graphByInstance(instanceId)
    const movedGraphAddress = graph ? `${targetSlug}.${graph.slug}` : undefined
    return textResult(JSON.stringify({ instanceId, space: targetSlug, movedGraphAddress }, null, 2))
  }),

  // ── app_find ─────────────────────────────────────────────────────
  app_find: async (args) => {
    const query = (args.query as string | undefined)?.trim().toLowerCase()
    const catalog = await listAppCatalog()
    const matches = query
      ? catalog.filter((entry) =>
          [entry.title, entry.appSlug, entry.extensionId, entry.description ?? ''].some((text) =>
            text.toLowerCase().includes(query),
          ),
        )
      : catalog
    return textResult(JSON.stringify(matches, null, 2))
  },

  // ── app_add ──────────────────────────────────────────────────────
  app_add: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    const appSlug = args.appSlug as string | undefined
    if (!extensionId || !appSlug) {
      fail(-32602, 'Missing required params: extensionId, appSlug')
    }
    // A graph address is accepted on the space part, like everywhere else,
    // but an instance is added to the SPACE — the graph suffix is dropped.
    const { spaceSlug } = parseGraphAddress(await resolveSpace(args))
    const params = (args.params as Record<string, string> | undefined) ?? {}
    const row = await addSpaceAppImpl(spaceSlug, extensionId, appSlug, params)
    const registry = getSpacesRegistry()
    const graph = registry.graphByInstance(row.id)
    const createdGraphAddress = graph ? `${spaceSlug}.${graph.slug}` : undefined
    return textResult(
      JSON.stringify(
        {
          instanceId: row.id,
          space: spaceSlug,
          app: `${extensionId}/${appSlug}`,
          params: JSON.parse(row.params) as Record<string, string>,
          createdGraphAddress,
        },
        null,
        2,
      ),
    )
  }),
}
