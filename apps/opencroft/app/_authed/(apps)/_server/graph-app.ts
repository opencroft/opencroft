// The HOST-registered Graph App's server hooks. The app is declared in
// builtin/core's manifest and its client component ships in that extension's
// bundle, but these hooks are host code, wired in by the apps runtime ahead
// of the extension-module lookup: graphs are core data (the whole node
// machinery -- exec dispatch, streams, MCP node tools -- stands on them), so
// their lifecycle talks to the spaces registry directly rather than through
// an extension sandbox that cannot see it.
//
// One instance = one graph. onAdded creates it (a name that slugifies onto an
// existing graph is refused, which rolls the instance back), onUpdated
// renames it in place -- the slug is an address and never moves -- and
// onRemoved deletes it with the instance. beforeRemoved vetoes removing the
// graph a bare `<space>` address resolves to: the default has to be pointed
// at another graph first.

import type { AppServerHooks } from '@opencroft/server'

import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { DefaultGraphRemovalError } from '@/app/_authed/(space)/_server/store'
import { DEFAULT_GRAPH_NAME } from '@/app/_authed/(space)/_server/types'

export const graphAppHooks: AppServerHooks = {
  async onAdded(ctx) {
    const r = await registry()
    await r.createGraph(ctx.spaceSlug, ctx.params.name?.trim() || DEFAULT_GRAPH_NAME, ctx.instanceId)
  },
  async beforeRemoved(ctx) {
    const r = await registry()
    const graph = r.graphByInstance(ctx.instanceId)
    if (!graph) {
      return
    }
    const space = r.getById(graph.spaceId)
    if (space && space.defaultGraphSlug === graph.slug) {
      throw new DefaultGraphRemovalError(`${space.slug}.${graph.slug}`)
    }
  },
  async onRemoved(ctx) {
    const r = await registry()
    await r.removeGraphByInstance(ctx.instanceId)
  },
  async onUpdated(ctx) {
    const r = await registry()
    await r.renameGraphByInstance(ctx.instanceId, ctx.params.name?.trim() || DEFAULT_GRAPH_NAME)
  },
  async onTransferred(ctx, previousSpaceSlug) {
    const r = await registry()
    await r.transferGraphByInstance(ctx.instanceId, previousSpaceSlug)
  },
}
