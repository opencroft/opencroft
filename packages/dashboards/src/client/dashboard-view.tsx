'use client'

import type { ComponentType } from 'react'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'

interface Props {
  title: string
  description?: string
  component?: ComponentType
}

export function DashboardView({ title, description, component: Body }: Props) {
  return (
    <Flex expanded>
      <Flex row withSpacing align='baseline' className='w-full'>
        <h1 className='text-lg font-semibold'>{title}</h1>
        {description && <p className='text-sm text-muted-foreground'>{description}</p>}
      </Flex>
      {Body && <Body />}
    </Flex>
  )
}
