'use client'

import { useEffect, useState } from 'react'

import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar'

interface BuildInfo {
  branch: string
  commit: string
}

const BUILD_INFO_URL = '/api/build-info'

export function DevBuildBadge() {
  const [info, setInfo] = useState<BuildInfo | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(BUILD_INFO_URL, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<BuildInfo>) : null))
      .then((data) => setInfo(data))
      .catch(() => {})
    return () => controller.abort()
  }, [])

  if (!info || (info.branch === 'unknown' && info.commit === 'unknown')) {
    return null
  }

  const label = [info.branch !== 'unknown' ? info.branch : null, info.commit !== 'unknown' ? info.commit.slice(0, 7) : null].filter(Boolean).join('@')

  if (!label) {
    return null
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className='px-2 py-1 text-[10px] font-mono text-muted-foreground/60 truncate' title={label}>
          {label}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
