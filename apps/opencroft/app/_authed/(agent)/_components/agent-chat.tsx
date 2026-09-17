'use client'

import { ChainDot, Chained } from 'agent-chat/components/chain'
import type {
  ChatTurnRenderers,
  ChatUserMessagePart,
  DetailItem as KitDetailItem,
} from 'agent-chat/components/chat-turn'
import { ThinkingBlock } from 'agent-chat/components/thinking-block'
import type { AgentChatEdit } from 'agent-chat/session'
import type { AvailableCommand } from 'agent-client/types'
import type { ComponentType } from 'react'

import type { ChatMessage } from '@/app/_authed/(agent)/_lib/messages'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { RenderBoundary } from '@/components/render-boundary'
import { GenericToolView } from '@/components/tool-views/builtin-views'
import { lookupToolView } from '@/components/tool-views/registry'

// The rail and the thinking block the installed conversation renders with.
// They stay the package's copies deliberately: `ui` sits below `agent-chat`, so
// the kit component cannot import them, and both exist in two implementations
// today — supplying them here is what keeps one conversation from mixing the
// two. Module-level so the reference is stable across renders. Passed to the
// package's `AgentChat` as its `renderers` prop by every host in this app.
export const CHAT_RENDERERS: ChatTurnRenderers = { Chained, ChainDot, ThinkingBlock }

// A registered tool view (see components/tool-views) renders in place of the
// generic block, giving e.g. remote_edit/edit_node_property a real diff instead
// of a raw args dump. Falls back to the same chrome without a target line
// otherwise (e.g. an external MCP server's tool, with no node/handle to point
// at). Which views exist is this application's registry, so it is passed to
// the package's `AgentChat` as its `renderTool` prop by every host in this app,
// rather than known by that component.
// Each block renders inside its own boundary. A tool view that throws would
// otherwise unmount the entire route, and because the transcript is replayed
// from stored history that failure is permanent: the same message re-renders
// and re-throws on every visit, leaving the conversation unopenable. Contained
// here, one block shows an error and the rest of the conversation still reads.
export function renderToolCall(item: Extract<KitDetailItem, { kind: 'tool' }>) {
  // Matched on the tool's PROGRAMMATIC name, falling back to the displayed one.
  // The two coincide for an MCP tool, which is why keying on the display name
  // worked at all — but an agent's own tools are announced with a human
  // phrasing that embeds an argument ("Write apps/opencroft/…/foo.tsx"), so no
  // registered id could ever equal one and every built-in silently fell through
  // to the generic dump. The fallback keeps an agent that names no tool working
  // exactly as it did.
  const spec = lookupToolView(item.toolName ?? item.name)
  const args = (item.args ?? {}) as Record<string, unknown>
  const ViewComponent = spec?.body
  // A missing view is expected (an external MCP server's tool has no
  // opencroft-specific view to register) and the generic chrome below covers
  // it correctly — but it's also the easiest thing to forget when wiring up a
  // NEW built-in tool, where a raw args dump instead of the real view is a
  // silent downgrade nobody notices without looking. Dev-only: this fires on
  // every unregistered tool a transcript renders, which is normal traffic for
  // external tools in production and would just be noise there.
  if (!ViewComponent && import.meta.env.DEV) {
    // Names the id that was actually looked up, not the displayed one: the two
    // differ for every agent tool, and reporting the phrasing sent a reader
    // looking for a registry key that was never the one being matched.
    console.warn(
      `[tool-views] No registered view for "${item.toolName ?? item.name}" — rendering the generic args/output dump.`,
    )
  }
  return (
    <RenderBoundary scope='tool-view' label={item.name} resetKey={item.id}>
      {ViewComponent ? (
        <ViewComponent tool={item.name} args={args} requestId={item.id} mode='history' result={item.result} />
      ) : (
        <GenericToolView tool={item.name} args={args} result={item.result} />
      )}
    </RenderBoundary>
  )
}

// This app's own richer session shape — a superset of the package's
// `AgentChatSession` (adds `messages`/`historyHeader`, which the package
// component deliberately does not take; see its own note on why). Consumers
// that only render the transcript pass `blocks` built from `messages`
// themselves (see `renderToolCall`'s siblings and the group-chat thread
// route); consumers that need the raw log directly (the
// voice input controls' `getMessages`) read `messages` off this type.
export interface AgentSession {
  sessionKey: string
  messages: ChatMessage[]
  loading: boolean
  sending: boolean
  waiting: boolean
  botName: string
  send: (text: string) => void
  // Turn control and message editing, provided by the ACP (local) backend; the
  // dashboard placeholder session leaves these unset.
  stop?: () => void
  canFork?: boolean
  // The adapter this session runs, resolved server-side. Only used to classify
  // the session's permission modes for display — a mode id means nothing
  // without knowing who advertised it. Unset for the dashboard placeholder
  // session, which has no agent behind it yet.
  adapterId?: string
  // OPEN a delivered user turn for editing, named by the block id the host
  // gave it (see chat-conversation's `onEditUser`). Stages nothing in the
  // composer: a turn can carry several messages, and the composer takes them
  // one at a time -- see `edit` below and the command bar's own edit
  // machinery.
  editMessage?: (blockId: string) => void
  // FORK a delivered user turn into a NEW conversation (a new group-chat
  // thread), named by the same block id. The conversation up to that message
  // becomes the new session's history, the forked message waits in the new
  // composer as a draft, and nothing is sent. Offered only where the host can
  // name a destination for the fork; the agent's own `canFork` gates it like
  // the edit flow.
  forkMessage?: (blockId: string) => void
  // The turn currently open for editing, if any.
  edit?: AgentChatEdit
  // Leave edit mode, dropping every pending edit in the turn.
  cancelEdit?: () => void
  // Commit the turn: re-send it with these words in place of the messages at
  // these positions. Words only -- authorship and send times are resolved
  // server-side from the stored turn, never stated here.
  commitEdit?: (edits: { index: number; text: string }[]) => void
  // Composer draft staged by the host (a send that failed puts its text back
  // through this); the input syncs to it when it changes.
  draft?: { text: string; key: number }
  // Copy for a send that did not go through, shown by the composer. Set
  // together with the message being put back in the composer, so the reader is
  // told what happened and still has what they typed. Cleared when the next
  // send starts, or by `dismissSendError`.
  sendError?: string
  dismissSendError?: () => void
  // Discards this session (transcript, durable pointer, live process) and
  // opens a fresh one in its place -- same tab, same chat-list entry. Pending
  // permission requests and the queue die with the old session; the composer
  // draft survives (owned separately -- see use-acp-session.ts's clearSession
  // for the full statement). Returns its promise so a caller can await/guard
  // it. Unset for a session that has nothing to clear yet (the dashboard
  // placeholder).
  clearSession?: () => Promise<void>
  // Commands the agent advertised for this session (the latest
  // 'available_commands' snapshot) — the composer offers them as slash
  // autocomplete. Unset for the dashboard placeholder session.
  commands?: AvailableCommand[]
  // When set, the composer's send is disabled (e.g. no agent selected yet).
  disabled?: boolean
  // Whether the server has earlier history than what's currently in `messages`
  // — a cold-opened chat starts from a bounded tail window, not the full
  // transcript, so a long conversation needs
  // "load older" to see anything further back.
  hasMoreHistory?: boolean
  loadingMoreHistory?: boolean
  // Fetches and prepends the next page of older history, resolving once
  // `messages` reflects it (or immediately, as a no-op, while a fetch is
  // already in flight or once hasMoreHistory is false) — callers await it to
  // sequence a DOM-window/scroll-position change with the data actually
  // landing, instead of the two racing.
  loadMoreHistory?: () => Promise<void>
  // The turn the loaded history starts inside, when only part of that turn is
  // loaded — its own `user` event sits above the window. Supplies the leading
  // section's sticky header text, and its `index` names the leading details
  // block so a mid-turn page merging into that block doesn't rename it.
  //
  // The two are separately optional on purpose: a question made entirely of
  // system tags has no words to show as a header, but the turn it names is
  // still the one the leading block belongs to, so the index outlives the text.
  historyHeader?: { index: number; parts: readonly ChatUserMessagePart[] } | null
}

// ── Extension-provided chat-input controls (e.g. voice) ──────────────────────
// Core owns only the injection point and this contract. The actual controls
// (mic capture, TTS playback) live in an extension that declares
// `provides: { 'agent-chat-input-controls': [{ id, component }] }` and resolves
// the agent's ASR/TTS config server-side from `agentNodeId`. Core never
// references any specific extension.
export interface AgentVoiceControlProps {
  /** The active agent's node id; the control resolves its ASR/TTS config from it. */
  agentNodeId: string
  /** Append transcribed text to the composer draft. */
  insertText: (text: string) => void
  /** Send a message as the user. */
  send: (text: string) => void
  /** Read the live message list (e.g. to speak the latest reply). */
  getMessages: () => ChatMessage[]
  /** True while the agent is generating a reply; flips false when the turn completes. */
  streaming: boolean
}

export interface AgentChatInputControl {
  id: string
  component: ComponentType<AgentVoiceControlProps>
}

export function AgentChatInputControls(props: AgentVoiceControlProps) {
  const { items } = useProvided<AgentChatInputControl>('agent-chat-input-controls', loadAllExtensions)
  return (
    <>
      {items.map((control) => (
        <control.component key={control.id} {...props} />
      ))}
    </>
  )
}

// ── Extension-provided chat status indicators (e.g. voice visualizer) ─────────
// Rendered at the foot of the message list, alongside the thinking indicator
// (passed to the package's `AgentChat` as its `footerExtra` prop by every host
// in this app). Each component mounts continuously and decides its own
// visibility (e.g. a TTS playback visualizer that only appears while audio is
// playing). Same pattern as the input controls above — core owns only the
// injection point, no extension is referenced by name.
export interface AgentChatStatusIndicator {
  id: string
  component: ComponentType
}

export function AgentChatStatusIndicators() {
  const { items } = useProvided<AgentChatStatusIndicator>('agent-chat-status-indicators', loadAllExtensions)
  return (
    <>
      {items.map((indicator) => (
        <indicator.component key={indicator.id} />
      ))}
    </>
  )
}
