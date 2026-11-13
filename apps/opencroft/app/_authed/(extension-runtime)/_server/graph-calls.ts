// Calls from a graph: what a Call Action may name as its target, the actions
// that target offers it, what its check finds, and the call itself.
//
// A call from a graph runs as nobody: a node action gets no caller, and an
// App action runs as its extension's own system identity, as every target of
// the execution dispatcher already does. So a node action its extension
// declares `admin` is never called from a graph: the check reports it and the
// call refuses it. A target is in the calling node's space, on any of its
// graphs; there is no grant that reaches another space.

import type { NodeError } from '@opencroft/core'
import { nodeName } from '@opencroft/core/values'
import type { GraphCallAction, GraphCallTargets } from '@opencroft/server/terminal'

import {
  type AppCallTarget,
  appCallTarget,
  callAppAction,
  spaceAppCallTargets,
} from '@/app/_authed/(apps)/_server/runtime'
import {
  type CallActionTarget,
  callActionIdOf,
  callActionParamsOf,
  callActionTargetOf,
  NO_ACTION_PROBLEM,
  NO_TARGET_PROBLEM,
  paramsOfSchema,
  sameParams,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/call-action-shared'
import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { ancestors, byIdOf } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { withProblem } from '@/app/_authed/(extension-runtime)/_node-errors'
import { inCallFrame } from '@/app/_authed/(extension-runtime)/_server/call-stack'
import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { dispatchNodeActionImpl } from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import type { ExtensionManifest, NodeMetadata } from '@/app/_authed/(extension-runtime)/_types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/** A node as a target is looked up: its type and data, and the space it is in. */
export interface TargetNode {
  type?: string
  data?: Record<string, unknown>
  spaceSlug: string
}

/** Where target nodes are looked up: by default the stored graphs of every space. */
export type TargetNodeLookup = (nodeId: string) => TargetNode | undefined

interface StoredNode {
  id: string
  type?: string
  parentId?: string
  data?: Record<string, unknown>
}

/** A target resolved: who is called, in order, and the actions they offer. */
interface ResolvedTarget {
  kind: 'nodes' | 'app'
  owners: { id: string; label: string }[]
  /** The target as a reader is told it: the nodes' names, or the app's address. */
  label: string
  actions: GraphCallAction[]
}

type Resolution = { ok: true; target: ResolvedTarget } | { ok: false; problem: NodeError }

/** A node of the stored graphs of every space, as a target is looked up. */
export function storedTargetNode(nodeId: string): TargetNode | undefined {
  const ref = getSpacesRegistry().findByNode(nodeId)
  const node = (ref?.graph.graph.nodes as unknown as StoredNode[] | undefined)?.find((n) => n.id === nodeId)
  return ref && node ? { type: node.type, data: node.data, spaceSlug: ref.space.slug } : undefined
}

/** The space a node is in, from the stored graphs. */
export async function spaceOfNode(nodeId: string): Promise<string | undefined> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  return registry.findByNode(nodeId)?.space.slug
}

function nodeMetaOf(manifests: ExtensionManifest[], type: string | undefined): NodeMetadata | undefined {
  return type ? manifests.flatMap((m) => m.nodes ?? []).find((n) => n.type === type) : undefined
}

/** The actions nodes of `type` declare, each with whether its extension declares it `admin`. */
async function nodeTypeActions(manifests: ExtensionManifest[], type: string): Promise<GraphCallAction[]> {
  const meta = nodeMetaOf(manifests, type)
  const parsed = parseType(type)
  if (!meta?.actions || !parsed) {
    return []
  }
  let access: Record<string, string> | undefined
  try {
    access = (await getExtensionModule(parsed.extensionId)).nodeActionAccess?.[parsed.bare]
  } catch {
    // An extension whose module does not load runs none of its actions;
    // the call says so when it is made.
  }
  return meta.actions.map((action) => ({
    id: action.id,
    label: action.label,
    ...(action.description ? { description: action.description } : {}),
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
    admin: access?.[action.id] === 'admin',
  }))
}

function otherSpaceProblem(what: string, spaceSlug: string): NodeError {
  return {
    title: 'Target in another space',
    detail: `${what} is in the space "${spaceSlug}". A Call Action calls nodes and apps of its own space only.`,
    next: 'Pick a target in this space.',
  }
}

async function resolveNodes(spaceSlug: string, ids: string[], lookup: TargetNodeLookup): Promise<Resolution> {
  const manifests = await loadAllManifests()
  const owners: { id: string; label: string; type?: string }[] = []
  for (const id of ids) {
    const node = lookup(id) ?? storedTargetNode(id)
    if (!node) {
      return {
        ok: false,
        problem: {
          title: 'Target not found',
          detail: `No node ${id} is in this space.`,
          next: 'Pick the target again.',
        },
      }
    }
    const label = nodeName(node.data, nodeMetaOf(manifests, node.type)?.name, id)
    if (node.spaceSlug !== spaceSlug) {
      return { ok: false, problem: otherSpaceProblem(label, node.spaceSlug) }
    }
    owners.push({ id, label, type: node.type })
  }
  const types = [...new Set(owners.map((o) => o.type ?? ''))]
  if (types.length > 1) {
    const names = types.map((t) => nodeMetaOf(manifests, t)?.name ?? (t || 'untyped node'))
    return {
      ok: false,
      problem: {
        title: 'Targets of different types',
        detail: `The targets are of ${names.length} types (${names.join(', ')}). The nodes a Call Action calls together are all of one type.`,
        next: 'Pick nodes of one type, or use a Call Action for each type.',
      },
    }
  }
  return {
    ok: true,
    target: {
      kind: 'nodes',
      owners: owners.map(({ id, label }) => ({ id, label })),
      label: owners.map((o) => o.label).join(', '),
      actions: types[0] ? await nodeTypeActions(manifests, types[0]) : [],
    },
  }
}

function appActions(app: AppCallTarget): GraphCallAction[] {
  return app.actions.map((action) => ({
    id: action.id,
    label: action.label ?? action.id,
    ...(action.description ? { description: action.description } : {}),
    ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
    admin: false,
  }))
}

async function resolveApp(spaceSlug: string, ref: string): Promise<Resolution> {
  const app = await appCallTarget(ref)
  if (!app) {
    return {
      ok: false,
      problem: { title: 'Target not found', detail: `No app ${ref} exists.`, next: 'Pick the target again.' },
    }
  }
  if (app.spaceSlug !== spaceSlug) {
    return { ok: false, problem: otherSpaceProblem(app.address, app.spaceSlug) }
  }
  if (!app.provided) {
    return {
      ok: false,
      problem: {
        title: "The target app's extension is not installed",
        detail: `${app.address} is an app of type ${app.type}, which no installed extension provides.`,
        next: 'Install its extension, or pick another target.',
      },
    }
  }
  return {
    ok: true,
    target: {
      kind: 'app',
      owners: [{ id: app.instanceId, label: app.address }],
      label: app.address,
      actions: appActions(app),
    },
  }
}

async function resolveTarget(
  spaceSlug: string,
  target: CallActionTarget | undefined,
  lookup: TargetNodeLookup = () => undefined,
): Promise<Resolution> {
  if (!target) {
    return { ok: false, problem: NO_TARGET_PROBLEM }
  }
  return 'nodes' in target ? resolveNodes(spaceSlug, target.nodes, lookup) : resolveApp(spaceSlug, target.app)
}

/** The action `actionId` of a resolved target as a graph may call it, or why it may not. */
function callableAction(
  target: ResolvedTarget,
  actionId: string | undefined,
): { ok: true; action: GraphCallAction } | { ok: false; problem: NodeError } {
  if (!actionId) {
    return { ok: false, problem: NO_ACTION_PROBLEM }
  }
  const action = target.actions.find((a) => a.id === actionId)
  if (!action) {
    return {
      ok: false,
      problem: {
        title: 'Action not found',
        detail: `${target.label} has no action "${actionId}".`,
        next: 'Pick one of its actions on the card.',
      },
    }
  }
  if (action.admin) {
    return {
      ok: false,
      problem: {
        title: `${action.label} is not called from a graph`,
        detail: `Its extension declares it for administrators only, and a call from a graph runs as nobody.`,
        next: "Run it from the target's own card or menu, or pick another action.",
      },
    }
  }
  const params = paramsOfSchema(action.inputSchema)
  if (!params.ok) {
    return {
      ok: false,
      problem: { title: `${action.label} cannot be called from a graph`, detail: params.unavailable },
    }
  }
  return { ok: true, action }
}

/** An error carrying `problem`, with its title and detail as the message. */
function problemError(problem: NodeError): Error {
  return withProblem(new Error(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title), problem)
}

/**
 * What a Call Action's check finds: its target and action as they resolve now,
 * and its parameter snapshot against the action's schema. `spaceSlug` is the
 * space the node is in; `lookup` gives nodes of the graph being written, as
 * they are written, before the stored graphs.
 */
export async function callActionFindings(
  data: Record<string, unknown>,
  spaceSlug: string,
  lookup?: TargetNodeLookup,
): Promise<NodeError[]> {
  const resolved = await resolveTarget(spaceSlug, callActionTargetOf(data), lookup)
  if (!resolved.ok) {
    return [resolved.problem]
  }
  const callable = callableAction(resolved.target, callActionIdOf(data))
  if (!callable.ok) {
    return [callable.problem]
  }
  const schema = paramsOfSchema(callable.action.inputSchema)
  if (schema.ok && !sameParams(callActionParamsOf(data), schema.params)) {
    return [
      {
        title: `The parameters of ${callable.action.label} changed`,
        detail: 'The action takes other parameters than this node keeps.',
        next: 'Press Refresh on the card to take them again.',
      },
    ]
  }
  return []
}

/**
 * The nodes of the caller's graph that have an action, and the apps of its
 * space: what a Call Action's picker offers. The caller itself is left out.
 */
export async function graphCallTargets(callerNodeId: string): Promise<GraphCallTargets> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const ref = registry.findByNode(callerNodeId)
  if (!ref) {
    throw new Error(`Node not found: ${callerNodeId}`)
  }
  const manifests = await loadAllManifests()
  const nodes = ref.graph.graph.nodes as unknown as StoredNode[]
  const byId = byIdOf(nodes)
  const listed: GraphCallTargets['nodes'] = []
  for (const node of nodes) {
    const meta = nodeMetaOf(manifests, node.type)
    if (node.id === callerNodeId || !meta?.actions?.length || !node.type) {
      continue
    }
    const path = ancestors(node.id, byId)
      .filter((n) => isSubgraph(n))
      .map((n) => nodeName(n.data, undefined, n.id))
      .reverse()
    listed.push({
      id: node.id,
      name: nodeName(node.data, meta.name, node.id),
      type: node.type,
      typeName: meta.name,
      ...(meta.icon ? { icon: meta.icon } : {}),
      path,
    })
  }
  const apps = (await spaceAppCallTargets(ref.space.slug)).map(({ instanceId, address, name, type }) => ({
    instanceId,
    address,
    name,
    type,
  }))
  return { nodes: listed, apps }
}

/** The actions `target` offers a call from the caller's graph; refused, naming why, when it does not resolve. */
export async function graphCallActions(callerNodeId: string, target: CallActionTarget): Promise<GraphCallAction[]> {
  const spaceSlug = await spaceOfNode(callerNodeId)
  if (!spaceSlug) {
    throw new Error(`Node not found: ${callerNodeId}`)
  }
  const resolved = await resolveTarget(spaceSlug, callActionTargetOf({ target }))
  if (!resolved.ok) {
    throw problemError(resolved.problem)
  }
  return resolved.target.actions
}

/**
 * Calls `actionId` of `target` with `params`, as a graph: with no caller, and
 * waiting for the work to end. Several nodes are called in order with the
 * same parameters, and the first failure stops the rest. Each call is entered
 * on the run's call stack (see `inCallFrame`), so one that leads back to an
 * action still running in the chain is refused. Answers the action's result,
 * or for several nodes their results in order. Refused before anything runs
 * when the target does not resolve, is in another space, or does not offer
 * the action to a graph.
 */
export async function callFromGraph(
  callerNodeId: string,
  target: CallActionTarget,
  actionId: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const spaceSlug = await spaceOfNode(callerNodeId)
  if (!spaceSlug) {
    throw new Error(`Node not found: ${callerNodeId}`)
  }
  const resolved = await resolveTarget(spaceSlug, callActionTargetOf({ target }))
  if (!resolved.ok) {
    throw problemError(resolved.problem)
  }
  const callable = callableAction(resolved.target, actionId)
  if (!callable.ok) {
    throw problemError(callable.problem)
  }
  const { kind, owners } = resolved.target
  const results: unknown[] = []
  for (const owner of owners) {
    const frame = { owner: owner.id, action: actionId, label: owner.label }
    results.push(
      await inCallFrame(frame, () =>
        kind === 'nodes'
          ? dispatchNodeActionImpl({ nodeId: owner.id, actionId, params })
          : callAppAction(owner.id, actionId, params),
      ),
    )
  }
  return results.length === 1 ? results[0] : results
}

/**
 * `data` of a Call Action as a write leaves it: an app target given by its
 * address stored by the app's instance id, which a rename does not move; and,
 * when the write gave `action` or `target` but no `params`, the snapshot of
 * the action's parameters taken now. A target or an action that does not
 * resolve is stored as written, and the check reports it.
 */
export async function callActionDataOnWrite(
  data: Record<string, unknown>,
  wrote: Record<string, unknown>,
  spaceSlug: string,
  lookup?: TargetNodeLookup,
): Promise<Record<string, unknown>> {
  let next = data
  const target = callActionTargetOf(data)
  if (target && 'app' in target && target.app.includes('.')) {
    const app = await appCallTarget(target.app)
    if (app) {
      next = { ...next, target: { app: app.instanceId } }
    }
  }
  const takesSnapshot =
    (Object.hasOwn(wrote, 'action') || Object.hasOwn(wrote, 'target')) && !Object.hasOwn(wrote, 'params')
  if (!takesSnapshot) {
    return next
  }
  const resolved = await resolveTarget(spaceSlug, callActionTargetOf(next), lookup)
  const action = resolved.ok ? resolved.target.actions.find((a) => a.id === callActionIdOf(next)) : undefined
  const schema = action ? paramsOfSchema(action.inputSchema) : undefined
  return schema?.ok ? { ...next, params: schema.params } : next
}
