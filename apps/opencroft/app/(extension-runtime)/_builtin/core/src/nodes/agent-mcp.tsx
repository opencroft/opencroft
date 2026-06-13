import { icons, React, toast } from '@ext/host'
import {
  Badge,
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ext/ui'

const { useCallback, useEffect, useState } = React

type McpTransport = 'http' | 'sse' | 'stdio'

interface KeyValue {
  name: string
  value: string
}

interface McpServerConfig {
  name: string
  transport: McpTransport
  url?: string
  command?: string
  args?: string[]
  headers?: KeyValue[]
  env?: KeyValue[]
}

interface McpRow {
  id: string
  config: McpServerConfig
}

interface CheckState {
  status: 'checking' | 'ok' | 'failed'
  tools?: number
  error?: string
}

const TRANSPORTS: McpTransport[] = ['http', 'sse', 'stdio']

const JSON_HEADERS = { 'content-type': 'application/json' }

export function AgentMcpTab() {
  const [rows, setRows] = useState<McpRow[]>([])
  const [checks, setChecks] = useState<Record<string, CheckState>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/acp/mcp')
      .then((r) => r.json())
      .then((servers: McpServerConfig[]) => setRows(servers.map((config) => ({ id: crypto.randomUUID(), config }))))
      .catch(() => setRows([]))
  }, [])

  const update = useCallback((id: string, patch: Partial<McpServerConfig>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, config: { ...row.config, ...patch } } : row)))
  }, [])

  const add = useCallback(() => {
    setRows((current) => [...current, { id: crypto.randomUUID(), config: { name: '', transport: 'http', url: '' } }])
  }, [])

  const remove = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id))
    setChecks((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }, [])

  const test = useCallback(async (row: McpRow) => {
    setChecks((current) => ({ ...current, [row.id]: { status: 'checking' } }))
    try {
      const result = await fetch('/api/acp/mcp-check', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(row.config),
      }).then((r) => r.json())
      setChecks((current) => ({
        ...current,
        [row.id]: result.ok ? { status: 'ok', tools: result.tools } : { status: 'failed', error: result.error },
      }))
    } catch (err) {
      setChecks((current) => ({
        ...current,
        [row.id]: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
      }))
    }
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await fetch('/api/acp/mcp', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(rows.map((row) => row.config)),
      })
      toast.success('MCP servers saved')
    } catch {
      toast.error('Failed to save MCP servers')
    } finally {
      setSaving(false)
    }
  }, [rows])

  const names = rows.map((row) => row.config.name).filter(Boolean)
  const hasConflict = new Set(names).size !== names.length

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <p className='text-[10px] text-muted-foreground'>
          MCP servers are shared by every local agent in this workspace (not per node). opencroft's own tools are always
          available; add custom servers here.
        </p>
        {rows.map((row) => (
          <McpServerRow
            key={row.id}
            config={row.config}
            check={checks[row.id]}
            duplicate={!!row.config.name && names.filter((n) => n === row.config.name).length > 1}
            onChange={(patch) => update(row.id, patch)}
            onTest={() => test(row)}
            onRemove={() => remove(row.id)}
          />
        ))}
        <Button variant='outline' size='sm' onClick={add}>
          <icons.Plus className='size-3 mr-1' />
          Add server
        </Button>
        <Button size='sm' onClick={save} disabled={saving || hasConflict}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </ScrollArea>
  )
}

function McpServerRow({
  config,
  check,
  duplicate,
  onChange,
  onTest,
  onRemove,
}: {
  config: McpServerConfig
  check: CheckState | undefined
  duplicate: boolean
  onChange: (patch: Partial<McpServerConfig>) => void
  onTest: () => void
  onRemove: () => void
}) {
  return (
    <div className='flex flex-col gap-2 rounded-md border p-2.5'>
      <div className='flex items-center gap-2'>
        <Input
          value={config.name}
          placeholder='name'
          className='h-7 text-xs'
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ name: e.target.value })}
        />
        <Select value={config.transport} onValueChange={(v: string) => onChange({ transport: v as McpTransport })}>
          <SelectTrigger className='h-7 w-24 text-xs'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSPORTS.map((t) => (
              <SelectItem key={t} value={t} className='text-xs'>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant='ghost' size='sm' className='size-7 p-0' onClick={onRemove}>
          <icons.Trash2 className='size-3' />
        </Button>
      </div>
      {duplicate ? <span className='text-[10px] text-destructive'>Duplicate name</span> : null}
      {config.transport === 'stdio' ? (
        <>
          <Input
            value={config.command ?? ''}
            placeholder='command'
            className='h-7 text-xs font-mono'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ command: e.target.value })}
          />
          <Input
            value={(config.args ?? []).join(' ')}
            placeholder='args'
            className='h-7 text-xs font-mono'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              onChange({ args: e.target.value.split(' ').filter(Boolean) })
            }
          />
          <KeyValueEditor label='Environment' entries={config.env ?? []} onChange={(env) => onChange({ env })} />
        </>
      ) : (
        <>
          <Input
            value={config.url ?? ''}
            placeholder='https://example.com/mcp'
            className='h-7 text-xs font-mono'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ url: e.target.value })}
          />
          <KeyValueEditor
            label='Headers (e.g. Authorization: Bearer …)'
            entries={config.headers ?? []}
            onChange={(headers) => onChange({ headers })}
          />
        </>
      )}
      <div className='flex items-center gap-2'>
        <Button
          variant='outline'
          size='sm'
          className='h-6 text-[10px]'
          onClick={onTest}
          disabled={check?.status === 'checking'}
        >
          {check?.status === 'checking' ? <icons.Loader2 className='size-3 animate-spin' /> : 'Test'}
        </Button>
        <CheckBadge check={check} />
      </div>
    </div>
  )
}

function CheckBadge({ check }: { check: CheckState | undefined }) {
  if (!check || check.status === 'checking') {
    return null
  }
  if (check.status === 'ok') {
    return (
      <Badge variant='secondary' className='text-[10px]'>
        {check.tools ?? 0} tools
      </Badge>
    )
  }
  return (
    <span className='text-[10px] text-destructive truncate' title={check.error}>
      {check.error ?? 'failed'}
    </span>
  )
}

function KeyValueEditor({
  label,
  entries,
  onChange,
}: {
  label: string
  entries: KeyValue[]
  onChange: (entries: KeyValue[]) => void
}) {
  const set = (index: number, patch: Partial<KeyValue>) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  return (
    <div className='flex flex-col gap-1.5'>
      <Label className='text-[10px] text-muted-foreground'>{label}</Label>
      {entries.map((entry, index) => (
        <div key={index} className='flex items-center gap-1.5'>
          <Input
            value={entry.name}
            placeholder='name'
            className='h-7 w-1/3 text-xs font-mono'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(index, { name: e.target.value })}
          />
          <Input
            value={entry.value}
            placeholder='value'
            className='h-7 text-xs font-mono'
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => set(index, { value: e.target.value })}
          />
          <Button
            variant='ghost'
            size='sm'
            className='size-7 p-0'
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            <icons.X className='size-3' />
          </Button>
        </div>
      ))}
      <Button
        variant='outline'
        size='sm'
        className='h-6 self-start text-[10px]'
        onClick={() => onChange([...entries, { name: '', value: '' }])}
      >
        <icons.Plus className='size-3 mr-1' />
        Add
      </Button>
    </div>
  )
}
