'use server';

import { Setting } from '@/app/(settings)/server/setting';
import * as db from '@/server/data';

export async function getSetting<T = Record<string, unknown>>(id: string): Promise<Setting<T> | null> {
  const row = await db.getSetting(id);
  if (!row) {
    return null;
  }
  return { ...row, data: JSON.parse(row.data) as T };
}

export async function setSetting<T = Record<string, unknown>>(id: string, data: T): Promise<Setting<T>> {
  const row = await db.upsertSetting(id, JSON.stringify(data));
  return { ...row, data };
}

export async function updateSetting<T = Record<string, unknown>>(id: string, data: Partial<T>): Promise<Setting<T> | null> {
  const existing = await db.getSetting(id);
  if (!existing) {
    return null;
  }
  const merged = { ...JSON.parse(existing.data), ...data } as T;
  const row = await db.upsertSetting(id, JSON.stringify(merged));
  return { ...row, data: merged };
}

export async function deleteSetting(id: string): Promise<boolean> {
  return db.deleteSetting(id);
}
