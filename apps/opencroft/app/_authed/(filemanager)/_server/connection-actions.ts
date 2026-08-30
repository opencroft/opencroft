import { createServerFn } from '@tanstack/react-start'

import type { StorageConnection } from '@/app/_authed/(filemanager)/_lib/types'
import { getSettingImpl, setSettingImpl } from '@/app/_authed/(settings)/_server/settings-impl'
import * as db from '@/server/data'

const INDEX_KEY = 'filemanager-connections'

function connectionKey(id: string) {
  return `filemanager-connection:${id}`
}

interface ConnectionIndex {
  ids: string[]
}

export const getConnections = createServerFn().handler(async (): Promise<StorageConnection[]> => {
  const index = await getSettingImpl(INDEX_KEY)
  if (!index) {
    return []
  }

  const { ids } = index.data as unknown as ConnectionIndex
  const results: StorageConnection[] = []
  for (const id of ids) {
    const row = await getSettingImpl(connectionKey(id))
    if (row) {
      results.push(row.data as unknown as StorageConnection)
    }
  }
  return results
})

export const saveConnection = createServerFn({ method: 'POST' })
  .inputValidator((connection: StorageConnection) => connection)
  .handler(async ({ data: connection }): Promise<void> => {
    await setSettingImpl({ id: connectionKey(connection.id), data: connection })

    const index = await getSettingImpl(INDEX_KEY)
    const ids = (index?.data as unknown as ConnectionIndex | undefined)?.ids ?? []
    if (!ids.includes(connection.id)) {
      await setSettingImpl({ id: INDEX_KEY, data: { ids: [...ids, connection.id] } })
    }
  })

export const deleteConnection = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<void> => {
    await db.deleteSetting(connectionKey(id))

    const index = await getSettingImpl(INDEX_KEY)
    if (index) {
      const { ids } = index.data as unknown as ConnectionIndex
      await setSettingImpl({ id: INDEX_KEY, data: { ids: ids.filter((i) => i !== id) } })
    }
  })
