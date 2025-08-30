'use server';

import { getSetting, setSetting } from '@/app/(settings)/server/actions';

const STORAGE_ID = 'app-dashboard-mvp-extension-storage';

type StorageMap = Record<string, unknown>;

function nsKey(extensionId: string, key: string): string {
  return `${extensionId}::${key}`;
}

async function readAll(): Promise<StorageMap> {
  const setting = await getSetting<StorageMap>(STORAGE_ID);
  return setting?.data ?? {};
}

async function writeAll(data: StorageMap): Promise<void> {
  await setSetting<StorageMap>(STORAGE_ID, data);
}

export async function extensionStorageGet<T = unknown>(extensionId: string, key: string): Promise<T | null> {
  const all = await readAll();
  return (all[nsKey(extensionId, key)] as T | undefined) ?? null;
}

export async function extensionStorageSet<T = unknown>(extensionId: string, key: string, value: T): Promise<void> {
  const all = await readAll();
  all[nsKey(extensionId, key)] = value;
  await writeAll(all);
}

export async function extensionStorageDelete(extensionId: string, key: string): Promise<void> {
  const all = await readAll();
  delete all[nsKey(extensionId, key)];
  await writeAll(all);
}

export async function extensionStorageList(extensionId: string): Promise<string[]> {
  const all = await readAll();
  const prefix = `${extensionId}::`;
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

export async function extensionStorageClear(extensionId: string): Promise<void> {
  const all = await readAll();
  const prefix = `${extensionId}::`;
  for (const k of Object.keys(all)) {
    if (k.startsWith(prefix)) {
      delete all[k];
    }
  }
  await writeAll(all);
}
