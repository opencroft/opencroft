import { createServerFn } from '@tanstack/react-start'

import { listPinnedDashboardSlugs, setDashboardPinned as setPinned } from './pins'

const _listPinnedDashboards = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<string[]> => listPinnedDashboardSlugs(),
)
export const listPinnedDashboards = () => _listPinnedDashboards()

const _setDashboardPinned = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { slug: string; pinned: boolean }) => data)
  .handler(async ({ data }): Promise<string[]> => setPinned(data.slug, data.pinned))
export const setDashboardPinned = (data: { slug: string; pinned: boolean }) => _setDashboardPinned({ data })
