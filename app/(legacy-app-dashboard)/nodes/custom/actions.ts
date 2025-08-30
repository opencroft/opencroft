'use server';

import { type CustomTemplate } from '@/app/(legacy-app-dashboard)/nodes/custom/types';
import { getSetting, setSetting } from '@/app/(settings)/server/actions';

const SETTING_ID = 'custom-node-templates';

export async function loadTemplates(): Promise<CustomTemplate[]> {
  const setting = await getSetting<CustomTemplate[]>(SETTING_ID);
  return setting?.data ?? [];
}

export async function saveTemplates(templates: CustomTemplate[]): Promise<void> {
  await setSetting<CustomTemplate[]>(SETTING_ID, templates);
}
