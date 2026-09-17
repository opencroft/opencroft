'use client'

import type { AvailableCommand } from 'agent-client/types'
import { Check, Send, ShieldAlert, ShieldCheck, ShieldCog, SlidersHorizontal, Sparkles, Square, X } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

import { Button } from 'ui/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { Textarea } from 'ui/components/ui/textarea'
import { cn } from 'ui/lib/utils'

import { CommandAutocomplete, commandToken, matchCommands } from './command-autocomplete'

// One choice inside a setting.
export interface CommandBarConfigOption {
  value: string
  label: string
  // A second line under the label -- what the choice costs or means. Optional,
  // because most settings are self-describing and a forced subtitle is noise.
  description?: string
}

// One agent setting the composer can change: a model, a reasoning effort, a
// permission profile. The host names it and owns the values; the panel only
// renders the picker and reports the choice back.
export interface CommandBarConfig {
  // Echoed back by `onConfigChange`, so the host can switch on it.
  id: string
  label: string
  value: string
  options: CommandBarConfigOption[]
}

// What the approval button says in each of its three states. The panel knows
// which state it is in; it cannot know what the host calls the setting, where
// it is configured, or whether clicking will do anything -- so the wording is
// the host's. These defaults only keep the button describable on its own.
export interface ApprovalTitles {
  yolo: string
  on: string
  off: string
}

const DEFAULT_APPROVAL_TITLES: ApprovalTitles = {
  yolo: 'Approvals are skipped by configuration',
  on: 'Auto-approve on — tool calls are approved automatically',
  off: 'Auto-approve off — tool calls require approval',
}

export interface AgentCommandBarProps {
  value: string
  // Bumped by the host every time it LOADS `value` from outside, as opposed to
  // echoing back what was typed. It is what makes "reload this same text" a
  // distinguishable event — see `shouldResyncBuffer`. Optional: a host that
  // never needs to reload identical text can leave it unset.
  valueRevision?: number
  onValueChange: (text: string) => void
  // Called with the trimmed text. **The value is cleared BEFORE this runs** --
  // see the clear-on-send contract in this component's doc comment. A host that
  // persists drafts can therefore clear its stored draft in the same turn, and
  // a host whose send can fail is the one that puts the text back.
  onSend: (text: string) => void
  // Escape clears the composer. Given a handler, it is called instead of
  // `onValueChange('')` -- a host that persists drafts usually wants the clear
  // to skip whatever it does on an ordinary edit, so that abandoning a message
  // does not overwrite the stored draft with an empty one.
  onEscape?: () => void
  placeholder?: string
  autoFocus?: boolean
  onFocus?: () => void
  onBlur?: () => void
  // A turn is running. With `onStop` given, Stop takes the trailing slot for
  // the whole turn -- and Send joins it, to its LEFT, as soon as there is text
  // to submit. An empty composer shows Stop alone.
  //
  // Send is deliberately NOT gated on `busy`. Submitting during a turn is how a
  // follow-up message is held until the turn ends, and `send()` never had a busy
  // gate -- only the button was taken away, which left a coarse pointer with no
  // way to submit during a turn at all: Enter inserts a newline there by design,
  // so the button is the only other route.
  busy?: boolean
  onStop?: () => void
  // A send is in flight, or the agent cannot accept one. Both only gate
  // sending; stopping stays available.
  sending?: boolean
  disabled?: boolean
  // Host slot: rendered at the very start of the action row.
  leading?: ReactNode
  // Turns the start icon into a button. Left unset it stays a plain mark.
  onStartIconClick?: () => void
  // Show the sparkles start icon at all. Default true; false hides it for a view
  // where the agent is fixed (a group-chat thread) and there is no session
  // picker to open.
  startIcon?: boolean
  // Host slot: rendered in the action row before the settings button (right
  // after the approval shield) -- e.g. the per-setting icon buttons (model,
  // effort, mode) a host breaks out of `configs` to give its own control.
  //
  // NOT the place for input controls a host provides (dictation, attachments):
  // those go in `trailingControls`, after the settings button, so a host's
  // input controls never sit ahead of the settings they control.
  controls?: ReactNode
  // Agent settings -- model, reasoning effort, anything else the host offers.
  // They collapse into a single icon button that opens a menu of pickers, so
  // the row costs one control no matter how many settings there are.
  configs?: CommandBarConfig[]
  onConfigChange?: (id: string, value: string) => void
  // Host slot: rendered in the action row beside the settings button, NOT
  // inside the menu. For readouts that belong with the settings but are not
  // choices -- a usage meter, a context budget. They sit in the row rather
  // than behind the button because a readout you have to open a menu to see
  // is a readout nobody reads.
  configExtra?: ReactNode
  // Host slot: rendered in the action row after `controls`, immediately before
  // Send/Stop -- where input controls the host provides (dictation,
  // attachments) belong. Kept separate from `controls` so a host can place
  // per-setting pickers and input controls independently, without either
  // fighting the other for position.
  trailingControls?: ReactNode
  // Copy for a send that did not go through, rendered directly above the
  // composer. One shape for every chat, so a refusal reads the same wherever
  // the panel is mounted -- a host wrapping the panel in its own error layout
  // is what made this differ per surface.
  //
  // The panel displays it and decides nothing: what failed, how it is worded
  // and when it clears are the host's. See the clear-on-send contract on this
  // component -- the host is also what puts the typed text back.
  sendError?: string
  // Delegation, not notification: the panel does not own `sendError`, so
  // without this there is no way to clear it and no dismiss control is
  // offered. (Contrast `configs`, where the feature is gated on the data the
  // host provides rather than on a callback.)
  onDismissSendError?: () => void
  // Host slot: rendered directly above the composer, under `sendError`. For a
  // strip that says something about the text currently in the input -- what is
  // being edited, which of a turn's messages it is. Nearer the input than the
  // error is, because it describes what is IN the input rather than what
  // happened to the last thing that left it.
  //
  // A conditional slot that holds its position whether or not it renders, for
  // the same reason `sendError` is one: see the structural rule in this
  // component's doc comment.
  editBar?: ReactNode
  // Host slot: a row of its own directly ABOVE the composer -- what is going
  // out ATTACHED to the next message. A selection being carried along, a
  // picked file, whatever a host attaches next.
  //
  // Above rather than below, because the panel is docked bottom and grows
  // upward: a row appearing there leaves the composer where it was, and the
  // same row below the composer would shove it up every time it appeared.
  // See the slot's own comment in the markup, and the host-owns-the-anchor
  // note in this component's doc comment for the one thing that can undo it.
  //
  // Arbitrary content, deliberately, and not one named thing: the row places
  // and spaces what it is given and knows nothing about it, so a second kind
  // of attachment is a change at the host and none here.
  //
  // Given nothing it renders NO ELEMENT -- not an empty one. The column spaces
  // its children, so an element that was always present would cost every
  // composer a strip of empty height whether or not anything was attached.
  // See the slot's own comment in the markup for why that is a layout
  // requirement rather than tidiness.
  //
  // Which puts one obligation on the host, and it is the easy one to miss:
  // **an element that renders null is not nothing.** Nothing in here can tell
  // the two apart -- a slot holds an element, and whether that element draws
  // anything is only known once it has been rendered, by which point this row
  // has already been drawn around it. So a host with nothing attached passes
  // `undefined`, rather than a component that will decide for itself that it
  // has nothing to show.
  attachments?: ReactNode
  // What pressing send MEANS right now. `commit` swaps the icon to a check and
  // says so -- an edit is committed by sending it, so it is the same control
  // and the same handler, not a second button that appears beside it.
  //
  // Presentation only: the gate is unchanged, so a commit needs text in the
  // composer exactly as a send does.
  submitMode?: 'send' | 'commit'
  // Show the approval toggle at all. Default true; false removes it for a
  // composer where there is nothing to approve -- starting a thread sends one
  // message to an agent that has not been asked for a tool call yet, so a
  // shield there describes a setting the press cannot be about.
  //
  // A switch rather than an inference from `onToggleAutoApprove`: that callback
  // is deliberately optional while the button still SHOWS the state, which is
  // what `yoloMode` needs -- so its absence cannot mean "no approval control".
  // Same shape as `startIcon` above, and the same reason.
  approval?: boolean
  // The approval toggle. Without `onToggleAutoApprove` the button still shows
  // the state but does nothing, which is what `yoloMode` wants.
  autoApprove?: boolean
  onToggleAutoApprove?: () => void
  // Approvals are being skipped wholesale by host configuration: the toggle
  // goes inert and says so.
  yoloMode?: boolean
  // Overrides the button's title in each state. A host that can say where the
  // setting lives, or that clicking toggles it, should -- the panel cannot.
  approvalTitles?: ApprovalTitles
  // The host needs this to focus the composer -- e.g. when it stages an
  // existing message for editing.
  textareaRef?: Ref<HTMLTextAreaElement>
  // Commands the agent advertised for this session (see the session
  // contract's `commands`). With any given, typing `/` in an empty composer
  // opens the autocomplete; without, `/text` is just text on its way out.
  commands?: AvailableCommand[]
  className?: string
}

// Shared metrics for every control in the action row, exported so host slots
// can match them without copying class names and drifting from them.
//
// Two constants, because the row holds two shapes. A square icon control takes
// `commandBarControlClass` whole. A variable-width one -- a labelled chip, a
// picker -- can take only the height, and must NOT inherit the `shrink-0` with
// it: a control with text in it is exactly the thing in this row that should
// give up width when there is not enough, and the fixed-size ones are not.
//
// Both are 28px and they move together or not at all. Written out separately
// rather than composed from a shared piece, because a constructed class name
// is not a literal and would not render.
export const commandBarControlHeight = 'h-7'
export const commandBarControlClass = 'size-7 shrink-0'

// The reset-contract decision behind the buffered `value` (see this
// component's own doc comment): true when the `value` PROP has changed since
// the render before this one -- `prevValue` is that prop as of the previous
// render, tracked unconditionally, never touched by this component's own
// `onValueChange` calls.
//
// That last part is the whole trick, and worth spelling out because the
// obvious-looking alternative is wrong: comparing against "what this
// component itself last reported" instead of "the prop last render" looks
// equivalent and is not. A host that does NOT echo every keystroke back
// through `value` (the entire point of the buffer) leaves `value` sitting at
// its pre-keystroke content across the next render -- if the comparison
// baseline were "last self-reported", that stale, unchanged `value` would
// read as differing from what was JUST reported and the buffer would resync
// BACKWARDS, erasing the keystroke that triggered the render in the first
// place. Comparing against last render's PROP instead of last SELF-REPORT
// means an unchanged `value` reads as unchanged, however many renders pass
// and however many self-reports happened, and only a prop the HOST actually
// moved reads as new.
//
// **AND THE TEXT ALONE CANNOT EXPRESS EVERY LOAD.** The comparison above is
// blind to the one load whose whole purpose is to restore what `value` already
// says: "put this message back the way it was". The host's `value` sits at the
// text it loaded, the reader has since typed over it in the buffer, and the
// reset loads that same text again -- an identical prop, no resync, and a
// button that does nothing. `valueRevision` is how a host says "loaded", as a
// fact separate from what was loaded: bump it on every external set and an
// unchanged string still lands. Omitted on both sides it compares
// `undefined !== undefined`, which is false, so a host that does not pass one
// keeps exactly the behaviour above.
export function shouldResyncBuffer(
  value: string,
  prevValue: string,
  valueRevision?: number,
  prevRevision?: number,
): boolean {
  return value !== prevValue || valueRevision !== prevRevision
}

// The bottom panel of an agent chat: the composer, an attachments row, and an
// action row underneath carrying every control and every host slot.
//
// **The composer owns a full-width line of its own, and that split is the
// point.** A message is read on the width it was typed on rather than through a
// gap between icon clusters. Everything else -- host slots, settings, the
// approval toggle, send/stop -- sits on the row below, which is what lets the
// panel hold together at a phone width instead of squeezing the textarea to
// nothing.
//
// **Above the composer sits the attachments row, and only while something
// occupies it.** It carries what goes out WITH the next message. Above rather
// than below because this panel is docked bottom and grows upward, so a row
// appearing there leaves the composer exactly where it was -- the text being
// typed does not move under the cursor. Empty, the row renders nothing at all,
// so a composer with nothing attached is still exactly the two rows it has
// always been.
//
// **Controlled, and it returns its own markup.** It holds no draft (nothing
// survives a remount), no approval state and no knowledge of where it is
// mounted -- a host that wants this in a command bar, a sidebar or a dialog
// puts it there. That is the whole reason the panel can be previewed at all:
// a no-op `onValueChange` previews it correctly, nothing needs to run behind
// it.
//
// The one exception, and it is a rendering optimisation rather than a change
// to that contract: keystrokes update an internal buffer (seeded from
// `value`, reported out through `onValueChange` on every change) rather than
// requiring the host to round-trip `value` back down before a character
// appears. A host publishing this element into a slot elsewhere in the tree
// (an overlay, a portal) would otherwise rebuild and republish that slot on
// every keystroke -- this component is exactly what is published in that
// case, so it is the only layer that can absorb the fix. `value` remains the
// single source of truth for anything EXTERNALLY driven -- a session switch,
// clear-on-send, Escape -- which the buffer re-syncs from immediately; see
// the reset contract below. A host that only ever sets `value` in response to
// this component's own `onValueChange` (the ordinary case) never notices the
// buffer exists.
//
// **Reset contract:** the buffer re-syncs from `value` whenever `value`
// differs from what it was on the PREVIOUS render, or whenever
// `valueRevision` does -- so an external `value` change (host clears the
// draft, loads a different session's saved text, `onEscape` resets it) always
// lands immediately, while a host that leaves `value` alone during ordinary
// typing (the whole point of the buffer) never sees it fight back
// mid-keystroke. The revision covers the load the text alone cannot express:
// restoring the text `value` already holds. See `shouldResyncBuffer`'s own
// comment for both halves -- why the comparison has to be against last
// render's prop and not against what this component last reported outward,
// and why a load needs an identity of its own.
//
// **Clear-on-send: the composer clears immediately, and the host restores on
// failure.** `onValueChange('')` runs before `onSend`, so the composer is empty
// the instant the message is handed over. The alternative -- hold the text and
// clear only once the host confirms -- was considered and rejected: a send is
// asynchronous and hosts chain sends behind one another, so "confirmed" can be
// several round trips away, and the composer would sit full and unusable
// through all of it while the message it still shows has already gone. That
// penalises every successful send to tidy up a rare failing one.
//
// So the failure path is the host's, and it has both halves: put the text back
// (through `value`) and say what happened (through `sendError`). A host that
// restores the ORIGINAL typed text rather than what it actually transmitted is
// doing it right -- an outgoing transform is machinery the user never typed.
// The visible cost of this choice is one frame of empty composer before the
// text returns, which is the trade made deliberately.
//
// **The host owns the width.** Every element from the composer and the action
// row up to this root carries `min-w-0`, so a long line of text or a wide host
// control shortens its own row rather than widening the panel -- including an
// unbroken run like a URL or a path, since `truncate` brings `overflow: hidden`
// with it and drops the automatic minimum size to zero. That holds only while
// something above gives this panel a bounded width. A containing block that is
// shrink-to-fit -- an overlay with no width and no opposing inset, or `w-max` /
// `w-fit` / `inline-flex` on the way down -- derives its width FROM this panel,
// and no class in here can clamp against a width its own content produced. If a
// row runs off the screen, the broken link is above this component.
//
// **And the host owns the anchor.** This panel gets taller as the composer is
// typed into and as the attachments row appears, and WHICH DIRECTION it grows
// in is not its own to decide. A container that pins the panel's bottom edge --
// a bottom-sticky dock, a column packing its children to the end -- grows it
// upward, and that is what keeps the composer still while a row appears above
// it. A top-anchored container grows it downward and moves the composer
// instead. No class in here changes that and nothing in here can detect it, so
// a host mounting this panel somewhere new owes it a bottom-anchored home.
//
// Enter sends on a fine-pointer client (Shift+Enter inserts a newline; on touch
// there is no Shift key, so the button sends); Escape clears.
//
// **Send and Stop coexist while a turn runs, and Stop is the one that never
// moves.** Stop holds the trailing slot from the moment `busy` goes true until
// it goes false; Send appears to its LEFT once there is text, and goes when the
// text does. The order is the whole of the decision. Were Send trailing, the
// rightmost button would change meaning under a reaching finger the moment a
// character was typed -- and the two are not equally recoverable: a mis-pressed
// Send holds a message the host can still take back, a mis-pressed Stop kills a
// running turn. So the costly one is the one that stays put.
//
// Both sit in the `shrink-0` cluster, so the second button takes its width from
// the host's own controls, never from Send or Stop.
//
// One structural rule matters more than it looks: **the wrapper column, the
// composer and the action row are rendered unconditionally**, even with no
// error above the composer. If the element structure changed as a conditional
// slot appeared and cleared, the textarea would be a different element
// afterwards -- React would remount it and the caret would vanish mid-sentence.
// A host memoising this panel has to preserve the same property on its side.
export function AgentCommandBar({
  value,
  valueRevision,
  onValueChange,
  onSend,
  onEscape,
  placeholder,
  autoFocus,
  onFocus,
  onBlur,
  busy = false,
  onStop,
  sending = false,
  disabled = false,
  leading,
  onStartIconClick,
  startIcon,
  controls,
  configs,
  onConfigChange,
  configExtra,
  trailingControls,
  sendError,
  onDismissSendError,
  editBar,
  attachments,
  submitMode = 'send',
  approval,
  autoApprove = false,
  onToggleAutoApprove,
  yoloMode = false,
  approvalTitles = DEFAULT_APPROVAL_TITLES,
  textareaRef,
  commands,
  className,
}: AgentCommandBarProps) {
  // Buffered value -- see this component's own doc comment for why and the
  // reset contract, and `shouldResyncBuffer`'s own comment (exported and
  // tested on its own above -- no React rendering harness in this package to
  // exercise the component end-to-end, but the one piece of this worth
  // getting wrong in isolation is which of "value" and "buffered" wins, and
  // that reduces to a pure function). `prevValueRef` tracks the PROP as of
  // the previous render, unconditionally -- `setValue` below never touches
  // it; only the render-time check does.
  const [buffered, setBuffered] = useState(value)
  const prevValueRef = useRef(value)
  const prevRevisionRef = useRef(valueRevision)
  if (shouldResyncBuffer(value, prevValueRef.current, valueRevision, prevRevisionRef.current)) {
    prevValueRef.current = value
    prevRevisionRef.current = valueRevision
    setBuffered(value)
  }
  const setValue = (next: string) => {
    setBuffered(next)
    onValueChange(next)
  }

  const hasText = Boolean(buffered.trim())
  const canSend = hasText && !sending && !disabled
  const hasConfigs = Boolean(configs && configs.length > 0)

  // Slash-command autocomplete. Derived from the buffered text every render
  // rather than held in state: the popup is a VIEW of what is typed, and a
  // stored copy is a second answer that can disagree with the first after a
  // draft restore or a buffer resync. Only the keyboard cursor and an explicit
  // dismiss are state of their own.
  const [commandCursor, setCommandCursor] = useState(0)
  const [dismissedToken, setDismissedToken] = useState<string | null>(null)
  const typedToken = commandToken(buffered)
  const commandMatches =
    commands && typedToken !== null && typedToken !== dismissedToken ? matchCommands(commands, buffered) : null
  const commandPopupOpen = commandMatches !== null && commandMatches.length > 0
  // Clamp instead of resetting on every keystroke: narrowing `/re` -> `/rev`
  // keeps the highlighted row when it survives the filter.
  const activeCommandIndex = commandPopupOpen ? Math.min(commandCursor, commandMatches.length - 1) : 0

  const insertCommand = (command: AvailableCommand) => {
    // The trailing space settles the token, which closes the popup by the
    // derivation above -- no state to clean up beyond the cursor.
    setValue(`/${command.name} `)
    setCommandCursor(0)
  }

  // Stop is present for the whole turn; Send is only withheld from a turn with
  // nothing to send. Without `onStop` there is no stop button to make room for,
  // so `busy` alone changes nothing -- the row stays the resting one.
  const showStop = busy && Boolean(onStop)
  const showSend = !showStop || hasText

  // The button carries an icon and no text, so its current values have to live
  // somewhere reachable -- otherwise the only way to read the model you are on
  // is to open the menu.
  const settingsTitle =
    configs && configs.length > 0
      ? configs
          .map((config) => {
            const selected = config.options.find((option) => option.value === config.value)
            return `${config.label}: ${selected ? selected.label : config.value}`
          })
          .join(' · ')
      : 'Settings'

  const send = () => {
    const text = buffered.trim()
    if (!text || sending || disabled) return
    // Cleared before the send so a host persisting drafts sees the empty value
    // and the send in the same turn, rather than racing its own save.
    setValue('')
    onSend(text)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // The command popup owns navigation keys while it is open: Enter picks
    // instead of sending, Escape closes it instead of clearing the composer.
    // Ahead of the send branch deliberately -- Enter's meaning depends on
    // whether a choice is on screen, and this is the one place that knows.
    if (commandPopupOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCommandCursor((activeCommandIndex + 1) % commandMatches.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandCursor((activeCommandIndex - 1 + commandMatches.length) % commandMatches.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        insertCommand(commandMatches[activeCommandIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        // Remembered per token, so the popup stays closed while THIS token is
        // being typed and offers itself again for the next one.
        setDismissedToken(typedToken)
        return
      }
    }
    // On a touch device (phone soft keyboard) there's no accessible Shift key,
    // so Enter inserts a newline like in any other textarea; only fine-pointer
    // clients (mouse / physical keyboard) send on Enter. Read at event time --
    // the handler only runs client-side on interaction, so there's nothing to hydrate.
    const isCoarsePointer =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(pointer: coarse)').matches
    if (event.key === 'Enter' && !event.shiftKey && !isCoarsePointer) {
      event.preventDefault()
      send()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (onEscape) onEscape()
      else setValue('')
    }
  }

  const approvalTitle = yoloMode ? approvalTitles.yolo : autoApprove ? approvalTitles.on : approvalTitles.off

  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      {/* A failed send, directly above the composer with the text that failed
          already back in it. `role='alert'` so it is announced rather than
          only seen -- the text reappearing under the cursor is not something a
          screen reader reports.

          A conditional slot that holds its position whether or not it renders,
          so the textarea below keeps its place among the children and is never
          remounted. See the structural rule in this component's doc comment --
          an element that appears and disappears ABOVE the composer is exactly
          the shape that would break it if it were spliced in instead. */}
      {sendError ? (
        <div role='alert' className='flex min-w-0 items-start gap-2 px-1 text-sm text-destructive'>
          <span className='min-w-0 flex-1 wrap-break-word'>{sendError}</span>
          {onDismissSendError ? (
            <button
              type='button'
              onMouseDown={(e) => e.preventDefault()}
              onClick={onDismissSendError}
              className='shrink-0 opacity-70 transition-opacity hover:opacity-100'
              title='Dismiss'
              aria-label='Dismiss error'
            >
              <X className='size-3.5' />
            </button>
          ) : null}
        </div>
      ) : null}

      {editBar ? <div className='min-w-0'>{editBar}</div> : null}

      {/* What is going out with the next message, on its own row directly
          above the composer.

          ABOVE, and that is a behaviour rather than a preference. This panel
          is docked to the bottom of its container, so it grows UPWARD: a row
          added above the composer takes its height from the space above the
          panel and leaves everything from the composer down exactly where it
          was. The text being typed does not move under the cursor as something
          is attached to it. The same row placed below the composer would push
          the composer up by its own height every time it appeared, which is
          the one thing this row was asked not to do.

          It holds only while the HOST pins the panel's bottom edge -- see the
          note on the host owning the anchor in this component's doc comment.
          A top-anchored container grows this panel downward instead, and then
          this row pushes the composer down and produces exactly the jump it
          sits here to avoid. Nothing in this file can detect that or correct
          it, and it looks right in a screenshot either way.

          RENDERED ONLY WHEN OCCUPIED, and that is structural rather than tidy:
          the column spaces its children with `gap-1`, and a gap is drawn
          between rendered children -- so an always-present empty element would
          add a strip of height to every composer that has nothing attached.
          `null` produces no child, and therefore no gap.

          Conditional and still safe for the composer below it, by the same
          mechanism `sendError` and `editBar` already rely on: a ternary in a
          fixed child position keeps every sibling's place in the child list,
          so nothing around it is remounted as this appears and clears. See the
          structural rule in this component's doc comment.

          IT WRAPS rather than scrolling or clipping. This row is the whole
          statement of what the next message is carrying, so a row that could
          hide one of them fails at the only thing it does; the panel standing
          a line taller is the cheaper cost -- and upward, so it costs the
          transcript above rather than the composer. Children carry `min-w-0`
          to shorten within a line, exactly as they do in the action row.

          That used to be argued from this row also being the only place to
          detach from, which is no longer true of every host: one may put the
          control that removes something in the action row instead, leaving
          this row drawing a thing whose removal it does not own. The reason
          survives it, because it was never about where the control is -- what
          the reader cannot see is what they cannot decide about. */}
      {attachments ? <div className='flex min-w-0 flex-wrap items-center gap-1 px-1'>{attachments}</div> : null}

      {/* Relative wrapper anchors the command popup to the composer's own
          box: the popup opens ABOVE (bottom-full), matching the panel's
          grow-upward contract -- the text never moves under the cursor. A
          permanent wrapper, not a conditional one, so the textarea's place in
          the child list never changes as the popup comes and goes. */}
      <div className='relative min-w-0'>
        {commandPopupOpen ? (
          <CommandAutocomplete
            items={commandMatches}
            activeIndex={activeCommandIndex}
            onSelect={insertCommand}
            onHover={setCommandCursor}
          />
        ) : null}
        <Textarea
          ref={textareaRef}
          value={buffered}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          className='max-h-60 min-h-8 w-full min-w-0 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0'
        />
      </div>

      <div className='flex min-w-0 items-center gap-1 px-1'>
        <div className='flex min-w-0 flex-1 items-center gap-1 overflow-hidden'>
          {leading}

          {startIcon === false ? null : onStartIconClick ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              // The composer keeps focus when these are pressed -- losing it
              // mid-sentence to a toolbar button is its own small betrayal.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStartIconClick}
              title='Sessions'
            >
              <Sparkles className='size-4 text-primary' />
            </Button>
          ) : (
            <span className={cn('inline-flex items-center justify-center', commandBarControlClass)}>
              <Sparkles className='size-4 text-primary' />
            </span>
          )}

          {/* BEFORE the settings button, not after. What is attached to the
              next message reads ahead of the controls that configure it, and
              the application settled on this order first -- the kit's copy had
              it the other way and was the one that was wrong.

              A FLEX ROW, NOT A BLOCK. This wrapper is where the action row's
              own `items-center` and `gap-1` stopped: whatever a host put in the
              slot was laid out as inline boxes aligned on their TEXT
              BASELINES, so two slot children of different heights never shared
              a centre line, and adjacent ones sat flush with none of the 4px
              every other pair in the row has. Both were invisible from either
              child's own source -- neither is wrong on its own.

              AND IT SHRINKS, deliberately. Everything else in this cluster is a
              fixed-size control, so while this wrapper was `shrink-0` there was
              nothing in the cluster that could give: it overflowed instead, and
              `overflow-hidden` clipped the right edge -- the last readout in the
              slot vanished with nothing to say it had. Now the width comes out
              of whichever slot child declares it may give, by carrying
              `min-w-0`; a fixed-size readout keeps its size. */}
          {configExtra ? <div className='flex min-w-0 items-center gap-1 text-xs text-muted-foreground'>{configExtra}</div> : null}
        </div>

        <div className='flex shrink-0 items-center gap-1'>
          {approval === false ? null : (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={yoloMode ? undefined : onToggleAutoApprove}
              disabled={yoloMode}
              title={approvalTitle}
            >
              {yoloMode ? (
                <ShieldAlert className='size-4 animate-pulse text-red-500' />
              ) : autoApprove ? (
                <ShieldCog className='size-4 text-amber-500' />
              ) : (
                <ShieldCheck className='size-4 text-primary' />
              )}
            </Button>
          )}
          {controls}

          {/* The leftover-settings button: whatever config options are not
              broken out into their own buttons (model, effort, permission -- see
              `controls` above). Placed after those rather than beside the
              sparkles/start icon, so a picker earns its own button by being
              extracted from here, not by sitting apart from it. Gated on
              `hasConfigs` so it disappears entirely once nothing is left. */}
          {hasConfigs ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type='button'
                  size='icon'
                  variant='ghost'
                  className={commandBarControlClass}
                  onMouseDown={(e) => e.preventDefault()}
                  title={settingsTitle}
                  aria-label={settingsTitle}
                >
                  <SlidersHorizontal className='size-4' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' side='top' className='w-60'>
                {configs
                  ? configs.map((config, index) => (
                      <Fragment key={config.id}>
                        {index > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel className='text-xs font-medium text-muted-foreground'>
                          {config.label}
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={config.value}
                          onValueChange={(next) => {
                            if (onConfigChange) onConfigChange(config.id, next)
                          }}
                        >
                          {config.options.map((option) => (
                            <DropdownMenuRadioItem key={option.value} value={option.value} className='min-w-0'>
                              <span className='flex min-w-0 flex-col'>
                                <span className='truncate'>{option.label}</span>
                                {option.description ? (
                                  <span className='truncate text-xs text-muted-foreground'>{option.description}</span>
                                ) : null}
                              </span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </Fragment>
                    ))
                  : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {trailingControls}

          {/* Send BEFORE Stop, so Stop is the trailing control from the moment
              the turn starts until it ends -- see the ordering note in this
              component's doc comment. Two separate conditional slots rather
              than one ternary: each button keeps its own position among the
              children, so neither is remounted when the other appears. */}
          {showSend ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={send}
              disabled={!canSend}
              // Both carry an explicit name as well as a title. `title` alone
              // does name a button with no text, but weakly -- and these two
              // are now adjacent icons a press apart, one of which ends the
              // turn. Same shape as the settings button above.
              title={submitMode === 'commit' ? 'Commit edits' : 'Send'}
              aria-label={submitMode === 'commit' ? 'Commit edits' : 'Send'}
            >
              {submitMode === 'commit' ? <Check className='size-4' /> : <Send className='size-4' />}
            </Button>
          ) : null}

          {showStop ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStop}
              title='Stop'
              aria-label='Stop'
            >
              <Square className='size-4' />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
