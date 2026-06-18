import { randomUUID } from 'node:crypto'

import type { McpServer as AcpMcpServer, Client } from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet, tool } from 'ai'
import { z } from 'zod'

import type { AgentConnection } from './connection'
import { connectMcpToolset } from './mcp-client'
import {
  type LocalTool,
  SKILL_INPUT_SCHEMA,
  SKILL_TOOL_NAME,
  type SkillHandler,
  type SkillsInput,
  skillToolDescription,
} from './mcp-server'
import { accessFor, type PermissionValue, type ResolvedPermissions, skillKey, toolKey } from './permissions'
import { findProvider } from './resolve'
import { findTurnBoundary } from './turns'
import type { AgentSelection } from './types'

const DEFAULT_MAX_STEPS = 24

export interface NativeHarnessConfig {
  tools: LocalTool[]
  skills: SkillsInput
  skillHandler?: SkillHandler
  systemPrompt?: string
  maxSteps?: number
  // Resolve the real MCP servers (configured + extra) to attach in-process.
  // Excludes the built-in local server: its tools/skills already run here.
  // Re-evaluated per turn so refreshes apply without a session restart.
  loadMcpServers?: () => Promise<AcpMcpServer[]>
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

function resolveModel(selection: AgentSelection): LanguageModel {
  const provider = createOpenAICompatible({
    name: selection.providerId,
    baseURL: resolveBaseUrl(selection),
    apiKey: selection.apiKey,
  })
  return provider(selection.model)
}

// Best-effort context window per model family — the AI SDK doesn't expose it.
// Returns 0 when unknown, which the engine surfaces as an undefined max.
function contextWindow(model: string): number {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 200_000
  if (m.includes('gpt-5') || m.includes('o3') || m.includes('o4')) return 400_000
  if (m.includes('gpt-4')) return 128_000
  if (m.includes('gemini')) return 1_000_000
  if (m.includes('glm')) return 200_000
  if (m.includes('qwen')) return 256_000
  if (m.includes('deepseek')) return 128_000
  return 0
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

// Gate a tool call through the ACP permission flow. 'AlwaysAllow' skips the
// prompt; otherwise (an 'Allow' grant or an MCP/ungranted tool) the prompt is
// shown unless the session is in bypass mode. Returns a denial string when the
// user rejects, else null to proceed.
async function gateToolCall(
  gate: ToolGate,
  name: string,
  input: unknown,
  toolCallId: string,
  access: PermissionValue,
): Promise<string | null> {
  if (access === 'AlwaysAllow' || gate.getMode() === 'bypass') {
    return null
  }
  const response = await gate.client.requestPermission({
    sessionId: gate.sessionId,
    toolCall: { toolCallId, title: name, rawInput: input },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  })
  if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow') {
    return 'Permission denied by user.'
  }
  return null
}

// Convert the host's LocalTool[] (the same ones served to ACP agents over MCP)
// into native AI SDK tools, plus the skill tool and any configured MCP servers'
// tools. Each tool gates itself through the ACP permission flow per its grant.
// Returns the toolset and a closer for the MCP connections opened this turn.
async function buildToolset(
  config: NativeHarnessConfig,
  gate: ToolGate,
  permissions: ResolvedPermissions | undefined,
): Promise<{ toolset: ToolSet; close: () => Promise<void> }> {
  const toolset: ToolSet = {}

  for (const local of config.tools) {
    // Hidden tools never enter the session; AlwaysAllow tools skip the prompt.
    const access = accessFor(permissions, toolKey(local.name))
    if (access === null) {
      continue
    }
    toolset[local.name] = tool({
      description: local.description,
      inputSchema: z.object(local.inputSchema),
      execute: async (input, { toolCallId }) => {
        const denied = await gateToolCall(gate, local.name, input, toolCallId, access)
        if (denied) {
          return denied
        }
        return await local.handler(input as Record<string, unknown>)
      },
    })
  }

  const allSkills = typeof config.skills === 'function' ? await config.skills() : config.skills
  // Only permitted skills appear in the catalog; the rest stay hidden.
  const skills = allSkills.filter((skill) => accessFor(permissions, skillKey(skill.name)) !== null)
  const skillHandler = config.skillHandler
  if (skills.length > 0 && skillHandler) {
    toolset[SKILL_TOOL_NAME] = tool({
      description: skillToolDescription(skills),
      inputSchema: z.object(SKILL_INPUT_SCHEMA),
      // Guard the handler too: a model could still name a non-permitted skill.
      execute: async ({ skill }) =>
        accessFor(permissions, skillKey(skill)) === null ? `Skill "${skill}" is not available.` : skillHandler(skill),
    })
  }

  // Real MCP servers (configured + extra). Role grants don't cover them, so they
  // gate like an 'Allow' tool: prompt unless bypass.
  const mcpServers = config.loadMcpServers ? await config.loadMcpServers() : []
  const mcp = await connectMcpToolset(mcpServers, { clientName: 'agent-client-native' })
  for (const [name, mcpTool] of Object.entries(mcp.tools)) {
    const execute = mcpTool.execute
    if (!execute) {
      continue
    }
    toolset[name] = {
      ...mcpTool,
      execute: async (input: unknown, callOptions) => {
        const denied = await gateToolCall(gate, name, input, callOptions.toolCallId, 'Allow')
        if (denied) {
          return denied
        }
        return execute(input, callOptions)
      },
    }
  }

  return { toolset, close: mcp.closeAll }
}

export interface NativeSession {
  messages: ModelMessage[]
  mode: string
  abort?: AbortController
  permissions?: ResolvedPermissions
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

const AVAILABLE_MODES = [
  { id: 'default', name: 'Ask every time' },
  { id: 'bypass', name: 'Bypass permissions' },
]

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
      return { protocolVersion: PROTOCOL_VERSION }
    },

    async newSession() {
      const sessionId = randomUUID()
      sessions.set(sessionId, { messages: [], mode: 'default' })
      return {
        sessionId,
        modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
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

    async setSessionMode({ sessionId, modeId }) {
      const session = sessions.get(sessionId)
      if (session) {
        session.mode = modeId
      }
      return {}
    },

    // The native harness applies reasoning via providerOptions, not config
    // options, so this is a no-op (kept to satisfy the connection interface).
    async setSessionConfigOption() {
      return { configOptions: [] }
    },

    async unstable_forkSession({ sessionId, _meta }) {
      const source = sessions.get(sessionId)
      const dropFromTurn = typeof _meta?.dropFromTurn === 'number' ? _meta.dropFromTurn : undefined
      const forkId = randomUUID()
      sessions.set(forkId, {
        messages: source ? truncateMessages(source.messages, dropFromTurn) : [],
        mode: source?.mode ?? 'default',
        permissions: source?.permissions,
      })
      return {
        sessionId: forkId,
        modes: {
          currentModeId: source?.mode ?? 'default',
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
      const text = prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
      session.messages.push({ role: 'user', content: text })

      const gate: ToolGate = { sessionId, client, getMode: () => session.mode }
      const { toolset, close } = await buildToolset(config, gate, session.permissions)
      // Reasoning effort goes to the OpenAI-compatible provider, keyed by the
      // provider name used in resolveModel (selection.providerId).
      const providerOptions = selection.reasoningEffort
        ? {
            [selection.providerId]: {
              reasoningEffort: selection.reasoningEffort,
            },
          }
        : undefined
      const result = streamText({
        model: resolveModel(selection),
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
                  kind: 'other',
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
                },
              })
              break
            default:
              break
          }
        }
      } catch (error) {
        if (abort.signal.aborted) {
          session.abort = undefined
          return { stopReason: 'cancelled' }
        }
        session.abort = undefined
        throw error
      } finally {
        await close()
      }

      // Persist this turn's assistant/tool messages BEFORE clearing the in-flight
      // marker. Clearing it earlier would let a concurrently-dispatched prompt pass
      // the guard and push its user message between this turn's user message and
      // its assistant reply, corrupting the message store.
      const response = await result.response
      session.messages.push(...response.messages)
      // The turn is fully recorded; a late cancel() is now a clean no-op and the
      // next prompt is accepted.
      session.abort = undefined

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
            size: contextWindow(selection.model),
          },
        })
      }

      return { stopReason: mapStopReason(await result.finishReason) }
    },
  }
}
