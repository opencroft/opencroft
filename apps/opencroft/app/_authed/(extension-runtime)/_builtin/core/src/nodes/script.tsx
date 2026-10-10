import { dispatch } from '@opencroft/client/actions'
import {
  InputHandle,
  inspectorIntent,
  NodeFrame,
  OutputHandle,
  useGraphNodes,
  useNodeContext,
  useReactFlow,
} from '@opencroft/client/canvas'
import { CodeEditor, type CodeEditorLanguage } from '@opencroft/client/code'
import { extensionId } from '@opencroft/client/extension'
import { getStream, type Stream, type TextChunk } from '@opencroft/client/streams'
import {
  Badge,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@opencroft/client/ui'
import { Code, Hexagon, Pencil, Play, ScrollText, TerminalSquare, X } from 'lucide-react'
import { type ChangeEvent, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { type ScriptResult, setScriptResult, useScriptResult } from './script-output-store'
import { storedType } from './stored-type'

export interface ScriptData {
  script: string
  language: 'bash' | 'python' | 'node'
  env: string
  secrets: string
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh'
  [key: string]: unknown
}

const LANG_CONFIG = {
  bash: { icon: TerminalSquare, accent: 'oklch(0.7 0.18 60)', label: 'Bash' },
  python: { icon: Code, accent: 'oklch(0.6 0.18 260)', label: 'Python' },
  node: { icon: Hexagon, accent: 'oklch(0.65 0.2 150)', label: 'Node.js' },
} as const

function editorLanguage(language: ScriptData['language']): CodeEditorLanguage {
  if (language === 'python') {
    return 'python'
  }
  if (language === 'node') {
    return 'javascript'
  }
  return 'shell'
}

// ═════════════════════════════════════════════════════════════════════
// Script node
// ═════════════════════════════════════════════════════════════════════

function ScriptNode({ id, data, selected }: { id: string; data: ScriptData; selected?: boolean }) {
  const lang = LANG_CONFIG[data.language]
  const ctx = useNodeContext<TerminalContext>(id, 'ctx-in')
  const { setNodes } = useReactFlow()
  const result = useScriptResult(id)
  const [running, setRunning] = useState(false)

  const errors = (data as ScriptData & { __errors?: string[] }).__errors

  const focus = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === id })))
  }, [id, setNodes])

  const openTab = useCallback(
    (tab: string) => {
      focus()
      inspectorIntent.open(id, tab)
    },
    [id, focus],
  )

  const run = useCallback(async () => {
    if (!data.script.trim()) {
      return
    }
    setRunning(true)
    setScriptResult(id, null)
    try {
      const res = (await dispatch(id, 'run')) as ScriptResult
      setScriptResult(id, res)
    } catch (err) {
      toast.error(`Script failed: ${String(err)}`)
    } finally {
      setRunning(false)
    }
  }, [id, data.script])

  return (
    <NodeFrame
      icon={lang.icon}
      title={lang.label}
      subtitle={ctx?.value ? `on ${ctx.value.type}` : 'local'}
      selected={selected ?? false}
      loading={running}
      errors={errors}
      input={<InputHandle type='execution-context' id='exec-in' />}
      extra={
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={() => openTab('editor')}
          >
            <Pencil className='h-2.5 w-2.5 shrink-0' />
          </Button>
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={run}
            disabled={running || !data.script.trim()}
          >
            <Play className='h-2.5 w-2.5 shrink-0' />
          </Button>
        </div>
      }
    >
      <div className='flex gap-3'>
        <div className='flex flex-col gap-1.5 shrink-0'>
          <InputHandle type='terminal-context' id='ctx-in'>
            <span className='text-[10px] text-muted-foreground'>Target</span>
          </InputHandle>
        </div>
        <div className='flex flex-col gap-1 flex-1 min-w-0 items-end'>
          <OutputHandle type='text-stream' id='stdout-out'>
            {result ? (
              <Button
                variant='ghost'
                size='sm'
                className='nodrag nopan h-5 text-[10px] px-1.5'
                onClick={() => openTab('output')}
              >
                <ScrollText className='h-2.5 w-2.5 shrink-0' />
                <span>Output</span>
              </Button>
            ) : (
              <span className='text-[10px] text-muted-foreground'>Output</span>
            )}
          </OutputHandle>
        </div>
      </div>
    </NodeFrame>
  )
}

// ═════════════════════════════════════════════════════════════════════
// SecretsPicker — reused from Application inspector
// ═════════════════════════════════════════════════════════════════════

interface SecretsStoreNodeData {
  secretKeys?: string[]
}

function SecretsPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const nodes = useGraphNodes()

  const availableKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const n of nodes as { type?: string; data?: SecretsStoreNodeData }[]) {
      if (n.type !== storedType(extensionId, 'core-secrets-store')) continue
      for (const key of n.data?.secretKeys ?? []) {
        keys.add(key)
      }
    }
    return [...keys].sort()
  }, [nodes])

  const selected = useMemo(
    () =>
      value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    [value],
  )

  const remaining = useMemo(() => availableKeys.filter((k) => !selected.includes(k)), [availableKeys, selected])

  const remove = useCallback(
    (name: string) => {
      onChange(selected.filter((s) => s !== name).join('\n'))
    },
    [onChange, selected],
  )

  const add = useCallback(
    (name: string) => {
      if (!name || selected.includes(name)) return
      onChange([...selected, name].join('\n'))
    },
    [onChange, selected],
  )

  const stale = selected.filter((s) => !availableKeys.includes(s))

  return (
    <div className='flex flex-col gap-1.5'>
      {selected.length > 0 ? (
        <div className='flex flex-wrap gap-1'>
          {selected.map((name) => {
            const missing = stale.includes(name)
            return (
              <Badge
                key={name}
                variant={missing ? 'destructive' : 'secondary'}
                className='gap-1 font-mono text-[10px] pr-1'
                title={missing ? 'Not found in any Secrets Store' : ''}
              >
                <span>{name}</span>
                <button type='button' onClick={() => remove(name)} className='hover:opacity-70'>
                  <X className='h-3 w-3' />
                </button>
              </Badge>
            )
          })}
        </div>
      ) : null}
      {remaining.length > 0 ? (
        <Select
          value=''
          onValueChange={(v) => {
            if (v !== null) {
              add(v)
            }
          }}
        >
          <SelectTrigger className='h-7 text-xs'>
            <SelectValue placeholder='Add secret…' />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((k) => (
              <SelectItem key={k} value={k} className='font-mono text-xs'>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : availableKeys.length === 0 ? (
        <p className='text-[10px] text-muted-foreground italic'>
          No Secrets Stores in this graph. Add a Secrets Store node and define keys to pick from.
        </p>
      ) : (
        <p className='text-[10px] text-muted-foreground italic'>
          All available secrets ({availableKeys.length}) selected.
        </p>
      )}
    </div>
  )
}

function ScriptInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: ScriptData
  updateData: (p: Partial<ScriptData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
        <span>Language: {LANG_CONFIG[data.language].label}</span>
        <span className='italic'>Open the Editor tab to edit code.</span>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Environment (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.env ?? ''}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => updateData({ env: e.target.value })}
          placeholder={'NODE_ENV=production\nDEBUG=false'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Secrets</Label>
        <SecretsPicker value={data.secrets ?? ''} onChange={(next: string) => updateData({ secrets: next })} />
      </div>
    </div>
  )
}

export function ScriptCodeEditorTab({
  data,
  updateData,
}: {
  nodeId: string
  data: ScriptData
  updateData: (p: Partial<ScriptData>) => void
}) {
  return (
    <div className='h-full w-full overflow-hidden'>
      <CodeEditor
        value={data.script ?? ''}
        language={editorLanguage(data.language)}
        onChange={(next: string) => updateData({ script: next })}
      />
    </div>
  )
}

export function ScriptOutputTab({
  nodeId,
}: {
  nodeId: string
  data: ScriptData
  updateData: (p: Partial<ScriptData>) => void
}) {
  const result = useScriptResult(nodeId)
  if (!result) {
    return <div className='p-3 text-xs text-muted-foreground italic'>Run the script to see output here.</div>
  }
  return (
    <div className='h-full w-full bg-black p-2 overflow-auto'>
      <pre className='font-mono text-[11px] text-[#cccccc] whitespace-pre-wrap'>{result.stdout}</pre>
      {result.stderr ? (
        <pre className='font-mono text-[11px] text-red-400 whitespace-pre-wrap mt-2'>{result.stderr}</pre>
      ) : null}
      <div className={`font-mono text-[11px] mt-2 ${result.exitCode === 0 ? 'text-green-400' : 'text-red-400'}`}>
        --- exit {result.exitCode} ---
      </div>
    </div>
  )
}

export function makeBashNode() {
  return {
    component: ScriptNode,
    inspector: ScriptInspector,
    editorTab: ScriptCodeEditorTab,
    outputTab: ScriptOutputTab,
  }
}

export function makePythonNode() {
  return {
    component: ScriptNode,
    inspector: ScriptInspector,
    editorTab: ScriptCodeEditorTab,
    outputTab: ScriptOutputTab,
  }
}

export function makeNodeJsNode() {
  return {
    component: ScriptNode,
    inspector: ScriptInspector,
    editorTab: ScriptCodeEditorTab,
    outputTab: ScriptOutputTab,
  }
}

export function scriptExposeOutput(
  handleId: string,
  _data: unknown,
  _type: string,
  nodeId: string,
): Stream<TextChunk> | undefined {
  if (handleId === 'stdout-out') {
    return getStream<TextChunk>(nodeId, 'stdout-out')
  }
  return undefined
}
