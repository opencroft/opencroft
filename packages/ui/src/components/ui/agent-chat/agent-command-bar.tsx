'use client'

import { Send, ShieldAlert, ShieldCheck, ShieldCog, SlidersHorizontal, Sparkles, Square, X } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// A message the host is holding until the current turn finishes. `text` is
// display-ready: whatever transform the host applies before sending (context
// tags and the like) has already been undone, because that transform belongs
// to the host's protocol, not to this panel.
export interface QueuedMessage {
  id: string
  text: string
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
  value: string
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
  // follow-up message gets queued (see `queued`), and `send()` never had a busy
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
  // Host slot: rendered in the action row after the settings button -- where
  // input controls the host provides (dictation, attachments) belong.
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
  queued?: QueuedMessage[]
  onRemoveQueued?: (id: string) => void
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
  // offered. (Contrast `onRemoveQueued`, which gates its own button for the
  // same reason -- and `configs`, where the feature is gated on the data.)
  onDismissSendError?: () => void
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
  className?: string
}

// Shared metrics for every control in the action row, exported so host slots
// can match it without copying four class names and drifting from them.
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
export function shouldResyncBuffer(value: string, prevValue: string): boolean {
  return value !== prevValue
}

// The bottom panel of an agent chat: a strip of queued messages, the composer,
// and an action row underneath carrying every control and every host slot.
//
// **Two rows, and the split is the point.** The composer owns the full width of
// its own line, so a message is read on the width it was typed on rather than
// through a gap between icon clusters. Everything else -- host slots, settings,
// the approval toggle, send/stop -- sits on the row below, which is what lets
// the panel hold together at a phone width instead of squeezing the textarea to
// nothing.
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
// differs from what it was on the PREVIOUS render -- so an external `value`
// change (host clears the draft, loads a different session's saved text,
// `onEscape` resets it) always lands immediately, while a host that leaves
// `value` alone during ordinary typing (the whole point of the buffer) never
// sees it fight back mid-keystroke. See `shouldResyncBuffer`'s own comment
// for why the comparison has to be against last render's prop and not
// against what this component last reported outward -- those are not the
// same thing, and the difference is exactly the bug this contract exists to
// avoid.
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
// **The host owns the width.** Every element from a queued message's text up to
// this root carries `min-w-0`, and the text truncates -- so a long message, or
// an unbroken one like a URL or a path, shortens to one line rather than
// widening its row. That holds only while something above gives this panel a
// bounded width. A containing block that is shrink-to-fit -- an overlay with no
// width and no opposing inset, or `w-max` / `w-fit` / `inline-flex` on the way
// down -- derives its width FROM this panel, and no class in here can clamp
// against a width its own content produced. If a queued message runs off the
// screen, the broken link is above this component.
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
// Send queues a message the host can remove, a mis-pressed Stop kills a running
// turn. So the costly one is the one that stays put.
//
// Both sit in the `shrink-0` cluster, so the second button takes its width from
// the host's own controls, never from Send or Stop.
//
// One structural rule matters more than it looks: **the wrapper column, the
// composer and the action row are rendered unconditionally**, even with nothing
// queued. If the element structure changed when messages queue or drain, the
// textarea would be a different element afterwards -- React would remount it
// and the caret would vanish mid-sentence. A host memoising this panel has to
// preserve the same property on its side.
export function AgentCommandBar({
  value,
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
  queued,
  onRemoveQueued,
  sendError,
  onDismissSendError,
  approval,
  autoApprove = false,
  onToggleAutoApprove,
  yoloMode = false,
  approvalTitles = DEFAULT_APPROVAL_TITLES,
  textareaRef,
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
  if (shouldResyncBuffer(value, prevValueRef.current)) {
    prevValueRef.current = value
    setBuffered(value)
  }
  const setValue = (next: string) => {
    setBuffered(next)
    onValueChange(next)
  }

  const hasText = Boolean(buffered.trim())
  const canSend = hasText && !sending && !disabled
  const hasConfigs = Boolean(configs && configs.length > 0)

  // Stop is present for the whole turn; Send is only withheld from a turn with
  // nothing to queue. Without `onStop` there is no stop button to make room for,
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
      {queued && queued.length > 0 ? (
        <div className='flex min-w-0 flex-col gap-1'>
          {queued.map((message) => (
            <div key={message.id} className='flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs'>
              <span className='shrink-0 text-muted-foreground'>Queued</span>
              <span className='min-w-0 flex-1 truncate'>{message.text}</span>
              {onRemoveQueued ? (
                <button
                  type='button'
                  onClick={() => onRemoveQueued(message.id)}
                  className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
                  title='Remove from queue'
                >
                  <X className='size-3.5' />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* A failed send, directly above the composer with the text that failed
          already back in it. `role='alert'` so it is announced rather than
          only seen -- the text reappearing under the cursor is not something a
          screen reader reports.

          Conditional in the same way the queued strip is: a slot that holds
          its position whether or not it renders, so the textarea below keeps
          its place among the children and is never remounted. See the
          structural rule in this component's doc comment -- an element that
          appears and disappears ABOVE the composer is exactly the shape that
          would break it if it were spliced in instead. */}
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

          {configExtra ? <div className='shrink-0 px-1 text-xs text-muted-foreground'>{configExtra}</div> : null}
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
              title='Send'
              aria-label='Send'
            >
              <Send className='size-4' />
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
