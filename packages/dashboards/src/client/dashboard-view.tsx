'use client'

import type { ComponentType } from 'react'
import { Flex } from 'ui/layout/flex'

interface Props {
  component?: ComponentType
}

// The dashboard component owns the whole pane — no page chrome is rendered
// above it. A dashboard's title/description are navigation labels (lists,
// sidebar, document title), not an on-page header.
export function DashboardView({ component: Body }: Props) {
  return <Flex expanded>{Body && <Body />}</Flex>
}
