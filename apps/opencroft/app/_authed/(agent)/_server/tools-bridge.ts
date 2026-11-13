import { adapterSupportsElicitation } from 'agent-client/agent-client'
import { type AskUserQuestionSpec, answerLines, questionsToElicitation } from 'agent-client/elicitation-form'
import { jsonSchemaToZodShape } from 'agent-client/json-schema'
import { type LocalTool, SKILL_TOOL_NAME, type ToolsCaller } from 'agent-client/mcp-server'

import type { ListedTool } from '@/app/_authed/(mcp)/_server/execution-mode'
import type { ToolCallerContext } from '@/app/_authed/(mcp)/_server/tool-caller'
import { handleToolCall, listDynamicTools, READ_ONLY_TOOLS, toolDefinitions } from '@/app/_authed/(mcp)/_server/tools'
import { agentForMcpIdentity } from '@/app/_authed/(space)/_server/agents-impl'

// Bridges opencroft's own MCP tool registry (spaces, nodes, extensions, docs,
// remote ops, MCP config, skills, dynamic agent-tool graph nodes — see
// (mcp)/_server/tools.ts) directly in-process into agent-client's LocalTool
// contract. agent-client then exposes these tools over the built-in 'local'
// MCP server (ACP harness path) and directly in the native harness's toolset —
// no network hop back into this app's own /mcp endpoint for the agent's own
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
  return (await agentForMcpIdentity(caller.mcpIdentity))?.name ?? null
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

function convert(def: ListedTool): ConvertedTool {
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
// on every call (see listDynamicTools()) so a tool installed, edited, or
// created on the canvas appears without an app restart — already presented, so
// one marked `awaitable` or `async` reads here as it does over HTTP.
// `caller` is required rather than defaulted: a default would silently stand in
// for a call site that forgot to say who is asking, which is the one thing this
// argument exists to make explicit. Callers with nobody to name pass `{}`.
export async function opencroftLocalTools(caller: ToolsCaller): Promise<LocalTool[]> {
  const callerAgent = await callingAgentName(caller)
  const dynamicDefs = await listDynamicTools()
  const sessionId = caller.sessionId
  // The session rides along with the agent, from the same bookkeeping: it is
  // how a tool reaches back into the conversation that called it — a
  // background task delivers its result there. Absent stays absent.
  const toolCaller: ToolCallerContext = sessionId ? { agent: callerAgent, sessionId } : { agent: callerAgent }
  // A harness verified to ask natively (ACP elicitation) does not get the
  // fallback question tool at all: both would render identically in the chat,
  // but the native one hands the answer back inside the turn, while the tool
  // makes the agent end its turn and wait for a message — offering both just
  // lets the model pick the worse channel.
  const harnessAsks = adapterSupportsElicitation(caller.adapterId)
  // The registry's `skill` is for external clients: agent-client registers its
  // own under the same name, filtered by the agent's role, and a second one
  // would collide with it.
  return [...getStaticTools(), ...dynamicDefs.map(convert)]
    .filter((tool) => tool.name !== SKILL_TOOL_NAME)
    .filter((tool) => !(tool.name === 'ask_user' && harnessAsks))
    .map((tool) => toLocalTool(tool, toolCaller))
    .map((tool) =>
      tool.name === 'ask_user' && sessionId ? sessionAskUserTool(tool, { agent: callerAgent, sessionId }) : tool,
    )
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

/** What the session's agent is told the tool does: it answers later, and the agent waits. */
const SESSION_ASK_USER_DESCRIPTION =
  'Ask the user structured questions with predefined options: up to 5 questions, each with up to 5 options plus a custom text input. ' +
  'The call returns at once: the questions are shown to the user, and the answers arrive later in this conversation as a message, ' +
  'one "question"="answer" line per question. After calling it, end your turn: make no further tool calls, do not continue the ' +
  'task and do not guess the answers. Wait for the message with the answers, however long it takes.'

/** The call's own answer: the question is out, and the agent stops here. */
function askUserStartedText(taskId: string): string {
  return (
    `Your questions are shown to the user, as background task ${taskId}. End your turn now: make no further tool ` +
    'calls, and do not continue the task or guess the answers. The answers will arrive in this conversation as ' +
    'a message about that task when the user gives them.'
  )
}

/**
 * ask_user for a caller WITH a session: the question goes into that session's
 * chat as the same form an agent-sent ACP elicitation renders as, instead of
 * the instance-wide MCP request queue. Callers without a session (external MCP
 * clients) keep the base handler's global path.
 *
 * The call does not wait for the answer. It starts a background task, with no
 * time limit, whose work is the question: the call answers at once, so no
 * harness's MCP request timeout can drop it, and the answer is the task's
 * result, delivered into the conversation like any other task's. The question
 * outlives the turn that asked it (the agent is told to end that turn), and
 * the task ends the way any in-process task does — answered, dismissed (a
 * failure saying so), stopped from the chat, ended with its conversation when
 * that is deleted, or ended by a restart. Starting the task here rather than
 * through a declaration is the one exception task-tools.ts's header names.
 *
 * No `space`: the form lands in the session's own chat, so there is no space
 * to name, and asking for one would make every in-chat question carry an
 * argument nothing reads. The base tool requires it because its queue is
 * shown per space.
 *
 * The agent-client and task-tools imports are deferred to the call because
 * this module is on the tools.ts <-> agent-client-instance import cycle (see
 * getStaticTools), and a tool family module must not be the first way into it.
 */
function sessionAskUserTool(base: LocalTool, caller: ToolCallerContext & { sessionId: string }): LocalTool {
  const { space: _space, ...inputSchema } = base.inputSchema
  return {
    ...base,
    description: SESSION_ASK_USER_DESCRIPTION,
    inputSchema,
    handler: async (args) => {
      const questions = parseAskUserQuestions(args.questions)
      if (!questions) {
        return base.handler(args)
      }
      const { message, schema } = questionsToElicitation(questions)
      const { backgroundTaskService, taskOwner } = await import('@/app/_authed/(mcp)/_server/task-tools')
      const record = await (await backgroundTaskService()).startInProcessTask({
        owner: taskOwner(caller),
        kind: 'tool',
        name: 'ask_user',
        target: '',
        summary: `Question for the user: ${questions.map((q) => q.title).join(', ')}`,
        timeoutMs: null,
        run: async (signal) => {
          const { agentClient } = await import('@/app/_authed/(agent)/_server/agent-client-instance')
          if (!agentClient.listSessions().some((session) => session.id === caller.sessionId)) {
            throw new Error('The conversation that asked is not open, so the questions could not be shown.')
          }
          const content = await agentClient.askUser(caller.sessionId, {
            message,
            form: schema,
            signal,
            outlivesTurn: true,
          })
          if (content === null) {
            // A stop from the chat or the conversation's deletion aborts the
            // signal and has ended the task already; what remains is a reader
            // who closed the form.
            throw signal.aborted ? signal.reason : new Error('The user dismissed the questions without answering.')
          }
          return `The user answered:\n${answerLines(questions, content)}`
        },
      })
      return { content: [{ type: 'text' as const, text: askUserStartedText(record.taskId) }] }
    },
  }
}
