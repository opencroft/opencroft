'use client'

import type { ChatMessage } from 'agent-client/fold'
import { Check, CheckCheck, X } from 'lucide-react'
import { useState } from 'react'
import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { Input } from 'ui/components/ui/input'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

import { ThinkingBlock } from './thinking-block'
import { ToolCallBlock } from './tool-block'
import type { ToolMessage, ToolViewRegistry } from './tool-views'

export type PermissionMessage = Extract<ChatMessage, { kind: 'permission' }>
export type AskMessage = Extract<ChatMessage, { kind: 'ask' }>
export type PlanMessage = Extract<ChatMessage, { kind: 'plan' }>

export interface MessageHandlers {
  onRespondPermission: (requestId: string, optionId?: string) => void
  onRespondAsk: (requestId: string, answer?: string) => void
  // Deny the pending tool and tell the agent what to do differently.
  onRespondText?: (requestId: string, text: string) => void
}

export function statusVariant(status: string): 'secondary' | 'destructive' | 'outline' {
  if (status === 'completed') return 'secondary'
  if (status === 'failed') return 'destructive'
  return 'outline'
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// Renders a single non-user message (assistant text, thought, tool call, plan,
// permission, ask, or error). User turns are rendered by <ChatView> as bubbles.
export function MessageView({
  message,
  toolViews,
  hideToolCalls,
  pending,
  onRespondPermission,
  onRespondAsk,
  onRespondText,
}: {
  message: ChatMessage
  toolViews: ToolViewRegistry
  hideToolCalls?: boolean
  // True while this is the active message and the turn is still generating.
  pending?: boolean
} & MessageHandlers) {
  switch (message.kind) {
    case 'assistant':
      return <div className='text-sm whitespace-pre-wrap wrap-break-word'>{message.text}</div>

    case 'thought':
      return <ThinkingBlock text={message.text} pending={pending} />

    case 'tool':
      return <ToolView message={message} toolViews={toolViews} hideToolCall={hideToolCalls} />

    case 'plan':
      return <PlanView message={message} />

    case 'permission':
      return <PermissionRequest message={message} onRespond={onRespondPermission} onRespondText={onRespondText} />

    case 'ask':
      return <AskPrompt message={message} onRespond={onRespondAsk} />

    case 'error':
      return (
        <div className='rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive whitespace-pre-wrap wrap-break-word'>
          {message.text}
        </div>
      )

    default:
      return null
  }
}

export function PlanView({ message }: { message: PlanMessage }) {
  return (
    <Flex withGaps className='rounded-md border p-2 text-sm gap-1'>
      {message.entries.map((entry) => (
        <Flex row key={entry.content} align='center' className='gap-2'>
          <Badge variant={statusVariant(entry.status)} className='shrink-0'>
            {entry.status}
          </Badge>
          <span className={cn(entry.status === 'completed' && 'line-through text-muted-foreground')}>
            {entry.content}
          </span>
        </Flex>
      ))}
    </Flex>
  )
}

export function PermissionRequest({
  message,
  onRespond,
  onRespondText,
}: {
  message: PermissionMessage
  onRespond: (requestId: string, optionId?: string) => void
  onRespondText?: (requestId: string, text: string) => void
}) {
  const [feedback, setFeedback] = useState('')
  const allow = message.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow')
  const allowAlways = message.options.find((option) => option.kind === 'allow_always')
  const reject = message.options.find((option) => option.kind.startsWith('reject'))

  const tellDifferent = () => {
    const text = feedback.trim()
    if (!text) return
    onRespondText?.(message.requestId, text)
    setFeedback('')
  }

  return (
    <Flex withGaps className='rounded-md border p-3 text-sm gap-2'>
      <span className='font-medium'>Permission: {message.title}</span>
      {message.resolved ? (
        <span className='text-xs text-muted-foreground'>
          Resolved{message.resolvedOptionId ? ` · ${message.resolvedOptionId}` : ' · cancelled'}
        </span>
      ) : (
        <Flex className='gap-1.5'>
          {allow && (
            <Button size='sm' onClick={() => onRespond(message.requestId, allow.id)} className='justify-start w-full'>
              <Check /> Allow
            </Button>
          )}
          {allowAlways && (
            <Button
              size='sm'
              variant='secondary'
              onClick={() => onRespond(message.requestId, allowAlways.id)}
              className='justify-start w-full'
            >
              <CheckCheck /> {allowAlways.label}
            </Button>
          )}
          <Button
            size='sm'
            variant='outline'
            onClick={() => onRespond(message.requestId, reject?.id)}
            className='justify-start w-full'
          >
            <X /> Reject
          </Button>
          {onRespondText && (
            <Input
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  tellDifferent()
                }
              }}
              placeholder='Tell what to do different (Enter)'
              className='h-8'
            />
          )}
        </Flex>
      )}
    </Flex>
  )
}

export function AskPrompt({
  message,
  onRespond,
}: {
  message: AskMessage
  onRespond: (requestId: string, answer?: string) => void
}) {
  const [answer, setAnswer] = useState('')
  return (
    <Flex withGaps className='rounded-md border p-3 text-sm gap-2'>
      <span className='whitespace-pre-wrap wrap-break-word'>{message.message}</span>
      {message.resolved ? (
        <span className='text-xs text-muted-foreground'>Answered</span>
      ) : (
        <Flex row className='gap-2'>
          <Input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRespond(message.requestId, answer)
            }}
            placeholder='Your answer…'
          />
          <Button size='sm' onClick={() => onRespond(message.requestId, answer)}>
            Send
          </Button>
          <Button size='sm' variant='ghost' onClick={() => onRespond(message.requestId)}>
            Skip
          </Button>
        </Flex>
      )}
    </Flex>
  )
}

export function ToolView({
  message,
  toolViews,
  hideToolCall,
}: {
  message: ToolMessage
  toolViews: ToolViewRegistry
  hideToolCall?: boolean
}) {
  const view = toolViews[message.title]
  const custom = view?.render(message) ?? null

  // Tools hidden: show only the custom view (<ChatView> only keeps tool messages
  // whose custom view renders, so `custom` is present here).
  if (hideToolCall) {
    return <>{custom}</>
  }
  // A settled call (or one that already has output) shows its result; until then
  // ToolCallBlock renders a running indicator (no `result`).
  const settled = message.status === 'completed' || message.status === 'failed'
  const toolCall = (
    <ToolCallBlock
      name={message.title}
      args={message.input}
      result={
        settled || message.output !== undefined
          ? {
              text: message.output === undefined ? '' : formatValue(message.output),
              isError: message.status === 'failed',
            }
          : undefined
      }
    />
  )
  // Nothing custom to show (yet) → just the tool call.
  if (!custom) {
    return toolCall
  }
  if (view?.display === 'replace') {
    return <>{custom}</>
  }
  return (
    <Flex withGaps className='gap-2'>
      {view?.display === 'before' ? (
        <>
          {custom}
          {toolCall}
        </>
      ) : (
        <>
          {toolCall}
          {custom}
        </>
      )}
    </Flex>
  )
}
