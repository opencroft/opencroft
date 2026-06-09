'use client'

import type { ReactNode } from 'react'
import { Send, Square } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { Textarea } from 'ui/components/ui/textarea'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

export interface AgentChatInputProps {
  value: string
  onValueChange: (text: string) => void
  onSend: (text: string) => void
  // While a turn is running the send button becomes a stop button.
  busy?: boolean
  onStop?: () => void
  // Disables sending (e.g. the agent isn't configured yet). Stop stays available.
  disabled?: boolean
  placeholder?: string
  // Optional trailing slot — e.g. a popover of extra actions. Rendered after the
  // send/stop button.
  menu?: ReactNode
  className?: string
}

// Composer for a generic agent chat: a growing, borderless textarea plus one
// trailing action button that sends a message, then switches to a stop button
// while the agent is working. Designed to sit inside a `StickySection` card
// (which provides the surface). Enter sends; Shift+Enter inserts a newline.
export function AgentChatInput({
  value,
  onValueChange,
  onSend,
  busy = false,
  onStop,
  disabled = false,
  placeholder = 'Message the agent…',
  menu,
  className,
}: AgentChatInputProps) {
  const canSend = !disabled && value.trim().length > 0

  const send = () => {
    const text = value.trim()
    if (!text) return
    onValueChange('')
    onSend(text)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (!busy && canSend) send()
    }
  }

  return (
    <Flex row align="center" className={cn('w-full gap-1', className)}>
      <Textarea
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className="flex-1 resize-none min-h-0 border-0 bg-transparent shadow-none focus-visible:ring-0 max-h-48"
      />
      {busy ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onStop}
          disabled={!onStop}
          title="Stop"
          aria-label="Stop"
        >
          <Square />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={send}
          disabled={!canSend}
          title="Send"
          aria-label="Send"
        >
          <Send />
        </Button>
      )}
      {menu}
    </Flex>
  )
}
