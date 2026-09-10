/** The group-chat family: the agent-facing group chat tools and the artifacts that live in a thread. */

import {
  deleteArtifactAsAgent,
  editArtifactAsAgent,
  listArtifactsAsAgent,
  writeArtifactAsAgent,
} from '@/app/_authed/(group-chats)/_server/artifacts'
import {
  compactThreadAsAgent,
  listGroupChatsForAgentView,
  listThreadTurnsAsAgent,
  sendMessageInThreadAsAgent,
  startThreadAsAgent,
  threadCompactStatusAsAgent,
  threadRefFromSessionKey,
} from '@/app/_authed/(group-chats)/_server/model'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, requireCallingAgent, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'

export const definitions = [
  // ── Group chats ───────────────────────────────────────────────────
  //
  // The agent-facing half of group chats. Both tools act as the CALLING agent
  // and are gated on that agent's own membership, so what they can reach is
  // whatever a person put them in — there is no parameter for "act as someone
  // else", and adding one would defeat the gate.
  {
    name: 'group_chat_list',
    description:
      'List the group chats you are a member of, with their topic and their threads. ' +
      'Use the `ref` values from this result to address a thread in group_chat_send — ' +
      'they are opaque handles, not a format to construct. Each thread also carries `contextUsage`: ' +
      "`{ usedTokens, contextLimit, asOf? }` as last reported by that thread session's own harness, the " +
      'same figure its context ring renders — never estimated here. An offline thread with prior ' +
      'activity reports its last-known reading here too, with `asOf` (ms since epoch) set — its absence ' +
      'means the figure is live. Null only when genuinely UNKNOWN (the session has never reported usage), ' +
      'and null must not be read as "nothing held"; `contextLimit` alone is null when the harness cannot ' +
      "say what the model's window is. Use it to spot a thread that should be compacted " +
      '(group_chat_compact) before dispatching into it.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'artifact_list',
    description:
      'List the notes (artifacts) left on a thread of a group chat you are a member of. ' +
      'Use the `ref` values from group_chat_list to address a thread. Returns each artifact with ' +
      'its id, title and markdown content — pass an id back to artifact_write to revise that note ' +
      'rather than adding a second one saying the same thing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
      },
      required: ['thread'],
    },
  },
  {
    name: 'artifact_write',
    description:
      'Write a note (artifact) onto a thread of a group chat you are a member of: a short markdown ' +
      'document recording what you worked out, shown in the thread header and opened beside the ' +
      'conversation. Omit `id` to add one; pass the `id` of an existing artifact to revise it in ' +
      'place, which is what to do when a later iteration changes the answer. Notes are for durable ' +
      'findings, plans and results — not for progress chatter, which belongs in the conversation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        title: { type: 'string', description: 'Short name, shown in the thread header.' },
        content: { type: 'string', description: 'The note itself, as markdown.' },
        id: {
          type: 'string',
          description: 'An existing artifact id from artifact_list. Omit to create a new note.',
        },
      },
      required: ['thread', 'title', 'content'],
    },
  },
  {
    name: 'artifact_edit',
    description:
      'Replace an exact string inside a note (artifact), leaving the rest untouched. Prefer this ' +
      'over artifact_write when revising part of a long note: it sends only what changes, and ' +
      'cannot drop a section you forgot to include. Fails if `oldString` is not found, or appears ' +
      'more than once without `replaceAll` — extend it with surrounding text until it is unique.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        id: { type: 'string', description: 'The artifact id, from artifact_list.' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace it with. Empty removes the fragment.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['thread', 'id', 'oldString', 'newString'],
    },
  },
  {
    name: 'artifact_delete',
    description:
      'Remove a note (artifact) from a thread of a group chat you are a member of. Deleting is for a ' +
      'note that should never have been written; a note whose content has changed is revised with ' +
      'artifact_write instead, so its place in the thread is kept.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        id: { type: 'string', description: 'The artifact id, from artifact_list.' },
      },
      required: ['thread', 'id'],
    },
  },
  {
    name: 'group_chat_send',
    description:
      'Send a message into a thread of a group chat you are a member of. The thread has one agent, ' +
      'which receives your message in its own session and replies in the thread — the reply does NOT ' +
      'come back to you, so read the thread later to see it. The thread agent may be you: that is how ' +
      'you hand work to a fresh-context instance of yourself. To reach an agent that has no thread ' +
      'yet, use group_chat_start_thread — this tool only addresses threads that already exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        message: { type: 'string', description: 'The message to send into the thread.' },
        queue: {
          type: 'string',
          enum: ['wait', 'push'],
          description:
            'How this message relates to anything already waiting for that agent. "wait" holds it until ' +
            'the turn it is working on ends, then delivers it on its own. "push" interrupts that turn and ' +
            'delivers everything held at once, this message last, so the agent sees the whole picture ' +
            'before acting — use it when what you are sending changes what it should be doing. With ' +
            'nothing already waiting the two are the same ordinary send. It is the MESSAGE that waits, ' +
            'never you: this call returns as soon as the message is safely held.',
        },
      },
      required: ['thread', 'message', 'queue'],
    },
  },
  {
    name: 'group_chat_start_thread',
    description:
      'Start a NEW thread in a group chat you are a member of, addressed to one of its agents, and ' +
      'send its first message. This is how you reach an agent that has no thread yet — group_chat_send ' +
      'can only address a thread that already exists. Creating a thread is deliberate: it is this tool ' +
      'and nothing else, so a mistyped thread reference elsewhere can never silently make one. ' +
      'The agent receives the message in its own session and replies IN THE THREAD, not to you, so read ' +
      'the thread later for the answer. Returns the new thread, whose `ref` addresses it from then on.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        chat: {
          type: 'string',
          description: 'The chat to start the thread in — a `ref` from group_chat_list.',
        },
        agent: {
          type: 'string',
          description:
            "Which agent the thread is addressed to, by name, as listed in that chat's `members` from " +
            'group_chat_list. It must be a member of the chat. Name yourself to hand work to a ' +
            'fresh-context instance of yourself.',
        },
        message: { type: 'string', description: "The thread's first message." },
        title: {
          type: 'string',
          description:
            'Optional name for the thread, which also becomes its address. Omit for an ad-hoc thread, ' +
            'which gets a short generated name instead — most threads are ad-hoc.',
        },
      },
      required: ['chat', 'agent', 'message'],
    },
  },
  {
    name: 'group_chat_compact',
    description:
      "Compact a thread's session: shrinks its context window and, on success, re-delivers the " +
      "thread's CURRENT standing context (topic + pins). Works on an offline thread too — it is woken " +
      'from its stored state first and left running afterwards, the same as a message sent into it would. ' +
      'Use this at a task boundary before the next dispatch — do not send a bare "/compact" message ' +
      'instead, since that skips the standing-context re-delivery. Returns immediately once the job is ' +
      'accepted; call group_chat_compact_status to see when it actually finishes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
      },
      required: ['thread'],
    },
  },
  {
    name: 'group_chat_compact_status',
    description:
      "Check a thread's compaction job status (never-requested / pending / running / done / error), " +
      'including the before/after token counts once done. Poll this after group_chat_compact before ' +
      'dispatching the next task into the thread.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
      },
      required: ['thread'],
    },
  },
  {
    name: 'group_chat_turns',
    description:
      "List a thread's recent turns, newest last — the same summaries the send-message node's " +
      'listTurns action returns: each turn carries a truncated opening prompt, its status ' +
      '(finished / in-progress / interrupted / unknown), and the truncated final message when one ' +
      'exists. Use it to see what a thread agent is doing and whether turns run long or end ' +
      'interrupted, without pulling the transcript into your context. Pages backwards via ' +
      '`beforeIndex` from the previous result.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        turns: {
          type: 'number',
          description: 'How many turns to return (default 10, max 50).',
        },
        beforeIndex: {
          type: 'number',
          description: "Page older history: pass the previous result's nextBeforeIndex.",
        },
      },
      required: ['thread'],
    },
  },
]

export const handlers: Record<string, ToolHandler> = {
  // ── group_chat_list ─────────────────────────────────────────────
  group_chat_list: async (_args, caller) => {
    const agent = requireCallingAgent(caller)
    return textResult(JSON.stringify(await listGroupChatsForAgentView(agent), null, 2))
  },

  // ── artifact_list / artifact_write / artifact_delete ────────────
  //
  // No approval wrapper, for the same reason group_chat_send has none: these
  // write into a thread somebody already put this agent into, onto a surface
  // that is visible on a screen. The membership gate is the control.
  artifact_list: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    return textResult(JSON.stringify(await listArtifactsAsAgent(agent, thread), null, 2))
  },

  artifact_write: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    const title = args.title as string | undefined
    const content = args.content as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    if (!title) {
      fail(-32602, 'Missing required param: title')
    }
    if (!content) {
      fail(-32602, 'Missing required param: content')
    }
    const written = await writeArtifactAsAgent(agent, thread, {
      id: args.id as string | undefined,
      title,
      content,
    })
    return textResult(JSON.stringify(written, null, 2))
  },

  artifact_edit: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    const id = args.id as string | undefined
    const oldString = args.oldString as string | undefined
    const newString = args.newString as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    if (!id) {
      fail(-32602, 'Missing required param: id')
    }
    // Checked against undefined, not falsiness: an empty newString is a
    // deletion of the fragment and a legitimate edit.
    if (oldString === undefined) {
      fail(-32602, 'Missing required param: oldString')
    }
    if (newString === undefined) {
      fail(-32602, 'Missing required param: newString')
    }
    const edited = await editArtifactAsAgent(agent, thread, {
      id,
      oldString,
      newString,
      replaceAll: args.replaceAll === true,
    })
    return textResult(JSON.stringify(edited, null, 2))
  },

  artifact_delete: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    const id = args.id as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    if (!id) {
      fail(-32602, 'Missing required param: id')
    }
    await deleteArtifactAsAgent(agent, thread, id)
    return textResult('Artifact removed.')
  },

  // ── group_chat_send ─────────────────────────────────────────────
  //
  // No approval wrapper, deliberately. Approval exists for tools that change
  // the workspace under a person who may not be watching; this posts a
  // message into a conversation that is visible on a screen, in a chat
  // somebody already put this agent into. The membership gate is the control,
  // and an approval queue on every delegated message would make the feature
  // unusable for the thing it was asked for.
  group_chat_send: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    const message = args.message as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    if (!message) {
      fail(-32602, 'Missing required param: message')
    }
    // Refused rather than defaulted. The thread agent may be mid-turn, and
    // whether this message should wait for that turn or interrupt it is
    // something only the sender knows — a default would decide it for them
    // silently, which is the guesswork this parameter exists to remove.
    const queue = args.queue
    if (queue !== 'wait' && queue !== 'push') {
      fail(-32602, 'Missing or invalid param: queue must be "wait" or "push"')
    }
    await sendMessageInThreadAsAgent(agent, thread, message, queue)
    // One sentence, whatever the instance's delivery gate is doing. A result
    // that changed with the gate would tell the caller the gate exists, and an
    // agent that learns it does not simply record it — it reasons about why
    // its send read differently and then acts on the reasoning, re-sending,
    // escalating, or reporting the state as if it were a property of the work.
    // Nothing is lost by staying quiet: a held message is queued and durable
    // exactly as one behind a running turn, and where the reply lands — which
    // this does say — is the only part of it the sender can act on.
    return textResult('Message sent into the thread. The reply lands in the thread, not here.')
  },

  // ── group_chat_start_thread ─────────────────────────────────────
  //
  // No approval wrapper, same reasoning as group_chat_send: this creates a
  // conversation in a chat somebody already put this agent into, on a
  // surface that is visible on a screen, and the membership gate is the
  // control. Creation being its own tool -- rather than a side effect of a
  // send whose thread reference happened not to resolve -- is what keeps it
  // deliberate: there is no argument to this tool that a caller could get
  // subtly wrong and end up with a thread it did not mean to make.
  group_chat_start_thread: async (args, caller) => {
    const callerAgent = requireCallingAgent(caller)
    const chat = args.chat as string | undefined
    const agent = args.agent as string | undefined
    const message = args.message as string | undefined
    if (!chat) {
      fail(-32602, 'Missing required param: chat')
    }
    if (!agent) {
      fail(-32602, 'Missing required param: agent')
    }
    if (!message) {
      fail(-32602, 'Missing required param: message')
    }
    const { thread } = await startThreadAsAgent(callerAgent, chat, agent, message, {
      title: args.title as string | undefined,
    })
    // The ref, in the same shape group_chat_list hands out, so the caller can
    // address the thread it just made without a second lookup. Built by the
    // same function, so the two cannot drift into different spellings of the
    // same thread -- which is the whole reason it is a function rather than a
    // slice repeated here.
    const ref = threadRefFromSessionKey(thread.sessionKey)
    return textResult(
      JSON.stringify(
        { ref, title: thread.title, sent: true, note: 'The reply lands in the thread, not here.' },
        null,
        2,
      ),
    )
  },

  // ── group_chat_compact / group_chat_compact_status ──────────────
  //
  // No approval wrapper, same reasoning as group_chat_send: this acts on a
  // thread somebody already put this agent into, and the membership gate
  // (compactThreadAsAgent's own) is the control.
  group_chat_compact: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const ack = await compactThreadAsAgent(agent, thread)
    return textResult(JSON.stringify(ack, null, 2))
  },

  group_chat_compact_status: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const status = await threadCompactStatusAsAgent(agent, thread)
    return textResult(JSON.stringify(status, null, 2))
  },

  // Same gate and reasoning as group_chat_compact_status: a read on a thread
  // somebody already put this agent into; the membership gate is the control.
  group_chat_turns: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const page = await listThreadTurnsAsAgent(agent, thread, {
      turns: typeof args.turns === 'number' ? args.turns : undefined,
      beforeIndex: typeof args.beforeIndex === 'number' ? args.beforeIndex : undefined,
    })
    return textResult(JSON.stringify(page, null, 2))
  },
}
