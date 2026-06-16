'use client'

import { Link } from '@tanstack/react-router'
import { Pin } from 'lucide-react'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/table'
import { Toggle } from 'ui/toggle'

import type { DashboardMeta } from '../types'

export interface DashboardListItem extends DashboardMeta {
  pinned: boolean
}

interface Props {
  dashboards: DashboardListItem[]
  onTogglePin: (slug: string, pinned: boolean) => void
}

export function DashboardsTable({ dashboards, onTogglePin }: Props) {
  return (
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' justify='between' className='w-full'>
          <h1 className='text-lg font-semibold'>Dashboards</h1>
        </Flex>
      </ScrollHeader>

      <ScrollContent className='p-4'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Extension</TableHead>
              <TableHead className='w-16 text-right'>Pin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dashboards.map((dashboard) => (
              <TableRow key={dashboard.slug}>
                <TableCell>
                  <Link to={`/dashboard/${dashboard.slug}`} className='font-medium hover:underline'>
                    {dashboard.title}
                  </Link>
                </TableCell>
                <TableCell className='text-muted-foreground'>{dashboard.slug}</TableCell>
                <TableCell className='text-muted-foreground'>{dashboard.description}</TableCell>
                <TableCell className='text-muted-foreground'>{dashboard.extensionId}</TableCell>
                <TableCell>
                  <Flex row align='center' justify='end'>
                    <Toggle
                      pressed={dashboard.pinned}
                      onPressedChange={() => onTogglePin(dashboard.slug, dashboard.pinned)}
                      aria-label={dashboard.pinned ? 'Unpin' : 'Pin'}
                    >
                      <Pin />
                    </Toggle>
                  </Flex>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollContent>
    </ScrollPage>
  )
}
