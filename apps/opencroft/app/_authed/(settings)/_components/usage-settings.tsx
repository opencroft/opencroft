'use client'

import type { UsageGrouping } from 'ui/admin/space-usage'

import type { ChatUsageQuery } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { getInstanceUsage } from '@/app/_authed/(settings)/_server/usage-actions'
import { UsagePanel } from '@/app/_authed/(space)/_components/usage-panel'

const GROUPINGS: UsageGrouping[] = ['all', 'agent', 'model', 'space']

// Module-level, so its identity holds for the page's whole life: the scope
// never changes.
const query = (query: ChatUsageQuery) => getInstanceUsage({ data: query })

/**
 * The Agents section's Usage tab: the Usage page over the whole instance's
 * spend, with a per-space grouping. No reset: each space resets its own.
 * Padded like the section's other tab panels, which pad themselves.
 */
export default function UsageSettings() {
  return <UsagePanel query={query} groupings={GROUPINGS} className='p-6' />
}
