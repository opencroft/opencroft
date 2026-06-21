import {
  getStream,
  InputHandle,
  icons,
  NodeFrame,
  OutputHandle,
  type React,
  type Stream,
  type TextChunk,
} from '@ext/host'

import { AssistantSelector, useAssistant } from './openai-assistant'

export interface TextGenerationData {
  assistantId: string
  systemPrompt: string
}

// Runs on the backend: when an inbound text-stream completes, the `text-in`
// handle's `streamAction` dispatches the `text-generation.run` node action,
// which calls the model server-side and broadcasts the reply on `text-out`.
export function TextGenerationNode({ data, selected }: { id: string; data: TextGenerationData; selected?: boolean }) {
  const assistant = useAssistant(data.assistantId)
  const subtitle = assistant?.chatModel?.trim() ? assistant.chatModel : 'No assistant'

  return (
    <NodeFrame
      icon={icons.Sparkles}
      title='Text Generation'
      subtitle={subtitle}
      selected={selected ?? false}
      input={<InputHandle type='text-stream' id='text-in' />}
      output={<OutputHandle type='text-stream' id='text-out' />}
    />
  )
}

export function TextGenerationInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: TextGenerationData
  updateData: (p: Partial<TextGenerationData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1 text-xs'>
        <span>Assistant</span>
        <AssistantSelector value={data.assistantId ?? ''} onChange={(v: string) => updateData({ assistantId: v })} />
      </div>
      <label className='flex flex-col gap-1 text-xs'>
        <span>System Prompt (optional)</span>
        <textarea
          value={data.systemPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ systemPrompt: e.target.value })}
          placeholder='You are a helpful assistant.'
          className='min-h-[80px] rounded border bg-transparent px-2 py-1 text-xs font-mono'
        />
      </label>
    </div>
  )
}

export const TEXT_GENERATION_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Prompt', streamAction: 'run' },
  { id: 'text-out', contextType: 'text-stream', role: 'source' as const, label: 'Text' },
]

export function textGenerationExposeOutput(
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
