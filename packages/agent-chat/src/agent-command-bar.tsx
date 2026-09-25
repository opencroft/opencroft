'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { canonicalEffortId } from 'agent-client/session-effort'
import { canonicalModeOf } from 'agent-client/session-modes'
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
  modeEntries,
  selectLeftoverBooleanOptions,
  selectLeftoverConfigs,
  selectOwnButtonOptions,
} from './agent-command-bar-configs'
import { AgentCommandBar, type ApprovalTitles, type CommandBarConfig } from './components/agent-command-bar'
import { AttachButton } from './components/attach-button'
import { AttachmentChip } from './components/attachment-chip'
import { ChatEditBar } from './components/chat-edit-bar'
import { ContextRing } from './components/context-ring'
import { EffortSelector } from './components/effort-selector'
import { FastModeToggle } from './components/fast-mode-toggle'
import { ModeSelector } from './components/mode-selector'
import { ModelSelector } from './components/model-selector'
import { PresenceSelector, type PresenceValue } from './components/presence-selector'
import type { UsageTokens } from './components/usage-cost'
import { ConfigOptionsBar } from './config-options-bar'
import {
  changedEdits,
  EDIT_SLOT_PREFIX,
  type EditDrafts,
  editSlot,
  hasContent,
  originalDrafts,
  originalPictures,
  othersHaveContent,
} from './edit-drafts'
import type { AgentChatSession } from './session'
import type { CompactRenderState } from './use-compact-control'
import { COMPOSE_SLOT, storedIds, type UploadPicture, useComposerPictures } from './use-composer-pictures'

export type { ApprovalTitles, UsageTokens }

// The minimal Pick of the named session-shape contract (session.ts) this hook
// actually reads — not the host's full session controller. `sessionKey` is
// what the reset contract below keys on; the rest is what the kit panel needs
// forwarded. A host's own richer session type structurally satisfies this
// without a wrapper.
export type AgentCommandBarSession = Pick<
  AgentChatSession,
  | 'sessionKey'
  | 'draft'
  | 'send'
  | 'waiting'
  | 'stop'
  | 'sending'
  | 'disabled'
  | 'edit'
  | 'cancelEdit'
  | 'commitEdit'
  | 'commands'
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

// The context/cost reading the bar hands to its ring. Declared once and
// exported because the shape crosses two more layers on its way here — a host's
// command-bar wrapper and whatever produces the reading — and all three have to
// agree; a field added for the ring is then added in one place.
export interface CommandBarUsage {
  used: number
  size?: number
  /** Session cost and rate-limit windows, when the harness reports them at all. */
  cost?: { amount: number; currency: string }
  /** The session's token account so far (summed from the turns the host
   *  recorded) — forwarded to the ring as `sessionTokens`. Absent counters
   *  draw as dashes there, never zeros. */
  tokens?: UsageTokens
  rateLimits?: { status: string; window: string; utilization?: number; resetsAt?: number }[]
  /** Wall-clock time (ms since epoch) this figure was last known — set only on
   *  a last-known reading from before the session went offline, never on one a
   *  live session reported. Forwarded to the ring unchanged. */
  asOf?: number
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
  usage?: CommandBarUsage
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
  /** Host slot: a control that governs the attachments row above — placed at
   *  the LEADING EDGE of the action row's readout cluster, immediately before
   *  the context ring.
   *
   *  A slot of its own rather than a corner of `controls`, because the two
   *  clusters mean different things: `controls` acts on the message being
   *  typed (dictation and the like), while this acts on what is riding along
   *  with it. Its position is beside the readouts for the same reason — what a
   *  message is carrying is a fact about the message, not another way to write
   *  one.
   *
   *  Nothing in this package knows what an attachment is or what governing one
   *  means; the slot places whatever it is given. Given nothing, no element is
   *  rendered — same contract as `attachments`, and the same obligation on the
   *  host: an element that renders null is not nothing. Must be
   *  identity-stable when nothing meaningful changed; it feeds the memoized
   *  bar. */
  attachmentControls?: ReactNode
  /** Files the reader brought in through the composer itself — pasted over the
   *  input, or dropped on the bar. Forwarded to the kit bar's slot of the same
   *  name, which recognises the gesture; what a file BECOMES stays here, in the
   *  same boundary `attachments` draws one row up. */
  onFiles?: (files: File[]) => void
  /** Pictures on messages: offered when given. The composer then owns them --
   *  the chips above it, the attach button, paste and drop, and which message
   *  of an edited turn each belongs to -- and sends their stored ids with the
   *  message (`session.send`'s `attachments`) or the commit.
   *
   *  `upload` is the host's half: store the file, answer with its id and
   *  stored size. `unavailableReason`, when set, keeps the attach button on
   *  screen but disabled, saying why -- an agent that cannot take pictures is
   *  offered none, in a new message or in an edit. Takes over from `onFiles`
   *  while pictures can be attached. */
  pictures?: { upload: UploadPicture; unavailableReason?: string }
  /** What pressing send on an EMPTY composer means, when it means anything.
   *  Present offers the press and is its tooltip; absent leaves send inert
   *  without words, as it has always been. A picture attached and nothing typed
   *  is the case this exists for. Forwarded unchanged to the kit bar. */
  emptySendLabel?: string
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
  presence?: { value: PresenceValue; onSelect: (presence: PresenceValue) => void; steering?: boolean }
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
  attachmentControls,
  onFiles,
  pictures,
  emptySendLabel,
  presence,
}: UseAgentCommandBarOptions): ReactElement {
  // Lazy init so a session opened with an existing draft paints with it
  // already in place — no separate fetch-then-fill flicker. This state
  // changes ONLY at genuine reset points (here, a session switch below, and
  // insertText) — never on an ordinary keystroke, which is what keeps the
  // returned element's identity stable; see the kit component's own buffer
  // for why an ordinary keystroke doesn't need this to change at all.
  const [value, setValueText] = useState(() => savedDraft ?? '')
  // Every call below is a LOAD — the composer being set from outside, never an
  // echo of a keystroke (that is `onChangeText`, which touches only the ref).
  // So every one of them counts, and a load that sets the text it already
  // holds counts as much as any other: "put this message back the way it was"
  // is exactly that case, and without a revision the composer cannot see it
  // happen. See the kit component's `valueRevision`.
  const [valueRevision, setValueRevision] = useState(0)
  const setValue = useCallback((next: string) => {
    setValueText(next)
    setValueRevision((revision) => revision + 1)
  }, [])
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
  }, [session.sessionKey, flushPendingDraft, setValue])

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
  }, [setValue])

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
    [onChangeText, setValue],
  )
  const sendMessage = useCallback((text: string) => sendRef.current(text), [])
  // Read through a structural type rather than narrowing the union: `find` does
  // not narrow by its predicate, and flattenOptions already takes unknown and
  // returns [] for anything that is not a value list.
  // The kit selectors take our own values and nothing else, so wire ids are
  // resolved here and mapped back on select. That keeps the synonym registry --
  // which is logic, not presentation -- on this side of the boundary.
  //
  // Each control is found by the option's meaning, not by one agent's id for
  // it (see selectOwnButtonOptions), so what is sent back is the id THIS
  // agent used, and a host lock names the control by its conventional id.
  const dial = useMemo(() => {
    const own = selectOwnButtonOptions(configOptions)
    const modeOption = own.mode as { id: string; currentValue?: unknown; options?: unknown } | undefined
    const effortOption = own.effort as { id: string; currentValue?: unknown; options?: unknown } | undefined
    const modelOption = own.model as { id: string; currentValue?: unknown; options?: unknown } | undefined
    const fastOption = own.fast as
      | { id: string; currentValue?: unknown; options?: unknown; type?: unknown; description?: unknown }
      | undefined
    const fastBoolean = fastOption?.type === 'boolean'
    const modeWire = modeEntries(modeOption?.options)
    const effortWire = flattenOptions(effortOption?.options)
    // Read with each value's `_meta`, where an agent may state what the mode
    // does -- see canonicalModeOf.
    const modeMeta = new Map(modeWire.map((entry) => [entry.id, entry._meta]))
    // A wire value nothing recognises passes through as itself: the kit renders
    // it with its own label and no grade colour, which is the honest answer.
    const modeOf = (value: string) =>
      (adapterId ? canonicalModeOf(adapterId, { id: value, _meta: modeMeta.get(value) }) : undefined) ?? value
    const effortOf = (value: string) => (adapterId ? canonicalEffortId(adapterId, value) : undefined) ?? value
    const modeBack = new Map(modeWire.map((entry) => [modeOf(entry.id), entry.id]))
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
      modeId: modeOption?.id ?? MODE_CONFIG_ID,
      effortId: effortOption?.id ?? EFFORT_CONFIG_ID,
      modelId: modelOption?.id ?? MODEL_CONFIG_ID,
      fastId: fastOption?.id ?? FAST_MODE_CONFIG_ID,
      modeValues: modeWire.map((entry) => modeOf(entry.id)),
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

  // A host pins a control by its conventional id, not knowing what a given
  // agent calls the option; the agent's own id is honoured too.
  const lockedReason = useCallback(
    (optionId: string, conventionalId: string) =>
      lockedConfigOptions?.[optionId] ?? lockedConfigOptions?.[conventionalId],
    [lockedConfigOptions],
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
            onSelect={(value) => onSetConfigOptionRef.current?.(dial.modelId, value)}
            lockedReason={lockedReason(dial.modelId, MODEL_CONFIG_ID)}
          />
        ) : null}
        {dial.effortValues.length > 0 ? (
          <EffortSelector
            options={dial.effortValues}
            current={dial.effortCurrent}
            onSelect={(value) => onSetConfigOptionRef.current?.(dial.effortId, dial.effortBack.get(value) ?? value)}
            lockedReason={lockedReason(dial.effortId, EFFORT_CONFIG_ID)}
          />
        ) : null}
        {dial.fastOffered ? (
          <FastModeToggle
            enabled={dial.fastEnabled}
            description={dial.fastDescription}
            onToggle={(next) =>
              onSetConfigOptionRef.current?.(dial.fastId, dial.fastBoolean ? next : next ? FAST_MODE_ON : FAST_MODE_OFF)
            }
            lockedReason={lockedReason(dial.fastId, FAST_MODE_CONFIG_ID)}
          />
        ) : null}
        {/* Presence, immediately LEFT of the permission-mode dial: the two are
            the session-level pair -- when the agent will get round to reading,
            beside what it may do once it does. Beside the mode dial rather
            than at the head of the cluster: a host that hides the approval
            toggle (auto-approve being process-wide rather than per-session,
            say) shows the mode dial as THE permission control, and a presence
            out at the head reads as left of everything. */}
        {presence ? (
          <PresenceSelector presence={presence.value} onSelect={presence.onSelect} steering={presence.steering} />
        ) : null}
        {dial.modeValues.length > 0 ? (
          <ModeSelector
            options={dial.modeValues}
            current={dial.modeCurrent}
            onSelect={(value) => onSetConfigOptionRef.current?.(dial.modeId, dial.modeBack.get(value) ?? value)}
            lockedReason={lockedReason(dial.modeId, MODE_CONFIG_ID)}
          />
        ) : null}
      </>
    ),
    [dial, lockedReason, presence],
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
  const editDraftsRef = useRef<EditDrafts>(new Map())
  const wasEditingRef = useRef(false)
  // What the composer held before the edit opened. Leaving the mode puts it
  // back: the reader's unsent text was never theirs to give up, and emptying
  // the composer on cancel destroyed exactly the draft `onChangeText` refuses
  // to overwrite while an edit is open.
  const preEditTextRef = useRef('')
  // The pictures, one slot for the message being written and one per message
  // of an open edit (see edit-drafts' `editSlot`). Held beside the text drafts
  // so paging, reset, leaving and committing treat a message's pictures and its
  // words as one thing.
  const composerPictures = useComposerPictures(pictures && !pictures.unavailableReason ? pictures.upload : undefined)
  const { seed: seedPictures, settled: settledPictures } = composerPictures

  const loadEditPart = useCallback(
    (text: string) => {
      textRef.current = text
      setValue(text)
      textareaRef.current?.focus()
    },
    [setValue],
  )

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
        seedPictures(EDIT_SLOT_PREFIX, {})
        textRef.current = preEditTextRef.current
        setValue(preEditTextRef.current)
      }
      return
    }
    if (!wasEditingRef.current) {
      preEditTextRef.current = textRef.current
    }
    wasEditingRef.current = true
    editDraftsRef.current = originalDrafts(edit.parts)
    seedPictures(EDIT_SLOT_PREFIX, originalPictures(edit.parts))
    editPositionRef.current = 0
    setEditPosition(0)
    loadEditPart(edit.parts[0]?.text ?? '')
  }, [edit?.eventIndex, loadEditPart, seedPictures])

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

  // Every message of the turn goes back to what it originally said and carried,
  // not only the open one: reset is "start this edit over", and the turn is the
  // thing being edited. The editor stays open, on the message it was on.
  const resetEdits = useCallback(() => {
    const current = editRef.current
    const open = current?.parts[editPositionRef.current]
    if (!current || !open) {
      return
    }
    editDraftsRef.current = originalDrafts(current.parts)
    seedPictures(EDIT_SLOT_PREFIX, originalPictures(current.parts))
    loadEditPart(open.text)
  }, [loadEditPart, seedPictures])

  // Commit every message at once, which is what the turn IS -- it was delivered
  // as one thing and it is re-sent as one thing. `open` is the text the
  // composer is handing over for the message currently in it; the rest come
  // from the drafts paging put there. Pictures still uploading are waited for,
  // so a picture added a second before the press goes with it. Only what
  // changed is sent (see `changedEdits`).
  const commitOpenEdit = useCallback(
    async (open: string) => {
      const current = editRef.current
      if (!current) {
        return
      }
      const drafts = editDraftsRef.current
      const openPart = current.parts[editPositionRef.current]
      if (openPart) {
        drafts.set(openPart.index, open)
      }
      const slots = await settledPictures()
      // Left or replaced while the uploads settled: this commit is no longer
      // about the edit on screen. Compared by WHICH turn, as the opening effect
      // is, since a session may rebuild the object every render.
      if (editRef.current?.eventIndex !== current.eventIndex) {
        return
      }
      commitEditRef.current?.(changedEdits(current.parts, drafts, slots))
    },
    [settledPictures],
  )

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
          onReset={resetEdits}
          onCancel={() => cancelEditRef.current?.()}
        />
      ) : null,
    [edit, editPart, editPosition, goToEditPart, resetEdits],
  )

  // ---- pictures ----
  //
  // The slot on screen: the open message's while editing, the new message's
  // otherwise. Mirrored into a ref so a paste or drop lands on the message that
  // is open at that moment, without the handler changing identity each page.
  const pictureSlot = editPart ? editSlot(editPart.index) : COMPOSE_SLOT
  const pictureSlotRef = useRef(pictureSlot)
  pictureSlotRef.current = pictureSlot
  const { add: addPictures, remove: removePicture } = composerPictures
  const slotPictures = composerPictures.slots[pictureSlot]
  const canAttach = Boolean(pictures && !pictures.unavailableReason)
  const addToOpenSlot = useCallback((files: File[]) => addPictures(pictureSlotRef.current, files), [addPictures])
  const attachmentsRow = useMemo(
    () =>
      slotPictures?.length || attachments ? (
        <>
          {attachments}
          {/* A line of their own, under whatever the host quoted: `basis-full`
              in the row's wrap is what starts it on a new line. */}
          {slotPictures?.length ? (
            <div className='flex basis-full flex-wrap gap-3'>
              {slotPictures.map((picture) => (
                <AttachmentChip
                  key={picture.key}
                  name={picture.name}
                  src={picture.src}
                  byteSize={picture.byteSize}
                  uploading={picture.uploading}
                  error={picture.error}
                  onRemove={() => removePicture(pictureSlot, picture.key)}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : undefined,
    [slotPictures, attachments, removePicture, pictureSlot],
  )
  const attachmentControlsRow = useMemo(
    () =>
      pictures ? (
        <>
          <AttachButton onFiles={addToOpenSlot} unavailableReason={pictures.unavailableReason} />
          {attachmentControls}
        </>
      ) : (
        attachmentControls
      ),
    [pictures, addToOpenSlot, attachmentControls],
  )
  // Whether the empty composer's press means something. Editing: commit, while
  // the open message still carries a picture or another message has anything
  // at all (a message left with nothing is removed rather than sent empty).
  // Composing: send the waiting pictures with no words.
  const canCommitEmpty = edit
    ? hasContent('', slotPictures) ||
      othersHaveContent(edit.parts, editDraftsRef.current, composerPictures.slots, editPart)
    : false
  const pictureSendLabel = hasContent('', composerPictures.slots[COMPOSE_SLOT])
    ? 'Send the attached picture'
    : undefined

  // The new message's pictures, waited for and taken off the row: they belong
  // to the message that just went, and the next one must not carry them again.
  const sendWithPictures = useCallback(
    async (text: string) => {
      const slots = await settledPictures()
      const ids = storedIds(slots[COMPOSE_SLOT])
      seedPictures(COMPOSE_SLOT, {})
      sendRef.current(text, ids.length > 0 ? { attachments: ids } : undefined)
    },
    [settledPictures, seedPictures],
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
        void commitOpenEdit(text)
        return
      }
      void sendWithPictures(text)
      if (draftDebounceRef.current) {
        clearTimeout(draftDebounceRef.current)
        draftDebounceRef.current = null
      }
      pendingDraftRef.current = null
      onDraftChangeRef.current?.(sessionKeyRef.current, '')
      textRef.current = ''
      setValue('')
    },
    [commitOpenEdit, sendWithPictures, setValue],
  )

  const onSetConfigOptionRef = useRef(onSetConfigOption)
  onSetConfigOptionRef.current = onSetConfigOption
  const handleConfigChange = useCallback((id: string, value: string) => {
    onSetConfigOptionRef.current?.(id, value)
  }, [])

  const configs = useMemo<CommandBarConfig[]>(() => selectLeftoverConfigs(configOptions), [configOptions])

  const configExtra = useMemo(() => {
    const booleanOptions = selectLeftoverBooleanOptions(configOptions)
    // The host's slot counts towards the cluster being occupied. Without it in
    // this test a composer whose only readout is the host's own control
    // renders no cluster at all, and the control it was handed is dropped with
    // nothing to say so.
    if (!attachmentControlsRow && !usage && booleanOptions.length === 0) {
      return null
    }
    return (
      <>
        {/* BEFORE the context ring, which is a position rather than a
            preference: the ring is a readout of what the session is holding,
            and what this message is about to add to it reads ahead of it. */}
        {attachmentControlsRow}
        {usage ? (
          <ContextRing
            usedTokens={usage.used}
            contextLimit={usage.size ?? 0}
            sessionCost={usage.cost}
            sessionTokens={usage.tokens}
            rateLimits={usage.rateLimits}
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
  }, [attachmentControlsRow, configOptions, usage, compact, onClear])

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
        valueRevision={valueRevision}
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
        attachments={attachmentsRow}
        onFiles={canAttach ? addToOpenSlot : onFiles}
        // Mid-edit an empty composer commits only while something is left to
        // send (see `canCommitEmpty`); composing, waiting pictures make it a send.
        emptySendLabel={edit ? (canCommitEmpty ? 'Commit edits' : undefined) : (pictureSendLabel ?? emptySendLabel)}
        submitMode={edit ? 'commit' : 'send'}
        approval={approval}
        autoApprove={autoApprove}
        onToggleAutoApprove={handleToggleAutoApprove}
        yoloMode={autoApproveLocked}
        approvalTitles={approvalTitles}
        textareaRef={textareaRef}
        commands={session.commands}
      />
    ),
    [
      value,
      valueRevision,
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
      attachmentsRow,
      canAttach,
      addToOpenSlot,
      onFiles,
      emptySendLabel,
      pictureSendLabel,
      edit,
      canCommitEmpty,
      approval,
      autoApprove,
      handleToggleAutoApprove,
      autoApproveLocked,
      approvalTitles,
      session.commands,
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
