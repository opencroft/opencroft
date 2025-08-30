'use server';

import { StorageConnection } from '@/app/(filemanager)/files/types';
import { getSetting, setSetting, deleteSetting } from '@/app/(settings)/server/actions';

const INDEX_KEY = 'filemanager-connections';

function connectionKey(id: string) {
  return `filemanager-connection:${id}`;
}

interface ConnectionIndex {
  ids: string[];
}

export async function getConnections(): Promise<StorageConnection[]> {
  const index = await getSetting<ConnectionIndex>(INDEX_KEY);
  if (!index) {
    return [];
  }

  const results: StorageConnection[] = [];
  for (const id of index.data.ids) {
    const row = await getSetting<StorageConnection>(connectionKey(id));
    if (row) {
      results.push(row.data);
    }
  }
  return results;
}

export async function saveConnection(connection: StorageConnection): Promise<void> {
  await setSetting(connectionKey(connection.id), connection);

  const index = await getSetting<ConnectionIndex>(INDEX_KEY);
  const ids = index?.data.ids ?? [];
  if (!ids.includes(connection.id)) {
    await setSetting(INDEX_KEY, { ids: [...ids, connection.id] });
  }
}

export async function deleteConnection(id: string): Promise<void> {
  await deleteSetting(connectionKey(id));

  const index = await getSetting<ConnectionIndex>(INDEX_KEY);
  if (index) {
    await setSetting(INDEX_KEY, { ids: index.data.ids.filter(i => i !== id) });
  }
}
