'use client'

import { type Node, useReactFlow } from '@xyflow/react'
import { Loader2, Pencil, Save, X } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

import { useCustomTemplates } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/custom-templates-context'
import { nodeDefinitions } from '@/app/(legacy-app-dashboard)/_legacy/nodes'
import type { CustomTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/types'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

interface NodeSettingsPanelProps {
  node: Node
  onEditTemplate: (template: CustomTemplate) => void
}

export function NodeSettingsPanel({ node, onEditTemplate }: NodeSettingsPanelProps) {
  const { updateNodeData, setNodes } = useReactFlow()
  const { templates, definitions: customDefinitions } = useCustomTemplates()
  const def = nodeDefinitions.find((d) => d.type === node.type) ?? customDefinitions.find((d) => d.type === node.type)
  const customTemplate = node.type?.startsWith('custom-') ? templates.find((t) => `custom-${t.id}` === node.type) : undefined
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const saveRef = useRef<(() => void | Promise<void>) | null>(null)

  const updateData = useCallback(
    (partial: Record<string, unknown>) => {
      updateNodeData(node.id, { ...node.data, ...partial })
    },
    [node.id, node.data, updateNodeData],
  )

  const onDirtyChange = useCallback((d: boolean, save: () => void | Promise<void>) => {
    setDirty(d)
    saveRef.current = save
  }, [])

  const onLoadingChange = useCallback((l: boolean) => {
    setLoading(l)
  }, [])

  const save = useCallback(async () => {
    await saveRef.current?.()
    setDirty(false)
  }, [])

  const deselect = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
  }, [setNodes])

  if (!def) {
    return null
  }

  const Icon = def.icon
  const Settings = def.settings

  return (
    <div className='w-[300px] h-full border-l bg-card flex flex-col'>
      <div className='flex items-center gap-2 p-3'>
        <Icon className='h-4 w-4 text-muted-foreground' />
        <span className='text-sm font-semibold flex-1'>{def.label}</span>
        {customTemplate && (
          <Button variant='ghost' size='icon' className='h-6 w-6' onClick={() => onEditTemplate(customTemplate)}>
            <Pencil className='h-3.5 w-3.5' />
          </Button>
        )}
        <Button variant='ghost' size='icon' className='h-6 w-6' onClick={deselect}>
          <X className='h-3.5 w-3.5' />
        </Button>
      </div>
      <Separator />
      <div className='flex-1 overflow-y-auto p-3 relative'>
        {loading && (
          <div className='absolute inset-0 flex items-center justify-center bg-card/80 z-10'>
            <Loader2 className='h-5 w-5 animate-spin text-muted-foreground' />
          </div>
        )}
        <Settings id={node.id} data={node.data} updateData={updateData} onDirtyChange={onDirtyChange} onLoadingChange={onLoadingChange} />
      </div>
      <Separator />
      <div className='p-3'>
        <Button size='sm' className='w-full h-7 text-xs' disabled={!dirty || loading} onClick={save}>
          <Save className='h-3 w-3 mr-1' /> Save
        </Button>
      </div>
    </div>
  )
}
