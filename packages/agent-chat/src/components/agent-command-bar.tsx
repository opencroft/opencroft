'use client'

import type { AvailableCommand } from 'agent-client/types'
import { Check, Send, ShieldAlert, ShieldCheck, ShieldCog, SlidersHorizontal, Sparkles, Square } from 'lucide-react'
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'

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
import { cn } from 'cn'

import { CommandAutocomplete } from './command-autocomplete'
import { MentionAutocomplete, type MentionCandidate } from './mention-autocomplete'

// The list open over the composer while something being typed can be
// completed: the agent's commands after a `/`, people after an `@`. Which
// items, which is active and what choosing does are the composer's; the bar
// draws the list in its place above the text.
export type AgentCommandBarSuggestions =
  | {
      kind: 'commands'
      items: readonly AvailableCommand[]
      activeIndex: number
      onSelect: (item: AvailableCommand) => void
      onHover: (index: number) => void
    }
  | {
      kind: 'mentions'
      items: readonly MentionCandidate[]
      activeIndex: number
      onSelect: (item: MentionCandidate) => void
      onHover: (index: number) => void
    }

// The message being written, as the bar needs it: the text itself to place,
// whether there is any to send, the send, and the list open over it. The text
// is a slot because the editor behind it is the host's -- the bar draws where
// a message is written, not how it is edited.
export interface AgentCommandBarComposer {
  input: ReactNode
  hasText: boolean
  // Sends what is written. `allowEmpty` comes from the Send button alone, and
  // only where `emptySendLabel` offers sending nothing.
  submit: (allowEmpty: boolean) => void
  suggestions?: AgentCommandBarSuggestions | null
}

// What a paste or a drop actually brought, as files. Only entries the
// platform reports as a file: an image copied out of a page carries BOTH an
// image/* file and an HTML fragment naming it, so reading the item list
// without this filter turns one screenshot into a picture plus a line of
// markup typed into the message.
export function filesFrom(transfer: DataTransfer | null): File[] {
  return transfer
    ? Array.from(transfer.items)
        .flatMap((item) => (item.kind === 'file' ? [item.getAsFile()] : []))
        .filter((file): file is File => file !== null)
    : []
}

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
  // The message being written. Its text is placed on its own full-width line,
  // with the list it opens drawn above it; see `AgentCommandBarComposer`.
  composer: AgentCommandBarComposer
  // A turn is running. With `onStop` given, Stop takes the trailing slot for
  // the whole turn -- and Send joins it, to its LEFT, as soon as there is text
  // to submit. An empty composer shows Stop alone.
  //
  // Send is deliberately NOT gated on `busy`. Submitting during a turn is how a
  // follow-up message is held until the turn ends, and the composer's send has no
  // busy gate -- were the button taken away, a coarse pointer would have no way
  // to submit during a turn at all: Enter breaks the line there by design, so
  // the button is the only route.
  busy?: boolean
  onStop?: () => void
  // A send is in flight, or the agent cannot accept one. Both only gate the
  // Send button (the composer gates its own Enter); stopping stays available.
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
  // Host slot: rendered directly above the composer. For a strip that says
  // something about the text currently in the input -- what is being edited,
  // which of a turn's messages it is.
  //
  // A conditional slot that holds its position whether or not it renders: see
  // the structural rule in this component's doc comment.
  //
  // There is no error slot. A send that did not go through is told in the
  // conversation, where the reader reads what happened; the panel only takes
  // the words back (see the clear-on-send contract).
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
  /** Files the reader brought in through the composer itself, rather than
   *  through a picker in the control row: pasted over the input, or dropped on
   *  the bar. Both routes exist because they are what readers actually do with
   *  a screenshot -- the picker is the fallback, not the main road.
   *
   *  The bar recognises the gesture and hands over the files. It still does not
   *  know what an attachment IS, which is the same boundary `attachments` draws
   *  one row up: what a file becomes, and whether it is allowed, stay the
   *  host's.
   *
   *  A host that passes nothing keeps the default behaviour exactly: the
   *  handlers are not attached at all, so a paste types itself into the box and
   *  a drop does whatever the browser does. */
  onFiles?: (files: File[]) => void
  // What pressing send MEANS right now. `commit` swaps the icon to a check and
  // says so -- an edit is committed by sending it, so it is the same control
  // and the same handler, not a second button that appears beside it.
  //
  // Presentation only: the gate is unchanged, so a commit needs text in the
  // composer exactly as a send does.
  submitMode?: 'send' | 'commit'
  // What pressing Send on an EMPTY composer means, if it means anything.
  //
  // Unset -- the default -- keeps Send withheld until something is typed:
  // handing nothing to an agent is not an action, and a live button that does
  // nothing is worse than an unavailable one.
  //
  // Given, Send stays available on an empty composer, and pressing it asks the
  // composer to send nothing (`composer.submit(true)`). The string is what the
  // button then calls itself, because a press that sends no message must not
  // say "Send". The new-thread composer uses this to mint the thread -- and
  // with it the agent's session, and the
  // settings that only a live session can advertise -- before there is a first
  // message to send.
  //
  // ONE PROP RATHER THAN A FLAG BESIDE A LABEL: the permission and the wording
  // cannot then be set apart, so there is no way to allow the press and leave
  // the button describing the one thing it will not do.
  //
  // Enter is deliberately NOT covered by it. This is a deliberate press on a
  // button that says what it does; a reflex Enter in an empty composer is not,
  // and it is the one keystroke a person makes without looking.
  emptySendLabel?: string
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

// The bottom panel of an agent chat: the composer, an attachments row, and an
// action row underneath carrying every control and every host slot.
//
// **The composer owns a full-width line of its own, and that split is the
// point.** A message is read on the width it was typed on rather than through a
// gap between icon clusters. Everything else -- host slots, settings, the
// approval toggle, send/stop -- sits on the row below, which is what lets the
// panel hold together at a phone width instead of squeezing the text to
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
// any element in the composer's place previews it, nothing needs to run behind
// it.
//
// **The text is a slot.** What is written, how it is edited, and what its keys
// do belong to the composer the host passes (`composer.input`); the bar
// places it on its line, draws the list it reports open above it, and sends
// through `composer.submit` when Send is pressed. So the bar knows nothing
// about an editor, and a second kind of text input is a change at the host.
//
// **Clear-on-send: the composer clears immediately, and the host restores on
// failure.** The composer empties, and reports itself empty, before it hands
// the message over, so it is empty the instant the message has gone. It does
// not hold the text until the host confirms: a send is asynchronous and hosts
// chain sends behind one another, so "confirmed" can be several round trips
// away, and the composer would sit full and unusable through all of it while
// the message it still shows has already gone. That would penalise every
// successful send to tidy up a rare failing one.
//
// So the failure path is the host's, and it has both halves: put the text back
// (through its composer) and say what happened (in its conversation). A host that
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
// strip above the composer. If the element structure changed as a conditional
// slot appeared and cleared, the composer's text would be a different element
// afterwards -- React would remount it and the caret would vanish mid-sentence.
// A host memoising this panel has to preserve the same property on its side.
export function AgentCommandBar({
  composer,
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
  editBar,
  attachments,
  onFiles,
  submitMode = 'send',
  emptySendLabel,
  approval,
  autoApprove = false,
  onToggleAutoApprove,
  yoloMode = false,
  approvalTitles = DEFAULT_APPROVAL_TITLES,
  className,
}: AgentCommandBarProps) {
  const { hasText, suggestions } = composer
  // An empty composer is sendable only where the host has said what sending it
  // would mean -- see `emptySendLabel`.
  const emptySendOffered = Boolean(emptySendLabel)
  const canSend = (hasText || emptySendOffered) && !sending && !disabled
  const hasConfigs = Boolean(configs && configs.length > 0)

  // Whether a file is being dragged over the bar. Only ever true while
  // `onFiles` is wired -- a bar with nowhere to put a file must not offer to
  // take one.
  const [dragging, setDragging] = useState(false)

  // Stop is present for the whole turn; Send is only withheld from a turn with
  // nothing to send. Without `onStop` there is no stop button to make room for,
  // so `busy` alone changes nothing -- the row stays the resting one.
  const showStop = busy && Boolean(onStop)
  const showSend = !showStop || hasText || emptySendOffered

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

  // An empty composer's press is not a send, so it is not named one. With text
  // in it the button is the ordinary Send (or Commit) whatever the host allows
  // on an empty one.
  const sendTitle =
    !hasText && emptySendLabel ? emptySendLabel : submitMode === 'commit' ? 'Commit edits' : 'Send'

  const approvalTitle = yoloMode ? approvalTitles.yolo : autoApprove ? approvalTitles.on : approvalTitles.off

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target has no interactive ARIA role to take -- dropping is a pointer-only gesture with no keyboard equivalent to expose, and the same capability is reachable from the attach control in the action row, which is a real button
    <div
      className={cn(
        'flex min-w-0 flex-1 flex-col gap-1',
        // A ring rather than a colour wash. The bar is already the brightest
        // thing on the panel, so the question a drag raises is not "is
        // something happening" but "where will this land" -- and an outline is
        // the answer to that one.
        dragging && 'rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background',
        className,
      )}
      // Attached only where the host can take a file, so a bar without
      // `onFiles` behaves exactly as it did before this prop existed.
      onDragOver={
        onFiles
          ? (event) => {
              // preventDefault on dragover is what makes a drop land here at
              // all. Without it the browser navigates to the file and the
              // reader loses the message they were part-way through writing --
              // which is why the check below reads `types` and not the items:
              // during a drag the item DATA is withheld, and only the kinds are
              // readable.
              if (Array.from(event.dataTransfer.types).includes('Files')) {
                event.preventDefault()
                setDragging(true)
              }
            }
          : undefined
      }
      // Moving onto a CHILD fires dragleave on the way, so the flag is cleared
      // only once the pointer has left the bar's own box. Without the check the
      // outline flickers off over every control it passes.
      onDragLeave={
        onFiles
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragging(false)
              }
            }
          : undefined
      }
      onDrop={
        onFiles
          ? (event) => {
              setDragging(false)
              // A drop on the text is the composer's, which takes the files
              // itself; the rest of the bar takes them here.
              if (event.defaultPrevented) {
                return
              }
              const files = filesFrom(event.dataTransfer)
              if (files.length > 0) {
                event.preventDefault()
                onFiles(files)
              }
            }
          : undefined
      }
    >
      {/* A conditional slot that holds its position whether or not it
          renders, so the composer's text below keeps its place among the
          children and is never remounted. See the structural rule in this
          component's doc comment -- an element that appears and disappears
          ABOVE the composer is exactly the shape that would break it if it
          were spliced in instead. */}
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
          mechanism `editBar` already relies on: a ternary in a
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

      {/* Relative wrapper anchors the popups to the composer's own box: they
          open ABOVE (bottom-full), matching the panel's grow-upward contract
          -- the text never moves under the cursor. A permanent wrapper, not a
          conditional one, so the text's place in the child list never
          changes as a popup comes and goes. */}
      <div data-slot='agent-command-bar-composer' className='relative flex min-w-0 flex-col'>
        {suggestions?.kind === 'commands' ? (
          <CommandAutocomplete
            items={suggestions.items}
            activeIndex={suggestions.activeIndex}
            onSelect={suggestions.onSelect}
            onHover={suggestions.onHover}
          />
        ) : null}
        {suggestions?.kind === 'mentions' ? (
          <MentionAutocomplete
            items={suggestions.items}
            activeIndex={suggestions.activeIndex}
            onSelect={suggestions.onSelect}
            onHover={suggestions.onHover}
          />
        ) : null}
        {composer.input}
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
              <DropdownMenuTrigger
                render={
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className={commandBarControlClass}
                    onMouseDown={(e) => e.preventDefault()}
                    title={settingsTitle}
                    aria-label={settingsTitle}
                  />
                }
              >
                <SlidersHorizontal className='size-4' />
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start' side='top' className='w-60'>
                {configs
                  ? configs.map((config, index) => (
                      <Fragment key={config.id}>
                        {index > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuRadioGroup
                          value={config.value}
                          onValueChange={(next) => {
                            if (onConfigChange) onConfigChange(config.id, next)
                          }}
                        >
                          {/* Inside the radio group: a menu label is a group label
                              and needs a group around it to render. */}
                          <DropdownMenuLabel className='text-xs font-medium text-muted-foreground'>
                            {config.label}
                          </DropdownMenuLabel>
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
              onClick={() => composer.submit(emptySendOffered)}
              disabled={!canSend}
              // Both carry an explicit name as well as a title. `title` alone
              // does name a button with no text, but weakly -- and these two
              // are now adjacent icons a press apart, one of which ends the
              // turn. Same shape as the settings button above.
              title={sendTitle}
              aria-label={sendTitle}
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
