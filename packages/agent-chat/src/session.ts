import type { TurnEdit } from 'agent-client/queue-tags'
import type { AvailableCommand, ElicitationContentValue, ElicitationSchema, PermissionOpt } from 'agent-client/types'

import type { EditablePart } from './user-parts'

/**
 * A delivered turn, open for editing.
 *
 * `eventIndex` identifies the turn the way the host's own transcript does — an
 * absolute position in the session's event log, not a count of user turns. A
 * chat opens on a bounded tail of its history, so "the third user turn" means
 * different turns to a client and to a server that holds all of it; an edit
 * keyed that way rewrites whichever message the two happened to disagree on.
 *
 * `parts` are the messages a reader can actually change, each carrying the
 * position it holds in the DELIVERED turn — which is not always its position
 * in this array. A message made entirely of application context renders no
 * words and is not a stop in the editor; the ones after it keep the delivery's
 * own numbering, so a commit still lands on the message it was aimed at. The
 * interrupt note is not in here either, for the same reason: it is nobody's
 * message, and it is preserved by the host that puts the turn back together.
 */
export interface AgentChatEdit {
  eventIndex: number
  parts: readonly EditablePart[]
}

export interface PendingPermission {
  requestId: string
  title: string
  options: PermissionOpt[]
}

export interface PendingAsk {
  requestId: string
  message: string
  // ACP form elicitation: the JSON schema the answer must match. Rendered as
  // a form (see components/ask-user.tsx); the answer goes back through `resolveAsk` as a
  // content object keyed by the schema's properties. Absent = free-text ask.
  form?: ElicitationSchema
  // ACP url elicitation: the link the reader is asked to visit. Usually
  // resolved by the agent's own completion notification; the UI offers Done
  // (accept) and Dismiss (cancel) regardless.
  url?: string
}

// THE named session-shape contract for packages/agent-chat's composed
// surface — every field a host's live session controller may be asked for by
// any component in this package, documented once, here, rather than redrawn
// per component with its own copy of the same semantics. A component that
// only needs part of this Picks its own narrower prop type from it (see
// e.g. approvals.tsx's ApprovalsSession, agent-chat.tsx's
// AgentChatProps['session']) — narrower is the honest signature for what
// that component actually reads, but the FIELD SEMANTICS live in exactly one
// place, so two components can never quietly drift into describing the same
// field differently.
//
// A host's own session type is checked against this (and against any Pick of
// it a component asks for) with a `satisfies` pin at the binding site, where
// the host constructs or returns its concrete session object — see this
// app's own pin, kept beside wherever that type is defined, so a field
// renamed or dropped on either side fails to typecheck immediately rather
// than surfacing as a runtime prop-shape mismatch three call sites away.
export interface AgentChatSession {
  // Identifies the session for keying (React keys, host-side lookups) and
  // composer placeholder copy.
  sessionKey: string
  // True until the initial history/config load resolves.
  loading: boolean
  // True while a message is in flight to the host but not yet acknowledged
  // (distinct from `waiting`, which covers the whole turn).
  sending: boolean
  // True while a turn is running — drives the composer's busy/stop affordance.
  waiting: boolean
  // True while the agent's OWN step is executing right now — the thinking
  // indicator's flag, deliberately narrower than `waiting`: a turn held open
  // only for delegated work (a live subagent, a background task) is still
  // `waiting` (Stop applies) but not `thinking` (nothing is being generated).
  // Optional: a host that does not track delegation leaves it unset and the
  // indicator falls back to `waiting`, exactly the pre-split behaviour.
  thinking?: boolean
  // Display name shown as the conversation's speaker when the host does not
  // override it with its own `agentName` prop.
  botName: string
  // `attachments` are the stored ids of pictures going with the message, as the
  // host's own `uploadPicture` answered them (see the composer hook).
  send: (text: string, options?: { attachments?: readonly string[] }) => void
  // Cancels the in-flight turn. Absent on a session with no live process to
  // cancel (e.g. a placeholder session with nothing selected yet).
  // Stop absorbs the interrupt: with unread messages held, stopping cancels
  // the turn AND delivers them, because a stop may mean the reader wants to
  // redirect the agent rather than abandon the work. That decision is the
  // server's, not this contract's — see the stop server function.
  stop?: () => void
  // Whether `editMessage` is meaningful for this session — a session that
  // cannot fork/rewind leaves both this and `editMessage` unset rather than
  // supplying a no-op.
  canFork?: boolean
  // The adapter this session runs (see agent-client's harness adapters). Only
  // needed to classify the session's permission modes for display: a mode id
  // means nothing without knowing who advertised it, since agents spell the
  // same mode differently. Unset leaves modes classified by their id alone,
  // which is correct but less legible.
  adapterId?: string
  // OPEN a delivered user turn for editing, named by the block id the host
  // gave it (see chat-conversation's `onEditUser`).
  //
  // The host resolves the id against its own transcript: it has the turn's
  // text as delivered, which is what an edit has to work from, and it knows
  // where the turn sits in the whole conversation rather than in the window
  // currently loaded.
  //
  // It stages nothing in the composer. A turn can carry several messages, and
  // putting the whole delivery in front of the reader means putting the tags
  // that separate them there too — markup nobody typed. This starts the mode
  // instead: `edit` below says what is open, and the composer holds one
  // message of it at a time.
  editMessage?: (blockId: string) => void
  // FORK a delivered user turn into a NEW conversation, named by the same
  // block id `editMessage` takes. The conversation up to that message becomes
  // the new session's history, the forked message waits in the new
  // conversation's composer as a draft, and nothing has been sent. The host
  // decides what "a new conversation" is (a group-chat thread, a tab) and
  // whether the destination exists at all — unset means the menu offers no
  // fork. The agent's own `canFork` gates it like the edit flow.
  forkMessage?: (blockId: string) => void
  // The turn currently open for editing, if any.
  edit?: AgentChatEdit
  // Leave edit mode, dropping every pending edit in the turn.
  cancelEdit?: () => void
  // Commit the turn: re-send it with these words in place of the messages at
  // these positions, everything else unchanged. Only the messages the reader
  // actually changed need be listed, and each carries the position it
  // replaces — the array's own order says nothing. `attachments`, present only
  // when the reader changed a message's pictures, is that message's COMPLETE
  // list of stored picture ids. A message left with blank words and no pictures
  // is REMOVED from the re-sent turn, tag and all, rather than sent empty.
  //
  // Words and picture ids only, never authorship: who sent each message and
  // when is the transcript's, and a host resolves it from the stored turn
  // rather than accepting it from whatever asked for the edit.
  commitEdit?: (edits: TurnEdit<string>[]) => void
  // Composer draft staged by `editMessage`; the composer's own text syncs to
  // it when it changes. Distinct from a host's own persisted composer draft
  // (loaded once when the session opens) — this one stages an in-progress
  // edit, not the session's resting unsent text.
  draft?: { text: string; key: number }
  // Copy for a send that did not go through, shown by the composer. Set
  // together with the message being put back in the composer, so the reader
  // is told what happened and still has what they typed. Cleared when the
  // next send starts, or by `dismissSendError`.
  sendError?: string
  dismissSendError?: () => void
  // When set, the composer's send is disabled (e.g. no agent selected yet).
  disabled?: boolean
  // Whether the host has earlier history than what it has currently loaded
  // — a cold-opened chat starts from a bounded tail window, not the full
  // transcript, so a long conversation needs "load older" to see further
  // back.
  hasMoreHistory?: boolean
  loadingMoreHistory?: boolean
  // Fetches and prepends the next page of older history, resolving once the
  // host's own transcript state reflects it (or immediately, as a no-op,
  // while a fetch is already in flight or once `hasMoreHistory` is false).
  loadMoreHistory?: () => Promise<void>
  // Commands the agent advertised for this session (ACP
  // available_commands_update, folded by the host from 'available_commands'
  // events). The composer offers them as slash autocomplete; a chosen command
  // is still sent through `send` as ordinary text starting with `/`. Absent or
  // empty means the agent advertised none — the composer then has nothing to
  // offer, and a typed `/...` still sends as-is.
  commands?: AvailableCommand[]
  // Every unresolved permission request for this session — see approvals.tsx.
  permissions: PendingPermission[]
  // Every unresolved free-text elicitation ("ask") for this session.
  asks: PendingAsk[]
  // Answers a pending permission request. Omitting `optionId` (or passing an
  // empty string) is not "no-op" — it rejects the request: the engine answers
  // with the request's own one-time reject option, and as *cancelled* only
  // when the request offers none (agent-client's pickRejectOption). That is
  // how a plain rejection is expressed, and what `respondPermissionText`
  // issues before sending its guidance.
  resolvePermission: (requestId: string, optionId?: string) => void
  // Deny the pending permission and tell the agent what to do differently,
  // in the same turn — not every host offers this (a session with no way to
  // steer a denial leaves it unset).
  respondPermissionText: (requestId: string, text: string) => void
  // Answers a pending ask. A string answers the free-text prompt; an object
  // answers a form ask with content keyed by its schema's properties (an
  // empty object is accept-with-nothing, the URL ask's "Done"). Omitting
  // `answer` (or passing an empty string) declines it: the elicitation
  // resolves as cancelled, so the agent receives no content at all rather
  // than an empty answer.
  resolveAsk: (requestId: string, answer?: string | Record<string, ElicitationContentValue>) => void
  // Discards this session and opens a fresh one under the same tab/entry.
  // Pending permission requests and the queue die with the old session; the
  // composer draft survives (it's owned separately, not part of session
  // identity). Returns its promise so a caller can await/guard it — e.g. to
  // disable the trigger for the duration, or to sequence a UI transition with
  // the new session actually being ready rather than racing it.
  clearSession?: () => Promise<void>
}
