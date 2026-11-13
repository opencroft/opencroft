// The node types' data validators (`NodeDataValidator` in
// `@opencroft/server/graph`), run over a graph: by a graph write, to refuse
// the problems it would introduce, and as a graph is stored, to keep each
// node's `data` errors in step with its data. Their checks (`NodeCheck`), run
// as a graph is stored to keep each node's `check` errors in step with its
// data and wiring.

import type { NodeDataProblem, NodeError } from '@opencroft/core'
import type { EnumCasesOf } from '@opencroft/core/values'
import type { NodeCheck, NodeCheckEdge, NodeDataValidator } from '@opencroft/server/graph'

import { isCallAction } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/call-action-shared'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import { enumCasesOfManifests } from '@/app/_authed/(extension-runtime)/_enum-types'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  dataProblemsOf,
  introducedProblems,
  type RefusedProblem,
} from '@/app/_authed/(extension-runtime)/_node-data-problems'
import {
  CHECK_ERROR_SOURCE,
  DATA_ERROR_SOURCE,
  nodeErrorOf,
  withErrorsShownOnce,
  withNodeErrors,
} from '@/app/_authed/(extension-runtime)/_node-errors'
import {
  callActionFindings,
  storedTargetNode,
  type TargetNode,
} from '@/app/_authed/(extension-runtime)/_server/graph-calls'
import { getExtensionModule, getManifest, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import {
  edgesByNode,
  type NodeCheckPass,
  nodeCheckPass,
} from '@/app/_authed/(extension-runtime)/_server/node-check-instance'
import { typedInputProblems } from '@/app/_authed/(extension-runtime)/_typed-inputs'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { type GraphData, parseGraphAddress } from '@/app/_authed/(space)/_server/types'

interface StoredNode {
  id: string
  type?: unknown
  data?: Record<string, unknown>
}

interface NodeRules {
  validate?: NodeDataValidator
  check?: NodeCheck
  /** The extension the type is declared by, whose own types its check may read. */
  extensionId?: string
  /** The handles the type declares, whose typed values (`data.inputs`) the host checks. */
  handles?: ExtensionHandle[]
}

type RulesOf = (type: unknown) => Promise<NodeRules>

async function loadRules(type: unknown): Promise<NodeRules> {
  const parsed = typeof type === 'string' ? parseType(type) : null
  if (!parsed) {
    return {}
  }
  try {
    const module = await getExtensionModule(parsed.extensionId)
    const manifest = await getManifest(parsed.extensionId)
    return {
      validate: module.nodeDataValidators?.[parsed.bare],
      check: module.nodeChecks?.[parsed.bare],
      extensionId: parsed.extensionId,
      handles: manifest.nodes?.find((node) => node.type === type)?.handles,
    }
  } catch {
    // An extension that is not installed or does not load has no rules to
    // run; why it does not load is reported where it is activated.
    return {}
  }
}

/**
 * A lookup that loads each type's rules once, for one pass over a graph, and
 * the enums every extension declares, once, as the pass first needs them.
 */
function rulesLookup(): RulesOf & { enums(): Promise<EnumCasesOf> } {
  const loaded = new Map<unknown, Promise<NodeRules>>()
  let enums: Promise<EnumCasesOf> | undefined
  const rulesOf: RulesOf = (type) => {
    let rules = loaded.get(type)
    if (!rules) {
      rules = loadRules(type)
      loaded.set(type, rules)
    }
    return rules
  }
  return Object.assign(rulesOf, {
    enums: () => {
      enums ??= loadAllManifests().then(enumCasesOfManifests)
      return enums
    },
  })
}

// The type's validator's problems, then the host's own over the values typed
// into the node's inputs.
async function problemsOf(rulesOf: ReturnType<typeof rulesLookup>, node: StoredNode, data: Record<string, unknown>) {
  const { validate, handles = [] } = await rulesOf(node.type)
  // A subgraph's ports and a value node's inputs follow its data, not its type.
  const type = typeof node.type === 'string' ? node.type : undefined
  const typed = typedInputProblems(
    declaredHandlesOf({ type, data }, () => handles, await rulesOf.enums()),
    data,
  )
  if (!validate) {
    return typed
  }
  try {
    return [...dataProblemsOf(validate(data)), ...typed]
  } catch (err) {
    console.error(`[node-data] the data validator of ${String(node.type)} threw on node ${node.id}`, err)
    return typed
  }
}

async function findingsOf(
  rulesOf: RulesOf,
  pass: NodeCheckPass,
  node: StoredNode,
  data: Record<string, unknown>,
  edges: readonly NodeCheckEdge[],
): Promise<NodeError[]> {
  const { check, extensionId } = await rulesOf(node.type)
  if (!check || !extensionId) {
    return []
  }
  try {
    const found: unknown = check({ id: node.id, data }, edges, pass.instanceFor(extensionId))
    return Array.isArray(found) ? found.map(nodeErrorOf).filter((error) => error !== undefined) : []
  } catch (err) {
    console.error(`[node-data] the check of ${String(node.type)} threw on node ${node.id}`, err)
    return []
  }
}

/**
 * A Call Action's check, which is the host's: its target is looked up on
 * every graph of its space and among the apps there (see `callActionFindings`),
 * the nodes of `graph` as they are being written. The types of the target
 * nodes it reads are recorded on the pass, so a change to one on another
 * graph checks `graph` again.
 */
function callActionChecks(
  graph: GraphData,
  pass: NodeCheckPass,
  checked: { address: string } | undefined,
): (nodeId: string, data: Record<string, unknown>) => Promise<NodeError[]> {
  const local = new Map((graph.nodes as unknown as StoredNode[]).map((node) => [node.id, node]))
  const checkedSpace = checked ? parseGraphAddress(checked.address).spaceSlug : undefined
  return async (nodeId, data) => {
    const spaceSlug = checkedSpace ?? storedTargetNode(nodeId)?.spaceSlug
    if (!spaceSlug) {
      return []
    }
    const lookup = (id: string): TargetNode | undefined => {
      const own = local.get(id)
      const found = own
        ? { type: typeof own.type === 'string' ? own.type : undefined, data: own.data, spaceSlug }
        : storedTargetNode(id)
      if (found?.type) {
        pass.read(found.type)
      }
      return found
    }
    try {
      return await callActionFindings(data, spaceSlug, lookup)
    } catch (err) {
      console.error(`[node-data] the Call Action check threw on node ${nodeId}`, err)
      return []
    }
  }
}

/** Each node's data as it is now, by node id, to compare a write against. */
export function nodeDataSnapshot(graph: GraphData): Map<string, string> {
  const nodes = graph.nodes as unknown as StoredNode[]
  return new Map(nodes.map((node) => [node.id, JSON.stringify(node.data ?? {})]))
}

/**
 * The problems that the data of `graph`'s nodes has and had not when
 * `before` was taken: on every node whose data the write changed or created.
 */
export async function problemsIntroduced(before: Map<string, string>, graph: GraphData): Promise<RefusedProblem[]> {
  const rulesOf = rulesLookup()
  const refused: RefusedProblem[] = []
  for (const node of graph.nodes as unknown as StoredNode[]) {
    const data = node.data ?? {}
    const was = before.get(node.id)
    if (was === JSON.stringify(data)) {
      continue
    }
    const wasData: Record<string, unknown> = was === undefined ? {} : JSON.parse(was)
    const had: NodeDataProblem[] = was === undefined ? [] : await problemsOf(rulesOf, node, wasData)
    const has = await problemsOf(rulesOf, node, data)
    const introduced = introducedProblems({ data: wasData, problems: had }, { data, problems: has })
    refused.push(...introduced.map((problem) => ({ nodeId: node.id, ...problem })))
  }
  return refused
}

/**
 * `graph` with each node's `data` errors set to what its type's validator
 * finds in its data now, and its `check` errors to what its type's check
 * finds in its data, its edges and the instance now, less those another
 * source already reports on it. A node whose errors already say that is kept
 * as the same object.
 *
 * `checked` names the instance's graph that `graph` is, as it is being
 * written: the checks see `graph` in its place, and what they read of the
 * instance is recorded as what that graph depends on. Without it they see the
 * instance as the registry holds it.
 */
export async function withCheckedErrors(
  graph: GraphData,
  checked?: { id: string; address: string },
): Promise<GraphData> {
  const rulesOf = rulesLookup()
  const pass = nodeCheckPass(checked && { ...checked, graph }, await rulesOf.enums())
  const edges = edgesByNode(graph)
  const callActions = callActionChecks(graph, pass, checked)
  const nodes = await Promise.all(
    graph.nodes.map(async (stored) => {
      const node = stored as unknown as StoredNode
      const data = node.data ?? {}
      const problems = await problemsOf(rulesOf, node, data)
      const findings = [
        ...(await findingsOf(rulesOf, pass, node, data, edges.get(node.id) ?? [])),
        ...(isCallAction(node.type) ? await callActions(node.id, data) : []),
      ]
      const next = withErrorsShownOnce(withNodeErrors(data, DATA_ERROR_SOURCE, problems), CHECK_ERROR_SOURCE, findings)
      return next === data ? stored : { ...stored, data: next }
    }),
  )
  pass.finish()
  return { ...graph, nodes }
}
