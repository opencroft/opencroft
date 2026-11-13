import type { GraphNodeRecord } from '@opencroft/server/graph'
import type { SecretKeyRecord } from '@opencroft/server/secrets'

// ═══════════════════════════════════════════════════════════════════
// Orphan secrets
//
// A secret row is an orphan when its store is no Secrets Store node on any
// graph of the instance: the node was deleted and its rows stayed behind.
// Every other row belongs to a store someone can open, so it is neither
// listed as an orphan nor deletable as one, whichever store is asking.
//
// The store list is an enumeration, and one that comes back short (a type
// that fails to resolve, a graph that did not load) gives no error: it
// would make every row on the instance look orphaned. The asking store is a
// store known to exist, so its absence from the list marks the list as
// untrustworthy, and both the listing and the delete refuse.
// ═══════════════════════════════════════════════════════════════════

type StoreNode = Pick<GraphNodeRecord, 'id'>

/** Why `stores` can't be trusted to tell orphans apart, or null when it can. */
function refuseStoreList(askingStoreId: string, live: Set<string>): string | null {
  if (live.has(askingStoreId)) {
    return null
  }
  return 'This Secrets Store is not on any saved graph, so orphan secrets cannot be told apart from live ones'
}

/** The rows no store in `stores` owns, in the order given. Throws when `askingStoreId` is not in `stores`. */
export function orphanRows(askingStoreId: string, rows: SecretKeyRecord[], stores: StoreNode[]): SecretKeyRecord[] {
  const live = new Set(stores.map((store) => store.id))
  const refusal = refuseStoreList(askingStoreId, live)
  if (refusal) {
    throw new Error(refusal)
  }
  return rows.filter((row) => !live.has(row.storeId))
}

/** Why row `id` may not be deleted as an orphan, or null when it may. */
export function refuseOrphanDelete(
  askingStoreId: string,
  id: string,
  rows: SecretKeyRecord[],
  stores: StoreNode[],
): string | null {
  const live = new Set(stores.map((store) => store.id))
  const refusal = refuseStoreList(askingStoreId, live)
  if (refusal) {
    return refusal
  }
  const row = rows.find((r) => r.id === id)
  if (!row) {
    return 'No such secret row'
  }
  if (live.has(row.storeId)) {
    return `Secret "${row.key}" belongs to a Secrets Store that exists; delete it from that store`
  }
  return null
}
