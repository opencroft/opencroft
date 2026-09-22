import { randomUUID } from 'node:crypto'

import type { McpServer as AcpMcpServer, Client, ContentBlock, SessionConfigOption } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from 'ai'
import { type ZodRawShape, z } from 'zod'

import type { AgentConnection } from './connection'
import { errorMessage } from './errors'
import { connectMcpToolset } from './mcp-client'
import {
  loadSkills,
  SKILL_INPUT_SCHEMA,
  SKILL_TOOL_NAME,
  type SkillHandler,
  type SkillsInput,
  skillToolDescription,
  type ToolsInput,
} from './mcp-server'
import { discoverModels, type OpenAiModel } from './models'
import { accessFor, type PermissionValue, type ResolvedPermissions, skillKey, toolKey } from './permissions'
import { reasoningEfforts } from './reasoning'
import { findProvider } from './resolve'
import { flattenToolResult } from './tool-result'
import { findTurnBoundary } from './turns'
import type { AgentSelection } from './types'

const DEFAULT_MAX_STEPS = 24

export interface NativeHarnessConfig {
  tools: ToolsInput
  skills: SkillsInput
  skillHandler?: SkillHandler
  systemPrompt?: string
  maxSteps?: number
  // Resolve the real MCP servers (configured + extra) to attach in-process.
  // Excludes the built-in local server: its tools/skills already run here.
  // Re-evaluated per turn so refreshes apply without a session restart.
  loadMcpServers?: (selection: AgentSelection) => Promise<AcpMcpServer[]>
}

// The harness reaches every provider through its OpenAI-compatible endpoint.
// A per-selection baseUrl override wins; otherwise the provider table endpoint;
// otherwise the public OpenAI default. Providers with no OpenAI endpoint
// (native-only Anthropic / Gemini) are unreachable here by design.
function resolveBaseUrl(selection: AgentSelection): string {
  if (selection.baseUrl) {
    return selection.baseUrl
  }
  const provider = findProvider(selection.providerId)
  const endpoint = provider?.endpoints.openai
  if (endpoint) {
    return endpoint
  }
  if (provider && 'openai' in provider.endpoints) {
    return 'https://api.openai.com/v1'
  }
  throw new Error(
    `Provider "${selection.providerId}" has no OpenAI-compatible endpoint; the native harness only reaches OpenAI-compatible models.`,
  )
}

// `model` overrides the profile's choice for one session, which is what the
// session's own model config option sets.
function resolveModel(selection: AgentSelection, model = selection.model): LanguageModel {
  const provider = createOpenAICompatible({
    name: selection.providerId,
    baseURL: resolveBaseUrl(selection),
    apiKey: selection.apiKey,
    // A streaming OpenAI-compatible response carries no token usage unless it
    // is asked for: this turns on `stream_options: { include_usage: true }`.
    // Every turn here streams, so without it the harness reports no usage at
    // all and the context ring has nothing to render.
    includeUsage: true,
  })
  return provider(model)
}

// FinishReason (AI SDK) -> StopReason (ACP).
function mapStopReason(reason: string): 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'content-filter':
      return 'refusal'
    case 'tool-calls':
      return 'max_turn_requests'
    default:
      return 'end_turn'
  }
}

interface ToolGate {
  sessionId: string
  client: Client
  getMode: () => string
}

export const CANCELLED = Symbol('cancelled')

// Races a promise against an abort signal. The signal firing resolves with
// CANCELLED immediately — it does not wait for (or care about) whatever the
// raced promise eventually settles to.
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof CANCELLED> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.resolve(CANCELLED)
  }
  return new Promise<T | typeof CANCELLED>((resolve, reject) => {
    const onAbort = () => resolve(CANCELLED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// Gate a tool call through the ACP permission flow. 'AlwaysAllow' skips the
// prompt; otherwise (an 'Allow' grant or an MCP/ungranted tool) the prompt is
// shown unless the session is in bypass mode. Returns a denial string when the
// user rejects or the turn is cancelled first, else null to proceed.
//
// requestPermission is a round trip to the operator and can be slow; a turn
// cancelled while it's in flight (cancel() aborts the turn's own signal) must
// not let a permission that resolves afterward reach the real tool call —
// abortSignal is raced against it rather than awaited alongside it, so a late
// 'allow' can never arrive after this function has already returned.
async function gateToolCall(
  gate: ToolGate,
  name: string,
  input: unknown,
  toolCallId: string,
  access: PermissionValue,
  // What the host declared this tool to be, carried into the permission
  // request as the ACP tool kind.
  //
  // THIS HARNESS RUNS THE LOOP, so unlike an external agent it knows exactly
  // which tool is being called and can say so. Leaving it out is what made
  // every native tool call arrive with no kind at all, so a host gate keyed on
  // kind could only ever prompt -- the tool was never classified, rather than
  // classified wrongly.
  //
  // Undeclared stays undeclared: no kind is sent, and the host sees exactly
  // what it saw before.
  kind: 'read' | undefined,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const decision = toolPermissionDecision(gate.getMode(), access)
  if (decision === 'allow') {
    return null
  }
  if (decision === 'deny') {
    return 'Permission denied: this session declines tool calls.'
  }
  const response = await raceAbort(
    Promise.resolve(
      gate.client.requestPermission({
        sessionId: gate.sessionId,
        toolCall: { toolCallId, title: name, rawInput: input, ...(kind ? { kind } : {}) },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      }),
    ),
    abortSignal,
  )
  if (response === CANCELLED || response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow') {
    return 'Permission denied by user.'
  }
  return null
}

// Build a native AI SDK tool schema from a tool's ZodRawShape. The zod object is
// NOT handed to tool() directly: the AI SDK's zod-to-JSON-Schema conversion forces
// `additionalProperties: false` on every object node, which erases the value type
// of open records (z.record) and so tells the model such maps must stay empty.
// Instead the model sees zod's own toJSONSchema output, which preserves record
// value types, while the zod object stays on as the runtime input validator.
function toolInputSchema<Shape extends ZodRawShape>(shape: Shape) {
  const object = z.object(shape)
  return jsonSchema<z.infer<typeof object>>(z.toJSONSchema(object, { target: 'draft-7', io: 'input' }) as JSONSchema7, {
    validate: (value) => {
      const result = object.safeParse(value)
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error }
    },
  })
}

// Convert the host's LocalTool[] (the same ones served to ACP agents over MCP)
// into native AI SDK tools, plus the skill tool and any configured MCP servers'
// tools. Each tool gates itself through the ACP permission flow per its grant.
// Returns the toolset and a closer for the MCP connections opened this turn.
async function buildToolset(
  config: NativeHarnessConfig,
  gate: ToolGate,
  permissions: ResolvedPermissions | undefined,
  selection: AgentSelection,
): Promise<{ toolset: ToolSet; close: () => Promise<void>; readOnlyTools: ReadonlySet<string> }> {
  const toolset: ToolSet = {}
  // Which of this turn's tools the host declared read-only. Collected here
  // because this is where the declarations are in hand, and read again when
  // the turn reports a tool call, so the kind the gate saw and the kind the
  // transcript shows are the same answer from the same source.
  const readOnlyTools = new Set<string>()

  // Same caller the MCP server path resolves from a session token — here the
  // session's selection is already in hand, so it comes straight off it.
  const localTools =
    typeof config.tools === 'function' ? await config.tools({ mcpIdentity: selection.mcpIdentity }) : config.tools
  for (const local of localTools) {
    // Hidden tools never enter the session; AlwaysAllow tools skip the prompt.
    const access = accessFor(permissions, toolKey(local.name))
    if (access === null) {
      continue
    }
    if (local.readOnly) {
      readOnlyTools.add(local.name)
    }
    toolset[local.name] = tool({
      description: local.description,
      inputSchema: toolInputSchema(local.inputSchema),
      execute: async (input, { toolCallId, abortSignal }) => {
        const kind = local.readOnly ? ('read' as const) : undefined
        const denied = await gateToolCall(gate, local.name, input, toolCallId, access, kind, abortSignal)
        if (denied || abortSignal?.aborted) {
          return denied ?? 'Permission denied by user.'
        }
        return flattenToolResult(await local.handler(input as Record<string, unknown>))
      },
    })
  }

  const allSkills = typeof config.skills === 'function' ? await config.skills() : config.skills
  // Only permitted skills appear in the catalog; the rest stay hidden.
  const skills = allSkills.filter((skill) => accessFor(permissions, skillKey(skill.name)) !== null)
  const skillHandler = config.skillHandler
  if (skills.length > 0 && skillHandler) {
    toolset[SKILL_TOOL_NAME] = tool({
      description: skillToolDescription(),
      inputSchema: toolInputSchema(SKILL_INPUT_SCHEMA),
      // loadSkills guards each name too: a model could still request a
      // non-permitted skill.
      execute: async ({ skills: requested }) => loadSkills(requested, skillHandler, permissions),
    })
  }

  // Real MCP servers (configured + extra). Role grants don't cover them, so they
  // gate like an 'Allow' tool: prompt unless bypass.
  const mcpServers = config.loadMcpServers ? await config.loadMcpServers(selection) : []
  const mcp = await connectMcpToolset(mcpServers, { clientName: 'agent-client-native' })
  for (const [name, mcpTool] of Object.entries(mcp.tools)) {
    const execute = mcpTool.execute
    if (!execute) {
      continue
    }
    toolset[name] = {
      ...mcpTool,
      execute: async (input: unknown, callOptions) => {
        // No kind: an external MCP server's tools are not the host's to
        // classify, and this harness knows nothing about them beyond what the
        // server advertised. Undeclared reaches the gate as undeclared.
        const denied = await gateToolCall(
          gate,
          name,
          input,
          callOptions.toolCallId,
          'Allow',
          undefined,
          callOptions.abortSignal,
        )
        if (denied || callOptions.abortSignal?.aborted) {
          return denied ?? 'Permission denied by user.'
        }
        return execute(input, callOptions)
      },
    }
  }

  return { toolset, close: mcp.closeAll, readOnlyTools }
}

export interface NativeSession {
  messages: ModelMessage[]
  mode: string
  abort?: AbortController
  permissions?: ResolvedPermissions
  // Session-level overrides for what the profile selected. A config option
  // changes the session in front of the reader, never the stored profile.
  model?: string
  effort?: string
  // What the endpoint reports about itself, fetched once per session.
  // `undefined` means not asked yet; `[]` means asked and it said nothing —
  // kept apart so a turn never pays for the same failed lookup twice.
  discovered?: OpenAiModel[]
}

// The session's effective model: a config option chosen for this session wins
// over the profile's.
function sessionModel(session: NativeSession, selection: AgentSelection): string {
  return session.model || selection.model
}

// The session's effective reasoning effort, on the same rule.
function sessionEffort(session: NativeSession, selection: AgentSelection): string | undefined {
  return session.effort ?? selection.reasoningEffort
}

function labelFor(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, ' ')
}

// What this harness advertises over the same config-option surface an ACP agent
// uses. Each option carries both halves of how it gets recognised: the id the
// composer reads -- 'mode', 'model', 'effort' -- so it renders as its own
// control rather than one more row in the generic settings dropdown, and the
// ACP `category` that states what the selector MEANS. The category is the
// protocol's own marker and the engine keys on it (which model a turn ran on,
// for one); the ids are a convention every bridge measured here happens to
// share, nothing the protocol fixes. An option that names only its id renders
// fine and goes unread.
//
// An option is advertised only when it has something to offer: a model with no
// known reasoning levels contributes no effort option at all, rather than an
// empty dropdown the reader can do nothing with.
export function buildConfigOptions(
  session: NativeSession,
  selection: AgentSelection,
  discovered: OpenAiModel[] = [],
): SessionConfigOption[] {
  const model = sessionModel(session, selection)
  const options: SessionConfigOption[] = [
    {
      id: 'mode',
      category: 'mode',
      name: 'Permission',
      type: 'select',
      currentValue: session.mode,
      options: AVAILABLE_MODES.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })),
    },
  ]
  // The endpoint's own list first; the provider table is the fallback for an
  // endpoint that reports nothing.
  const discoveredIds = discovered.map((entry) => entry.id)
  const models = discoveredIds.length > 0 ? discoveredIds : (findProvider(selection.providerId)?.models ?? [])
  // The profile's model may be one the provider list does not name (a custom
  // deployment, a preview id); it still has to appear, or selecting anything
  // else would make it unreachable.
  const modelValues = models.includes(model) ? models : [model, ...models]
  if (modelValues.length > 1) {
    options.push({
      id: 'model',
      category: 'model',
      name: 'Model',
      type: 'select',
      currentValue: model,
      options: modelValues.map((id) => ({ value: id, name: id })),
    })
  }
  const efforts = reasoningEfforts(model)
  if (efforts.length > 0) {
    options.push({
      id: 'effort',
      // 'thought_level' is the spec's name for this meaning; 'effort' is ours.
      category: 'thought_level',
      name: 'Reasoning effort',
      type: 'select',
      // Only the grades this model takes. `off` would mean an instruction not
      // to think, and an OpenAI-compatible endpoint has no way to say that —
      // advertising it would name a state this harness cannot reach. The client
      // adds `default` itself, which is the "leave it alone" this can honour.
      currentValue: sessionEffort(session, selection) ?? 'default',
      options: efforts.map((value) => ({ value, name: labelFor(value) })),
    })
  }
  return options
}

// One discovery per session, shared by everything derived from it: which models
// exist, and what window each has. Asking the endpoint beats any table here —
// a static list cannot describe a custom deployment, and a name-derived window
// cannot separate a 200k model from a 1M one in the same family.
async function discovery(session: NativeSession, selection: AgentSelection): Promise<OpenAiModel[]> {
  const cached = session.discovered
  if (cached !== undefined) {
    return cached
  }
  const fetched = await discoverModels(resolveBaseUrl(selection), selection.apiKey)
  session.discovered = fetched
  return fetched
}

// The window to report as the session's context size. A configured value wins:
// it is a deliberate override. 0 means unknown, which every surface renders as
// used-tokens alone rather than inventing a ratio.
async function resolveContextWindow(session: NativeSession, selection: AgentSelection): Promise<number> {
  if (selection.contextWindow) {
    return selection.contextWindow
  }
  const model = sessionModel(session, selection)
  return (await discovery(session, selection)).find((entry) => entry.id === model)?.contextWindow ?? 0
}

// Rewind to a branch point: drop everything from the `dropFromTurn`-th user
// message onward (0-based; defaults to the last turn). Returns a fresh array so
// the source session keeps its full history (a real fork/branch).
function truncateMessages(messages: ModelMessage[], dropFromTurn?: number): ModelMessage[] {
  const userIndices: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      userIndices.push(index)
    }
  })
  const boundary = findTurnBoundary(userIndices, dropFromTurn)
  if (boundary === null) {
    return []
  }
  return messages.slice(0, boundary)
}

// The permission modes this harness advertises, named with the canonical ids
// every adapter is classified into (see session-modes) rather than with a
// private vocabulary. An ACP agent advertises its modes over the protocol and
// the client renders whatever comes back; this harness has no protocol to carry
// them, so it states the same shape directly and the client cannot tell the
// difference.
const AVAILABLE_MODES = [
  { id: 'manual-edits', name: 'Manual', description: 'Asks before running any tool.' },
  { id: 'accept-edits', name: 'Accept', description: 'Runs tool calls without asking.' },
  { id: 'reject-edits', name: 'Reject', description: 'Declines every tool call without asking.' },
  { id: 'bypass', name: 'Bypass', description: 'Skips the permission check entirely.' },
]

const DEFAULT_MODE = 'manual-edits'

/**
 * What this harness accepts in a prompt, as ACP's `promptCapabilities`.
 *
 * Images: yes. The loop reaches a model through the provider's
 * OpenAI-compatible endpoint, and an image block becomes an AI SDK image part
 * (see toModelContent) — so a vision model behind that endpoint gets the
 * picture, and a text-only one refuses it at the endpoint, where the reason is
 * the provider's to give.
 *
 * `audio` and `embeddedContext` are not claimed: the prompt conversion has
 * nothing to turn them into, and a claim this side cannot honour is worse than
 * a client that never offers the block.
 *
 * Exported because the ENGINE is the one that decides what a prompt may carry,
 * and it never handshakes this harness — a native selection is not spawned, so
 * it holds no connection entry to read an initialize answer off. One
 * declaration, read by initialize() below and by the engine directly, rather
 * than the same fact written down in two places that can drift apart.
 */
export const NATIVE_PROMPT_CAPABILITIES = { image: true } as const

type UserContent = Extract<ModelMessage, { role: 'user' }>['content']

/**
 * One prompt's blocks as the model's own content.
 *
 * A plain string when the prompt is only words, which is every turn that
 * attaches nothing: the parts form exists for the mixed case, and paying for it
 * always would change what every stored message looks like.
 *
 * Text blocks join into one part — they are one message, split only by however
 * the client chose to send it. An image block becomes an image part carrying
 * its media type, which is what tells an OpenAI-compatible endpoint to route
 * the turn to a vision model rather than reject a wall of base64.
 *
 * A block this harness advertises no capability for is dropped. That used to be
 * the behaviour for EVERY non-text block, silently, by joining the empty string
 * it mapped to — which is how an attachment could vanish between the composer
 * and the model with nothing anywhere saying so. Now the only blocks that can
 * reach here are the ones NATIVE_PROMPT_CAPABILITIES claims, and a client that
 * respects the protocol never sends another.
 */
export function toModelContent(prompt: readonly ContentBlock[]): UserContent {
  const text = prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
  const images = prompt.filter((block) => block.type === 'image')
  if (images.length === 0) {
    return text
  }
  return [
    { type: 'text', text },
    ...images.map((block) => ({ type: 'image' as const, image: block.data, mediaType: block.mimeType })),
  ]
}

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask'

// What a session mode means for one tool call, given the grant the session's
// roles already resolved for that tool. Pure and exported so the decision is
// stated once and can be tested without standing up a session: the gate below
// only performs it.
//
// An AlwaysAllow grant wins over the mode — it is a per-tool decision the host
// already made deliberately, and a mode is the session-wide default it sits
// inside. Any mode this harness does not define (including a stored 'default'
// from an older session, and the plan/auto modes only ACP agents advertise)
// falls through to asking, which is the answer that cannot silently do
// something the reader did not agree to.
export function toolPermissionDecision(mode: string, access: PermissionValue): ToolPermissionDecision {
  if (access === 'AlwaysAllow' || mode === 'bypass' || mode === 'accept-edits') {
    return 'allow'
  }
  if (mode === 'reject-edits') {
    return 'deny'
  }
  return 'ask'
}

/**
 * An in-process agent that satisfies {@link AgentConnection} without any ACP
 * transport: it runs the model loop directly and reports progress by calling
 * the same `Client` callbacks an ACP subprocess would — so `handleUpdate` turns
 * them into the engine's `ChatEvent`s unchanged.
 */
// `sessions` is owned by the engine (kept in its global store) so it survives
// dev hot-reloads: the harness object is rebuilt fresh on every call — always
// with the latest code — while conversation state persists across reloads.
export function createNativeHarness(
  client: Client,
  selection: AgentSelection,
  config: NativeHarnessConfig,
  sessions: Map<string, NativeSession>,
): AgentConnection {
  // Per-profile prompt (from the selection) wins over the host default; empty by
  // default — no system prompt is injected unless one is configured.
  const systemPrompt = selection.systemPrompt?.trim() || config.systemPrompt || ''
  const maxSteps = config.maxSteps ?? DEFAULT_MAX_STEPS

  return {
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: NATIVE_PROMPT_CAPABILITIES },
      }
    },

    async newSession() {
      const sessionId = randomUUID()
      const session: NativeSession = { messages: [], mode: DEFAULT_MODE }
      sessions.set(sessionId, session)
      return {
        sessionId,
        // Modes are advertised twice, exactly as an ACP agent advertises them:
        // as session modes, and as the 'mode' config option built from the same
        // list. The composer drives the option; other surfaces read the modes.
        modes: { currentModeId: DEFAULT_MODE, availableModes: AVAILABLE_MODES },
        configOptions: buildConfigOptions(session, selection, await discovery(session, selection)),
      }
    },

    async resumeSession() {
      return {}
    },

    // No on-disk history to replay — the native harness keeps conversation state
    // in the in-memory `sessions` map, so a load is a no-op (and the engine never
    // routes a real resume here; it falls back to a fresh session).
    async loadSession() {
      return {}
    },

    // No subprocess to free — the engine never calls this for native selections
    // (deleteSession skips them), but the harness still has to satisfy
    // AgentConnection. Just drop the in-memory conversation state.
    async closeSession({ sessionId }) {
      sessions.delete(sessionId)
      return {}
    },

    async setSessionMode({ sessionId, modeId }) {
      const session = sessions.get(sessionId)
      if (session) {
        session.mode = modeId
      }
      return {}
    },

    // Applying an option changes THIS session only — the profile it started
    // from is untouched, the same way setting a mode on an ACP session does not
    // rewrite the agent's configuration. The rebuilt list comes back so the
    // client re-renders from one source: changing the model can add or remove
    // the effort option entirely, since efforts are per model.
    async setSessionConfigOption({ sessionId, configId, value }) {
      const session = sessions.get(sessionId)
      if (!session) {
        return { configOptions: [] }
      }
      const next = typeof value === 'string' ? value : String(value)
      if (configId === 'mode') {
        session.mode = next
      } else if (configId === 'model') {
        session.model = next
      } else if (configId === 'effort') {
        session.effort = next
      }
      return { configOptions: buildConfigOptions(session, selection, await discovery(session, selection)) }
    },

    async unstable_forkSession({ sessionId, _meta }) {
      const source = sessions.get(sessionId)
      const dropFromTurn = typeof _meta?.dropFromTurn === 'number' ? _meta.dropFromTurn : undefined
      const forkId = randomUUID()
      sessions.set(forkId, {
        messages: source ? truncateMessages(source.messages, dropFromTurn) : [],
        mode: source?.mode ?? DEFAULT_MODE,
        permissions: source?.permissions,
      })
      return {
        sessionId: forkId,
        modes: {
          currentModeId: source?.mode ?? DEFAULT_MODE,
          availableModes: AVAILABLE_MODES,
        },
      }
    },

    async cancel({ sessionId }) {
      sessions.get(sessionId)?.abort?.abort()
    },

    async prompt({ sessionId, prompt }) {
      const session = sessions.get(sessionId)
      if (!session) {
        return { stopReason: 'cancelled' }
      }
      // A native session runs one turn at a time. A prompt arriving mid-turn is
      // refused rather than interleaved (which would corrupt the message store).
      if (session.abort) {
        await client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'A turn is already in progress.' },
          },
        })
        return { stopReason: 'refusal' }
      }
      const abort = new AbortController()
      session.abort = abort
      session.messages.push({ role: 'user', content: toModelContent(prompt) })

      const gate: ToolGate = { sessionId, client, getMode: () => session.mode }
      const { toolset, close, readOnlyTools } = await buildToolset(config, gate, session.permissions, selection)
      // Reasoning effort goes to the OpenAI-compatible provider, keyed by the
      // provider name used in resolveModel (selection.providerId). 'off' is an
      // explicit "no preference" choice from the UI, not a literal effort value.
      const effort = sessionEffort(session, selection)
      const providerOptions =
        effort && effort !== 'default' && effort !== 'off'
          ? {
              [selection.providerId]: {
                reasoningEffort: effort,
              },
            }
          : undefined
      const result = streamText({
        model: resolveModel(selection, sessionModel(session, selection)),
        system: systemPrompt || undefined,
        messages: session.messages,
        tools: toolset,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: abort.signal,
        temperature: selection.temperature,
        providerOptions,
      })

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              await client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: part.text },
                },
              })
              break
            case 'reasoning-delta':
              await client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: part.text },
                },
              })
              break
            case 'tool-call':
              await client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: part.toolCallId,
                  title: part.toolName,
                  // The same declaration the gate was given, so the transcript
                  // and the permission decision cannot disagree about what a
                  // call was. 'other' remains the answer for anything the host
                  // did not classify -- unchanged from before, and still the
                  // honest one: unknown, not known-to-write.
                  kind: readOnlyTools.has(part.toolName) ? 'read' : 'other',
                  status: 'in_progress',
                  rawInput: part.input,
                },
              })
              break
            case 'tool-result':
              await client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: part.toolCallId,
                  status: 'completed',
                  rawOutput: part.output,
                },
              })
              break
            case 'tool-error':
              await client.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: part.toolCallId,
                  status: 'failed',
                  rawOutput: errorMessage(part.error),
                },
              })
              break
            default:
              break
          }
        }
        // Persist this turn's assistant/tool messages BEFORE the in-flight
        // marker is released. Releasing it earlier would let a concurrently
        // dispatched prompt pass the guard and push its user message between
        // this turn's user message and its assistant reply, corrupting the
        // message store. The `finally` below runs after this, which is what
        // keeps that ordering while still releasing on every path.
        const response = await result.response
        session.messages.push(...response.messages)

        // Report context usage like an ACP agent would. The last step's input
        // tokens are the full conversation sent this turn; add its output for the
        // tokens now in context. size=0 → engine reports an unknown max.
        const steps = await result.steps
        const last = steps.at(-1)
        const used = (last?.usage.inputTokens ?? 0) + (last?.usage.outputTokens ?? 0)
        if (used > 0) {
          await client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used,
              // The endpoint's own answer for this model, or a configured
              // override. 0 still means "not known" — the AI SDK reports no
              // window, and an endpoint that carries none leaves it unknown
              // rather than inventing a ratio, which every surface renders as
              // used-tokens-alone.
              size: await resolveContextWindow(session, selection),
            },
          })
        }

        return { stopReason: mapStopReason(await result.finishReason) }
      } catch (error) {
        // AN ABORT ENDS THIS TURN FROM WHEREVER IT IS NOTICED, and nothing here
        // may depend on which await noticed it.
        //
        // Cancelling does not reliably make `fullStream` throw: the stream can
        // simply STOP, leaving the rejection to surface later from
        // `result.response`. That await used to sit outside this block, so an
        // aborted turn left the function without releasing the marker below --
        // and since the marker is also the guard, the session answered "A turn
        // is already in progress." to every later message for the rest of its
        // life, with the header still reading Idle and a reload changing
        // nothing.
        if (abort.signal.aborted) {
          return { stopReason: 'cancelled' }
        }
        throw error
      } finally {
        await close()
        // THE ONE RELEASE. Not a path-by-path clear: a turn ends here however it
        // ends, so there is no exit left to forget. Guarded on identity so this
        // turn's exit can never release a LATER turn's marker -- the guard above
        // makes that unreachable today, and this keeps it unreachable if the
        // guard is ever relaxed to allow interleaving.
        if (session.abort === abort) {
          session.abort = undefined
        }
      }
    },
  }
}
