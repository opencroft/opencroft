'use client'

import { Button } from '@opencroft/ui-kit/button'
import { Input } from '@opencroft/ui-kit/input'
import { Label } from '@opencroft/ui-kit/label'
import { Textarea } from '@opencroft/ui-kit/textarea'
import { type Node, type NodeProps, useReactFlow } from '@xyflow/react'
import { FileCode2, Play, TerminalSquare } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { useSettingsDraft } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/use-settings-draft'
import { runScript } from '@/app/(legacy-app-dashboard)/_legacy/nodes/script/actions'
import { ButtonPin, HANDLE_EXECUTION } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/button-pin'
import { PinnedNode } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/pinned-node'

export type ScriptData = {
  name: string
  code: string
}

export type ScriptNode = Node<ScriptData, 'script'>

function ScriptComponent({ id, data, selected }: NodeProps<ScriptNode>) {
  const { getNodes, getEdges } = useReactFlow()
  const [output, setOutput] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = useCallback(async () => {
    const edges = getEdges()
    const incoming = edges.find((e) => e.target === id && e.targetHandle === HANDLE_EXECUTION)
    if (!incoming) {
      return
    }

    const source = getNodes().find((n) => n.id === incoming.source)
    if (!source?.type) {
      return
    }

    setRunning(true)
    setOutput(null)
    try {
      const result = await runScript({
        data: {
          nodeType: source.type,
          nodeData: source.data as Record<string, unknown>,
          code: data.code,
        },
      })
      setOutput(result)
    } catch (e) {
      setOutput(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
    setRunning(false)
  }, [id, data.code, getEdges, getNodes])

  const lines = (data.code || '').split('\n').length

  return (
    <PinnedNode
      selected={selected}
      loading={running}
      accent='oklch(0.65 0.15 260)'
      icon={FileCode2}
      iconClassName='text-indigo-400'
      title={data.name || 'Script'}
      subtitle={`${lines} line${lines !== 1 ? 's' : ''}`}
      input={<ButtonPin handleId={HANDLE_EXECUTION} icon={TerminalSquare} label='Exec' side='left' />}
      output={
        <div className='nodrag nopan'>
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1.5' onClick={run} disabled={running || !data.code}>
            <Play className='h-2.5 w-2.5 mr-0.5' />
            {running ? 'Running...' : 'Run'}
          </Button>
        </div>
      }
      preview={output ? <pre className='mt-1 text-[9px] font-mono text-muted-foreground bg-black/20 rounded p-1 max-h-20 overflow-auto whitespace-pre-wrap'>{output}</pre> : undefined}
    />
  )
}

function ScriptSettings(props: NodeSettingsProps<ScriptData>) {
  const { draft, update } = useSettingsDraft(props)

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Name</Label>
        <Input value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} className='h-7 text-xs' />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Code</Label>
        <Textarea value={draft.code ?? ''} onChange={(e) => update({ code: e.target.value })} className='min-h-[120px] text-xs font-mono resize-y' placeholder='#!/bin/bash' spellCheck={false} />
      </div>
    </div>
  )
}

export const scriptDefinition: NodeTypeDefinition<ScriptData> = {
  type: 'script',
  label: 'Script',
  icon: FileCode2,
  group: 'Automation',
  defaultData: () => ({ name: '', code: '' }),
  component: ScriptComponent,
  settings: ScriptSettings,
}
