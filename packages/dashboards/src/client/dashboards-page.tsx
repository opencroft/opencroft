'use client'

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { setDashboardPinned } from '../server/actions'
import type { DashboardMeta } from '../types'
import { DashboardsTable } from './dashboards-table'

interface Props {
  dashboards: DashboardMeta[]
  initialPinned: string[]
}

export function DashboardsPage({ dashboards, initialPinned }: Props) {
  const router = useRouter()
  const [pinned, setPinned] = useState(initialPinned)

  async function handleTogglePin(slug: string, current: boolean) {
    setPinned(await setDashboardPinned({ slug, pinned: !current }))
    router.invalidate()
  }

  const items = dashboards.map((dashboard) => ({ ...dashboard, pinned: pinned.includes(dashboard.slug) }))
  return <DashboardsTable dashboards={items} onTogglePin={handleTogglePin} />
}
