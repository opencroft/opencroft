'use client'

import type { ChatMessage } from 'agent-client/fold'
import { Check, CheckCheck, X } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { Input } from 'ui/components/ui/input'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

import { ThinkingBlock } from './thinking-block'
import { ToolCallBlock } from './tool-block'
import { lookupToolView, toolViewProps, type ToolMessage, type ToolViewRegistry } from './tool-views'

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

// A permission/ask request can arrive while the user is mid-tap on something
// else. Animate it in and ignore pointer input until the entrance settles, so
// a tap meant for the chat doesn't accidentally resolve a freshly-appeared
// request.
const APPEAR_LOCKOUT_MS = 550

function AppearGuard({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setLocked(false), APPEAR_LOCKOUT_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div
      className={cn('animate-in fade-in slide-in-from-bottom-2 duration-500', locked && 'pointer-events-none')}
      aria-busy={locked}
    >
      {children}
    </div>
  )
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
      return (
        <div className='prose-chat'>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
        </div>
      )

    case 'thought':
      return <ThinkingBlock text={message.text} pending={pending} />

    case 'tool':
      return <ToolView message={message} toolViews={toolViews} hideToolCall={hideToolCalls} />

    case 'plan':
      return <PlanView message={message} />

    case 'permission': {
      const request = (
        <PermissionRequest message={message} onRespond={onRespondPermission} onRespondText={onRespondText} />
      )
      // Only guard a freshly-arrived, still-unresolved request — a resolved
      // one (e.g. replayed history on reconnect) doesn't need the entrance
      // animation or the accidental-tap lockout.
      return message.resolved ? request : <AppearGuard>{request}</AppearGuard>
    }

    case 'ask': {
      const prompt = <AskPrompt message={message} onRespond={onRespondAsk} />
      return message.resolved ? prompt : <AppearGuard>{prompt}</AppearGuard>
    }

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
  const spec = lookupToolView(toolViews, message.title)
  const props = toolViewProps(message, 'history')
  // hasContent (default true once a spec is registered) decides whether the
  // view has something to show — the component itself is only ever rendered
  // through JSX below, never called as a plain function, so this pre-render
  // check is what layout decisions key off instead of inspecting its output.
  const showCustom = spec !== undefined && (spec.hasContent ? spec.hasContent(props) : true)
  const custom = showCustom && spec ? <spec.component {...props} /> : null

  // Tools hidden: show only the custom view (<ChatView> only keeps tool messages
  // whose custom view has content, so `custom` is present here).
  if (hideToolCall) {
    return <>{custom}</>
  }
  const toolCall = <ToolCallBlock name={message.title} args={message.input} result={props.result} />
  // Nothing custom to show (yet) → just the tool call.
  if (!custom) {
    return toolCall
  }
  if (spec?.display === 'replace') {
    return <>{custom}</>
  }
  return (
    <Flex withGaps className='gap-2'>
      {spec?.display === 'before' ? (
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
