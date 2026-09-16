'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { type AgentCommandBarControlsContext, useAgentCommandBar } from 'agent-chat/agent-command-bar'
import type { CompactRenderState } from 'agent-chat/use-compact-control'
import type { Presence } from 'agent-client/types'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AgentChatInputControls, type AgentSession } from '@/app/_authed/(agent)/_components/agent-chat'
import { getAutoApprove, setAutoApprove } from '@/app/_authed/(approvals)/_server/actions'

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
  /** The session's agent-advertised config options (model/effort/mode/…). */
  configOptions?: SessionConfigOption[]
  /** Change one of the session's config options. Must be stable — it feeds the
   * memoized command bar. */
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  /** Context usage meter (tokens used / window), shown alongside the
   *  selectors. `asOf`, when present, marks a last-known reading from before
   *  the session went offline rather than a live one — forwarded through to
   *  the ring unchanged. */
  usage?: {
    used: number
    size?: number
    cost?: { amount: number; currency: string }
    rateLimits?: { status: string; window: string; utilization?: number; resetsAt?: number }[]
    asOf?: number
  }
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
  /** Show the sparkles start icon. Default true; false hides it where the agent
   *  is fixed (a group-chat thread) and there is no session picker. */
  startIcon?: boolean
  /** Copy for a send that did not go through, and how to dismiss it. Both come
   *  from the session (see AgentSession.sendError) — this host only forwards
   *  them to the kit's error slot. */
  sendError?: string
  onDismissSendError?: () => void
  /** Rendered in the composer's attachments row, directly above the composer —
   *  forwarded to the package hook's slot of the same name. Left out when there
   *  is nothing attached, and that is the caller's call to make: an element
   *  that renders null still counts as content here and the row would draw for
   *  it. Must be identity-stable when nothing changed; it feeds the memoized
   *  bar. */
  attachments?: ReactNode
  /** Rendered in the action row below the composer, at the start of the readout
   *  cluster and before the context ring — forwarded to the package hook's slot
   *  of the same name. This is where a control that governs the attachments row
   *  goes; the same null-is-not-nothing rule applies, and it must be
   *  identity-stable when nothing changed. */
  attachmentControls?: ReactNode
  /** How often the session reads what is waiting for it, and how to change it —
   *  both from the session controller, forwarded straight to the package hook's
   *  slot of the same name. Must be identity-stable when nothing changed; it
   *  feeds the memoized bar. */
  presence?: { value: Presence; onSelect: (presence: Presence) => void }
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

// This app's binding of the package's useAgentCommandBar: what neither the
// design-kit component nor the package hook can know — the approval state
// behind two server calls, and the extension-provided input controls. It
// returns the bar for its caller to place; there is one composition path, so a
// feature added here reaches every surface that mounts it.
export function AgentCommandBarHost({
  session,
  agentNodeId,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  leadingBarContent,
  configOptions,
  onSetConfigOption,
  usage,
  compact,
  onClear,
  savedDraft,
  onDraftChange,
  startIcon = true,
  sendError,
  onDismissSendError,
  attachments,
  attachmentControls,
  presence,
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
    startIcon,
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
    attachments,
    attachmentControls,
    presence,
  })

  return barNode
}
