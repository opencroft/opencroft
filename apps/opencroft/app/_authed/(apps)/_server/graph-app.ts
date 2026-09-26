// The HOST-registered Graph App's server hooks. The app is declared in
// builtin/core's manifest and its client component ships in that extension's
// bundle, but these hooks are host code, wired in by the apps runtime ahead
// of the extension-module lookup: graphs are core data (the whole node
// machinery -- exec dispatch, streams, the graph actions -- stands on them), so
// their lifecycle talks to the spaces registry directly rather than through
// an extension sandbox that cannot see it.
//
// One instance = one graph, and one address: the graph carries the
// INSTANCE's name and slug (the platform mints the slug from the name at add
// time and keeps it unique per space). onAdded creates the graph under that
// slug, onRenamed follows the instance's rename -- BOTH halves of it, since
// the slug moves with the label and a graph left on its old
// slug would make `<space>.<app-slug>` and `<space>.<graph-slug>` two
// addresses for one thing -- onTransferred follows a move (the platform has
// already re-resolved the slug for the target space), and onRemoved deletes the
// graph with the instance. beforeRemoved vetoes removing the graph a bare
// `<space>` address resolves to: the default has to be pointed at another
// graph first.

import type { AppServerHooks } from '@opencroft/server'

import { registry } from '@/app/_authed/(space)/_server/actions-impl'
import { DefaultGraphRemovalError } from '@/app/_authed/(space)/_server/store'

export const graphAppHooks: AppServerHooks = {
  async onAdded(ctx) {
    const r = await registry()
    await r.createGraph(ctx.spaceSlug, ctx.name, ctx.slug, ctx.instanceId)
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
  async onRenamed(ctx) {
    const r = await registry()
    // ctx carries the instance's ALREADY-RESOLVED name and slug, so the graph
    // mirrors what the platform decided rather than re-deriving it here. Two
    // slugifications of one name is two chances to disagree.
    await r.renameGraphByInstance(ctx.instanceId, ctx.name, ctx.slug)
  },
  async onTransferred(ctx, previousSpaceSlug) {
    const r = await registry()
    await r.transferGraphByInstance(ctx.instanceId, previousSpaceSlug)
  },
}
