import type { HostSendMessageResult, ServerConfig } from '@opencroft/server'
import host from '@opencroft/server'

import { fireEvent } from './event'
import { keyStoreCreateKey, keyStoreDeleteKey, keyStoreListKeys } from './key-store'
import { openaiChat } from './openai'
import { runScript, type ScriptResult } from './script'
import { DELETE_OVERRIDE_PARAM, findSecretReferences, refuseSecretDelete } from './secret-references'
import { type GenerateSecretResult, type SecretFormat, secretsStoreGenerate } from './secrets-store'
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
  callerAgent?: string
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
  const data = ctx.data as unknown as ScriptData
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

// ── Secrets Store node actions ────────────────────────────────────────────
// Agent-invokable, and no action here returns a secret value: generate returns
// the name and whether it was created or rotated, list returns names, delete
// returns the name it removed. `listKeys` is the only store read any of them
// makes, and it never decrypts — so there is no value in scope to return by
// mistake, rather than one that each action has to remember to withhold.
//
// `secretKeys` on the node is a MIRROR of the store: what the canvas shows and
// what every secret picker offers. Both write paths re-derive it from the store
// rather than adding or removing the single name they touched — an increment is
// only ever as correct as the mirror it starts from, while a re-derivation also
// repairs drift that was already there.

function requireSecretName(ctx: ActionCtx): string {
  const name = typeof ctx.params.name === 'string' ? ctx.params.name.trim() : ''
  if (!name) {
    throw new Error('Secret name is required (params.name)')
  }
  return name
}

async function syncSecretKeys(ctx: ActionCtx): Promise<string[]> {
  const names = await host.secrets.listKeys(ctx.nodeId)
  ctx.updateData({ secretKeys: names })
  return names
}

async function secretsStoreGenerateAction(ctx: ActionCtx): Promise<GenerateSecretResult> {
  const name = requireSecretName(ctx)
  const length = typeof ctx.params.length === 'number' ? ctx.params.length : undefined
  const format: SecretFormat | undefined = ctx.params.format === 'symbols' ? 'symbols' : undefined
  const result = await secretsStoreGenerate(ctx.nodeId, name, { length, format })
  // secretsStoreGenerate writes straight to the secrets table; without this,
  // a key created/rotated through this action (the only path MCP callers have)
  // never reaches the node's own secretKeys mirror.
  await syncSecretKeys(ctx)
  return result
}

function secretsStoreListAction(ctx: ActionCtx): Promise<{ names: string[] }> {
  return host.secrets.listKeys(ctx.nodeId).then((names) => ({ names }))
}

async function secretsStoreDeleteAction(ctx: ActionCtx): Promise<{ deleted: string; secretKeys: string[] }> {
  const name = requireSecretName(ctx)
  // Every reason to keep the secret is established before the one call that
  // removes it. An absent name is refused rather than deleted for a second
  // time: without this a typo, or a name that lives in a different store,
  // reports a successful deletion having removed nothing.
  if (!(await host.secrets.listKeys(ctx.nodeId)).includes(name)) {
    throw new Error(`Secret "${name}" is not in this store`)
  }
  const references = findSecretReferences(await host.graph.listNodes(), name)
  const refusal = refuseSecretDelete(name, references, ctx.params[DELETE_OVERRIDE_PARAM] === true)
  if (refusal) {
    throw new Error(refusal.message)
  }
  await host.secrets.delete(ctx.nodeId, name)
  return { deleted: name, secretKeys: await syncSecretKeys(ctx) }
}

// ── Send Message node actions ─────────────────────────────────────────────
// Thin entry points only — all routing/delivery logic lives behind
// `host.sendMessage` (`_server/host.ts`), which reuses the exact mechanism
// the node's own `text-in` wiring already goes through: session reuse/create,
// envelope composition, hidden-by-default registration.

async function sendMessageSendAction(ctx: ActionCtx): Promise<HostSendMessageResult> {
  // Schema already requires `message` (see extension.json) — checked again
  // here (mirrors secretsStoreGenerateAction's `name` check above) since a
  // caller can still pass a payload that resolves empty/non-string.
  const message = typeof ctx.params.message === 'string' ? ctx.params.message.trim() : ''
  if (!message) {
    throw new Error('"message" is required and must be a non-empty string')
  }
  // What actually fed this run, from the action context rather than from the
  // graph: several things can be wired to one handle and only the run knows
  // which of them fired. That is what the message is attributed to.
  //
  // And who invoked it, for the case where nothing fed it: an agent calling
  // this action has no upstream node by definition, which is not the same as
  // having no sender. Both are handed over and the host decides between them,
  // because deciding here would put the rule in the one place that changes
  // whenever somebody adds a node type.
  return host.sendMessage.send(ctx.nodeId, ctx.params, ctx.inputSource('text-in')?.sourceNodeId, ctx.callerAgent)
}

function sendMessageListAgentsAction(ctx: ActionCtx): Promise<{ agent: string; jobs: string[] }[]> {
  return host.sendMessage.listAgents(ctx.nodeId)
}

// Mirrors the host's shape across the extension boundary — redeclared rather
// than imported, so the two must move together. `null` context usage means
// unknown (never loaded, no turn completed since it was loaded, or a harness
// that does not report usage); it never means "nothing held". An offline
// session with a prior reading carries it here too, with `asOf` (ms since
// epoch) set — its absence means the figure is live.
interface ContextUsage {
  usedTokens: number
  contextLimit: number | null
  asOf?: number
}

interface SessionSummary {
  sessionKey: string
  agent: string
  job: string
  title: string
  createdAt: number
  lastActivityAt: number
  status: 'offline' | 'idle' | 'working' | 'waiting'
  contextUsage: ContextUsage | null
}

function sendMessageListSessionsAction(ctx: ActionCtx): Promise<SessionSummary[]> {
  const agent = typeof ctx.params.agent === 'string' ? ctx.params.agent : undefined
  const job = typeof ctx.params.job === 'string' ? ctx.params.job : undefined
  return host.sendMessage.listSessions(ctx.nodeId, { agent, job })
}

// Mirrors the host's TurnSummary across the extension boundary, which is why it
// is redeclared rather than imported — and why the two must move together.
// 'unknown' is a turn restored by a session/load replay: it ended, but the
// replay does not say how.
interface TurnSummary {
  index: number
  prompt: string
  promptLength: number
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

function sendMessageListTurnsAction(ctx: ActionCtx): Promise<{
  turns: TurnSummary[]
  hasMore: boolean
  nextBeforeIndex: number | null
  sessionStatus: 'offline' | 'idle' | 'working' | 'waiting'
}> {
  const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey.trim() : ''
  if (!sessionKey) {
    throw new Error('"sessionKey" is required and must be a non-empty string')
  }
  const turns = typeof ctx.params.turns === 'number' ? ctx.params.turns : undefined
  const beforeIndex = typeof ctx.params.beforeIndex === 'number' ? ctx.params.beforeIndex : undefined
  return host.sendMessage.listTurns(ctx.nodeId, { sessionKey, turns, beforeIndex })
}

function sendMessageCompactAction(ctx: ActionCtx): Promise<{
  sessionKey: string
  accepted: true
  coalesced: boolean
  state: 'pending' | 'running'
}> {
  const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey.trim() : ''
  if (!sessionKey) {
    throw new Error('"sessionKey" is required and must be a non-empty string')
  }
  return host.sendMessage.compact(ctx.nodeId, { sessionKey })
}

function sendMessageCompactStatusAction(ctx: ActionCtx): Promise<{
  sessionKey: string
  state: 'never-requested' | 'pending' | 'running' | 'done' | 'error'
  requestedAt?: number
  startedAt?: number
  finishedAt?: number
  result?: {
    sessionKey: string
    contextUsageBefore: ContextUsage | null
    contextUsageAfter: ContextUsage | null
    compacted: boolean | null
    instructionsRestored: boolean
  }
  error?: string
}> {
  const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey.trim() : ''
  if (!sessionKey) {
    throw new Error('"sessionKey" is required and must be a non-empty string')
  }
  return host.sendMessage.compactStatus(ctx.nodeId, { sessionKey })
}

function sendMessageUnloadAction(ctx: ActionCtx): Promise<{ sessionKey: string; unloaded: true }> {
  const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey.trim() : ''
  if (!sessionKey) {
    throw new Error('"sessionKey" is required and must be a non-empty string')
  }
  return host.sendMessage.unload(ctx.nodeId, { sessionKey })
}

function sendMessageDeleteAction(ctx: ActionCtx): Promise<{ sessionKey: string; deleted: true }> {
  const sessionKey = typeof ctx.params.sessionKey === 'string' ? ctx.params.sessionKey.trim() : ''
  if (!sessionKey) {
    throw new Error('"sessionKey" is required and must be a non-empty string')
  }
  const force = ctx.params.force === true
  return host.sendMessage.delete(ctx.nodeId, { sessionKey, force })
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
  'core-secrets-store': {
    generate: secretsStoreGenerateAction,
    list: secretsStoreListAction,
    delete: secretsStoreDeleteAction,
  },
  'send-message': {
    send: sendMessageSendAction,
    listAgents: sendMessageListAgentsAction,
    listSessions: sendMessageListSessionsAction,
    listTurns: sendMessageListTurnsAction,
    compact: sendMessageCompactAction,
    compactStatus: sendMessageCompactStatusAction,
    unload: sendMessageUnloadAction,
    delete: sendMessageDeleteAction,
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
