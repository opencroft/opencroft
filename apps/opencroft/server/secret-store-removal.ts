import type { SecretKeyReferences } from '@/app/_authed/(secrets-store)/_lib/secret-references'
import { getSpacesRegistry, nodeIdsOf } from '@/app/_authed/(space)/_server/store'
import { secrets, storeIdsOn } from '@/server/secrets'

/**
 * What removing the graph of App instance `instanceId` breaks: the Apps of its space that name a
 * secret of a store on it. Its own nodes go with it, and no other graph resolves from its stores.
 * Empty for an instance that owns no graph. Removing a whole space breaks nothing this way: every
 * node and App that could resolve from its stores goes with it.
 */
export async function referencesLostWithGraph(instanceId: string): Promise<SecretKeyReferences[]> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const graph = registry.graphByInstance(instanceId)
  if (!graph) {
    return []
  }
  return secrets.referencesToStores(storeIdsOn([graph.graph]), nodeIdsOf(graph.graph))
}

/**
 * A store's secrets are stored under the id of the node that owns them, outside its graph. They
 * are deleted here when that node's graph or space is deleted, both of which say they take their
 * data with them. A node deleted from a graph that stays keeps its secrets until they are purged
 * on purpose (the canvas asks, the graph action takes `purgeSecrets`): a node can leave its graph
 * for a moment, through a cut before its paste, and a deleted secret cannot be recovered.
 */
export function purgeSecretsWithTheirGraphs(): void {
  getSpacesRegistry().onGraphNodesRemoved((nodeIds) => {
    void purgeSecretsOf(nodeIds)
  })
}

/** Deletes the secrets every node among `nodeIds` owns. Never throws: a failure is logged. */
export async function purgeSecretsOf(nodeIds: string[]): Promise<void> {
  try {
    const removed = new Set(nodeIds)
    for (const { storeId } of await secrets.listStores()) {
      if (removed.has(storeId)) {
        await secrets.deleteStore(storeId)
      }
    }
  } catch (err) {
    // The rows stay, and every store's inspector lists them as orphans to delete by hand.
    console.error('[secrets] the secrets of a deleted graph could not be deleted', err)
  }
}
