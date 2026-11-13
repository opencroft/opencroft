import { type HostSendMessageResult, sendMessage } from '@opencroft/server/chat'
import { graph } from '@opencroft/server/graph'
import { type SecretFormat, secrets } from '@opencroft/server/secrets'
import { execContext, type ServerConfig } from '@opencroft/server/terminal'
import {
  isValueType,
  nodeName,
  type PrimitiveValue,
  switchConditionType,
  switchOutput,
  typedValueOf,
} from '@opencroft/server/values'

import {
  type CallActionOutcome,
  callActionIdOf,
  callActionParamsOf,
  callActionTargetOf,
  missingParamProblem,
  NO_ACTION_PROBLEM,
  NO_TARGET_PROBLEM,
  paramHandleId,
} from '../src/nodes/call-action-shared'
import { resolveEnvironment } from '../src/nodes/script-environment'
import { isScriptLanguage, scriptDataProblems } from '../src/nodes/script-language'
import { DELETE_OVERRIDE_PARAM } from './checked-delete'
import { fireEvent } from './event'
import {
  KEY_STORE_TYPE,
  type KeyCreated,
  type KeyImported,
  type KeyRotated,
  keyStoreCreateKey,
  keyStoreDeleteKey,
  keyStoreImportKey,
  keyStoreKeyNames,
  keyStoreReadPublicKey,
  keyStoreRotateKey,
  keyStoreShowKeys,
} from './key-store'
import { checkKeyReference, keyStoreLookupOn, requireKeyName } from './key-store-checks'
import { type OpenAIChatResult, openaiChat } from './openai'
import { problemError } from './openai-chat'
import { runScript, type ScriptResult } from './script'
import { type GenerateSecretResult, secretsStoreDelete, secretsStoreGenerate } from './secrets-store'
import { acceptHostKey, type HostKeyStatus, installPublicKey, resolvePublicKey } from './ssh-setup'

interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

interface ActionCtx {
  nodeId: string
  type: string
  data: Record<string, unknown>
  params: Record<string, unknown>
  input<T = unknown>(handleId: string): T | undefined
  inputSource<T = unknown>(
    handleId: string,
  ): { sourceNodeId: string; sourceHandleId: string; handleType: string; value: T } | undefined
  connectedSources(
    handleId: string,
  ): { nodeId: string; handleId: string; type?: string; data: Record<string, unknown> }[]
  containingNodes(
    type?: string,
  ): { id: string; type?: string; position: { x: number; y: number }; data: Record<string, unknown> }[]
  output<T = unknown>(handleId: string): Stream<T>
  updateData(patch: Record<string, unknown>): void
  callerAgent?: string
}

interface ScriptData {
  script: string
  language?: unknown
  // The stored form is script-environment.ts's to describe, and read only through it.
  env?: unknown
  secrets?: unknown
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh'
  [key: string]: unknown
}

interface TextChunk {
  text: string
  final: boolean
}

// The wired terminal context, or local when nothing is wired. A wired input
// that did not resolve is refused rather than run locally: "local" here is the
// server's own process, so the script would run against the wrong machine and
// report success.
function terminalContextOf(ctx: ActionCtx): TerminalContext {
  const context = ctx.input<TerminalContext>('ctx-in')
  if (context) {
    return context
  }
  const [source] = ctx.connectedSources('ctx-in')
  if (source) {
    throw new Error(`Target ${source.nodeId}/${source.handleId} is connected but has no resolved terminal context`)
  }
  return { type: 'local' }
}

async function scriptRun(ctx: ActionCtx): Promise<ScriptResult> {
  const data = ctx.data as unknown as ScriptData
  if (!data.script?.trim()) {
    throw new Error('Script is empty')
  }
  const { language } = data
  if (!isScriptLanguage(language)) {
    const [problem] = scriptDataProblems(data)
    throw new Error(`${problem.title}. ${problem.next}`)
  }
  const context = terminalContextOf(ctx)

  // Secrets resolve from the Secrets Stores on the script node's own graph, so a missing name
  // throws naming the graph.
  const env = await resolveEnvironment(data, (stored) => secrets.resolveValue(stored, { nodeId: ctx.nodeId }))

  const stream = ctx.output<TextChunk>('stdout-out')
  const result = await runScript({ script: data.script, language, context, env })
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

// A Switch routes the execution it is given on to the one output its
// condition picks (`switchOutput`), with the same event, and answers with
// what that output's target answered. Nothing connected there answers the
// dispatcher's "No target connected to …". A wired condition is read as it
// arrives, not through the condition's type, which reads a text as nothing on
// a boolean Switch: `switchOutput` names the wrong type. A condition with no
// value (a request missing the field it is read from) routes nowhere: the
// run fails naming the Switch, rather than taking either side. A Switch on an
// enum routes on the enum's cases as its extension declares them now, and
// reads a typed condition as it is stored, as it reads a wired one: a typed
// value that is not one of the cases, which reads as nothing through the
// enum, routes to Default.
async function switchHandle(ctx: ActionCtx): Promise<unknown> {
  const wired = ctx.inputSource<PrimitiveValue>('condition')
  const type = switchConditionType(ctx.data)
  const onEnum = !isValueType(type)
  const enumCases = onEnum ? (await graph.getHandleType(type))?.cases : undefined
  const typed = onEnum ? typedValueOf(ctx.data, 'condition') : ctx.input<PrimitiveValue>('condition')
  const routed = switchOutput(ctx.data, wired ? wired.value : typed, enumCases)
  if (!routed.ok) {
    throw new Error(`Switch "${nodeName(ctx.data, 'Switch', ctx.nodeId)}": ${routed.error}`)
  }
  const { primary } = await execContext.dispatch(ctx.nodeId, routed.output, ctx.params)
  return primary
}

// Crossed on name, not `instanceof`: see `fireEvent`.
function isNoExecTarget(err: unknown): boolean {
  return (err as { name?: string } | undefined)?.name === 'NoExecTargetError'
}

// What Error carries of a failed call: its message, which holds the problem's
// title and detail (`problemError`). Read by shape, as `isNoExecTarget` is.
function failureMessage(failure: unknown): string {
  const message = (failure as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message : String(failure)
}

// The call's parameters, from the node's inputs: each the wired value, else
// the typed one. One with no value is left out, and a required one fails the
// call before it starts.
function callParams(ctx: ActionCtx): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const param of callActionParamsOf(ctx.data)) {
    const value = ctx.input<PrimitiveValue>(paramHandleId(param.name))
    if (value === undefined || value === '') {
      if (param.required) {
        throw problemError(missingParamProblem(param.name))
      }
      continue
    }
    params[param.name] = value
  }
  return params
}

// A Call Action calls the action its data names (`execContext.call`), then
// continues on Done with the event it was given and answers with what Done's
// target answered, or the action's result when nothing is on Done. A failed
// call continues on Failed the same way; with nothing there it fails, and the
// node records the action's problem. While Done or Failed dispatches, the
// node's outcome outputs answer from the outcome it hands the run.
async function callActionHandle(ctx: ActionCtx): Promise<unknown> {
  const onward = (handleId: string, outcome: CallActionOutcome) =>
    execContext.dispatch(ctx.nodeId, handleId, ctx.params, { run: outcome })
  let result: unknown
  try {
    const target = callActionTargetOf(ctx.data)
    const action = callActionIdOf(ctx.data)
    if (!target) {
      throw problemError(NO_TARGET_PROBLEM)
    }
    if (!action) {
      throw problemError(NO_ACTION_PROBLEM)
    }
    result = await execContext.call(ctx.nodeId, target, action, callParams(ctx))
  } catch (failure) {
    try {
      return (await onward('exec-error', { error: failureMessage(failure) })).primary
    } catch (err) {
      throw isNoExecTarget(err) ? failure : err
    }
  }
  try {
    return (await onward('exec-out', { result })).primary
  } catch (err) {
    if (isNoExecTarget(err)) {
      return { status: 200, body: result }
    }
    throw err
  }
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

// One chat request to the model of the AI Assistant node `assistantId` names.
async function assistantChat(
  assistantId: string | undefined,
  systemPrompt: string,
  userPrompt: string,
): Promise<OpenAIChatResult> {
  if (!assistantId) {
    throw problemError({ title: 'No AI Assistant selected', next: "Pick an AI Assistant in this node's Details." })
  }
  const node = await graph.getNode(assistantId)
  const assistant = (node?.data ?? {}) as AssistantData
  if (!assistant.chatModel?.trim()) {
    throw problemError({
      title: 'The AI Assistant has no model',
      next: "Set Model in the AI Assistant's Chat settings.",
    })
  }
  return openaiChat(
    {
      apiBase: assistant.chatApiBase ?? '',
      apiKey: assistant.chatApiKey ?? '',
      model: assistant.chatModel,
      systemPrompt,
      userPrompt,
      temperature: typeof assistant.temperature === 'number' ? assistant.temperature : 0.7,
    },
    { nodeId: assistantId },
  )
}

async function textGenerationRun(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as TextGenerationData
  const prompt = streamText(ctx)
  if (!prompt.trim()) {
    throw new Error('No input text to generate from')
  }
  const result = await assistantChat(data.assistantId, data.systemPrompt ?? '', prompt)
  const stream = ctx.output<TextChunk>('text-out')
  stream.broadcast({ text: result.content, final: false })
  stream.broadcast({ text: '', final: true })
}

interface OpenAIClientData {
  assistantId?: string
  systemPrompt?: string
  userPrompt?: string
}

// A failure is recorded as the node's error, which its inspector shows, and cleared by the next run.
async function openaiClientRun(ctx: ActionCtx): Promise<OpenAIChatResult> {
  const data = ctx.data as OpenAIClientData
  if (!data.userPrompt?.trim()) {
    throw problemError({ title: 'The user prompt is empty', next: "Write the User Prompt in this node's Details." })
  }
  return assistantChat(data.assistantId, data.systemPrompt ?? '', data.userPrompt)
}

async function promptSend(ctx: ActionCtx): Promise<void> {
  const text = typeof ctx.params.text === 'string' ? ctx.params.text.trim() : ''
  if (!text) {
    throw new Error('Prompt is empty')
  }
  ctx.output<TextChunk>('text-out').broadcast({ text, final: true })
}

// ── Key Store node actions ────────────────────────────────────────────────
// Agent-invokable. These only ever return key metadata (name/type/
// fingerprint) and public halves — never private key material — so keys
// don't leak into an agent's context.

function keyStoreGenerate(ctx: ActionCtx): Promise<KeyCreated> {
  return keyStoreCreateKey(ctx.nodeId, ctx.params.name, ctx.params.keyType)
}

// Write-only: the key goes into the store and the answer carries only its metadata.
function keyStoreImport(ctx: ActionCtx): Promise<KeyImported> {
  return keyStoreImportKey(ctx.nodeId, ctx.params.name, ctx.params.privateKey)
}

function keyStoreRotate(ctx: ActionCtx): Promise<KeyRotated> {
  return keyStoreRotateKey(ctx.nodeId, ctx.params.name, ctx.params.keyType)
}

function keyStoreListAction(ctx: ActionCtx) {
  return keyStoreShowKeys(ctx.nodeId)
}

async function keyStoreReadPublicKeyAction(ctx: ActionCtx): Promise<{ name: string; publicKey: string }> {
  const name = requireKeyName(ctx.params.name)
  return { name, publicKey: (await keyStoreReadPublicKey(ctx.nodeId, name)).trim() }
}

async function keyStoreDeleteAction(ctx: ActionCtx): Promise<{ deleted: string }> {
  const outcome = await keyStoreDeleteKey(ctx.nodeId, ctx.params.name, ctx.params[DELETE_OVERRIDE_PARAM] === true)
  if ('refused' in outcome) {
    throw new Error(outcome.refused.message)
  }
  return outcome
}

// ── Secrets Store node actions ────────────────────────────────────────────
// Agent-invokable, and no action here returns a secret value: generate returns
// the name and whether it was created or rotated, list returns names, delete
// returns the name it removed. `listKeys` is the only store read any of them
// makes, and it never decrypts — so there is no value in scope to return by
// mistake, rather than one that each action has to remember to withhold.
//
// `secretKeys` on the node is the store's key index, which the host re-derives
// from the store after every write; none of these actions writes it.

function requireSecretName(ctx: ActionCtx): string {
  const name = typeof ctx.params.name === 'string' ? ctx.params.name.trim() : ''
  if (!name) {
    throw new Error('Secret name is required (params.name)')
  }
  return name
}

function secretsStoreGenerateAction(ctx: ActionCtx): Promise<GenerateSecretResult> {
  const name = requireSecretName(ctx)
  const length = typeof ctx.params.length === 'number' ? ctx.params.length : undefined
  const format: SecretFormat | undefined = ctx.params.format === 'symbols' ? 'symbols' : undefined
  return secretsStoreGenerate(ctx.nodeId, name, { length, format })
}

function secretsStoreListAction(ctx: ActionCtx): Promise<{ names: string[] }> {
  return secrets.listKeys(ctx.nodeId).then((names) => ({ names }))
}

async function secretsStoreDeleteAction(ctx: ActionCtx): Promise<{ deleted: string; secretKeys: string[] }> {
  const name = requireSecretName(ctx)
  const outcome = await secretsStoreDelete(ctx.nodeId, name, ctx.params[DELETE_OVERRIDE_PARAM] === true)
  if ('refused' in outcome) {
    throw new Error(outcome.refused.message)
  }
  return { deleted: name, secretKeys: await secrets.listKeys(ctx.nodeId) }
}

// ── Send Message node actions ─────────────────────────────────────────────
// Thin entry point only — the delivery logic lives behind `host.sendMessage`
// (`_server/host.ts`), the exact mechanism the node's own `text-in` wiring
// already goes through: sender attribution and membership-gated thread
// delivery.

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
  return sendMessage.send(ctx.nodeId, ctx.params, ctx.inputSource('text-in')?.sourceNodeId, ctx.callerAgent)
}

// ── Server node actions ───────────────────────────────────────────────────

// `nodeId` is the Server node: a `secret:NAME` password resolves from the Secrets Stores on its
// graph, and a key reference only from a Key Store there.
function serverConfigFromData(nodeId: string, data: Record<string, unknown>): ServerConfig {
  const address = typeof data.address === 'string' ? data.address : ''
  if (!address) {
    throw new Error('Server has no address configured')
  }
  return {
    address,
    port: typeof data.port === 'number' ? data.port : 22,
    username: typeof data.username === 'string' && data.username ? data.username : 'root',
    password: typeof data.password === 'string' ? data.password : undefined,
    credentialsScope: nodeId,
    keyPath: typeof data.keyPath === 'string' ? data.keyPath : undefined,
  }
}

// Assign a Key Store key to this Server node. With `install: true`, also append
// the key's public half to the remote's authorized_keys (connecting with the
// server's current auth, typically a password). A reference to no key, or to a
// Key Store on another graph, which the dial would refuse, is refused before
// anything is stored.
async function serverSetKey(ctx: ActionCtx): Promise<{ keyPath: string; installed: boolean }> {
  const key = await checkKeyReference(
    ctx.params.key,
    keyStoreLookupOn(await graph.listGraphNodes(ctx.nodeId), KEY_STORE_TYPE, keyStoreKeyNames),
  )
  const install = ctx.params.install === true
  ctx.updateData({ keyPath: key })
  if (install) {
    const publicKey = await resolvePublicKey(key)
    await installPublicKey(serverConfigFromData(ctx.nodeId, { ...ctx.data, keyPath: key }), publicKey)
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
    import: keyStoreImport,
    rotate: keyStoreRotate,
    list: keyStoreListAction,
    readPublicKey: keyStoreReadPublicKeyAction,
    delete: keyStoreDeleteAction,
  },
  'core-secrets-store': {
    generate: secretsStoreGenerateAction,
    list: secretsStoreListAction,
    delete: secretsStoreDeleteAction,
  },
  'send-message': {
    send: sendMessageSendAction,
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
  switch: {
    handle: switchHandle,
  },
  'call-action': {
    handle: callActionHandle,
  },
  'text-generation': {
    run: textGenerationRun,
  },
  'openai-client': {
    run: openaiClientRun,
  },
  prompt: {
    send: promptSend,
  },
}
