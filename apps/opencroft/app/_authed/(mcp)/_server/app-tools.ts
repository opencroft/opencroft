/** The App family: listing, calling, transferring, finding and adding App instances. */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import { appAddressOf, resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import {
  addSpaceAppImpl,
  appDetail,
  callAppAction,
  listAppActions,
  listAppCatalog,
  listSpaceApps,
  removeSpaceAppImpl,
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
      'The apps a space holds — an app is an extension-provided application a user added to a space, with its own parameters and private data. `apps` is keyed by ADDRESS, `<space>.<app-slug>`: that address is what every other tool takes to reach one, including the `<space>.<app-slug>/<handle-id>` target form the remote_* tools accept. Each entry gives the App it is an instance of (`type`), the name its user gave it, and — for the few Apps that expose context sources — the live `handles` ids, already resolved. `actions` lists the action ids by type, because actions belong to the App rather than to each app added from it; what an action does and what it takes comes from app_actions, and the parameter values an app was configured with come from app_get. Use this to discover which app to target before app_call.',
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
    name: 'app_get',
    description:
      'One app in full: the parameter values it was added with, the fields those values fill (id, label, whether required), its App and extension, and its live handles. This is the configuration view — app_list deliberately omits parameters, because choosing which app to call does not need them and printing them for every app is what made that listing unreadable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'The app’s address, `<space>.<app-slug>` — see app_list.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'app_actions',
    description:
      'Load what actions do and what they take — the descriptions and JSON input schemas app_list leaves out, for the actions you have settled on. Give the app’s type (the key of app_list’s `actions` map) or an app’s address; either resolves to the same declarations, since actions belong to the App. Omit `actions` to load every action of that type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'An app’s type (e.g. "git") or its address — see app_list.' },
        actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Action ids to load. Omit for all of them.',
        },
      },
      required: ['app'],
    },
  },
  {
    name: 'app_call',
    description:
      'Invoke an action on one app. The action runs server-side in the providing extension, scoped to that app (its parameters and private data). Use app_list to find the app and its action ids, and app_actions for what an action takes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'The app’s address, `<space>.<app-slug>` — see app_list.' },
        action: { type: 'string', description: 'Action id — see app_list.' },
        params: {
          type: 'object',
          description: 'Parameters for the action. Shape is the action’s inputSchema — see app_actions.',
          additionalProperties: true,
        },
      },
      required: ['app', 'action'],
    },
  },
  {
    name: 'app_transfer',
    description:
      'Move one app to another space, with whatever space-scoped data its App owns — a Graph app moves its whole graph (the graph keeps its slug when free in the target, otherwise takes its donor space’s name and slug). A transfer the App refuses (e.g. a Graph that is its space’s default while other graphs remain) rolls back whole. Use app_list to find the app’s address.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'The app to move, as `<space>.<app-slug>` — see app_list.' },
        target: { type: 'string', description: 'Slug of the space to move it to.' },
      },
      required: ['app', 'target'],
    },
  },
  {
    name: 'app_find',
    description:
      'Find Apps available to add to a space, with the parameters an add takes. Searches the Apps installed extensions provide; later it will also reach extensions not yet installed. Omit the query to see everything. Pair with app_add; for the apps already added, use app_list.',
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
      'Add an app to a space. Every app is NAMED: its slug is derived from the name once, must be free in the space (a taken slug is refused — pick a different name), and with the space forms the address <space>.<slug>. The same App can be added many times under different names. Declared required parameters must be non-empty; an add the App refuses (a throwing hook) rolls back whole. Adding the builtin/core "graph" App creates a new graph in the space at that same address. See app_find for what can be added.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug. Omit to target the currently active space.' },
        extensionId: { type: 'string', description: 'The providing extension — see app_find.' },
        appSlug: { type: 'string', description: 'The App within that extension — see app_find.' },
        name: { type: 'string', description: 'The instance name; its slug (and so its address) derives from it.' },
        params: {
          type: 'object',
          description: 'Parameter values by parameter id, as declared in the catalog entry.',
        },
      },
      required: ['extensionId', 'appSlug', 'name'],
    },
  },
  {
    name: 'app_remove',
    description:
      'Remove an app from its space, with whatever data it owns — removing a Graph app removes its graph and every node on it. The App can refuse (e.g. a Graph that is its space’s default while other graphs remain); a refusal leaves the app whole. Use app_list to find the app’s address.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        app: { type: 'string', description: 'The app to remove, as `<space>.<app-slug>` — see app_list.' },
      },
      required: ['app'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── app_list ─────────────────────────────────────────────────────
  app_list: async (args) => {
    const space = args.space === '*' ? undefined : await resolveSpace(args)
    const listing = await listSpaceApps(space)
    return textResult(JSON.stringify(listing, null, 2))
  },

  // ── app_get ──────────────────────────────────────────────────────
  app_get: async (args) => {
    const app = args.app as string | undefined
    if (!app) {
      fail(-32602, 'Missing required param: app')
    }
    return textResult(JSON.stringify(await appDetail(app), null, 2))
  },

  // ── app_actions ──────────────────────────────────────────────────
  app_actions: async (args) => {
    const app = args.app as string | undefined
    if (!app) {
      fail(-32602, 'Missing required param: app')
    }
    const ids = args.actions as string[] | undefined
    return textResult(JSON.stringify(await listAppActions(app, ids), null, 2))
  },

  // ── app_call ─────────────────────────────────────────────────────
  app_call: withApprovalRequired(
    async (args, caller) => {
      const app = args.app as string | undefined
      const action = args.action as string | undefined
      if (!app || !action) {
        fail(-32602, 'Missing required params: app, action')
      }
      const params = (args.params as Record<string, unknown> | undefined) ?? {}
      // Caller handed over, never required — same reasoning as `call` above.
      const result = await callAppAction(app, action, params, caller.agent ?? undefined)
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
    const app = args.app as string | undefined
    const target = args.target as string | undefined
    if (!app || !target) {
      fail(-32602, 'Missing required params: app, target')
    }
    const targetSlug = await resolveSpaceSlugImpl(target)
    if (!targetSlug) {
      fail(-32602, `Space not found: ${target} (use a slug — see list_spaces)`)
    }
    // The MOVED row, not the reference the caller gave: an address names an
    // instance through its space, so the caller's reference stops resolving the
    // moment the transfer lands. Looking the graph up by it would answer "no
    // graph" for an instance that has one — a half-done move reported as a
    // whole one.
    const moved = await transferSpaceAppImpl(app, targetSlug)
    const registry = getSpacesRegistry()
    const graph = registry.graphByInstance(moved.id)
    const movedGraphAddress = graph ? `${targetSlug}.${graph.slug}` : undefined
    // The instance's address AFTER the move, never the caller's own reference
    // echoed back: an address names an instance through its space, so the one
    // they sent now names nothing. Handing it back would teach the dead form.
    return textResult(
      JSON.stringify({ app: `${targetSlug}.${moved.slug}`, space: targetSlug, movedGraphAddress }, null, 2),
    )
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
    const name = args.name as string | undefined
    if (!extensionId || !appSlug || !name) {
      fail(-32602, 'Missing required params: extensionId, appSlug, name')
    }
    // A graph address is accepted on the space part, like everywhere else,
    // but an instance is added to the SPACE — the graph suffix is dropped.
    const { spaceSlug } = parseGraphAddress(await resolveSpace(args))
    const params = (args.params as Record<string, string> | undefined) ?? {}
    const row = await addSpaceAppImpl(spaceSlug, extensionId, appSlug, name, params)
    return textResult(
      JSON.stringify(
        {
          space: spaceSlug,
          app: `${extensionId}/${appSlug}`,
          name: row.name,
          address: `${spaceSlug}.${row.slug}`,
          params: JSON.parse(row.params) as Record<string, string>,
        },
        null,
        2,
      ),
    )
  }),

  // ── app_remove ───────────────────────────────────────────────────
  app_remove: withApprovalRequired(async (args) => {
    const ref = args.app as string | undefined
    if (!ref) {
      fail(-32602, 'Missing required param: app')
    }
    // Resolved before the removal so the result can name the instance by its
    // ADDRESS. Echoing the caller's own argument back would print a uuid
    // whenever they sent one, which is the one thing an emitter must not do —
    // and an argument that resolved to nothing is simply left out, because
    // `removed: false` already says everything true about it.
    const row = await resolveAppAddress(ref)
    const app = row ? await appAddressOf(row) : undefined
    const removed = await removeSpaceAppImpl(ref)
    return textResult(JSON.stringify({ app, removed }, null, 2))
  }),
}
