'use client'

import type { DashboardDefinition, DashboardMeta } from '@opencroft/dashboards'
import { DashboardView } from '@opencroft/dashboards/client'

import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/(extension-runtime)/_client/provides'

// The dashboard's React component lives in the extension's client bundle, so it
// is resolved from the `dashboards` provider once extensions have loaded. Only
// the slug is needed here — the manifest's title/description label the dashboard
// in lists and navigation, not on the page itself.
export function DashboardPage({ meta }: { meta: DashboardMeta }) {
  const { items } = useProvided<DashboardDefinition>('dashboards', loadAllExtensions)
  const dashboard = items.find((entry) => entry.slug === meta.slug)
  return <DashboardView component={dashboard?.component} />
}
