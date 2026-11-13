import { dispatch } from '@opencroft/client/actions'
import { InputHandle, inspectorIntent, NodeFrame, OutputHandle, useNodeContext } from '@opencroft/client/canvas'
import { CodeEditor, type CodeEditorLanguage } from '@opencroft/client/code'
import { getStream, type Stream, type TextChunk } from '@opencroft/client/streams'
import { Button, EnvironmentTable, type EnvironmentVariable, Label } from '@opencroft/client/ui'
import { Code, Hexagon, Pencil, Play, ScrollText, TerminalSquare } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { environmentPatch, envNameProblem, readEnvironment } from './script-environment'
import { isScriptLanguage, type ScriptLanguage } from './script-language'
import { type ScriptResult, setScriptResult, useScriptResult } from './script-output-store'
import { useSecretKeys } from './secrets'

// Stored data is whatever its creator wrote, so every field may be missing,
// and `language` may hold a value no script node runs.
export interface ScriptData {
  script?: string
  language?: unknown
  // The stored form is script-environment.ts's to describe; read it only through readEnvironment.
  env?: unknown
  secrets?: unknown
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh'
  [key: string]: unknown
}

const LANG_CONFIG = {
  bash: { icon: TerminalSquare, accent: 'oklch(0.7 0.18 60)', label: 'Bash' },
  python: { icon: Code, accent: 'oklch(0.6 0.18 260)', label: 'Python' },
  node: { icon: Hexagon, accent: 'oklch(0.65 0.2 150)', label: 'Node.js' },
} as const satisfies Record<ScriptLanguage, unknown>

function editorLanguage(language: ScriptLanguage): CodeEditorLanguage {
  if (language === 'python') {
    return 'python'
  }
  if (language === 'node') {
    return 'javascript'
  }
  return 'shell'
}

// What the node shows itself as: the language its data names, or its type's
// when the data names none it runs (which the node's errors report).
function shownLanguage(data: ScriptData, typeLanguage: ScriptLanguage): ScriptLanguage {
  return isScriptLanguage(data.language) ? data.language : typeLanguage
}

/** The props every script node view gets beside its own: the language its type is created with. */
interface OfType {
  typeLanguage: ScriptLanguage
}

// ═════════════════════════════════════════════════════════════════════
// Script node
// ═════════════════════════════════════════════════════════════════════

function ScriptNode({
  id,
  data,
  selected,
  typeLanguage,
}: { id: string; data: ScriptData; selected?: boolean } & OfType) {
  const lang = LANG_CONFIG[shownLanguage(data, typeLanguage)]
  const script = data.script ?? ''
  const ctx = useNodeContext<TerminalContext>(id, 'ctx-in')
  const result = useScriptResult(id)
  const [running, setRunning] = useState(false)

  const openTab = useCallback(
    (tab: string) => {
      inspectorIntent.open(id, tab)
    },
    [id],
  )

  const run = useCallback(async () => {
    if (!script.trim()) {
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
  }, [id, script])

  return (
    <NodeFrame
      icon={lang.icon}
      title={lang.label}
      subtitle={ctx?.value ? `on ${ctx.value.type}` : 'local'}
      selected={selected ?? false}
      loading={running}
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
            disabled={running || !script.trim()}
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

// The node's Environment: the kit's table over the stored field, offering the
// keys of the Secrets Stores on this graph.
function EnvironmentField({ data, updateData }: Pick<ScriptViewProps, 'data' | 'updateData'>) {
  const secretNames = useSecretKeys()
  const { env, secrets } = data
  const variables = useMemo(() => readEnvironment({ env, secrets }), [env, secrets])
  return (
    <EnvironmentTable
      variables={variables}
      secrets={secretNames}
      onChange={(next: EnvironmentVariable[]) => updateData(environmentPatch(next))}
      validateName={envNameProblem}
      noSecretsMessage='No Secrets Stores in this graph. Add a Secrets Store node and define keys to pick from.'
    />
  )
}

interface ScriptViewProps extends OfType {
  nodeId: string
  data: ScriptData
  updateData: (p: Partial<ScriptData>) => void
}

function ScriptInspector({ data, updateData, typeLanguage }: ScriptViewProps) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1 text-xs text-muted-foreground'>
        {isScriptLanguage(data.language) ? (
          <span>Language: {LANG_CONFIG[data.language].label}</span>
        ) : (
          <div className='flex items-center gap-2'>
            <span className='text-destructive'>
              Language: {data.language === undefined ? 'not set' : JSON.stringify(data.language)}
            </span>
            <Button variant='outline' size='sm' onClick={() => updateData({ language: typeLanguage })}>
              Set to {LANG_CONFIG[typeLanguage].label}
            </Button>
          </div>
        )}
        <span className='italic'>Open the Editor tab to edit code.</span>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Environment</Label>
        <EnvironmentField data={data} updateData={updateData} />
      </div>
    </div>
  )
}

function ScriptCodeEditorTab({ data, updateData, typeLanguage }: ScriptViewProps) {
  return (
    <div className='h-full w-full overflow-hidden'>
      <CodeEditor
        value={data.script ?? ''}
        language={editorLanguage(shownLanguage(data, typeLanguage))}
        onChange={(next: string) => updateData({ script: next })}
      />
    </div>
  )
}

function ScriptOutputTab({ nodeId }: { nodeId: string }) {
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

type ViewProps = Omit<ScriptViewProps, 'typeLanguage'>

// One script node type's views, each told the language that type is created
// with, which it shows when the node's data names none it runs.
function scriptNodeViews(typeLanguage: ScriptLanguage) {
  return {
    component: (props: { id: string; data: ScriptData; selected?: boolean }) => (
      <ScriptNode {...props} typeLanguage={typeLanguage} />
    ),
    inspector: (props: ViewProps) => <ScriptInspector {...props} typeLanguage={typeLanguage} />,
    editorTab: (props: ViewProps) => <ScriptCodeEditorTab {...props} typeLanguage={typeLanguage} />,
    outputTab: ScriptOutputTab,
  }
}

export function makeBashNode() {
  return scriptNodeViews('bash')
}

export function makePythonNode() {
  return scriptNodeViews('python')
}

export function makeNodeJsNode() {
  return scriptNodeViews('node')
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
