'use client'

import { Button } from 'ui/button'
import { MessageSquare, X } from 'lucide-react'
import { cloneElement, type ReactElement } from 'react'
import { useAskAI } from '@/components/core/providers/ask-ai-provider'
import { cn } from '@/lib/utils'

interface AskAIButtonProps {
  value: string
  onResult: (result: string) => void
  instruction?: string
  disabled?: boolean
  variant?: 'icon' | 'text'
  size?: 'sm' | 'md'
  className?: string
}

export function AskAIButton({ value, onResult, instruction = 'Help me improve this text', disabled = false, variant = 'icon', size = 'sm', className }: AskAIButtonProps) {
  const { openChat } = useAskAI()

  const handleClick = () => {
    openChat(value, instruction, onResult)
  }

  if (variant === 'icon') {
    return (
      <Button
        type='button'
        variant='ghost'
        size={size === 'sm' ? 'sm' : 'default'}
        onClick={handleClick}
        disabled={disabled}
        className={cn('h-8 w-8 p-0 hover:bg-muted/50 pointer-events-auto', size === 'sm' && 'h-6 w-6', className)}
        title='Ask AI'
      >
        <MessageSquare className={cn('h-4 w-4', size === 'sm' && 'h-3 w-3')} />
      </Button>
    )
  }

  return (
    <Button type='button' variant='outline' size={size === 'md' ? 'default' : size} onClick={handleClick} disabled={disabled} className={cn('gap-2', className)}>
      <MessageSquare className='h-4 w-4' />
      Ask AI
    </Button>
  )
}

interface AskAIWrapperProps {
  children: ReactElement<{ className?: string }>
  value: string
  onResult: (result: string) => void
  onClear?: () => void
  instruction?: string
  disabled?: boolean
  variant?: 'icon' | 'text'
  size?: 'sm' | 'md'
  buttonClassName?: string
  className?: string
}

export function AskAIWrapper({
  children,
  value,
  onResult,
  onClear,
  instruction = 'Help me improve this text',
  disabled = false,
  variant = 'icon',
  size = 'sm',
  buttonClassName,
  className,
}: AskAIWrapperProps) {
  const clonedChild = cloneElement(children, {
    className: cn(children.props.className, 'pr-10'),
  })

  return (
    <div className={cn('relative', className)}>
      {clonedChild}
      <div className='absolute right-2 top-2 bottom-2 flex flex-col-reverse justify-between items-end'>
        <AskAIButton value={value} onResult={onResult} instruction={instruction} disabled={disabled} variant={variant} size={size} className={buttonClassName} />
        {onClear && value && (
          <Button type='button' variant='ghost' size={size === 'sm' ? 'sm' : 'default'} onClick={onClear} className={cn('h-6 w-6 p-0 hover:bg-muted/50', size !== 'sm' && 'h-8 w-8')} title='Clear'>
            <X className='h-3 w-3' />
          </Button>
        )}
      </div>
    </div>
  )
}
