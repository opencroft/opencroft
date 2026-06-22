import { icons, React, toast } from '@ext/host'
import { Button, Input, Label, ScrollArea, Textarea } from '@ext/ui'

const { useCallback, useEffect, useState } = React

interface SkillConfig {
  name: string
  description: string
  body: string
}

interface SkillRow {
  id: string
  config: SkillConfig
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export function AgentSkillsTab() {
  const [rows, setRows] = useState<SkillRow[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch('/api/acp/skills')
      .then((r) => r.json())
      .then((skills: SkillConfig[]) => setRows(skills.map((config) => ({ id: crypto.randomUUID(), config }))))
      .catch(() => setRows([]))
  }, [])

  const update = useCallback((id: string, patch: Partial<SkillConfig>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, config: { ...row.config, ...patch } } : row)))
  }, [])

  const add = useCallback(() => {
    setRows((current) => [...current, { id: crypto.randomUUID(), config: { name: '', description: '', body: '' } }])
  }, [])

  const remove = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id))
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      await fetch('/api/acp/skills', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(rows.map((row) => row.config)),
      })
      toast.success('Skills saved')
    } catch {
      toast.error('Failed to save skills')
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
          Skills are shared by every local agent in this workspace (not per node). Each skill is exposed to the agent
          client and loaded on demand when the agent invokes it.
        </p>
        {rows.map((row) => (
          <SkillRowEditor
            key={row.id}
            config={row.config}
            duplicate={!!row.config.name && names.filter((n) => n === row.config.name).length > 1}
            onChange={(patch) => update(row.id, patch)}
            onRemove={() => remove(row.id)}
          />
        ))}
        <Button variant='outline' size='sm' onClick={add}>
          <icons.Plus className='size-3 mr-1' />
          Add skill
        </Button>
        <Button size='sm' onClick={save} disabled={saving || hasConflict}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </ScrollArea>
  )
}

function SkillRowEditor({
  config,
  duplicate,
  onChange,
  onRemove,
}: {
  config: SkillConfig
  duplicate: boolean
  onChange: (patch: Partial<SkillConfig>) => void
  onRemove: () => void
}) {
  return (
    <div className='flex flex-col gap-2 rounded-md border p-2.5'>
      <div className='flex items-center gap-2'>
        <Input
          value={config.name}
          placeholder='name'
          className='h-7 text-xs font-mono'
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ name: e.target.value })}
        />
        <Button variant='ghost' size='sm' className='size-7 p-0' onClick={onRemove}>
          <icons.Trash2 className='size-3' />
        </Button>
      </div>
      {duplicate ? <span className='text-[10px] text-destructive'>Duplicate name</span> : null}
      <div className='flex flex-col gap-1'>
        <Label className='text-[10px] text-muted-foreground'>Description</Label>
        <Input
          value={config.description}
          placeholder='When to use this skill…'
          className='h-7 text-xs'
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ description: e.target.value })}
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-[10px] text-muted-foreground'>Instructions</Label>
        <Textarea
          value={config.body}
          rows={6}
          placeholder='Markdown instructions loaded when the agent invokes this skill…'
          className='text-xs font-mono'
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ body: e.target.value })}
        />
      </div>
    </div>
  )
}
