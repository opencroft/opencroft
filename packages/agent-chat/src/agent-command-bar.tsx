'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { canonicalEffortId } from 'agent-client/session-effort'
import { canonicalModeId } from 'agent-client/session-modes'
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
  EFFORT_CONFIG_ID,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_OFF,
  FAST_MODE_ON,
  flattenOptions,
  MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  selectLeftoverBooleanOptions,
  selectLeftoverConfigs,
} from './agent-command-bar-configs'
import { AgentCommandBar, type ApprovalTitles, type CommandBarConfig } from './components/ui/composer/agent-command-bar'
import { ChatEditBar } from './components/chat-edit-bar'
import { ContextRing } from './components/context-ring'
import { EffortSelector } from './components/effort-selector'
import { FastModeToggle } from './components/fast-mode-toggle'
import { ModeSelector } from './components/mode-selector'
import { ModelSelector } from './components/model-selector'
import { PresenceSelector, type PresenceValue } from './components/presence-selector'
import { ConfigOptionsBar } from './config-options-bar'
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
  'sessionKey' | 'draft' | 'send' | 'waiting' | 'stop' | 'sending' | 'disabled' | 'edit' | 'cancelEdit' | 'commitEdit'
>

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
  configOptions?: SessionConfigOption[]
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  /** `asOf` (ms since epoch), when present, marks this as a last-known
   *  reading from before the session went offline rather than a live one —
   *  forwarded to the ring, which renders it dimmed with the time in its
   *  popover. Absent on every live reading. */
  usage?: { used: number; size?: number; asOf?: number }
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
  /** Host slot: the composer's attachments row — what goes out WITH the next
   *  message, forwarded to the kit component's slot of the same name. Nothing
   *  in this package knows what an attachment is; the row places whatever it
   *  is given, and is not rendered at all when given nothing.
   *
   *  Which makes one thing the host's to get right: pass nothing when nothing
   *  is attached, and an element that renders null does not count as nothing.
   *  See the kit component's own comment on the slot — neither it nor this
   *  hook can tell the two apart, and the difference is a strip of empty row
   *  under every composer. Must be identity-stable when nothing meaningful
   *  changed; it feeds the memoized bar. */
  attachments?: ReactNode
  /** Discards the session and starts a fresh one, offered from the ring's
   *  popover. Omit to render the ring with no Clear button. */
  onClear?: () => void
  /** How often the session reads what is waiting for it, and how to change it.
   *
   *  Built in rather than left to a host slot: the queue and its hand-over are
   *  the engine's, so the control over WHEN it is handed over belongs with the
   *  panel that any host embedding the engine already gets. A host with no
   *  queue of its own omits this and no control is offered.
   *
   *  One object rather than a value and a callback, so half of it cannot be
   *  passed — a cadence with no way to change it is a control that lies. Must
   *  be identity-stable when nothing meaningful changed; it feeds the memoized
   *  bar. */
  presence?: { value: PresenceValue; onSelect: (presence: PresenceValue) => void }
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
  attachments,
  presence,
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
    if (editRef.current) {
      // An edit is not the session's resting draft. What is typed here belongs
      // to a message being revised, and persisting it would overwrite whatever
      // the reader had left unsent in this composer -- which they never chose
      // to give up, and would have no way to get back.
      return
    }
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

  // Escape abandons what was typed without touching the stored draft. Mid-edit
  // it abandons the whole edit instead -- the same thing the bar's own X does,
  // because "get me out of this" should not depend on where the pointer is.
  const onEscape = useCallback(() => {
    if (editRef.current) {
      cancelEditRef.current?.()
      return
    }
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
  // Read through a structural type rather than narrowing the union: `find` does
  // not narrow by its predicate, and flattenOptions already takes unknown and
  // returns [] for anything that is not a value list.
  // The kit selectors take our own values and nothing else, so wire ids are
  // resolved here and mapped back on select. That keeps the synonym registry --
  // which is logic, not presentation -- on this side of the boundary.
  const dial = useMemo(() => {
    const pick = (id: string) =>
      (configOptions ?? []).find((option) => option.id === id) as
        | { currentValue?: unknown; options?: unknown }
        | undefined
    const modeOption = pick(MODE_CONFIG_ID)
    const effortOption = pick(EFFORT_CONFIG_ID)
    const modelOption = pick(MODEL_CONFIG_ID)
    const fastOption = pick(FAST_MODE_CONFIG_ID) as
      | { currentValue?: unknown; options?: unknown; type?: unknown; description?: unknown }
      | undefined
    const fastBoolean = fastOption?.type === 'boolean'
    const modeWire = flattenOptions(modeOption?.options)
    const effortWire = flattenOptions(effortOption?.options)
    // A wire value nothing recognises passes through as itself: the kit renders
    // it with its own label and no grade colour, which is the honest answer.
    const modeOf = (value: string) => (adapterId ? canonicalModeId(adapterId, value) : undefined) ?? value
    const effortOf = (value: string) => (adapterId ? canonicalEffortId(adapterId, value) : undefined) ?? value
    const modeBack = new Map(modeWire.map((entry) => [modeOf(entry.value), entry.value]))
    const effortBack = new Map(effortWire.map((entry) => [effortOf(entry.value), entry.value]))
    const effortValues = effortWire.map((entry) => effortOf(entry.value))
    // `default` is offered even by an agent that advertises no such value: it
    // means "leave the baseline alone", and an agent without a name for that
    // still has one. It sends the agent's own `high` -- the strongest value
    // that is a grade rather than a limit -- so the choice reaches the wire as
    // something the agent actually accepts.
    if (effortValues.length > 0 && !effortValues.includes('default')) {
      const baseline = effortBack.get('high')
      if (baseline !== undefined) {
        effortBack.set('default', baseline)
        effortValues.push('default')
      }
    }
    return {
      modeOption,
      effortOption,
      modeValues: modeWire.map((entry) => modeOf(entry.value)),
      effortValues,
      modeCurrent: modeOf(String(modeOption?.currentValue ?? '')),
      effortCurrent: effortOf(String(effortOption?.currentValue ?? '')),
      modeBack,
      effortBack,
      // No canonical id/label table for models -- the wire's own {value, label}
      // pairs are shown as-is, unlike mode/effort's synonym-normalized values.
      modelOptions: flattenOptions(modelOption?.options),
      modelCurrent: String(modelOption?.currentValue ?? ''),
      fastOffered: fastOption !== undefined,
      fastBoolean,
      fastEnabled: fastBoolean
        ? Boolean(fastOption?.currentValue)
        : String(fastOption?.currentValue ?? '') === FAST_MODE_ON,
      fastDescription: typeof fastOption?.description === 'string' ? fastOption.description : undefined,
    }
  }, [configOptions, adapterId])

  const hostControls = useMemo(
    () => controls?.({ insertText, sendMessage, streaming: session.waiting }),
    [controls, insertText, sendMessage, session.waiting],
  )

  // The bar's pre-settings control group, right after the approval shield.
  // Model leads: it is the least often changed of the three but the one whose
  // current value most changes what the others even mean. Effort before mode:
  // effort is the lighter, more often nudged dial, and mode stays nearest the
  // settings button. `hostControls` (voice dictation and the like) is NOT
  // included here -- the kit renders it in its own `trailingControls` slot,
  // after the settings button, so a host's input controls never sit ahead of
  // the settings they control.
  const controlsNode = useMemo(
    () => (
      <>
        {dial.modelOptions.length > 0 ? (
          <ModelSelector
            options={dial.modelOptions}
            current={dial.modelCurrent}
            onSelect={(value) => onSetConfigOptionRef.current?.(MODEL_CONFIG_ID, value)}
            lockedReason={lockedConfigOptions?.[MODEL_CONFIG_ID]}
          />
        ) : null}
        {dial.effortValues.length > 0 ? (
          <EffortSelector
            options={dial.effortValues}
            current={dial.effortCurrent}
            onSelect={(value) => onSetConfigOptionRef.current?.(EFFORT_CONFIG_ID, dial.effortBack.get(value) ?? value)}
            lockedReason={lockedConfigOptions?.[EFFORT_CONFIG_ID]}
          />
        ) : null}
        {dial.fastOffered ? (
          <FastModeToggle
            enabled={dial.fastEnabled}
            description={dial.fastDescription}
            onToggle={(next) =>
              onSetConfigOptionRef.current?.(
                FAST_MODE_CONFIG_ID,
                dial.fastBoolean ? next : next ? FAST_MODE_ON : FAST_MODE_OFF,
              )
            }
            lockedReason={lockedConfigOptions?.[FAST_MODE_CONFIG_ID]}
          />
        ) : null}
        {/* Presence, immediately LEFT of the permission-mode dial: the two are
            the session-level pair -- when the agent will get round to reading,
            beside what it may do once it does. Beside the mode dial rather
            than at the head of the cluster: a host that hides the approval
            toggle (auto-approve being process-wide rather than per-session,
            say) shows the mode dial as THE permission control, and a presence
            out at the head reads as left of everything. */}
        {presence ? <PresenceSelector presence={presence.value} onSelect={presence.onSelect} /> : null}
        {dial.modeValues.length > 0 ? (
          <ModeSelector
            options={dial.modeValues}
            current={dial.modeCurrent}
            onSelect={(value) => onSetConfigOptionRef.current?.(MODE_CONFIG_ID, dial.modeBack.get(value) ?? value)}
            lockedReason={lockedConfigOptions?.[MODE_CONFIG_ID]}
          />
        ) : null}
      </>
    ),
    [dial, lockedConfigOptions, presence],
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
  // ---- editing a delivered turn ----
  //
  // The per-message drafts live HERE, in the composer, and not in the session.
  // This is where the typed text already is: keystrokes land in `textRef`, and
  // paging between a turn's messages is exactly "put this one away, bring that
  // one out". A session that owned the drafts would have to be told every
  // keystroke to keep them, which is the churn this hook is built to avoid.
  const edit = session.edit
  const editRef = useRef(edit)
  editRef.current = edit
  const cancelEditRef = useRef(session.cancelEdit)
  cancelEditRef.current = session.cancelEdit
  const commitEditRef = useRef(session.commitEdit)
  commitEditRef.current = session.commitEdit
  // Which message of the turn is open, as a position in `edit.parts`. Mirrored
  // into a ref because paging has to read it while it is also setting it, and
  // a state updater is not a place to do the rest of that work from.
  const [editPosition, setEditPosition] = useState(0)
  const editPositionRef = useRef(0)
  const editDraftsRef = useRef(new Map<number, string>())
  const wasEditingRef = useRef(false)
  // What the composer held before the edit opened. Leaving the mode puts it
  // back: the reader's unsent text was never theirs to give up, and emptying
  // the composer on cancel destroyed exactly the draft `onChangeText` refuses
  // to overwrite while an edit is open.
  const preEditTextRef = useRef('')

  const loadEditPart = useCallback((text: string) => {
    textRef.current = text
    setValue(text)
    textareaRef.current?.focus()
  }, [])

  // Opening a turn seeds the drafts from what its messages actually said and
  // opens the first of them. Leaving one restores the composer to whatever was
  // in it beforehand -- what was there during the edit was a message being
  // revised, and it is not the reader's resting draft to inherit.
  //
  // Keyed on WHICH turn is open rather than on the object, so a session that
  // rebuilds `edit` each render does not reseed the drafts under the cursor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above
  useLayoutEffect(() => {
    if (!edit) {
      editDraftsRef.current = new Map()
      if (wasEditingRef.current) {
        wasEditingRef.current = false
        textRef.current = preEditTextRef.current
        setValue(preEditTextRef.current)
      }
      return
    }
    if (!wasEditingRef.current) {
      preEditTextRef.current = textRef.current
    }
    wasEditingRef.current = true
    editDraftsRef.current = new Map(edit.parts.map((part) => [part.index, part.text]))
    editPositionRef.current = 0
    setEditPosition(0)
    loadEditPart(edit.parts[0]?.text ?? '')
  }, [edit?.eventIndex, loadEditPart])

  // Paging away is not discarding: what was typed into a message is held until
  // the whole turn is committed or abandoned. That is the entire reason these
  // drafts exist rather than the composer simply reloading each message.
  const goToEditPart = useCallback(
    (position: number) => {
      const current = editRef.current
      const target = current?.parts[position]
      if (!current || !target) {
        return
      }
      const leaving = current.parts[editPositionRef.current]
      if (leaving) {
        editDraftsRef.current.set(leaving.index, textRef.current)
      }
      editPositionRef.current = position
      setEditPosition(position)
      loadEditPart(editDraftsRef.current.get(target.index) ?? target.text)
    },
    [loadEditPart],
  )

  // Only the open message goes back, and only to what it originally said. The
  // others are not on screen, and reverting work the reader cannot see would be
  // the one undo they could not undo.
  const resetEditPart = useCallback(() => {
    const part = editRef.current?.parts[editPositionRef.current]
    if (!part) {
      return
    }
    editDraftsRef.current.set(part.index, part.text)
    loadEditPart(part.text)
  }, [loadEditPart])

  // Commit every message at once, which is what the turn IS -- it was delivered
  // as one thing and it is re-sent as one thing. `open` is the text the
  // composer is handing over for the message currently in it; the rest come
  // from the drafts paging put there.
  //
  // Unchanged messages are left out entirely rather than sent back as
  // themselves: what did not change is not an edit, and the host re-sends the
  // stored message for every position it is not given.
  const commitOpenEdit = useCallback((open: string) => {
    const current = editRef.current
    if (!current) {
      return
    }
    const drafts = editDraftsRef.current
    const openPart = current.parts[editPositionRef.current]
    if (openPart) {
      drafts.set(openPart.index, open)
    }
    commitEditRef.current?.(
      current.parts
        .filter((part) => (drafts.get(part.index) ?? part.text) !== part.text)
        .map((part) => ({ index: part.index, text: drafts.get(part.index) ?? part.text })),
    )
  }, [])

  // Clamped rather than trusted: `parts` comes from the session and the
  // position is this hook's, so a turn that changed under an open editor must
  // not index past the end of it.
  const editPart = edit ? edit.parts[Math.min(editPosition, edit.parts.length - 1)] : undefined
  const editBarNode = useMemo(
    () =>
      edit && editPart ? (
        <ChatEditBar
          original={editPart.text}
          index={Math.min(editPosition, edit.parts.length - 1)}
          count={edit.parts.length}
          onPrev={() => goToEditPart(editPosition - 1)}
          onNext={() => goToEditPart(editPosition + 1)}
          onReset={resetEditPart}
          onCancel={() => cancelEditRef.current?.()}
        />
      ) : null,
    [edit, editPart, editPosition, goToEditPart, resetEditPart],
  )

  const onSend = useCallback(
    (text: string) => {
      // Sending IS committing while a turn is open: the check button and this
      // path are the same control, so Enter commits exactly as the button does.
      //
      // Nothing is cleared here on that path. A commit can be refused or fail,
      // and the mode stays open until the host says it succeeded -- so the
      // composer keeps the words, and leaving edit mode is what empties it (see
      // the effect above). The stored draft is not touched either: it is the
      // reader's unsent text, which an edit never became.
      if (editRef.current) {
        commitOpenEdit(text)
        return
      }
      sendRef.current(text)
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current)
        draftDebounceRef.current = null
      }
      pendingDraftRef.current = null
      onDraftChangeRef.current?.(sessionKeyRef.current, '')
      textRef.current = ''
      setValue('')
    },
    [commitOpenEdit],
  )

  const onSetConfigOptionRef = useRef(onSetConfigOption)
  onSetConfigOptionRef.current = onSetConfigOption
  const handleConfigChange = useCallback((id: string, value: string) => {
    onSetConfigOptionRef.current?.(id, value)
  }, [])

  const configs = useMemo<CommandBarConfig[]>(() => selectLeftoverConfigs(configOptions), [configOptions])

  const configExtra = useMemo(() => {
    const booleanOptions = selectLeftoverBooleanOptions(configOptions)
    if (!usage && booleanOptions.length === 0) {
      return null
    }
    return (
      <>
        {usage ? (
          <ContextRing
            usedTokens={usage.used}
            contextLimit={usage.size ?? 0}
            asOf={usage.asOf}
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
  }, [configOptions, usage, compact, onClear])

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
        trailingControls={hostControls}
        sendError={sendError}
        onDismissSendError={onDismissSendError}
        editBar={editBarNode}
        attachments={attachments}
        submitMode={edit ? 'commit' : 'send'}
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
      hostControls,
      sendError,
      onDismissSendError,
      editBarNode,
      attachments,
      edit,
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

// A session key is long and mostly noise; the tail identifies it well enough
// for a placeholder.
function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}
