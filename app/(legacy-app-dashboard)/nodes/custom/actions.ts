import { createServerFn } from '@tanstack/react-start';

import { type CustomTemplate } from '@/app/(legacy-app-dashboard)/nodes/custom/types';
import { getSetting, setSetting } from '@/app/(settings)/server/actions';
import { type Setting } from '@/app/(settings)/server/setting';

const SETTING_ID = 'custom-node-templates';

export const loadTemplates = createServerFn({ strict: { output: false } }).handler(async (): Promise<CustomTemplate[]> => {
  const setting = (await getSetting({ data: SETTING_ID })) as Setting<CustomTemplate[]> | null;
  return setting?.data ?? [];
});

export const saveTemplates = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((templates: CustomTemplate[]) => templates).handler(async ({ data: templates }): Promise<void> => {
  await setSetting({ data: { id: SETTING_ID, data: templates } });
});
