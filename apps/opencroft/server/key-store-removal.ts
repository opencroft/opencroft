import type { GraphNodeRecord } from '@opencroft/server/graph'

import { findKeyReferences } from '@/app/_authed/(extension-runtime)/_builtin/core/server/key-store-checks'
import type { NodeReference } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/delete-refusal-shared'
import { getSpacesRegistry, nodeIdsOf } from '@/app/_authed/(space)/_server/store'
import { deleteKeyStores, type KeyStoreHolding } from '@/server/ssh-key-store'

/** A key some store holds, and the nodes that would stop connecting without it. */
export interface KeyNameReferences {
  key: string
  references: NodeReference[]
}

/**
 * For each key the stores in `holding` hold, the nodes that name it where it resolves (see
 * `findKeyReferences`): on the store's graph, and routed copies on other graphs whose credentials
 * come from a node there. `removing` are left out: nodes deleted with the stores break with
 * nothing. Only keys something still names are listed, each name once with each node once. A
 * store on no graph (an orphan's rows) is named by nothing.
 */
export async function keyReferencesToStores(
  holding: KeyStoreHolding[],
  removing: Iterable<string> = [],
): Promise<KeyNameReferences[]> {
  if (holding.length === 0) {
    return []
  }
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const gone = new Set(removing)
  const nodes = registry.listGraphs().flatMap((ref) => ref.graph.graph.nodes as unknown as GraphNodeRecord[])
  const byKey = new Map<string, Map<string, NodeReference>>()
  for (const { storeId, keys } of holding) {
    const ref = registry.findByNode(storeId)
    if (!ref) {
      continue
    }
    const onStoreGraph = new Set(nodeIdsOf(ref.graph.graph))
    for (const key of keys) {
      const found = byKey.get(key) ?? new Map<string, NodeReference>()
      for (const node of findKeyReferences(nodes, storeId, key, onStoreGraph)) {
        if (!gone.has(node.nodeId)) {
          found.set(node.nodeId, node)
        }
      }
      byKey.set(key, found)
    }
  }
  return [...byKey]
    .filter(([, found]) => found.size > 0)
    .map(([key, found]) => ({ key, references: [...found.values()] }))
}

/**
 * A Key Store's keys are stored under the id of its node, outside its graph, as a Secrets Store's
 * secrets are, and go the same way: with the node's graph or space, both of which say they take
 * their data with them. A node deleted from a graph that stays keeps its keys until they are
 * purged on purpose (the canvas asks, the graph action takes `purgeKeys`), as a cut node comes
 * back under the same id when it is pasted. See `purgeSecretsWithTheirGraphs`.
 */
export function purgeKeysWithTheirGraphs(): void {
  getSpacesRegistry().onGraphNodesRemoved((nodeIds) => {
    void purgeKeysOf(nodeIds)
  })
}

/** Deletes the keys, and their cache files, of every node among `nodeIds`. Never throws: a failure is logged. */
export async function purgeKeysOf(nodeIds: string[]): Promise<void> {
  try {
    await deleteKeyStores(nodeIds)
  } catch (err) {
    // The rows stay, encrypted, under the ids of nodes that are on no graph.
    console.error('[key-store] the SSH keys of a deleted graph could not be deleted', err)
  }
}
