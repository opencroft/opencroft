import host from '@ext/host'
import type { ServerConfig } from '@opencroft/server'

import { fireEvent } from './event'
import { keyStoreCreateKey, keyStoreDeleteKey, keyStoreListKeys } from './key-store'
import { openaiChat } from './openai'
import { runScript, type ScriptResult } from './script'
import { acceptHostKey, type HostKeyStatus, installPublicKey, resolvePublicKey } from './ssh-setup'

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
  updateData(patch: Record<string, unknown>): void
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

// ── Key Store node actions ────────────────────────────────────────────────
// Agent-invokable. These only ever return key *metadata* (name/type/
// fingerprint) — never private key material — so keys don't leak into an
// agent's context.

const KEY_TYPES = ['ed25519', 'rsa', 'ecdsa']

function requireKeyName(ctx: ActionCtx): string {
  const name = typeof ctx.params.name === 'string' ? ctx.params.name.trim() : ''
  if (!name) {
    throw new Error('Key name is required (params.name)')
  }
  return name
}

async function keyStoreGenerate(ctx: ActionCtx): Promise<{ name: string; keyType: string }> {
  const name = requireKeyName(ctx)
  const requested = typeof ctx.params.keyType === 'string' ? ctx.params.keyType.trim() : ''
  const keyType = requested || 'ed25519'
  if (!KEY_TYPES.includes(keyType)) {
    throw new Error(`Unsupported key type "${keyType}". Use one of: ${KEY_TYPES.join(', ')}`)
  }
  await keyStoreCreateKey(ctx.nodeId, name, keyType)
  return { name, keyType }
}

function keyStoreListAction(ctx: ActionCtx) {
  return keyStoreListKeys(ctx.nodeId)
}

async function keyStoreDeleteAction(ctx: ActionCtx): Promise<{ deleted: string }> {
  const name = requireKeyName(ctx)
  await keyStoreDeleteKey(ctx.nodeId, name)
  return { deleted: name }
}

// ── Server node actions ───────────────────────────────────────────────────

function serverConfigFromData(data: Record<string, unknown>): ServerConfig {
  const address = typeof data.address === 'string' ? data.address : ''
  if (!address) {
    throw new Error('Server has no address configured')
  }
  return {
    address,
    port: typeof data.port === 'number' ? data.port : 22,
    username: typeof data.username === 'string' && data.username ? data.username : 'root',
    password: typeof data.password === 'string' ? data.password : undefined,
    keyPath: typeof data.keyPath === 'string' ? data.keyPath : undefined,
  }
}

// Assign a Key Store key to this Server node. With `install: true`, also append
// the key's public half to the remote's authorized_keys (connecting with the
// server's current auth, typically a password).
async function serverSetKey(ctx: ActionCtx): Promise<{ keyPath: string; installed: boolean }> {
  const key = typeof ctx.params.key === 'string' ? ctx.params.key.trim() : ''
  if (!key) {
    throw new Error('A key reference is required (params.key)')
  }
  const install = ctx.params.install === true
  ctx.updateData({ keyPath: key })
  if (install) {
    const publicKey = await resolvePublicKey(key)
    await installPublicKey(serverConfigFromData({ ...ctx.data, keyPath: key }), publicKey)
  }
  return { keyPath: key, installed: install }
}

// Scan the remote host key and pin it into known_hosts so OpenSSH-based
// transports (e.g. docker `ssh://`) stop failing host-key verification.
function serverAcceptHostKey(ctx: ActionCtx): Promise<HostKeyStatus> {
  const address = typeof ctx.data.address === 'string' ? ctx.data.address : ''
  const port = typeof ctx.data.port === 'number' ? ctx.data.port : 22
  return acceptHostKey(address, port)
}

export const nodeActions = {
  'core-key-store': {
    generate: keyStoreGenerate,
    list: keyStoreListAction,
    delete: keyStoreDeleteAction,
  },
  server: {
    setKey: serverSetKey,
    acceptHostKey: serverAcceptHostKey,
  },
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
