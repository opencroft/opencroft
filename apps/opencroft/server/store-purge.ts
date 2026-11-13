import type { SecretKeyReferences } from '@/app/_authed/(secrets-store)/_lib/secret-references'
import { type KeyNameReferences, keyReferencesToStores } from '@/server/key-store-removal'
import { secrets } from '@/server/secrets'
import { deleteKeyStores, type KeyStoreHolding, keyStoresHolding } from '@/server/ssh-key-store'

// ═══════════════════════════════════════════════════════════════════
// Deleting stores from the canvas
//
// A Secrets Store's secrets and a Key Store's keys are stored under the id of
// their node, outside the graph, and a deleted one cannot be recovered. The
// canvas deletes them with their nodes once the person has confirmed it, in
// one confirm and one purge for both kinds: a purge refused for either deletes
// neither, so the nodes never stay while half of what they held is gone.
// ═══════════════════════════════════════════════════════════════════

/** A store among the nodes being deleted that holds something: secret names, or key names. */
export type StoreHolding = KeyStoreHolding

/** Who still names what the stores hold, by kind: those stop resolving it once it is purged. */
export interface StoredNamed {
  secrets: SecretKeyReferences[]
  keys: KeyNameReferences[]
}

/** What deleting a set of nodes takes with it, and who still names any of it. */
export interface StoresDeleted {
  secretStores: StoreHolding[]
  keyStores: StoreHolding[]
  named: StoredNamed
}

/**
 * The stores among `deleting` that hold secrets or keys, read from the stores themselves rather
 * than the nodes' indexes, and the nodes and Apps outside `deleting` that name what they hold.
 */
export async function storesDeletedWith(deleting: string[]): Promise<StoresDeleted> {
  const ids = new Set(deleting)
  const secretStores = (await secrets.listStores()).filter((store) => ids.has(store.storeId))
  const keyStores = await keyStoresHolding(deleting)
  const [secretsNamed, keysNamed] = await Promise.all([
    secrets.referencesToStores(
      secretStores.map((store) => store.storeId),
      deleting,
    ),
    keyReferencesToStores(keyStores, deleting),
  ])
  return { secretStores, keyStores, named: { secrets: secretsNamed, keys: keysNamed } }
}

/** A confirmed purge: done, or refused with every node and App that names something it would delete. */
export type PurgeOutcome = { purged: true } | { refused: StoredNamed }

/**
 * Purges the stores among `deleting` after a person confirmed it having been shown `shown`: the
 * nodes and Apps the confirm listed as still naming their secrets or keys. A node or App outside
 * `shown` that names one of them now refuses the whole purge and deletes nothing, so the confirm
 * lists it before anything it uses is gone.
 */
export async function purgeStoresConfirmed(deleting: string[], shown: string[]): Promise<PurgeOutcome> {
  const { secretStores, keyStores, named } = await storesDeletedWith(deleting)
  const acknowledged = new Set(shown)
  const references = [...named.secrets, ...named.keys].flatMap((entry) => entry.references)
  if (references.some((ref) => !acknowledged.has(ref.nodeId))) {
    return { refused: named }
  }
  for (const { storeId } of secretStores) {
    await secrets.deleteStore(storeId)
  }
  await deleteKeyStores(keyStores.map((store) => store.storeId))
  return { purged: true }
}
