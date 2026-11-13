/** The family that reads and writes an agent's instruction texts: agent_instructions_read and agent_instructions_write. */

import {
  AgentInstructionsError,
  type InstructionFileRole,
  readAgentInstructions,
  writeAgentInstructions,
} from '@/app/_authed/(agent)/_server/agent-instructions'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, jsonResult } from '@/app/_authed/(mcp)/_server/tool-shared'

const AGENT_PARAM = {
  agent: { type: 'string', description: 'The agent: its node id, or its name when no other agent has that name.' },
}

const ROLES: InstructionFileRole[] = ['shared', 'agent', 'system-prompt']

export const definitions = [
  {
    name: 'agent_instructions_read',
    description:
      "Read an agent's instruction texts and the files its harness reads them from. `shared` is the text of the place the agent runs in (its container, or this server), read by every agent there (`sharedWith`); `agent` is the agent's own; `system-prompt` is the Custom harness's prompt. `rereads` says whether the harness reads a file every turn or once per session. A harness that keeps its own files has none listed. `chats` are the chats the agent is in, whose topic and pinned notes reach it in its threads' messages.",
    inputSchema: {
      type: 'object' as const,
      properties: AGENT_PARAM,
      required: ['agent'],
    },
  },
  {
    name: 'agent_instructions_write',
    description:
      "Replace one of an agent's instruction texts (markdown). `agent`: the agent's own text, written as the instruction file in its workspace. `shared`: the text of the place it runs in, which every agent there reads; the answer names them. `system-prompt`: the Custom harness's prompt. A new session reads the new text; an open thread is told at its next message. An empty text removes the file.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...AGENT_PARAM,
        role: { type: 'string', enum: ROLES, description: 'Which text to replace.' },
        text: { type: 'string', description: 'The whole new text.' },
      },
      required: ['agent', 'role', 'text'],
    },
  },
]

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || (name !== 'text' && !value)) {
    fail(-32602, `Missing required param: ${name}`)
  }
  return value
}

// A refusal about the agent or the role is the caller's to correct; anything else is the server's.
async function answering<T>(work: () => Promise<T>): Promise<Record<string, unknown>> {
  try {
    return jsonResult(await work())
  } catch (error) {
    if (error instanceof AgentInstructionsError) {
      fail(-32602, error.message)
    }
    throw error
  }
}

export const handlers: Record<string, ToolHandler> = {
  agent_instructions_read: async (args) => answering(() => readAgentInstructions(requiredString(args, 'agent'))),

  agent_instructions_write: async (args, caller) => {
    const role = requiredString(args, 'role') as InstructionFileRole
    if (!ROLES.includes(role)) {
      fail(-32602, `role must be one of: ${ROLES.join(', ')}`)
    }
    return answering(() =>
      writeAgentInstructions(requiredString(args, 'agent'), role, requiredString(args, 'text'), {
        updatedBy: caller.agent ?? undefined,
      }),
    )
  },
}
