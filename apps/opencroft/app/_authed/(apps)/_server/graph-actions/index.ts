/**
 * The Graph App's actions — what an agent does to one graph, called as
 * `app_call { app: "<space>.<graph>", action, params }`. The graph is the
 * called instance's own, so an action cannot run without an address and
 * cannot reach any graph but the one it was called on.
 */

import { overlayActions } from '@/app/_authed/(apps)/_server/graph-actions/overlays'
import { readActions } from '@/app/_authed/(apps)/_server/graph-actions/reads'
import { writeActions } from '@/app/_authed/(apps)/_server/graph-actions/writes'
import type { HostAppAction } from '@/app/_authed/(apps)/_server/host-apps'

export const graphActions: HostAppAction[] = [...readActions, ...writeActions, ...overlayActions]
