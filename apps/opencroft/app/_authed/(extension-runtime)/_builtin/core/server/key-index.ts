import type { HostGraphApi } from '@opencroft/server/graph'

import { turnsPerKey } from './turns-per-key'

// ═══════════════════════════════════════════════════════════════════
// The key list of a Key Store node
//
// A store's keys are files in its directory, and the node's `data.keyNames`
// lists their names: what its card shows without the store being opened. The
// files are the truth and the list follows them.
//
// Every write to a store's files re-derives its list once the write is done,
// and so does every read of the store's keys through the inspector or the
// `list` action, which repairs a list an earlier update failed to write. The
// re-derivations of one store run one after another, each reading the files
// when its turn comes, so the last to run has read every write before it: two
// writes racing each other cannot leave the earlier list behind.
// ═══════════════════════════════════════════════════════════════════

const KEY_NAMES_FIELD = 'keyNames'

export interface KeyIndexSource {
  /** The names of the keys the store's files hold, in the order the store lists them. */
  listNames(storeId: string): Promise<string[]>
  graph: Pick<HostGraphApi, 'getNode' | 'updateNode'>
  /** The stored type of a Key Store node: a node of any other type is never written. */
  storeType: string
}

const storeTurns = turnsPerKey()

function sameList(current: unknown, names: string[]): boolean {
  return Array.isArray(current) && current.length === names.length && current.every((name, i) => name === names[i])
}

/**
 * Brings the `keyNames` of the Key Store node `storeId` to exactly the names
 * its files hold. Answers whether the node changed; false when it already
 * listed them, or when `storeId` is no Key Store node.
 */
export function syncKeyIndex(storeId: string, source: KeyIndexSource): Promise<boolean> {
  return storeTurns(storeId, async () => {
    const node = await source.graph.getNode(storeId)
    if (node?.type !== source.storeType) {
      return false
    }
    const names = await source.listNames(storeId)
    if (sameList(node.data?.[KEY_NAMES_FIELD], names)) {
      return false
    }
    await source.graph.updateNode(storeId, { data: { [KEY_NAMES_FIELD]: names } })
    return true
  })
}
