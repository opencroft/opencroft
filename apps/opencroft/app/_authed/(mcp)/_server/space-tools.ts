/** The space family: listing spaces with their graphs, and creating, renaming and deleting a space. */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, jsonResult, resolveSpace, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'
import {
  createSpaceImpl,
  deleteSpaceImpl,
  listSpacesImpl,
  renameSpaceImpl,
} from '@/app/_authed/(space)/_server/actions-impl'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

export const definitions = [
  {
    name: 'list_spaces',
    description:
      'List all spaces with their graphs. A space can hold several graphs (each one is a Graph App instance); every node tool addresses one graph — a bare space slug means its default graph, "<space>.<graph>" a named one. Each graph entry carries its address, its name, and whether it is the default — the address is what every graph-addressed tool takes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_space',
    description: 'Create a new empty space.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_space',
    description: 'Rename an existing space.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug' },
        name: { type: 'string', description: 'New name' },
      },
      required: ['space', 'name'],
    },
  },
  {
    name: 'delete_space',
    description: 'Delete a space by slug. The last remaining space cannot be deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug' },
      },
      required: ['space'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── list_spaces ─────────────────────────────────────────────────
  list_spaces: async () => {
    const spaces = await listSpacesImpl()
    const registry = getSpacesRegistry()
    const withGraphs = spaces.map((space) => ({
      ...space,
      graphs: registry.graphsOf(space.slug).map((graph) => ({
        address: `${space.slug}.${graph.slug}`,
        name: graph.name,
        default: registry.getBySlug(space.slug)?.defaultGraphSlug === graph.slug,
      })),
    }))
    return jsonResult(withGraphs)
  },

  // ── create_space ────────────────────────────────────────────────
  create_space: withApprovalRequired(async (args) => {
    const name = args.name as string | undefined
    if (!name) {
      fail(-32602, 'Missing required param: name')
    }
    const space = await createSpaceImpl(name)
    return jsonResult(space)
  }),

  // ── rename_space ────────────────────────────────────────────────
  rename_space: withApprovalRequired(async (args) => {
    const name = args.name as string | undefined
    if (!args.space || !name) {
      fail(-32602, 'Missing required params: space, name')
    }
    const slug = await resolveSpace(args)
    const renamed = await renameSpaceImpl({ slug, name })
    if (!renamed.ok) {
      // Distinct messages, because these are different things for the caller
      // to do next: one is a bad reference, the other is a name to change.
      fail(
        -32602,
        renamed.code === 'slug-taken'
          ? `Another space already answers to the address "${name}" would take`
          : `Space not found: ${slug}`,
      )
    }
    return jsonResult(renamed.space)
  }),

  // ── delete_space ────────────────────────────────────────────────
  delete_space: withApprovalRequired(async (args) => {
    if (!args.space) {
      fail(-32602, 'Missing required param: space')
    }
    const slug = await resolveSpace(args)
    const ok = await deleteSpaceImpl(slug)
    if (!ok) {
      fail(-32602, 'Cannot delete (not found or last remaining space)')
    }
    return textResult(`Space ${slug} deleted.`)
  }),
}
