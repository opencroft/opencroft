'use client'

import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'

import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

export interface ThinkingBlockProps {
  // The model's reasoning text (may stream in while `pending`).
  text: string
  // True while thinking tokens are still being generated.
  pending?: boolean
}

// A collapsible reasoning ("thinking") block, styled like the tool-call block:
// a one-line header (chevron + label + a spinner while tokens stream) that
// expands to reveal the thinking text.
export function ThinkingBlock({ text, pending = false }: ThinkingBlockProps) {
  const [open, setOpen] = useState(false)
  return (
    <Flex className='gap-1.5'>
      <button type='button' onClick={() => setOpen((v) => !v)} className='flex items-center gap-2 text-xs text-left cursor-pointer'>
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className='font-medium text-muted-foreground shrink-0'>Thinking</span>
        {pending && <Loader2 className='size-3 shrink-0 animate-spin text-muted-foreground' />}
      </button>
      {open && text.trim() && (
        <div className='whitespace-pre-wrap wrap-break-word border-l-2 pl-3 text-[11px] text-muted-foreground italic'>{text}</div>
      )}
    </Flex>
  )
}