import host from '@ext/host'

import { fireEvent } from './event'
import { openaiChat } from './openai'
import { runScript, type ScriptResult } from './script'

interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

interface ActionCtx {
  nodeId: string
  typeId: string
  data: Record<string, unknown>
  params: Record<string, unknown>
  input<T = unknown>(handleId: string): T | undefined
  inputSource<T = unknown>(
    handleId: string,
  ): { sourceNodeId: string; sourceHandleId: string; contextType: string; value: T } | undefined
  connectedSources(
    handleId: string,
  ): { nodeId: string; handleId: string; type?: string; data: Record<string, unknown> }[]
  containingNodes(
    typeId?: string,
  ): { id: string; type?: string; position: { x: number; y: number }; data: Record<string, unknown> }[]
  output<T = unknown>(handleId: string): Stream<T>
}

interface ScriptData {
  script: string
  language: 'bash' | 'python' | 'node'
  env?: string
  secrets?: string
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh'
  [key: string]: unknown
}

interface TextChunk {
  text: string
  final: boolean
}

async function scriptRun(ctx: ActionCtx): Promise<ScriptResult> {
  const data = ctx.data as ScriptData
  if (!data.script?.trim()) {
    throw new Error('Script is empty')
  }
  const context = ctx.input<TerminalContext>('ctx-in') ?? { type: 'local' }

  // Resolve secrets
  const secretNames = (data.secrets ?? '')
    .split('\n')
    .map((s: string) => s.trim())
    .filter(Boolean)
  const secretEnv: Record<string, string> = {}
  if (secretNames.length > 0) {
    for (const name of secretNames) {
      const value = await host.secrets.resolve(name)
      if (value === null) {
        throw new Error(`Secret "${name}" not found in any Secrets Store`)
      }
      secretEnv[name] = value
    }
  }

  // Merge env lines with secrets
  const envLines = (data.env ?? '')
    .split('\n')
    .map((s: string) => s.trim())
    .filter(Boolean)
  const env: Record<string, string> = {}
  for (const line of envLines) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      env[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
  }
  Object.assign(env, secretEnv)

  const stream = ctx.output<TextChunk>('stdout-out')
  const result = await runScript({ script: data.script, language: data.language, context, env })
  if (result.stdout) {
    stream.broadcast({ text: result.stdout, final: false })
  }
  if (result.stderr) {
    stream.broadcast({ text: `\n--- stderr ---\n${result.stderr}`, final: false })
  }
  stream.broadcast({ text: '', final: true })
  return result
}

async function eventRun(ctx: ActionCtx): Promise<unknown> {
  return fireEvent(ctx.nodeId, ctx.params)
}

interface AssistantData {
  chatApiBase?: string
  chatApiKey?: string
  chatModel?: string
  temperature?: number
}

interface TextGenerationData {
  assistantId?: string
  systemPrompt?: string
}

// Resolve the text to act on: streamed text (delivered on stream completion via
// the handle's `streamAction`), else a resolved `text-in` input, else empty.
function streamText(ctx: ActionCtx): string {
  const param = ctx.params.text
  if (typeof param === 'string' && param.trim()) {
    return param
  }
  const input = ctx.inputSource<unknown>('text-in')?.value
  if (typeof input === 'string' && input.trim()) {
    return input
  }
  return ''
}

async function textGenerationRun(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as TextGenerationData
  const prompt = streamText(ctx)
  if (!prompt.trim()) {
    throw new Error('No input text to generate from')
  }
  if (!data.assistantId) {
    throw new Error('No assistant selected')
  }
  const node = await host.graph.getNode(data.assistantId)
  const assistant = (node?.data ?? {}) as AssistantData
  if (!assistant.chatModel?.trim()) {
    throw new Error('Assistant has no chat model configured')
  }
  const result = await openaiChat({
    apiBase: assistant.chatApiBase ?? '',
    apiKey: assistant.chatApiKey ?? '',
    model: assistant.chatModel,
    systemPrompt: data.systemPrompt ?? '',
    userPrompt: prompt,
    temperature: typeof assistant.temperature === 'number' ? assistant.temperature : 0.7,
  })
  const stream = ctx.output<TextChunk>('text-out')
  stream.broadcast({ text: result.content, final: false })
  stream.broadcast({ text: '', final: true })
}

async function promptSend(ctx: ActionCtx): Promise<void> {
  const text = typeof ctx.params.text === 'string' ? ctx.params.text.trim() : ''
  if (!text) {
    throw new Error('Prompt is empty')
  }
  ctx.output<TextChunk>('text-out').broadcast({ text, final: true })
}

export const nodeActions = {
  'script-bash': {
    run: scriptRun,
  },
  'script-python': {
    run: scriptRun,
  },
  'script-node': {
    run: scriptRun,
  },
  event: {
    run: eventRun,
  },
  'text-generation': {
    run: textGenerationRun,
  },
  prompt: {
    send: promptSend,
  },
}
