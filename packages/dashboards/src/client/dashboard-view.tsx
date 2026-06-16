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
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' className='w-full'>
          <h1 className='text-lg font-semibold'>{title}</h1>
          {description && <p className='text-sm text-muted-foreground'>{description}</p>}
        </Flex>
      </ScrollHeader>
      <ScrollContent className='p-4'>{Body && <Body />}</ScrollContent>
    </ScrollPage>
  )
}
