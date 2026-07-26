import type { React } from '@ext/host'
import { Input, Label, ScrollArea } from '@ext/ui'

import type { AgentData } from './agent'
import { KeyValueEditor } from './key-value-editor'

// Speech-recognition (speech-to-text) profile of an agent: an OpenAI-compatible
// transcription endpoint (`<base>/audio/transcriptions`). Consumers (e.g. audio
// nodes) read these fields from the agent node's data by node type — nothing
// here is specific to any one consumer.
export function AgentSpeechRecognitionTab({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
}) {
  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <div className='flex flex-col gap-1'>
          <Label>API Base</Label>
          <Input
            value={data.asrApiBase ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ asrApiBase: e.target.value })}
            placeholder='http://localhost:8881/v1'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>API Key</Label>
          <Input
            type='password'
            value={data.asrApiKey ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ asrApiKey: e.target.value })}
            placeholder='not-needed'
          />
        </div>
        <KeyValueEditor
          label='Request headers (optional)'
          entries={data.asrHeaders ?? []}
          onChange={(asrHeaders) => updateData({ asrHeaders })}
          valuePlaceholder='value or secret:NAME'
        />
        <div className='flex flex-col gap-1'>
          <Label>Model</Label>
          <Input
            value={data.asrModel ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ asrModel: e.target.value })}
            placeholder='Qwen/Qwen3-ASR-0.6B'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Language (optional)</Label>
          <Input
            value={data.asrLanguage ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ asrLanguage: e.target.value })}
            placeholder='auto-detect (e.g. en, ru)'
          />
        </div>
      </div>
    </ScrollArea>
  )
}
