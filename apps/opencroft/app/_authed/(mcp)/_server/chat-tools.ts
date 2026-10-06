/** The group-chat family: the agent-facing group chat tools and the artifacts that live in a thread. */

import {
  deleteArtifactAsAgent,
  editArtifactAsAgent,
  listArtifactsAsAgent,
  writeArtifactAsAgent,
} from '@/app/_authed/(group-chats)/_server/artifacts'
import { COMPACT_WAIT_MS, waitForCompact } from '@/app/_authed/(group-chats)/_server/compact-wait'
import {
  compactThreadAsAgent,
  deleteThreadAsAgent,
  listGroupChatsForAgentView,
  listThreadTurnsAsAgent,
  renameThreadAsAgent,
  sendMessageInThreadAsAgent,
  setThreadArchivedAsAgent,
  startThreadAsAgent,
  threadCompactStatusAsAgent,
  threadRefFromSessionKey,
} from '@/app/_authed/(group-chats)/_server/model'
import { compactOutcome } from '@/app/_authed/(mcp)/_server/compact-outcome'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import { fail, jsonResult, requireCallingAgent, textResult } from '@/app/_authed/(mcp)/_server/tool-shared'

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
      'they are opaque handles, not a format to construct. Each thread carries `folder`: the name of the ' +
      'thread-list folder it is filed in, or null for a thread at the top level. Each thread also carries `contextUsage`: ' +
      "`{ usedTokens, contextLimit, asOf? }` as last reported by that thread session's own harness, the " +
      'same figure its context ring renders — never estimated here. An offline thread with prior ' +
      'activity reports its last-known reading here too, with `asOf` (ms since epoch) set — its absence ' +
      'means the figure is live. Null only when genuinely UNKNOWN (the session has never reported usage), ' +
      'and null must not be read as "nothing held"; `contextLimit` alone is null when the harness cannot ' +
      "say what the model's window is. Use it to spot a thread that should be compacted " +
      "(group_chat_compact) before dispatching into it. A thread with `archived: true` is in the chat's " +
      'archive and refuses every send until it is unarchived (group_chat_archive_thread); its `folder` is ' +
      'its folder in the archive.',
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
        folder: {
          type: 'string',
          description:
            "Optional thread-list folder to file the thread in, by its name as shown in the chat's thread " +
            'list (and in `folder` from group_chat_list). An exact name match goes into that folder; with ' +
            'none, the folder is created. Omit to leave the thread at the top level.',
        },
      },
      required: ['chat', 'agent', 'message'],
    },
  },
  {
    name: 'group_chat_rename_thread',
    description:
      'Rename a thread of a group chat you are a member of, file it in a thread-list folder, or both — ' +
      'what a person does from the thread list. Pass at least one of `title` and `folder`. A new title ' +
      "also becomes the thread's address: use the `ref` this returns from then on, though the old one " +
      'keeps working. A `folder` is matched by exact name and created if the chat has none by that name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        title: { type: 'string', description: 'The new name for the thread.' },
        folder: {
          type: 'string',
          description: 'The folder to move the thread into, by its name as shown in the thread list.',
        },
      },
      required: ['thread'],
    },
  },
  {
    name: 'group_chat_delete_thread',
    description:
      'Delete a thread and the session underneath it: its history, its queue and its agent process ' +
      'all go. There is no undo and nothing is archived. Use it to retire a thread whose work is ' +
      'finished — a per-ticket thread when the ticket closes, a scratch thread when you are done ' +
      'with it — so a chat lists live work rather than everything that ever happened in it. ' +
      'You may delete a thread you STARTED with group_chat_start_thread, or a thread addressed to ' +
      'YOU; any other thread of a chat you are in is refused by name, because deleting a ' +
      "colleague's thread is not recoverable. A thread whose agent is mid-turn is also refused — " +
      'wait for the turn to end and call again, rather than destroying work in progress.',
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
    name: 'group_chat_archive_thread',
    description:
      'Archive a thread of a group chat you are a member of, or unarchive it. An archived thread keeps ' +
      "its history and moves from the chat's thread list to its archive, in the same folder; nothing can " +
      'be sent into it, by anyone, until it is unarchived, and messages still waiting in its queue are ' +
      'dropped. Unarchiving returns it to the thread list, into the folder it has in the archive. Use it ' +
      'to retire finished work without destroying it. The same threads are yours to archive as to delete: ' +
      'one you started, or one addressed to you.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread: {
          type: 'string',
          description: 'A thread reference from group_chat_list. Opaque — pass it back unchanged.',
        },
        archived: {
          type: 'boolean',
          description: 'true to archive the thread, false to unarchive it.',
        },
      },
      required: ['thread', 'archived'],
    },
  },
  {
    name: 'group_chat_compact',
    // Async: a compaction takes minutes, and the caller must not send into the
    // thread until it ends — so the host waits for the job and delivers how it
    // ended, instead of every caller polling group_chat_compact_status.
    execution: 'async' as const,
    description:
      "Compact a thread's session: shrinks its context window and, on success, re-delivers the " +
      "thread's CURRENT standing context (topic + pins). Works on an offline thread too — it is woken " +
      'from its stored state first and left running afterwards, the same as a message sent into it would. ' +
      'Use this at a task boundary before the next dispatch — prefer it over sending a bare "/compact" ' +
      'message: this one re-delivers standing context on every harness and reports progress, while a bare ' +
      '/compact only triggers the re-delivery on harnesses that report compaction over ACP, and reports ' +
      'nothing back. The outcome arrives as a background-task notification when the compaction ends: whether ' +
      'the context actually shrank (a finished job can still report NOT compacted — retry then), whether the ' +
      'standing context was re-delivered, the usage before and after, or the error. Send nothing into the ' +
      'thread before that notification arrives.',
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
      'including the before/after token counts once done. group_chat_compact reports its outcome as a ' +
      'background-task notification; poll this instead only where those notifications cannot reach you, ' +
      'before dispatching the next task into the thread.',
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
    return jsonResult(await listGroupChatsForAgentView(agent))
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
    return jsonResult(await listArtifactsAsAgent(agent, thread))
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
    return jsonResult(written)
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
    return jsonResult(edited)
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
    const { thread, folder } = await startThreadAsAgent(callerAgent, chat, agent, message, {
      title: args.title as string | undefined,
      folder: args.folder as string | undefined,
    })
    // The ref, in the same shape group_chat_list hands out, so the caller can
    // address the thread it just made without a second lookup. Built by the
    // same function, so the two cannot drift into different spellings of the
    // same thread -- which is the whole reason it is a function rather than a
    // slice repeated here.
    const ref = threadRefFromSessionKey(thread.sessionKey)
    return jsonResult({
      ref,
      title: thread.title,
      folder,
      sent: true,
      note: 'The reply lands in the thread, not here.',
    })
  },

  // ── group_chat_rename_thread ────────────────────────────────────
  //
  // No approval wrapper, same reasoning as group_chat_send: a person may do
  // exactly this from the thread list of a chat they are in, and the membership
  // gate (renameThreadAsAgent's own) is the same control their rename answers to.
  group_chat_rename_thread: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const renamed = await renameThreadAsAgent(agent, thread, {
      title: args.title as string | undefined,
      folder: args.folder as string | undefined,
    })
    return jsonResult(renamed)
  },

  // ── group_chat_delete_thread ────────────────────────────────────
  //
  // No approval wrapper, like the rest of this family — but the reasoning is
  // NOT the family's, because the family's is "the membership gate is the
  // control" and for a delete it is not enough. Membership admits every thread
  // of the chat, and this is the one operation nothing can undo: the session,
  // the process and the transcript go together.
  //
  // What stands in its place is a narrower gate one level down
  // (`deleteThreadAsAgent`): the caller must own the thread, by having started
  // it or by being the agent it is addressed to. An approval prompt would ask
  // a person to confirm an agent tidying up after its own work, which is the
  // kind of prompt that trains people to click through prompts. If the product
  // owner later wants human confirmation on this, it is a wrapper here and
  // nothing else changes.
  group_chat_delete_thread: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const result = await deleteThreadAsAgent(agent, thread)
    if (!result.deleted) {
      // Named, with the reason, because both of these are states the caller can
      // do something about — ask the owner, or wait — and a bare failure would
      // send them to look for a broken tool instead.
      fail(
        -32602,
        result.refused === 'turn-in-progress'
          ? `"${thread}" has a turn in progress and was NOT deleted. Wait for it to finish and call again — ` +
              'deleting mid-turn would destroy work the agent is doing right now.'
          : `"${thread}" is not yours to delete and was NOT deleted. You may delete a thread you started, ` +
              'or a thread addressed to you; this is neither. Ask the agent it belongs to.',
      )
    }
    return textResult(`Thread "${thread}" deleted: its session, history and queue are gone.`)
  },

  // ── group_chat_archive_thread ───────────────────────────────────
  //
  // No approval wrapper; the gate is deletion's ownership rule
  // (`setThreadArchivedAsAgent`), for the same reason as there: membership
  // admits every thread of the chat, and closing a colleague's thread to
  // messages is not the caller's call to make. Archiving destroys nothing, so
  // unlike deletion a running turn is not a refusal.
  group_chat_archive_thread: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const archived = args.archived
    if (typeof archived !== 'boolean') {
      fail(-32602, 'Missing or invalid param: archived must be true or false')
    }
    const result = await setThreadArchivedAsAgent(agent, thread, archived)
    if (!result.changed) {
      fail(
        -32602,
        `"${thread}" is not yours to ${archived ? 'archive' : 'unarchive'} and was NOT changed. You may archive a ` +
          'thread you started, or a thread addressed to you; this is neither. Ask the agent it belongs to.',
      )
    }
    return textResult(
      archived
        ? `Thread "${thread}" archived: it keeps its history and takes no messages until it is unarchived.`
        : `Thread "${thread}" unarchived: it is back in the thread list and takes messages again.`,
    )
  },

  // ── group_chat_compact / group_chat_compact_status ──────────────
  //
  // No approval wrapper, same reasoning as group_chat_send: this acts on a
  // thread somebody already put this agent into, and the membership gate
  // (compactThreadAsAgent's own) is the control.
  //
  // Declared async, so this runs as a background task and its answer is the
  // task's result: it waits for the job it started or joined, bounded, and
  // reports how it ended (compact-outcome.ts). A failed job or a wait that
  // gave up answers isError, which fails the task.
  group_chat_compact: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const watch = await compactThreadAsAgent(agent, thread)
    const wait = await waitForCompact(watch, { timeoutMs: COMPACT_WAIT_MS, signal: caller.signal })
    const outcome = compactOutcome(watch.ack, wait, { timeoutMs: COMPACT_WAIT_MS })
    return outcome.failed ? { ...textResult(outcome.text), isError: true } : textResult(outcome.text)
  },

  group_chat_compact_status: async (args, caller) => {
    const agent = requireCallingAgent(caller)
    const thread = args.thread as string | undefined
    if (!thread) {
      fail(-32602, 'Missing required param: thread')
    }
    const status = await threadCompactStatusAsAgent(agent, thread)
    return jsonResult(status)
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
    return jsonResult(page)
  },
}
