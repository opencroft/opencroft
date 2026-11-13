import type { GraphWriteOrigin } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { mutateLiveGraph } from '@/app/_authed/(space)/_server/graph-collab'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { keyedLock } from '@/server/collab/keyed-lock'
import { secrets } from '@/server/secrets'

// ═══════════════════════════════════════════════════════════════════
// The key index of a Secrets Store node
//
// A store's rows are keyed by the id of the node that owns them, and the
// node's `data.secretKeys` lists their names: what its canvas face and every
// secret picker show, and what anyone auditing a store by name reads, since
// the values are not readable. The rows are the truth and the index follows
// them, written here and nowhere else.
//
// The index is re-derived from the rows after every write to a store, after
// every change to a graph holding a store, and for every store at boot. The
// graph pass is what keeps a list no row backs off a card: a pasted copy of a
// store gets a fresh id with the original's list and no rows, and any graph
// write that sets the list, an agent's for one, does the same. The re-derivations of one store run one after another, each
// reading the rows when its turn comes, so the last to run has read every
// write before it: two writes racing each other cannot leave the earlier list
// behind. A canvas save cannot overwrite the index either, because a graph
// write changes only the data keys its writer changed.
// ═══════════════════════════════════════════════════════════════════

const INDEX_ORIGIN: GraphWriteOrigin = { kind: 'system', name: 'secret index' }
const INDEX_FIELD = 'secretKeys'
// A burst of graph edits (typing in an inspector) is checked once, this long after its first edit.
const GRAPH_CHECK_DELAY_MS = 250

const withLock = keyedLock()

const graphCheck: { pending: Set<string>; timer: ReturnType<typeof setTimeout> | undefined; watching: boolean } = {
  pending: new Set(),
  timer: undefined,
  watching: false,
}

interface IndexNode {
  id?: unknown
  type?: unknown
  data?: Record<string, unknown>
}

/** The index a store's names make of `current`: exactly those names, in the store's order; null when it already is. */
export function exactIndex(current: string[], names: string[]): string[] | null {
  return sameList(current, names) ? null : names
}

/**
 * Whether a node carries a store's index. A Secrets Store node is created with an empty list; one
 * created without data (through a graph action, say) is told apart by its type.
 */
export function isSecretsStoreNode(node: IndexNode): boolean {
  if (Array.isArray(node.data?.[INDEX_FIELD])) {
    return true
  }
  return typeof node.type === 'string' && /(^|\.)core-secrets-store$/.test(node.type)
}

function indexOf(node: IndexNode): string[] {
  const list = node.data?.[INDEX_FIELD]
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

function storeIdsOf(nodes: IndexNode[]): string[] {
  return nodes
    .filter(isSecretsStoreNode)
    .map((node) => node.id)
    .filter((id): id is string => typeof id === 'string')
}

/**
 * Brings the index of the store node `storeId` to exactly the names its rows hold, reading them
 * inside the store's turn. Answers whether the index changed; false too when no store node has
 * that id.
 */
function updateIndex(storeId: string): Promise<boolean> {
  return withLock(storeId, async () => {
    const registry = getSpacesRegistry()
    await registry.ensureLoaded()
    const ref = registry.findByNode(storeId)
    if (!ref) {
      return false
    }
    const names = await secrets.listKeys(storeId)
    return mutateLiveGraph(
      registry.addressOf(ref),
      INDEX_ORIGIN,
      (graph) => {
        const node = (graph.nodes as IndexNode[]).find((n) => n.id === storeId)
        if (!node || !isSecretsStoreNode(node)) {
          return false
        }
        const next = exactIndex(indexOf(node), names)
        if (!next) {
          return false
        }
        node.data = { ...node.data, [INDEX_FIELD]: next }
        return true
      },
      { resolveContexts: false },
    )
  })
}

/** Brings the store's index to exactly the names its rows hold. Registered as the store's write listener. */
export async function syncSecretIndex(storeId: string): Promise<void> {
  await updateIndex(storeId)
}

/**
 * Brings each store's index to exactly the names its rows hold, one store after another. A store
 * that fails is logged and the others still go ahead. Answers how many indexes changed.
 */
async function reconcileStores(storeIds: string[]): Promise<number> {
  let changed = 0
  for (const storeId of storeIds) {
    try {
      if (await updateIndex(storeId)) {
        changed++
      }
    } catch (err) {
      console.error(`[secret-index] the index of store ${storeId} could not be brought in step with its rows`, err)
    }
  }
  return changed
}

/** Brings every store's index to exactly the names its rows hold. Runs at boot; answers how many indexes changed. */
export async function reconcileSecretIndexes(): Promise<number> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  return reconcileStores(registry.listGraphs().flatMap((ref) => storeIdsOf(ref.graph.graph.nodes as IndexNode[])))
}

async function checkPendingGraphs(): Promise<void> {
  const registry = getSpacesRegistry()
  const graphIds = [...graphCheck.pending]
  graphCheck.pending.clear()
  const storeIds = graphIds.flatMap((graphId) => {
    const ref = registry.graphById(graphId)
    return ref ? storeIdsOf(ref.graph.graph.nodes as IndexNode[]) : []
  })
  await reconcileStores(storeIds)
}

function checkGraphLater(graphId: string): void {
  graphCheck.pending.add(graphId)
  // A pending check is left to run: it comes GRAPH_CHECK_DELAY_MS after the
  // first change of a burst, so a graph that keeps changing cannot put it off.
  if (graphCheck.timer !== undefined) {
    return
  }
  graphCheck.timer = setTimeout(() => {
    graphCheck.timer = undefined
    checkPendingGraphs().catch((err) => console.error('[secret-index] could not check the changed graphs', err))
  }, GRAPH_CHECK_DELAY_MS)
}

/** Keeps every store's index in step with its rows from now on: after each write to a store and each change to a graph. */
export function indexSecretStores(): void {
  secrets.onStoreChanged(syncSecretIndex)
  if (!graphCheck.watching) {
    graphCheck.watching = true
    getSpacesRegistry().onGraphChanged((ref) => checkGraphLater(ref.graph.id))
  }
}
