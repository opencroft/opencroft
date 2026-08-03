import { createServerFn } from '@tanstack/react-start'

import type { CustomTemplate } from '@/app/_authed/(legacy-app-dashboard)/_legacy/nodes/custom/types'
import { getSetting, setSetting } from '@/app/_authed/(settings)/_server/actions'
import type { Setting } from '@/app/_authed/(settings)/_server/setting'

const SETTING_ID = 'custom-node-templates'

export const loadTemplates = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<CustomTemplate[]> => {
    const setting = (await getSetting({ data: SETTING_ID })) as Setting<CustomTemplate[]> | null
    return setting?.data ?? []
  },
)

export const saveTemplates = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((templates: CustomTemplate[]) => templates)
  .handler(async ({ data: templates }): Promise<void> => {
    await setSetting({ data: { id: SETTING_ID, data: templates } })
  })
