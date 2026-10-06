'use client'

import { useEffect, useState, useTransition } from 'react'
import { type AuditStatusFilter, McpAudit } from 'ui/settings/mcp-audit'

import {
  type AuditQuery,
  clearAuditLog,
  listAuditEntries,
  listAuditTools,
} from '@/app/_authed/(settings)/_server/audit-actions'

// The page is the kit's McpAudit; what stays here is loading the log and
// acting on it.

export default function AuditSettings() {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof listAuditEntries>>>([])
  const [tools, setTools] = useState<string[]>([])
  const [tool, setTool] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<AuditStatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()

  const reload = (next: AuditQuery) => {
    setLoading(true)
    startTransition(async () => {
      const [rows, knownTools] = await Promise.all([listAuditEntries({ data: next }), listAuditTools()])
      setEntries(rows)
      setTools(knownTools)
      setLoading(false)
    })
  }

  useEffect(() => {
    reload({})
  }, [])

  const onToolChange = (next: string | undefined) => {
    setTool(next)
    reload({ tool: next, status })
  }

  const onStatusChange = (next: AuditStatusFilter) => {
    setStatus(next)
    reload({ tool, status: next })
  }

  const onRefresh = () => {
    reload({ tool, status })
  }

  const onClear = () => {
    setLoading(true)
    startTransition(async () => {
      await clearAuditLog()
      const rows = await listAuditEntries({ data: {} })
      setEntries(rows)
      setTools([])
      setTool(undefined)
      setLoading(false)
    })
  }

  return (
    <McpAudit
      entries={entries}
      tools={tools}
      tool={tool}
      status={status}
      onToolChange={onToolChange}
      onStatusChange={onStatusChange}
      onRefresh={onRefresh}
      onClear={onClear}
      loading={loading}
      pending={pending}
    />
  )
}
