// The Apps this HOST implements, rather than an extension: their server hooks
// and their actions are app code, because they stand on host internals an
// extension server bundle cannot see. Their metadata and client component
// still ship through the providing extension's manifest like any other App's;
// what this module adds is everything the manifest cannot carry — the action
// handlers, their schemas beside them, and the host's own policy per action.
//
// ONE SOURCE PER ACTION. A host action is declared once, here (via the App's
// own module), and every reader derives from that declaration: the catalog
// `app_list`/`app_actions` print, the dispatch `app_call` runs, and the
// approval and read-only questions the tool surfaces ask about a call.

import type { AppActionMeta, AppEntry } from '@opencroft/core'
import type { AppActionHandler, AppServerHooks } from '@opencroft/server'

import { resolveAppAddress } from '@/app/_authed/(apps)/_server/app-address'
import { graphActions } from '@/app/_authed/(apps)/_server/graph-actions'
import { graphAppHooks } from '@/app/_authed/(apps)/_server/graph-app'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { Provided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { getProvided } from '@/app/_authed/(extension-runtime)/_server/provides'
import { GRAPH_APP_TYPE } from '@/app/_authed/(space)/_server/types'

/**
 * One action of a host-implemented App: what the catalog shows, what runs, and
 * how a caller is asked about it.
 */
export interface HostAppAction extends AppActionMeta {
  run: AppActionHandler
  /**
   * Queues for approval on a surface that has the queue. Absent means it does
   * not, exactly like a static tool without `withApprovalRequired`.
   */
  requireApproval?: boolean
  /** The tool view an approval of this action renders with. */
  view?: string
  /**
   * The canvas an approval of this action is shown on — the same id the
   * canvas subscribes to its events under.
   */
  approvalSpace?: (ctx: { instanceId: string }) => Promise<string | undefined>
}

interface HostApp {
  hooks: AppServerHooks
  actions: HostAppAction[]
}

// Built on first use rather than at module load: the graph's actions reach the
// extension runtime, which reaches back here, so whichever of the two a process
// happens to import first, the other may still be initialising at load time.
// Keyed by the App's qualified type, which names the extension declaring it.
let hostApps: Record<string, HostApp> | undefined

function hostApp(type: string): HostApp | undefined {
  hostApps ??= {
    [GRAPH_APP_TYPE]: { hooks: graphAppHooks, actions: graphActions },
  }
  return hostApps[type]
}

/**
 * The server hooks of a host-implemented App — its lifecycle plus its actions'
 * handlers — or undefined for an App an extension implements.
 */
export function hostAppHooks(type: string): AppServerHooks | undefined {
  const app = hostApp(type)
  if (!app) {
    return undefined
  }
  return { ...app.hooks, actions: Object.fromEntries(app.actions.map((action) => [action.id, action.run])) }
}

/** What the catalog prints about one host action: the manifest shape, and nothing host-private. */
function actionMeta({ id, label, description, inputSchema, execution }: HostAppAction): AppActionMeta {
  return {
    id,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(inputSchema ? { inputSchema } : {}),
    ...(execution ? { execution } : {}),
  }
}

/**
 * Every App any extension provides, with a host App's actions filled in from
 * their declarations here. The one catalog every reader of App entries uses,
 * so a host action cannot be listed in one place and missing in another.
 */
export async function providedApps(): Promise<Provided<AppEntry>[]> {
  const provided = await getProvided<AppEntry>('apps')
  return provided.map((entry) => {
    const app = hostApp(entry.value.type)
    return app ? { ...entry, value: { ...entry.value, actions: app.actions.map(actionMeta) } } : entry
  })
}

/**
 * How the tool surfaces classify one `app_call`: the policy key of the action
 * it names — `<bare type>.<action>`, e.g. `graph.listNodes`, the host's own
 * vocabulary for its own Apps — and that action's declaration, when the call
 * names an action of a HOST App.
 *
 * Undefined for everything else: an extension App's action, an address that
 * resolves to nothing, an action the App does not declare, arguments that are
 * not strings. The key is only ever minted from a resolved row whose App the
 * host implements, so an extension App cannot reach a host classification by
 * naming its own action the same — callers treat undefined as "unclassified",
 * which keeps whatever gate `app_call` itself has.
 */
export async function hostAppCall(
  app: unknown,
  action: unknown,
): Promise<{ key: string; instanceId: string; action: HostAppAction } | undefined> {
  if (typeof app !== 'string' || typeof action !== 'string' || !app || !action) {
    return undefined
  }
  const row = await resolveAppAddress(app)
  if (!row) {
    return undefined
  }
  const declared = hostApp(row.type)?.actions.find((candidate) => candidate.id === action)
  const bare = parseType(row.type)?.bare
  return declared && bare ? { key: `${bare}.${action}`, instanceId: row.id, action: declared } : undefined
}
