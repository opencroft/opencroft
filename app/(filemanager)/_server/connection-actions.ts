import { createServerFn } from '@tanstack/react-start'

import type { StorageConnection } from '@/app/(filemanager)/_lib/types'
import { deleteSetting, getSetting, setSetting } from '@/app/(settings)/_server/actions'

const INDEX_KEY = 'filemanager-connections'

function connectionKey(id: string) {
  return `filemanager-connection:${id}`
}

interface ConnectionIndex {
  ids: string[]
}

export const getConnections = createServerFn().handler(async (): Promise<StorageConnection[]> => {
  const index = await getSetting({ data: INDEX_KEY })
  if (!index) {
    return []
  }

  const results: StorageConnection[] = []
  for (const id of index.data.ids) {
    const row = await getSetting({ data: connectionKey(id) })
    if (row) {
      results.push(row.data)
    }
  }
  return results
})

export const saveConnection = createServerFn({ method: 'POST' })
  .inputValidator((connection: StorageConnection) => connection)
  .handler(async ({ data: connection }): Promise<void> => {
    await setSetting({ data: { id: connectionKey(connection.id), data: connection } })

    const index = await getSetting({ data: INDEX_KEY })
    const ids = index?.data.ids ?? []
    if (!ids.includes(connection.id)) {
      await setSetting({ data: { id: INDEX_KEY, data: { ids: [...ids, connection.id] } } })
    }
  })

export const deleteConnection = createServerFn({ method: 'POST' })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }): Promise<void> => {
    await deleteSetting({ data: connectionKey(id) })

    const index = await getSetting({ data: INDEX_KEY })
    if (index) {
      await setSetting({ data: { id: INDEX_KEY, data: { ids: index.data.ids.filter((i) => i !== id) } } })
    }
  })
