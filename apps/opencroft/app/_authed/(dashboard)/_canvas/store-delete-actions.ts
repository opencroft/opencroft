import { createServerFn } from '@tanstack/react-start'

import { type PurgeOutcome, purgeStoresConfirmed, type StoresDeleted, storesDeletedWith } from '@/server/store-purge'

/**
 * The Secrets Stores and Key Stores among `deleting` that hold anything, and the nodes and Apps
 * outside `deleting` that name what they hold: what the canvas's confirm shows.
 */
export const listStoresDeleted = createServerFn({ method: 'POST' })
  .inputValidator((data: { deleting: string[] }) => data)
  .handler(({ data }): Promise<StoresDeleted> => storesDeletedWith(data.deleting))

/**
 * Purges the stores among `deleting` once the person confirmed it: `shown` are the nodes and Apps
 * the confirm listed as still naming their secrets or keys, the only ones it purges past.
 */
export const purgeStores = createServerFn({ method: 'POST' })
  .inputValidator((data: { deleting: string[]; shown: string[] }) => data)
  .handler(({ data }): Promise<PurgeOutcome> => purgeStoresConfirmed(data.deleting, data.shown))
