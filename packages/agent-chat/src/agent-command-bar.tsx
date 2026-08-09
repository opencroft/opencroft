'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AgentCommandBar,
  type ApprovalTitles,
  type CommandBarConfig,
  type CommandBarConfigOption,
} from 'ui/agent-chat/agent-command-bar'
import { ContextRing } from 'ui/agent-chat/context-ring'

import { ConfigOptionsBar } from './config-options-bar'
import { EffortSelector } from './effort-selector'
import { ModeSelector } from './mode-selector'

// The config-option id agents use for the permission mode. ACP delivers modes
// twice -- as session modes AND as this option, built from the same list -- and
// this surface drives the option, so the id is the handle for both pulling it
// out of the generic row and locking it.
const MODE_CONFIG_ID = 'mode'
// Likewise for reasoning effort: rendered as its own icon button rather than a
// labelled dropdown. Unlike `mode`, the values behind this vary per model — the
// agent decides what it advertises, and it may advertise none.
const EFFORT_CONFIG_ID = 'effort'

import type { AgentChatSession } from './session'
import type { CompactRenderState } from './use-compact-control'

export type { ApprovalTitles }

// The minimal Pick of the named session-shape contract (session.ts) this hook
// actually reads — not the host's full session controller. `sessionKey` is
// what the reset contract below keys on; the rest is what the kit panel needs
// forwarded. A host's own richer session type structurally satisfies this
// without a wrapper.
export type AgentCommandBarSession = Pick<
  AgentChatSession,
  'sessionKey' | 'draft' | 'send' | 'waiting' | 'stop' | 'sending' | 'disabled'
>

export interface AgentCommandBarQueuedItem {
  id: string
  text: string
}

// What a `controls` render prop is handed — the primitives it needs to wire
// an input method (voice dictation, anything else) into the composer without
// this hook knowing that input method exists. `insertText` and `sendMessage`
// are stable across renders (safe to depend on in the host's own memoization);
// `streaming` is the session's live busy state, for a control that wants to
// react to it (e.g. pause listening while the agent is talking back).
export interface AgentCommandBarControlsContext {
  insertText: (text: string) => void
  sendMessage: (text: string) => void
  streaming: boolean
}

export interface UseAgentCommandBarOptions {
  session: AgentCommandBarSession
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  /** Extra content rendered at the start of the command bar (left of sparkles icon). */
  leadingBarContent?: ReactNode
  onStartIconClick?: () => void
  /** Show the sparkles start icon at all. Default true. */
  startIcon?: boolean
  /** Messages held in the host's server-side queue while a turn runs, already
   *  formatted to display text — a host with its own outgoing-text transform
   *  (e.g. stripping tags it added before sending) undoes it before calling
   *  this hook, the same way AgentChat takes pre-built `blocks` rather than
   *  raw messages. */
  queued?: AgentCommandBarQueuedItem[]
  onRemoveQueued?: (id: string) => void
  configOptions?: SessionConfigOption[]
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  usage?: { used: number; size?: number }
  /** This session's persisted composer draft, loaded once when the session
   *  (identified by `session.sessionKey`) opens. Distinct from
   *  `session.draft` (edit-message staging, see the contract's own note). */
  savedDraft?: string
  /** Save (or clear, with '') the given session's draft. Debounced here;
   *  called with the session key so a flush during a session switch always
   *  targets the session the text actually belonged to. */
  onDraftChange?: (key: string, text: string) => void
  sendError?: string
  onDismissSendError?: () => void
  /** Render prop for a host-specific input method (e.g. voice dictation) —
   *  mirrors AgentChat's `renderTool`. Absent renders nothing in that slot. */
  controls?: (ctx: AgentCommandBarControlsContext) => ReactNode
  /** Auto-approve state and its toggle — a generic agent-chat concept (some
   *  MCP tool calls are approved automatically), not host vocabulary. */
  autoApprove: boolean
  onToggleAutoApprove?: () => void
  /** True when the host's own configuration forces auto-approve on and the
   *  toggle cannot be used — the panel goes inert and says so via
   *  `approvalTitles`. What that configuration IS (an env var, a settings
   *  route, anything else host-specific) is copy the host supplies through
   *  `approvalTitles`, never named here. */
  autoApproveLocked?: boolean
  /** Show the approval toggle at all. Default true. A host whose approval state
   *  is not per-session — so a per-session control would misrepresent its
   *  reach — passes false and surfaces it wherever its real scope lives. */
  approval?: boolean
  /** Adapter the session runs, so its modes can be classified for icons. */
  adapterId?: string
  /** Config-option ids the host has pinned, mapped to the reason why. */
  lockedConfigOptions?: Record<string, string>
  /** Copy for the approval toggle in each state — see the kit's own
   *  ApprovalTitles. The host names its own setting/route in here; this hook
   *  and the kit component both stay silent on what auto-approve even means
   *  to configure. */
  approvalTitles: ApprovalTitles
  /** Compact lifecycle for the ring's popover — the trigger plus what to show
   *  while/after it runs. Omit to render the ring with no Compact button at
   *  all (ContextRing offers one only when it's given a handler). The host
   *  builds this from its own useCompactControl (this package), which needs
   *  host-specific fetch/request callbacks this hook has no business knowing
   *  — same reason `controls` is a render prop instead of built in here. */
  compact?: CompactRenderState
  /** Discards the session and starts a fresh one, offered from the ring's
   *  popover. Omit to render the ring with no Clear button. */
  onClear?: () => void
}

// Everything the command bar needs that the design-kit component deliberately
// does not know: the draft and its persistence, the approval state, a
// host-specific input-controls slot. Returns the built element as a VALUE —
// not rendered here — because the caller may need to publish it into a slot
// elsewhere in the tree (a canvas overlay) rather than mount it in place;
// see this app's own AgentCommandBarHost wrapper for both cases. The
// returned element is used exactly like state published into a store: it
// MUST be identity-stable when nothing meaningful changed, or a host
// publishing it into a slot (a `useState`/context write on every call)
// re-renders everything downstream of that slot on every keystroke — hence
// the memoization below, and hence the buffered-value design in the kit
// component this composes (see AgentCommandBar's own doc comment).
export function useAgentCommandBar({
  session,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  leadingBarContent,
  onStartIconClick,
  startIcon = true,
  queued,
  onRemoveQueued,
  configOptions,
  onSetConfigOption,
  usage,
  savedDraft,
  onDraftChange,
  sendError,
  onDismissSendError,
  controls,
  autoApprove,
  onToggleAutoApprove,
  autoApproveLocked = false,
  approval = true,
  adapterId,
  lockedConfigOptions,
  approvalTitles,
  compact,
  onClear,
}: UseAgentCommandBarOptions): ReactElement {
  // Lazy init so a session opened with an existing draft paints with it
  // already in place — no separate fetch-then-fill flicker. This state
  // changes ONLY at genuine reset points (here, a session switch below, and
  // insertText) — never on an ordinary keystroke, which is what keeps the
  // returned element's identity stable; see the kit component's own buffer
  // for why an ordinary keystroke doesn't need this to change at all.
  const [value, setValue] = useState(() => savedDraft ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The live typed text, tracked without triggering a re-render — every
  // keystroke updates this, but only a genuine reset (see above) touches
  // `value` state. `insertText` below reads this to know what it's appending
  // to; the debounce machinery reads it to know what to eventually save.
  const textRef = useRef(value)

  // Reset contract (requirement: explicit, not implicit) for every piece of
  // hook-internal state keyed on which session is open: on a `sessionKey`
  // change, flush whatever draft-save was pending for the OUTGOING session
  // first (so its last few keystrokes aren't lost or, worse, saved under the
  // wrong session), then load the incoming session's saved draft into both
  // `value` (so the kit panel's buffer resyncs to it) and `textRef` (so
  // `insertText`/the debounce machinery agree with what's now displayed). A
  // layout effect so the swap happens before paint — otherwise the outgoing
  // session's stale text would flash in the composer for a frame.
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
    const next = savedDraft ?? ''
    textRef.current = next
    setValue(next)
  }, [session.sessionKey, flushPendingDraft])

  // Flush on unmount (e.g. navigating away entirely) so the very last
  // keystrokes before the debounce would have fired aren't dropped.
  useEffect(() => () => flushPendingDraft(), [flushPendingDraft])

  // Editing a user message stages its text as a draft — load it into the
  // composer and focus so it's ready to revise and re-send. Also a genuine
  // reset: `session.draft` is host-driven, same standing as a session switch.
  // Keyed on `key` specifically, not the object identity, so a caller that
  // rebuilds `draft` every render (a plain object literal) doesn't re-trigger
  // this on every unrelated re-render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above
  useLayoutEffect(() => {
    if (session.draft) {
      textRef.current = session.draft.text
      setValue(session.draft.text)
      textareaRef.current?.focus()
    }
  }, [session.draft?.key])

  const onChangeText = useCallback((next: string) => {
    textRef.current = next
    const key = sessionKeyRef.current
    pendingDraftRef.current = { key, text: next }
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

  // Escape abandons what was typed without touching the stored draft.
  const onEscape = useCallback(() => {
    textRef.current = ''
    setValue('')
  }, [])

  // Focus callbacks come from the caller as inline arrows, so they are a new
  // function on every one of its renders. Held in refs and called through, so
  // the bar sees one identity for the component's lifetime while the calls
  // still reach the current prop.
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const onBlurRef = useRef(onBlur)
  onBlurRef.current = onBlur
  const handleFocus = useCallback(() => onFocusRef.current?.(), [])
  const handleBlur = useCallback(() => onBlurRef.current?.(), [])

  // Extension-provided input controls (e.g. voice): insert transcribed text
  // into the composer, or send a message directly, or read whether a turn is
  // running. Routed through the same onChangeText path as typing, so
  // voice-inserted text is draft-tracked the same as typed text — but it IS
  // a genuine external reset (see `value`'s own note above), so it updates
  // `value` too, not just `textRef`.
  const sendRef = useRef(session.send)
  sendRef.current = session.send
  const insertText = useCallback(
    (piece: string) => {
      const trimmed = piece.trim()
      if (!trimmed) {
        return
      }
      const prev = textRef.current
      const next = prev ? `${prev} ${trimmed}` : trimmed
      textRef.current = next
      setValue(next)
      onChangeText(next)
    },
    [onChangeText],
  )
  const sendMessage = useCallback((text: string) => sendRef.current(text), [])
  const controlsNode = useMemo(
    () => controls?.({ insertText, sendMessage, streaming: session.waiting }),
    [controls, insertText, sendMessage, session.waiting],
  )

  const autoApproveRef = useRef(onToggleAutoApprove)
  autoApproveRef.current = onToggleAutoApprove
  const handleToggleAutoApprove = useCallback(() => autoApproveRef.current?.(), [])

  const inputPlaceholder = placeholder ?? `Message ${shortKey(session.sessionKey)}…`

  // The kit component clears its own buffer before handing the text over (see
  // its clear-on-send contract); this settles the stored draft on top —
  // cancel the pending save so a stray timer can't resave the now-stale text
  // over the clear, then also collapse `value`/`textRef` to '' so a LATER
  // session switch whose draft happens to match the pre-send text still
  // resyncs the kit's buffer correctly (an unchanged `value` prop would
  // otherwise read as "nothing to sync" even though the session did change).
  const onSend = useCallback((text: string) => {
    sendRef.current(text)
    if (draftDebounceRef.current) {
      clearTimeout(draftDebounceRef.current)
      draftDebounceRef.current = null
    }
    pendingDraftRef.current = null
    onDraftChangeRef.current?.(sessionKeyRef.current, '')
    textRef.current = ''
    setValue('')
  }, [])

  // Queued items arrive pre-formatted (see this hook's own prop doc) — no
  // transform needed here, only the shape change to what the kit expects.
  const queuedItems = useMemo(() => queued?.map((m) => ({ id: m.id, text: m.text })), [queued])

  const onSetConfigOptionRef = useRef(onSetConfigOption)
  onSetConfigOptionRef.current = onSetConfigOption
  const handleConfigChange = useCallback((id: string, value: string) => {
    onSetConfigOptionRef.current?.(id, value)
  }, [])

  const configs = useMemo<CommandBarConfig[]>(
    () =>
      (configOptions ?? [])
        // Two filters rather than one condition: TypeScript infers a type
        // predicate from the bare `type !== 'boolean'` test and narrows the
        // array to the select variants, which the `.options` read below needs.
        // Folding a second condition into it silently loses that inference.
        .filter((option) => option.type !== 'boolean')
        // `mode` and `effort` are deliberately absent: each is rendered as its
        // own icon button above, not as one more labelled dropdown.
        .filter((option) => option.id !== MODE_CONFIG_ID && option.id !== EFFORT_CONFIG_ID)
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
    // Read through a structural type rather than narrowing the union: `find`
    // does not narrow by its predicate, and flattenOptions already takes unknown
    // and returns [] for anything that is not a value list.
    const modeOption = (configOptions ?? []).find((option) => option.id === MODE_CONFIG_ID) as
      | { currentValue?: unknown; options?: unknown }
      | undefined
    const modeOptions = flattenOptions(modeOption?.options)
    const effortOption = (configOptions ?? []).find((option) => option.id === EFFORT_CONFIG_ID) as
      | { currentValue?: unknown; options?: unknown }
      | undefined
    const effortOptions = flattenOptions(effortOption?.options)
    if (!usage && booleanOptions.length === 0 && modeOptions.length === 0 && effortOptions.length === 0) {
      return null
    }
    return (
      <>
        {modeOptions.length > 0 ? (
          <ModeSelector
            options={modeOptions}
            current={String(modeOption?.currentValue ?? '')}
            onSelect={(value) => onSetConfigOptionRef.current?.(MODE_CONFIG_ID, value)}
            adapterId={adapterId}
            lockedReason={lockedConfigOptions?.[MODE_CONFIG_ID]}
          />
        ) : null}
        {effortOptions.length > 0 ? (
          <EffortSelector
            options={effortOptions}
            current={String(effortOption?.currentValue ?? '')}
            onSelect={(value) => onSetConfigOptionRef.current?.(EFFORT_CONFIG_ID, value)}
            adapterId={adapterId}
            lockedReason={lockedConfigOptions?.[EFFORT_CONFIG_ID]}
          />
        ) : null}
        {usage ? (
          <ContextRing
            usedTokens={usage.used}
            contextLimit={usage.size ?? 0}
            onCompact={compact?.onCompact}
            compacting={compact?.compacting}
            statusMessage={compact?.statusMessage}
            statusTone={compact?.statusTone}
            onClear={onClear}
          />
        ) : null}
        {booleanOptions.length > 0 ? (
          <ConfigOptionsBar
            options={booleanOptions}
            onSetOption={(id, value) => onSetConfigOptionRef.current?.(id, value)}
          />
        ) : null}
      </>
    )
  }, [configOptions, usage, compact, onClear, adapterId, lockedConfigOptions])

  // Memoized for element identity, not for render cost -- see this hook's own
  // doc comment on why identity stability is the whole point. Every entry
  // below must be real state or a stable identity; a raw callback prop does
  // not qualify (wrap it in a ref instead, see `handleFocus` above). `value`
  // is in this list deliberately -- it only changes at genuine reset points
  // (session switch, edit-message staging, insertText, send), never on an
  // ordinary keystroke, so including it does not reintroduce the
  // per-keystroke churn this hook exists to avoid.
  const barNode = useMemo(
    () => (
      <AgentCommandBar
        value={value}
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
        controls={controlsNode}
        configs={configs}
        onConfigChange={handleConfigChange}
        configExtra={configExtra}
        queued={queuedItems}
        onRemoveQueued={onRemoveQueued}
        sendError={sendError}
        onDismissSendError={onDismissSendError}
        approval={approval}
        autoApprove={autoApprove}
        onToggleAutoApprove={handleToggleAutoApprove}
        yoloMode={autoApproveLocked}
        approvalTitles={approvalTitles}
        textareaRef={textareaRef}
      />
    ),
    [
      value,
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
      controlsNode,
      configs,
      handleConfigChange,
      configExtra,
      queuedItems,
      onRemoveQueued,
      sendError,
      onDismissSendError,
      approval,
      autoApprove,
      handleToggleAutoApprove,
      autoApproveLocked,
      approvalTitles,
    ],
  )

  return barNode
}

// Debounce composer draft saves so normal typing doesn't POST every keystroke.
// Flushed immediately (bypassing this delay) on send and on session switch.
const DRAFT_SAVE_DEBOUNCE_MS = 600

// A config option's values can be a flat list or grouped under labeled
// sections — flatten to the { value, label } pairs the command bar's settings
// dropdown takes.
function flattenOptions(options: unknown): CommandBarConfigOption[] {
  const flat: CommandBarConfigOption[] = []
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
