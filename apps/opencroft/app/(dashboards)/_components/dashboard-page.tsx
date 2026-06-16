'use client'

import type { DashboardDefinition, DashboardMeta } from '@opencroft/dashboards'
import { DashboardView } from '@opencroft/dashboards/client'

import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/(extension-runtime)/_client/provides'

// The title/description come from the server (manifest) and render immediately.
// The dashboard's React component lives in the extension's client bundle, so it
// is resolved from the `dashboards` provider once extensions have loaded.
export function DashboardPage({ meta }: { meta: DashboardMeta }) {
  const { items } = useProvided<DashboardDefinition>('dashboards', loadAllExtensions)
  const dashboard = items.find((entry) => entry.slug === meta.slug)
  return <DashboardView title={meta.title} description={meta.description} component={dashboard?.component} />
}
