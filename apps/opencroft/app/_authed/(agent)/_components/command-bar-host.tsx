'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ConfigOptionsBar } from 'agent-chat/config-options-bar'
import type { QueuedPrompt } from 'agent-client/types'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentCommandBar, type CommandBarConfig } from 'ui/agent-chat/agent-command-bar'
import { ContextRing } from 'ui/agent-chat/context-ring'

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
  leadingBarContent?: React.ReactNode
  /** Rendered in the command-bar menu (e.g. a session picker shown on focus). The
   * caller decides when it's non-null. */
  focusMenu?: React.ReactNode
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
  /** Context usage meter (tokens used / window), shown alongside the selectors. */
  usage?: { used: number; size?: number }
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
}

// Debounce composer draft saves so normal typing doesn't POST every keystroke.
// Flushed immediately (bypassing this delay) on send and on session switch.
const DRAFT_SAVE_DEBOUNCE_MS = 600

// The approval button's wording. It lives here rather than in the panel
// because only this side can name the env var and the settings route that
// turn yolo mode on, or promise that clicking does anything. Module-level so
// the reference is stable — it feeds the memoized bar.
const APPROVAL_TITLES = {
  yolo: 'YOLO Mode — all MCP tool approvals skipped (set via OPENCROFT_YOLO_MODE env or /settings?section=audit)',
  on: 'Auto-approve ON — all MCP tool calls approved automatically (click to require approval)',
  off: 'Auto-approve OFF — MCP tool calls require approval (click to auto-approve)',
}

// Everything the command bar needs that the design-kit component deliberately
// does not know: the draft and its persistence, the approval state behind two
// server calls, the extension-provided input controls, and the overlay slot the
// bar is published into. The kit component renders the panel; this decides what
// it is filled with and where it goes.
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
  savedDraft,
  onDraftChange,
  inline = false,
  startIcon = true,
}: AgentCommandBarHostProps) {
  // Lazy init so a session opened with an existing draft paints with it already
  // in place — no separate fetch-then-fill flicker.
  const [text, setText] = useState(() => savedDraft ?? '')
  const [autoApprove, setAutoApproveState] = useState(false)
  const [yoloMode, setYoloMode] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    getAutoApprove().then(setAutoApproveState)
    fetch('/api/yolo')
      .then((r) => r.json())
      .then(({ enabled }) => setYoloMode(enabled))
      .catch(() => {})
  }, [])

  // Editing a user message stages its text as a draft — load it into the
  // composer and focus so it's ready to revise and re-send.
  useEffect(() => {
    if (session.draft) {
      setText(session.draft.text)
      textareaRef.current?.focus()
    }
  }, [session.draft])

  // This component isn't remounted when the user switches sessions (only
  // `session` changes), so the composer's own text has to be swapped manually
  // on a sessionKey change: flush whatever was pending for the OUTGOING session
  // first (so its last few keystrokes aren't lost or, worse, saved under the
  // wrong session), then load the incoming session's saved draft. A layout
  // effect so the swap happens before paint — otherwise the outgoing session's
  // stale text would flash in the composer for a frame.
  const onDraftChangeRef = useRef(onDraftChange)
  onDraftChangeRef.current = onDraftChange
  const draftDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDraftRef = useRef<{ key: string; text: string } | null>(null)
  const sessionKeyRef = useRef(session.sessionKey)

  const flushPendingDraft = useCallback(() => {
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
      draftDebounceRef.current = null
    }
    const pending = pendingDraftRef.current
    if (pending) {
      pendingDraftRef.current = null
      onDraftChangeRef.current?.(pending.key, pending.text)
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies(savedDraft): read only at the moment sessionKey changes, not on every savedDraft echo — including this composer's own debounced save, which would otherwise reset the text under the cursor
  useLayoutEffect(() => {
    if (sessionKeyRef.current === session.sessionKey) {
      return
    }
    flushPendingDraft()
    sessionKeyRef.current = session.sessionKey
    setText(savedDraft ?? '')
  }, [session.sessionKey, flushPendingDraft])

  // Flush on unmount (e.g. navigating away entirely) so the very last
  // keystrokes before the debounce would have fired aren't dropped.
  useEffect(() => () => flushPendingDraft(), [flushPendingDraft])

  const onChangeText = useCallback((value: string) => {
    setText(value)
    const key = sessionKeyRef.current
    pendingDraftRef.current = { key, text: value }
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
    }
    draftDebounceRef.current = setTimeout(() => {
      draftDebounceRef.current = null
      const pending = pendingDraftRef.current
      if (pending) {
        pendingDraftRef.current = null
        onDraftChangeRef.current?.(pending.key, pending.text)
      }
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }, [])

  // Escape abandons what was typed without touching the stored draft — the same
  // as before this panel moved to the kit, where the clear bypassed draft
  // tracking entirely.
  const onEscape = useCallback(() => setText(''), [])

  // Focus callbacks come from the caller as inline arrows, so they are a new
  // function on every one of its renders. Everything handed to the memoized bar
  // below has to be stable or the bar is rebuilt each render, republished into
  // the overlay slot, and that state update renders the caller again — an
  // unbroken loop. Held in refs and called through, so the bar sees one identity
  // for the component's lifetime while the calls still reach the current prop.
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur
  const handleFocus = useCallback(() => onFocusRef.current?.(), [])
  const handleBlur = useCallback(() => onBlurRef.current?.(), [])

  // Extension-provided input controls (e.g. voice) get a stable context: insert
  // transcribed text into the composer, send a message, or read the live reply
  // stream — all via stable refs so the memoized bar below doesn't churn.
  // Routed through onChangeText (not a raw setText) so voice-inserted text is
  // draft-tracked the same as typed text.
  const textRef = useRef(text)
  textRef.current = text
  const insertText = useCallback(
    (piece: string) => {
      const value = piece.trim()
      if (value) {
        const prev = textRef.current
        onChangeText(prev ? `${prev} ${value}` : value)
      }
    },
    [onChangeText],
  )
  const sendRef = useRef(session.send)
  sendRef.current = session.send
  const messagesRef = useRef(session.messages)
  messagesRef.current = session.messages
  const sendMessage = useCallback((value: string) => sendRef.current(value), [])
  const getMessages = useCallback(() => messagesRef.current, [])
  const voiceControls = useMemo(
    () =>
      agentNodeId ? (
        <AgentChatInputControls
          agentNodeId={agentNodeId}
          insertText={insertText}
          send={sendMessage}
          getMessages={getMessages}
          streaming={session.waiting}
        />
      ) : null,
    [agentNodeId, insertText, sendMessage, getMessages, session.waiting],
  )

  // Reads the current value through a ref rather than closing over it, so the
  // callback keeps one identity and does not rebuild the memoized bar every
  // time the approval state flips.
  const autoApproveRef = useRef(autoApprove)
  autoApproveRef.current = autoApprove
  const toggleAutoApprove = useCallback(async () => {
    const next = await setAutoApprove({ data: !autoApproveRef.current })
    setAutoApproveState(next)
  }, [])

  const inputPlaceholder = placeholder ?? `Message ${shortKey(session.sessionKey)}…`

  // The kit component clears the value before handing the text over, so all
  // that is left here is delivering it and settling the stored draft: cancel
  // the pending save so a stray timer can't resave the now-stale text over the
  // clear.
  // Sends through `sendRef` so this keeps one identity for the component's
  // lifetime. `session.send` is a `useCallback` today and would be a safe
  // dependency, but every producer of a session would have to keep it that way
  // for this memo to stay stable — and the cost of one of them not doing so is
  // a render loop, not a wasted render.
  const onSend = useCallback((value: string) => {
    sendRef.current(value)
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
      draftDebounceRef.current = null
    }
    pendingDraftRef.current = null
    onDraftChangeRef.current?.(sessionKeyRef.current, '')
  }, [])

  // Queued text arrives transformed for the agent (system/context tags applied
  // at send time); the panel shows the user's own words, same as delivered user
  // bubbles. The transform is this app's, so undoing it is too.
  // `userText` returns null for a prompt that is nothing but tags. Rendering it
  // straight into JSX used to make that an empty line rather than a missing
  // row, and the row still says "Queued" and still offers removal — so the
  // empty string keeps that, rather than dropping a message the user can see
  // is being held.
  const queuedItems = useMemo(() => queued?.map((m) => ({ id: m.id, text: userText(m.text) ?? '' })), [queued])

  // String choices (model / effort / mode) collapse into the command bar's
  // settings dropdown via configs. The context-usage ring and any boolean
  // toggles ride along in the action row via configExtra.
  const onSetConfigOptionRef = useRef(onSetConfigOption)
  onSetConfigOptionRef.current = onSetConfigOption
  const handleConfigChange = useCallback((id: string, value: string) => {
    onSetConfigOptionRef.current?.(id, value)
  }, [])

  const configs = useMemo<CommandBarConfig[]>(
    () =>
      (configOptions ?? [])
        .filter((option) => option.type !== 'boolean')
        .map((option) => ({
          id: option.id,
          label: option.name,
          value: String(option.currentValue ?? ''),
          options: flattenOptions(option.options),
        })),
    [configOptions],
  )

  const configExtra = useMemo(() => {
    const booleanOptions = (configOptions ?? []).filter((option) => option.type === 'boolean')
    if (!usage && booleanOptions.length === 0) {
      return null
    }
    return (
      <>
        {usage ? <ContextRing used={usage.used} size={usage.size ?? 0} /> : null}
        {booleanOptions.length > 0 ? (
          <ConfigOptionsBar
            options={booleanOptions}
            onSetOption={(id, value) => onSetConfigOptionRef.current?.(id, value)}
          />
        ) : null}
      </>
    )
  }, [configOptions, usage])

  // Memoized for element identity, not for render cost: recreating this node
  // would give the textarea a new identity, React would remount it, and focus
  // would be lost mid-typing whenever anything above changed — which includes
  // messages queueing and draining. The kit component keeps its own structure
  // stable for the same reason; this is the other half of that guarantee, and
  // it has to stay.
  //
  // Every entry below must be real state or a stable identity. A raw callback
  // prop does not qualify: callers pass inline arrows, so the memo would miss
  // on every render, republish the bar into the overlay slot, and that state
  // update would render the caller again — "Maximum update depth exceeded".
  // Wrap such a prop in a ref (see `handleFocus`) instead of adding it here.
  // This list being deliberately narrower than what the body reads is the
  // point; do not "complete" it.
  const barNode = useMemo(
    () => (
      <AgentCommandBar
        value={text}
        onValueChange={onChangeText}
        onSend={onSend}
        onEscape={onEscape}
        placeholder={inputPlaceholder}
        autoFocus={autoFocus}
        onFocus={handleFocus}
        onBlur={handleBlur}
        busy={session.waiting}
        onStop={session.stop}
        sending={session.sending}
        disabled={session.disabled}
        leading={leadingBarContent}
        onStartIconClick={onStartIconClick}
        startIcon={startIcon}
        controls={voiceControls}
        configs={configs}
        onConfigChange={handleConfigChange}
        configExtra={configExtra}
        queued={queuedItems}
        onRemoveQueued={onRemoveQueued}
        autoApprove={autoApprove}
        onToggleAutoApprove={toggleAutoApprove}
        yoloMode={yoloMode}
        approvalTitles={APPROVAL_TITLES}
        textareaRef={textareaRef}
      />
    ),
    [
      text,
      onChangeText,
      onSend,
      onEscape,
      inputPlaceholder,
      autoFocus,
      handleFocus,
      handleBlur,
      session.waiting,
      session.stop,
      session.sending,
      session.disabled,
      leadingBarContent,
      onStartIconClick,
      startIcon,
      voiceControls,
      configs,
      configExtra,
      queuedItems,
      onRemoveQueued,
      autoApprove,
      toggleAutoApprove,
      yoloMode,
      handleConfigChange,
    ],
  )

  useOptionalOverlay({ menu: focusMenu ?? null, bar: barNode })

  return inline ? barNode : null
}

// A config option's values can be a flat list or grouped under labeled
// sections — flatten to the { value, label } pairs the command bar's settings
// dropdown takes.
function flattenOptions(options: unknown): Array<{ value: string; label: string }> {
  const flat: Array<{ value: string; label: string }> = []
  if (!Array.isArray(options)) {
    return flat
  }
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      for (const option of entry.options as Array<{ name?: string; value?: string }>) {
        if (typeof option.value === 'string') {
          flat.push({ value: option.value, label: option.name ?? option.value })
        }
      }
    } else if (typeof entry.value === 'string' && typeof entry.name === 'string') {
      flat.push({ value: entry.value, label: entry.name })
    }
  }
  return flat
}

// A session key is long and mostly noise; the tail identifies it well enough
// for a placeholder.
function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}
