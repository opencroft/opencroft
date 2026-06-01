import { createServerFn } from '@tanstack/react-start';

import { Setting } from '@/app/(settings)/server/setting';
import * as db from '@/server/data';

export const getSetting = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((id: string) => id).handler(async ({ data: id }): Promise<Setting<Record<string, unknown>> | null> => {
  const row = await db.getSetting(id);
  if (!row) {
    return null;
  }
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
});

export const setSetting = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((data: { id: string; data: Record<string, unknown> }) => data).handler(async ({ data }): Promise<Setting<Record<string, unknown>>> => {
  const { id } = data;
  const row = await db.upsertSetting(id, JSON.stringify(data.data));
  return { ...row, data: data.data };
});

export const updateSetting = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((data: { id: string; data: Partial<Record<string, unknown>> }) => data).handler(async ({ data }): Promise<Setting<Record<string, unknown>> | null> => {
  const { id } = data;
  const existing = await db.getSetting(id);
  if (!existing) {
    return null;
  }
  const merged = { ...JSON.parse(existing.data), ...data.data } as Record<string, unknown>;
  const row = await db.upsertSetting(id, JSON.stringify(merged));
  return { ...row, data: merged };
});

export const deleteSetting = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((id: string) => id).handler(async ({ data: id }): Promise<boolean> => {
  return db.deleteSetting(id);
});
