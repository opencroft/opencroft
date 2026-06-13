import { broadcast, getStream, icons, NodeFrame, OutputHandle, React, type Stream, type TextChunk } from '@ext/host'
import { Button, Textarea } from '@ext/ui'

const { useCallback, useState } = React

export interface PromptData {
  text: string
}

export function PromptNode({ id, data, selected }: { id: string; data: PromptData; selected?: boolean }) {
  const [input, setInput] = useState(data.text ?? '')

  const send = useCallback(() => {
    const text = input.trim()
    if (!text) {
      return
    }
    const stream = getStream<TextChunk>(id, 'text-out')
    broadcast(stream, { text, final: true })
  }, [id, input])

  return (
    <NodeFrame
      icon={icons.MessageCircle}
      title='Prompt'
      selected={selected ?? false}
      output={<OutputHandle type='text-stream' id='text-out' />}
      extra={
        <div className='nodrag nopan flex items-center gap-1 flex-1 w-xs'>
          <Textarea
            placeholder='Type a prompt…'
            value={input}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            className='flex-1 resize-none min-h-0 border-0 bg-transparent focus-visible:ring-0 shadow-none'
          />
          <Button variant='ghost' size='icon-lg' onClick={send} disabled={!input.trim()} title='Send'>
            <icons.Send className='h-4 w-4' />
          </Button>
        </div>
      }
    />
  )
}

export function PromptInspector() {
  return null
}

export const PROMPT_HANDLES = [{ id: 'text-out', contextType: 'text-stream', role: 'source' as const, label: 'Text' }]

export function promptExposeOutput(
  handleId: string,
  _data: unknown,
  _typeId: string,
  nodeId: string,
): Stream<TextChunk> | undefined {
  if (handleId === 'text-out') {
    return getStream<TextChunk>(nodeId, 'text-out')
  }
  return undefined
}
