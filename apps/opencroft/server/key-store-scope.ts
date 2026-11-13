import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

/**
 * Throws, saying why, unless `storeId` is a Key Store node on the graph that holds `nodeId`. A
 * `<storeId>:<name>` key reference stored on a node (a Server's `keyPath`) reads its key only from
 * a store on that node's own graph, as a `secret:NAME` it stores resolves only from the Secrets
 * Stores there. The terminal package asks this before it reads any store key (see
 * `registerKeyStoreAccess` in `startup.ts`), so every SSH dial and every extension's
 * `ssh.resolveKey` is held to it.
 */
export async function requireKeyStoreOnGraphOf(storeId: string, nodeId: string | undefined): Promise<void> {
  if (!nodeId) {
    throw new Error(
      `A key from Key Store ${storeId} is used only for a node on the store's graph, and no node was given`,
    )
  }
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const ref = registry.findByNode(nodeId)
  if (!ref) {
    throw new Error(`Node ${nodeId} is on no graph, so no Key Store's key can be used for it`)
  }
  const store = (ref.graph.graph.nodes as { id?: unknown; type?: unknown }[]).find((node) => node.id === storeId)
  if (!store || parseType(String(store.type ?? ''))?.bare !== 'core-key-store') {
    throw new Error(
      `No Key Store ${storeId} on graph ${registry.addressOf(ref)}: a key is used only from a Key Store ` +
        'on the graph of the node that names it',
    )
  }
}
