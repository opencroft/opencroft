'use client'

import { Send, ShieldAlert, ShieldCheck, ShieldCog, Sparkles, Square, X } from 'lucide-react'
import type { KeyboardEvent, ReactNode, Ref } from 'react'

import { Button } from '@/components/ui/button'
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
  // Host slot: rendered at the very start of the row, before the start icon.
  leading?: ReactNode
  // Turns the start icon into a button. Left unset it stays a plain mark.
  onStartIconClick?: () => void
  // Host slot: rendered between the textarea and the approval toggle -- where
  // input controls the host provides (voice, say) belong.
  controls?: ReactNode
  // Host slot: rendered as its own row underneath. The host decides whether
  // there is anything worth showing there.
  configBar?: ReactNode
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

// The bottom panel of an agent chat: a strip of queued messages above a
// composer row, and an optional options row below it.
//
// **Fully controlled, and it returns its own markup.** It holds no draft, no
// approval state and no knowledge of where it is mounted -- a host that wants
// this in a command bar, a sidebar or a dialog puts it there. That is the whole
// reason the panel can be previewed at all: it needs nothing running behind it.
//
// Enter sends, Shift+Enter inserts a newline, Escape clears.
//
// One structural rule matters more than it looks: **the wrapper column and the
// composer row are rendered unconditionally**, even with nothing queued. If the
// element structure changed when messages queue or drain, the textarea would be
// a different element afterwards -- React would remount it and the caret would
// vanish mid-sentence. A host memoising this panel has to preserve the same
// property on its side.
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
  controls,
  configBar,
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
      {queued && queued.length > 0 && onRemoveQueued ? (
        <div className='flex min-w-0 flex-col gap-1'>
          {queued.map((message) => (
            <div key={message.id} className='flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs'>
              <span className='shrink-0 text-muted-foreground'>Queued</span>
              <span className='min-w-0 flex-1 truncate'>{message.text}</span>
              <button
                type='button'
                onClick={() => onRemoveQueued(message.id)}
                className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
                title='Remove from queue'
              >
                <X className='size-3.5' />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className='flex min-w-0 items-start gap-2'>
        {leading}
        {onStartIconClick ? (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='mt-0.5 h-7 w-7 shrink-0'
            // The composer keeps focus when these are pressed -- losing it
            // mid-sentence to a toolbar button is its own small betrayal.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onStartIconClick}
            title='Sessions'
          >
            <Sparkles className='h-4 w-4 text-primary' />
          </Button>
        ) : (
          <Sparkles className='ml-1 mt-1.5 h-4 w-4 shrink-0 text-primary' />
        )}

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
          className='max-h-60 min-h-8 resize-none border-0 bg-transparent py-1.5 shadow-none focus-visible:border-0 focus-visible:ring-0'
        />

        {controls}

        <Button
          type='button'
          size='icon'
          variant='ghost'
          className='mt-0.5 h-7 w-7 shrink-0'
          onMouseDown={(e) => e.preventDefault()}
          onClick={yoloMode ? undefined : onToggleAutoApprove}
          disabled={yoloMode}
          title={approvalTitle}
        >
          {yoloMode ? (
            <ShieldAlert className='h-4 w-4 animate-pulse text-red-500' />
          ) : autoApprove ? (
            <ShieldCog className='h-4 w-4 text-amber-500' />
          ) : (
            <ShieldCheck className='h-4 w-4 text-primary' />
          )}
        </Button>

        {busy && onStop ? (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='mt-0.5 h-7 w-7 shrink-0'
            onMouseDown={(e) => e.preventDefault()}
            onClick={onStop}
            title='Stop'
          >
            <Square className='h-4 w-4' />
          </Button>
        ) : (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='mt-0.5 h-7 w-7 shrink-0'
            onMouseDown={(e) => e.preventDefault()}
            onClick={send}
            disabled={!canSend}
            title='Send'
          >
            <Send className='h-4 w-4' />
          </Button>
        )}
      </div>

      {configBar}
    </div>
  )
}
