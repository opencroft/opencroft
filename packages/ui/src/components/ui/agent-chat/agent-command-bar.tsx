'use client'

import { Send, ShieldAlert, ShieldCheck, ShieldCog, SlidersHorizontal, Sparkles, Square, X } from 'lucide-react'
import { Fragment } from 'react'
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
  // Called with the trimmed text. The value is cleared first, so a host that
  // persists drafts can clear its stored draft in the same turn.
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
  // A turn is running: the send button becomes a stop button when `onStop` is
  // also given.
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
  // Host slot: rendered inside that same settings menu, under the pickers.
  // For readouts that belong with the settings but are not choices -- a usage
  // meter, a context budget.
  configExtra?: ReactNode
  queued?: QueuedMessage[]
  onRemoveQueued?: (id: string) => void
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
// **Fully controlled, and it returns its own markup.** It holds no draft, no
// approval state and no knowledge of where it is mounted -- a host that wants
// this in a command bar, a sidebar or a dialog puts it there. That is the whole
// reason the panel can be previewed at all: it needs nothing running behind it.
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
// Enter sends, Shift+Enter inserts a newline, Escape clears.
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
  autoApprove = false,
  onToggleAutoApprove,
  yoloMode = false,
  approvalTitles = DEFAULT_APPROVAL_TITLES,
  textareaRef,
  className,
}: AgentCommandBarProps) {
  const canSend = Boolean(value.trim()) && !sending && !disabled
  const hasConfigs = Boolean(configs && configs.length > 0)

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
    const text = value.trim()
    if (!text || sending || disabled) return
    // Cleared before the send so a host persisting drafts sees the empty value
    // and the send in the same turn, rather than racing its own save.
    onValueChange('')
    onSend(text)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      if (onEscape) onEscape()
      else onValueChange('')
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

      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
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
          {controls}

          {busy && onStop ? (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStop}
              title='Stop'
            >
              <Square className='size-4' />
            </Button>
          ) : (
            <Button
              type='button'
              size='icon'
              variant='ghost'
              className={commandBarControlClass}
              onMouseDown={(e) => e.preventDefault()}
              onClick={send}
              disabled={!canSend}
              title='Send'
            >
              <Send className='size-4' />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
