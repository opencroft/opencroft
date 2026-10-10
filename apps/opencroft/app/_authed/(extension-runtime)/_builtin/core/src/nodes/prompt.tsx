import { dispatch } from '@opencroft/client/actions'
import { NodeFrame, OutputHandle } from '@opencroft/client/canvas'
import { getStream, type Stream, type TextChunk } from '@opencroft/client/streams'
import { Button, Textarea } from '@opencroft/client/ui'
import { MessageCircle, Send } from 'lucide-react'
import { type ChangeEvent, type KeyboardEvent, useCallback, useState } from 'react'
import { toast } from 'sonner'

export interface PromptData {
  text: string
}

export function PromptNode({ id, data, selected }: { id: string; data: PromptData; selected?: boolean }) {
  const [input, setInput] = useState(data.text ?? '')

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text) {
      return
    }
    try {
      await dispatch(id, 'send', { text })
      setInput('')
    } catch (err) {
      toast.error(`Send failed: ${String(err)}`)
    }
  }, [id, input])

  return (
    <NodeFrame
      icon={MessageCircle}
      title='Prompt'
      selected={selected ?? false}
      output={<OutputHandle type='text-stream' id='text-out' />}
      extra={
        <div className='nodrag nopan flex items-center gap-1 flex-1 w-xs'>
          <Textarea
            placeholder='Type a prompt…'
            value={input}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            className='flex-1 resize-none min-h-0 border-0 bg-transparent focus-visible:ring-0 shadow-none'
          />
          <Button variant='ghost' size='icon-lg' onClick={send} disabled={!input.trim()} title='Send'>
            <Send className='h-4 w-4' />
          </Button>
        </div>
      }
    />
  )
}

export function PromptInspector() {
  return null
}

export const PROMPT_HANDLES = [{ id: 'text-out', handleType: 'text-stream', role: 'source' as const, label: 'Text' }]

export function promptExposeOutput(
  handleId: string,
  _data: unknown,
  _type: string,
  nodeId: string,
): Stream<TextChunk> | undefined {
  if (handleId === 'text-out') {
    return getStream<TextChunk>(nodeId, 'text-out')
  }
  return undefined
}
