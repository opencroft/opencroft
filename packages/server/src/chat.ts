/**
 * `@opencroft/server/chat` — group chats as the extension's own sender, and
 * delivery through a SendMessage node.
 */

/** What a SendMessage node's `send` delivered to -- a group-chat thread, the only destination it routes to. `status` says whether the message queued behind a running turn or was delivered immediately. */
export interface HostSendMessageResult {
  kind: 'thread'
  threadRef: string
  status: 'queued' | 'delivered'
}

/** Deliver through a SendMessage node's own path -- the same membership-gated thread delivery its `text-in` wiring uses. */
export interface HostSendMessageApi {
  /**
   * `sourceNodeId` is what fed THIS run, taken from the action context's input
   * source rather than from a graph lookup: several things can be wired to one
   * handle and only the run knows which of them fired. The message is
   * attributed to it, and a send whose source cannot be turned into an account
   * is refused rather than attributed to the application.
   *
   * `callerAgent` is who INVOKED the action, from `ctx.callerAgent`, and it is
   * consulted only when nothing fed the run -- an action a caller triggered
   * directly has no upstream node by definition, and that is not the same fact
   * as having no sender. Pass both and let the host choose; a run with neither
   * is still refused.
   */
  send(
    nodeId: string,
    payload: Record<string, unknown>,
    sourceNodeId: string | undefined,
    callerAgent?: string,
  ): Promise<HostSendMessageResult>
}

/** A group chat as the bound sender sees it: its address, name and agent members. */
export interface HostGroupChat {
  /** The chat's id — accepted wherever a chat is named, as is its slug. */
  ref: string
  /** The chat's slug: what `EmbeddedAgentChat` takes as `space`. */
  slug: string
  name: string
  agents: Array<{ nodeId: string; name: string }>
}

/** A thread as the bound sender sees it. `threadId` is what `EmbeddedAgentChat` takes as `thread.threadId`. */
export interface HostGroupChatThread {
  /** Opaque thread reference: store it, pass it back. */
  ref: string
  threadId: string
  title: string | null
  chat: { ref: string; slug: string; name: string }
  agent: { nodeId: string; name: string | null }
  createdAt: Date
  /** True while the thread is archived: it refuses every send until unarchived. */
  archived: boolean
}

/** One turn of a thread's session, summarised — the same shape `group_chat_turns` returns. */
export interface HostThreadTurn {
  index: number
  prompt: string
  promptLength: number
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

/** One finished turn of a thread's session, as its usage record has it. */
export interface HostThreadUsageTurn {
  /** When the turn ended, ISO. */
  endedAt: string
  /** The model the turn ran on, when the harness named it. */
  model: string | null
  /** The turn's own token spend — this turn's, not a running total — including what its subagents spent. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** The turn's own cost; null when the harness does not price the session. */
  cost: { amount: number; currency: string } | null
}

/** How much context a thread's session holds. */
export interface HostThreadContext {
  usedTokens: number
  /** The model's window; null when it cannot be named. */
  contextLimit: number | null
  /** When the reading was taken, ISO, for a session not loaded now; absent for a live reading. */
  asOf?: string
}

/**
 * What a thread has spent: its recorded turns, oldest first, and whether a
 * turn is running now (its spend then arrives when that turn ends). `context`
 * is what its session holds now, or last held; null when it never reported.
 */
export interface HostThreadUsage {
  turns: HostThreadUsageTurn[]
  busy: boolean
  context: HostThreadContext | null
}

/**
 * How a compaction asked for with `groupChats.compact` ended.
 * `compacted`: the session's context shrank. `not_compacted`: it did not (a
 * harness without compaction answers it as a message). `unknown`: there was
 * no reading to tell by. `failed`: the compaction errored. `timed_out`: it was
 * still waiting or running when the wait ended; it carries on regardless.
 */
export interface HostCompactResult {
  outcome: 'compacted' | 'not_compacted' | 'unknown' | 'failed' | 'timed_out'
  /** Context tokens around the compaction alone; null when not read. */
  contextBefore: number | null
  contextAfter: number | null
  /** Why it failed, for `failed`. */
  error?: string
}

export interface HostThreadTurnsPage {
  turns: HostThreadTurn[]
  hasMore: boolean
  nextBeforeIndex: number | null
  sessionStatus: string
}

/** How often a session's agent reads what is sent to it — the chat command bar's Presence control. */
export type HostPresence =
  | { kind: 'high-attention' }
  | { kind: 'realtime' }
  | { kind: 'online' }
  | { kind: 'minutes' }
  | { kind: 'hourly' }
  | { kind: 'daily' }
  | { kind: 'custom'; intervalMs: number }

/**
 * Settings for a thread's session, applied before the message they ride with
 * is delivered — the chat command bar's Effort, Presence and Permission Mode
 * controls, in the command bar's own vocabulary. Each is optional: one left
 * out leaves the session's current setting as it is.
 */
export interface HostSessionOptions {
  /** Reasoning effort: `max`, `extra`, `high`, `medium`, `low`, `default` or `off`. */
  effort?: string
  presence?: HostPresence
  /** `auto`, `plan`, `manual-edits`, `accept-edits`, `reject-edits` or `bypass`. */
  permissionMode?: string
}

/**
 * What became of the session options a call carried. A value the session's
 * agent does not offer (an effort level its model lacks, a permission mode its
 * harness has no such thing as) is skipped with the reason, and the others
 * still apply: an option never fails the call it rides with.
 */
export interface HostSessionOptionsResult {
  applied: Array<keyof HostSessionOptions>
  skipped: Array<{ option: keyof HostSessionOptions; reason: string }>
}

/**
 * Group chats, acting as ONE sender the host chose: inside an App action
 * invoked by an agent (`ctx.groupChats`), that agent; everywhere else
 * (`groupChats` here, or an action nobody's agent called), the extension's own
 * system identity `system.ext.<extension id, dotted>` — e.g.
 * `system.ext.acme.task-pipelines`. There is no way to name another sender.
 *
 * Every call is gated on that sender's membership of the chat, exactly as an
 * agent's group-chat tools are; a system identity is a member once a person
 * grants it in the chat's members list. A chat or thread the sender cannot
 * reach refuses with "Not available", whichever of the two it was.
 *
 * A system identity may open threads and post; it cannot read transcripts.
 * Reading is `HostAgentGroupChatsApi.turns`, offered only when an agent is the
 * sender and so only over chats that agent belongs to.
 */
export interface HostGroupChatsApi {
  /** Chats the sender is a member of, with their agent members. */
  list(): Promise<HostGroupChat[]>
  /**
   * Open a thread addressed to an agent member of `chat` (id or slug), with
   * `message` as its first message from the sender. `sessionOptions` are
   * applied to the thread's session before that message is delivered, and
   * the result says what became of them (present only when they were given).
   */
  startThread(input: {
    chat: string
    agentNodeId: string
    message: string
    title?: string
    folder?: string
    sessionOptions?: HostSessionOptions
  }): Promise<{ thread: HostGroupChatThread; folder: string | null; sessionOptions?: HostSessionOptionsResult }>
  /**
   * Send into a thread; `queue` defaults to `wait` (after the running turn).
   * `sessionOptions` are applied to the thread's session before the message
   * is delivered or queued, as for `startThread`.
   */
  send(input: {
    thread: string
    message: string
    queue?: 'wait' | 'push'
    sessionOptions?: HostSessionOptions
  }): Promise<{ status: 'queued' | 'delivered'; sessionOptions?: HostSessionOptionsResult }>
  thread(ref: string): Promise<HostGroupChatThread>
  /**
   * Archive a thread the sender owns — one it started, or for an agent sender
   * one addressed to it. The thread keeps its history and its folder, moves to
   * the chat's archive, and refuses every send (`send` included) until it is
   * unarchived. Already archived: nothing changes. Any other thread refuses
   * with "Not available".
   */
  archive(ref: string): Promise<HostGroupChatThread>
  /** Bring an archived thread back into the chat's thread list, into the folder it has in the archive. Same gate as `archive`. */
  unarchive(ref: string): Promise<HostGroupChatThread>
  /**
   * The usage of a thread THIS extension opened (through `startThread`, as its
   * own system identity): its turns' tokens and cost, optionally only turns
   * that ended at or after `since` (ISO). Numbers only — never the transcript.
   * Any other thread, or one in a chat the extension is no longer a member
   * of, refuses with "Not available", whoever the sender is.
   */
  usage(ref: string, options?: { since?: string }): Promise<HostThreadUsage>
  /**
   * Compact the session of a thread THIS extension opened, and resolve once
   * the compaction has ended or the wait for it gave up. The compaction runs
   * after any turn in progress, and on success the thread's standing context
   * is re-delivered, as `group_chat_compact` does. Send the next message after
   * this resolves: one sent before it can be read before the compaction.
   * An archived thread, or one whose agent left the chat, is refused; any
   * other thread refuses with "Not available", as for `usage`.
   */
  compact(ref: string): Promise<HostCompactResult>
}

/** `groupChats` acting as the agent that invoked an App action: the same calls, plus reading. */
export interface HostAgentGroupChatsApi extends HostGroupChatsApi {
  /** The thread's recent turns, newest last; page back with `beforeIndex` from the previous page. */
  turns(ref: string, page?: { turns?: number; beforeIndex?: number }): Promise<HostThreadTurnsPage>
}

/** A chat the signed-in person belongs to, and whether this extension may already deliver into it. */
export interface HostPersonGroupChat extends HostGroupChat {
  /** Whether this extension's own system identity is a member — the grant `grantExtension` makes. */
  extensionGranted: boolean
}

/**
 * `groupChats` for an App action a signed-in person invoked from the App's UI.
 * Sending is unchanged — the inherited calls act as the extension's own system
 * identity, as they do for any call no agent made — and two calls act as the
 * PERSON, so a UI can offer the person's own chats and let them grant this
 * extension into one.
 */
export interface HostPersonGroupChatsApi extends HostGroupChatsApi {
  /** The chats the person is a member of, with their agent members and the extension's grant state. */
  personChats(): Promise<HostPersonGroupChat[]>
  /**
   * Add this extension's own system identity to `chat` (id or slug) as a
   * member, acting as the person through the chat's members gate: refused
   * with "Not available" when the person is not a member of it. It can grant
   * nothing else — no other principal can be named.
   */
  grantExtension(chat: string): Promise<void>
}

/** Group chats as this extension's own system identity — see `HostGroupChatsApi`. */
export declare const groupChats: HostGroupChatsApi

export declare const sendMessage: HostSendMessageApi
