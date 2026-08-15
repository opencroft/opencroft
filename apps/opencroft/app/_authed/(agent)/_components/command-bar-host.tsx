'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { type AgentCommandBarControlsContext, useAgentCommandBar } from 'agent-chat/agent-command-bar'
import type { CompactRenderState } from 'agent-chat/use-compact-control'
import type { QueuedPrompt } from 'agent-client/types'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AgentChatInputControls, type AgentSession } from '@/app/_authed/(agent)/_components/agent-chat'
import { userText } from '@/app/_authed/(agent)/_lib/build-blocks'
import { getAutoApprove, setAutoApprove } from '@/app/_authed/(approvals)/_server/actions'
import { useOptionalOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'

interface AgentCommandBarHostProps {
  session: AgentSession
  /** Active agent's node id. When set, extension-provided input controls (e.g.
   *  voice) declared for the `agent-chat-input-controls` point are rendered. */
  agentNodeId?: string
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  /** Extra content rendered at the start of the command bar (left of sparkles icon). */
  leadingBarContent?: ReactNode
  /** Rendered in the command-bar menu (e.g. a session picker shown on focus). The
   * caller decides when it's non-null. */
  focusMenu?: ReactNode
  /** When set, the Sparkles start icon becomes a button that runs this (e.g. open
   * the session picker). Must be stable — it feeds the memoized command bar. */
  onStartIconClick?: () => void
  /** Messages held in the session's server-side queue while a turn runs. */
  queued?: QueuedPrompt[]
  /** Drop a still-queued message before delivery. Must be stable — it feeds the
   * memoized command bar. */
  onRemoveQueued?: (id: string) => void
  /** The session's agent-advertised config options (model/effort/mode/…). */
  configOptions?: SessionConfigOption[]
  /** Change one of the session's config options. Must be stable — it feeds the
   * memoized command bar. */
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  /** Context usage meter (tokens used / window), shown alongside the
   *  selectors. `asOf`, when present, marks a last-known reading from before
   *  the session went offline rather than a live one — forwarded through to
   *  the ring unchanged. */
  usage?: { used: number; size?: number; asOf?: number }
  /** Compact lifecycle for the ring's popover -- the trigger plus what to show
   *  while/after it runs. Omit to render the ring with no Compact button at
   *  all (ContextRing offers one only when it's given a handler). */
  compact?: CompactRenderState
  /** Discards the session and starts a fresh one, offered from the ring's
   *  popover. Omit to render the ring with no Clear button. */
  onClear?: () => void
  /** This session's persisted composer draft, loaded once when the session
   * (identified by `session.sessionKey`) opens. Distinct from `session.draft`
   * (edit-message staging). */
  savedDraft?: string
  /** Save (or clear, with '') the given session's draft. Debounced here; called
   * with the session key so a flush during a session switch always targets the
   * session the text actually belongs to. */
  onDraftChange?: (key: string, text: string) => void
  /** Render the bar inline (return it) instead of publishing to the canvas
   *  overlay. For a standalone route with no OverlayProvider (a group-chat
   *  thread). Default false (publish to overlay). */
  inline?: boolean
  /** Show the sparkles start icon. Default true; false hides it where the agent
   *  is fixed (a group-chat thread) and there is no session picker. */
  startIcon?: boolean
  /** Copy for a send that did not go through, and how to dismiss it. Both come
   *  from the session (see AgentSession.sendError) — this host only forwards
   *  them to the kit's error slot. */
  sendError?: string
  onDismissSendError?: () => void
}

// The approval button's wording. It lives here rather than in the package
// because only this side can name the env var and the settings route that
// turn yolo mode on, or promise that clicking does anything — the package's
// useAgentCommandBar never sees "yolo" in its own API (a generic-agent-chat
// concept, autoApprove/autoApproveLocked, not opencroft vocabulary). Module-
// level so the reference is stable — it feeds the memoized bar.
const APPROVAL_TITLES = {
  yolo: 'YOLO Mode — all MCP tool approvals skipped (set via OPENCROFT_YOLO_MODE env or /settings?section=audit)',
  on: 'Auto-approve ON — all MCP tool calls approved automatically (click to require approval)',
  off: 'Auto-approve OFF — MCP tool calls require approval (click to auto-approve)',
}

// This app's binding of the package's useAgentCommandBar: everything the kit
// panel needs that neither the design-kit component nor the package hook can
// know — the approval state behind two server calls, the extension-provided
// input controls, and the overlay slot the bar is published into. The SAME
// wrapper serves both mounts (the canvas overlay's ChatHost and the group-
// chat thread route) — there is one composition path, not two, which is what
// keeps a feature added here from needing to be re-added on the other
// surface. `inline` is the only thing that differs between them.
export function AgentCommandBarHost({
  session,
  agentNodeId,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  leadingBarContent,
  focusMenu,
  onStartIconClick,
  queued,
  onRemoveQueued,
  configOptions,
  onSetConfigOption,
  usage,
  compact,
  onClear,
  savedDraft,
  onDraftChange,
  inline = false,
  startIcon = true,
  sendError,
  onDismissSendError,
}: AgentCommandBarHostProps) {
  const [autoApprove, setAutoApproveState] = useState(false)
  const [yoloMode, setYoloMode] = useState(false)

  useEffect(() => {
    getAutoApprove().then(setAutoApproveState)
    fetch('/api/yolo')
      .then((r) => r.json())
      .then(({ enabled }) => setYoloMode(enabled))
      .catch(() => {})
  }, [])

  // YOLO pins every session to its bypass permission mode and refuses changes
  // server-side, so the mode control has to say so rather than look live and
  // silently do nothing. The wording is this app's: agent-chat only carries the
  // reason through to a tooltip, it has no idea what YOLO is.
  const lockedConfigOptions = useMemo(
    () => (yoloMode ? { mode: 'YOLO mode is on — every session is pinned to Bypass Permissions.' } : undefined),
    [yoloMode],
  )

  const autoApproveRef = useRef(autoApprove)
  autoApproveRef.current = autoApprove
  const toggleAutoApprove = useCallback(async () => {
    const next = await setAutoApprove({ data: !autoApproveRef.current })
    setAutoApproveState(next)
  }, [])

  // Queued text arrives transformed for the agent (system/context tags applied
  // at send time); the panel shows the user's own words, same as delivered user
  // bubbles. The transform is this app's, so undoing it is too — the package
  // hook takes queued items pre-formatted, the same way AgentChat takes
  // pre-built blocks rather than raw messages.
  // `userText` returns null for a prompt that is nothing but tags. Rendering it
  // straight into JSX used to make that an empty line rather than a missing
  // row, and the row still says "Queued" and still offers removal — so the
  // empty string keeps that, rather than dropping a message the user can see
  // is being held.
  const queuedItems = useMemo(() => queued?.map((m) => ({ id: m.id, text: userText(m.text) ?? '' })), [queued])

  // Extension-provided input controls (e.g. voice) get a stable context from
  // the package hook (insertText/sendMessage/streaming); this app supplies
  // `getMessages` by closing over the full session, which the package's
  // narrower AgentCommandBarSession deliberately does not carry.
  const messagesRef = useRef(session.messages)
  messagesRef.current = session.messages
  const getMessages = useCallback(() => messagesRef.current, [])
  const controls = useCallback(
    (ctx: AgentCommandBarControlsContext) =>
      agentNodeId ? (
        <AgentChatInputControls
          agentNodeId={agentNodeId}
          insertText={ctx.insertText}
          send={ctx.sendMessage}
          getMessages={getMessages}
          streaming={ctx.streaming}
        />
      ) : null,
    [agentNodeId, getMessages],
  )

  const barNode = useAgentCommandBar({
    session,
    placeholder,
    autoFocus,
    onFocus,
    onBlur,
    leadingBarContent,
    onStartIconClick,
    startIcon,
    queued: queuedItems,
    onRemoveQueued,
    configOptions,
    onSetConfigOption,
    usage,
    compact,
    onClear,
    savedDraft,
    onDraftChange,
    sendError,
    onDismissSendError,
    controls,
    autoApprove,
    onToggleAutoApprove: toggleAutoApprove,
    autoApproveLocked: yoloMode,
    // Auto-approve is a single process-wide flag (see approval-store), so a
    // control sitting in one session's composer misrepresented its reach:
    // flipping it there silently changed approvals for every chat, group and
    // space. Hidden until it has a home that matches its actual scope —
    // not yet built. The per-session permission mode and the YOLO indicator now
    // occupy this row, and both are honest about what they govern.
    approval: false,
    adapterId: session.adapterId,
    lockedConfigOptions: lockedConfigOptions,
    approvalTitles: APPROVAL_TITLES,
  })

  useOptionalOverlay({ menu: focusMenu ?? null, bar: barNode })

  return inline ? barNode : null
}
