import { adapterSupportsElicitation } from 'agent-client/agent-client'
import {
  type AskUserQuestionSpec,
  contentToAnswers,
  questionsToElicitation,
} from 'agent-client/elicitation-form'
import { jsonSchemaToZodShape } from 'agent-client/json-schema'
import type { LocalTool, ToolsCaller } from 'agent-client/mcp-server'

import { getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import type { ToolCallerContext } from '@/app/_authed/(mcp)/_server/tool-caller'
import {
  getAgentToolDefinitions,
  handleToolCall,
  READ_ONLY_TOOLS,
  toolDefinitions,
} from '@/app/_authed/(mcp)/_server/tools'
import { slug } from '@/app/_authed/(server)/_server/types'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

// Bridges opencroft's own MCP tool registry (spaces, nodes, extensions, docs,
// remote ops, MCP config, skills, dynamic agent-tool graph nodes — see
// (mcp)/_server/tools.ts) directly in-process into agent-client's LocalTool
// contract. agent-client then exposes these tools over the built-in 'local'
// MCP server (ACP harness path) and directly in the native harness's toolset —
// no network hop back into this app's own /api/mcp route for the agent's own
// tool calls, which used to need a container-URL rewrite to even be reachable.
//
// `internal: true` mirrors the `x-opencroft-internal` header the old HTTP
// bridge sent: these calls skip the external MCP approval queue because the
// agent chat already gates tool calls through its own permission flow (ACP
// requestPermission / the native harness's tool gate).
async function callTool(
  name: string,
  args: Record<string, unknown>,
  caller: ToolCallerContext,
): Promise<Record<string, unknown>> {
  try {
    return await handleToolCall(name, args, {
      internal: true,
      callerAgent: caller.agent,
      callerSessionId: caller.sessionId,
    })
  } catch (e) {
    const err = e as { message?: string }
    return { content: [{ type: 'text' as const, text: err.message ?? String(e) }], isError: true }
  }
}

/**
 * Which agent this bridge is serving, asserted from the session's own
 * bookkeeping: agent-client hands over the `mcpIdentity` it was given when the
 * session was opened — the agent node's name slug — and that is turned back
 * into the agent's name here. Nothing the caller passes in a tool argument
 * takes part, and `internal: true` grants no identity of its own: a call that
 * skips the approval queue is not thereby a call from somebody.
 *
 * Null whenever the answer is not exactly one agent — no identity on the
 * session, no node whose name slugifies to it, or more than one. Tools that act
 * AS the caller refuse on null (see `requireCallingAgent`), which is the only
 * safe reading: an ambiguous identity used anyway is a message delivered as the
 * wrong agent.
 */
async function callingAgentName(caller: ToolsCaller): Promise<string | null> {
  const identity = caller.mcpIdentity
  if (!identity) {
    return null
  }
  const matches = (await listAgentNodesImpl()).filter((node) => slug(node.name) === identity)
  return matches.length === 1 ? (matches[0]?.name ?? null) : null
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// The JSON-Schema-to-Zod conversion is the expensive half and does not depend
// on who is calling, so it is cached; the LocalTool wrapper around it is not,
// because its handler closes over the caller and a cached one would carry the
// previous caller's identity into the next session's tool call.
interface ConvertedTool {
  name: string
  description: string
  inputSchema: LocalTool['inputSchema']
}

function convert(def: ToolDef): ConvertedTool {
  return { name: def.name, description: def.description, inputSchema: jsonSchemaToZodShape(def.inputSchema) }
}

function toLocalTool(tool: ConvertedTool, caller: ToolCallerContext): LocalTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (args) => callTool(tool.name, args, caller),
    // Declared here because this is the bridge: it is where opencroft's own
    // tools become something an agent can see, and the classification is
    // opencroft's to make.
    //
    // SET ONLY WHEN TRUE, never `false`. Absent means nobody classified this
    // tool; `false` would assert that it writes, which is a claim the set does
    // not make and cannot -- extension-contributed and dynamic graph tools
    // pass through this same function, and their absence from the set says
    // only that nobody has looked at them.
    ...(READ_ONLY_TOOLS.has(tool.name) ? { readOnly: true } : {}),
  }
}

// The static registry never changes at runtime, so its schemas only need
// converting once — but lazily, on first actual use, not at module-load time:
// tools.ts imports agentClient (agent-client-instance.ts) for
// refreshMcpServers(), and agent-client-instance.ts imports this module for
// `tools`, so tools.ts <-> this module is a real circular import. Reading
// `toolDefinitions` at this module's top level would run before tools.ts has
// finished evaluating in that cycle and see it as undefined.
let staticTools: ConvertedTool[] | undefined

function getStaticTools(): ConvertedTool[] {
  if (!staticTools) {
    staticTools = toolDefinitions.map(convert)
  }
  return staticTools
}

// Extension-contributed tools and dynamic agent-tool graph nodes are re-read
// on every call (see getExtensionToolDefinitions()/getAgentToolDefinitions())
// so a tool installed, edited, or created on the canvas appears without an
// app restart.
// `caller` is required rather than defaulted: a default would silently stand in
// for a call site that forgot to say who is asking, which is the one thing this
// argument exists to make explicit. Callers with nobody to name pass `{}`.
export async function opencroftLocalTools(caller: ToolsCaller): Promise<LocalTool[]> {
  const callerAgent = await callingAgentName(caller)
  const staticNames = new Set(toolDefinitions.map((t) => t.name))
  const extensionDefs = await getExtensionToolDefinitions(staticNames)
  const dynamicDefs = await getAgentToolDefinitions(new Set(extensionDefs.map((t) => t.name)))
  const sessionId = caller.sessionId
  // The session rides along with the agent, from the same bookkeeping: it is
  // how a tool reaches back into the conversation that called it — a
  // background task delivers its result there. Absent stays absent.
  const toolCaller: ToolCallerContext = sessionId ? { agent: callerAgent, sessionId } : { agent: callerAgent }
  // A harness verified to ask natively (ACP elicitation) does not get the
  // fallback question tool at all: both would render identically in the chat,
  // but the tool path dies at the MCP request timeout and the native one
  // doesn't — offering both just lets the model pick the worse channel.
  const harnessAsks = adapterSupportsElicitation(caller.adapterId)
  return [...getStaticTools(), ...extensionDefs.map(convert), ...dynamicDefs.map(convert)]
    .filter((tool) => !(tool.name === 'ask_user' && harnessAsks))
    .map((tool) => toLocalTool(tool, toolCaller))
    .map((tool) => (tool.name === 'ask_user' && sessionId ? sessionAskUserTool(tool, sessionId) : tool))
}

/**
 * Read the ask_user tool's `questions` argument into specs, or null when it is
 * not a well-formed non-empty batch — in which case the caller delegates to
 * the base handler so the canonical validation errors stay in one place
 * (user-tools.ts).
 */
function parseAskUserQuestions(raw: unknown): AskUserQuestionSpec[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5) {
    return null
  }
  const questions = raw.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>
    return {
      title: String(record.title ?? ''),
      question: String(record.question ?? ''),
      options: (Array.isArray(record.options) ? record.options : []).map(String).slice(0, 5),
      ...(record.multiple ? { multiple: true } : {}),
    }
  })
  return questions.some((q) => !q.title || !q.question || q.options.length === 0) ? null : questions
}

/**
 * ask_user for a caller WITH a session: the question goes into that session's
 * chat as the same form an agent-sent ACP elicitation renders as, instead of
 * the instance-wide MCP request queue. Same questions argument, same
 * `"question"="answer"` result text, same cancelled error — only where the
 * form appears changes. Callers without a session (external MCP clients) keep
 * the base handler's global path.
 *
 * The agent-client import is deferred to the call because this module is on
 * the tools.ts <-> agent-client-instance import cycle (see getStaticTools).
 */
function sessionAskUserTool(base: LocalTool, sessionId: string): LocalTool {
  return {
    ...base,
    handler: async (args) => {
      const questions = parseAskUserQuestions(args.questions)
      if (!questions) {
        return base.handler(args)
      }
      const { agentClient } = await import('@/app/_authed/(agent)/_server/agent-client-instance')
      const { message, schema } = questionsToElicitation(questions)
      const content = await agentClient.askUser(sessionId, { message, form: schema })
      if (content === null) {
        return { content: [{ type: 'text' as const, text: 'cancelled' }], isError: true }
      }
      const answers = contentToAnswers(questions, content)
      const lines = questions.map((q) => `"${q.question}"="${answers[q.title] ?? ''}"`)
      return { content: [{ type: 'text' as const, text: `User answered to your questions:\n${lines.join('\n')}` }] }
    },
  }
}
