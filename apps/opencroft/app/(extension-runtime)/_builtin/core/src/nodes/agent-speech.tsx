import { type React } from '@ext/host'
import {
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Textarea,
} from '@ext/ui'

import type { AgentData } from './agent'

// Suggested voices for OpenAI-compatible speech endpoints.
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']

// Speech (text-to-speech) profile of an agent: an OpenAI-compatible speech
// endpoint plus output-format knobs. Consumers (e.g. audio nodes) read these
// fields from the agent node's data by node type — nothing here is specific
// to any one consumer.
export function AgentSpeechTab({
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
            value={data.ttsApiBase ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsApiBase: e.target.value })}
            placeholder='http://localhost:8880/v1'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>API Key</Label>
          <Input
            type='password'
            value={data.ttsApiKey ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsApiKey: e.target.value })}
            placeholder='not-needed'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Model</Label>
          <Input
            value={data.ttsModel ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsModel: e.target.value })}
            placeholder='0.6B-CustomVoice'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Voice</Label>
          <Input
            value={data.voice ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ voice: e.target.value })}
            placeholder='Vivian'
            list='agent-speech-voices'
          />
          <datalist id='agent-speech-voices'>
            {VOICES.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Speed</Label>
          <Input
            type='number'
            step='0.25'
            min='0.25'
            max='4'
            value={data.ttsSpeed ?? 1.0}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsSpeed: Number(e.target.value) })}
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Voice Instructions</Label>
          <Textarea
            value={data.ttsInstructions ?? ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ ttsInstructions: e.target.value })}
            placeholder='Speak cheerfully, like a friendly radio host.'
            className='text-xs min-h-[60px]'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>PCM Sample Rate (Hz)</Label>
          <Input
            type='number'
            step='1000'
            min='8000'
            max='48000'
            value={data.pcmSampleRate ?? 24000}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              updateData({ pcmSampleRate: Number(e.target.value) || 24000 })
            }
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>PCM Bit Depth</Label>
          <Select
            value={String(data.pcmBitDepth ?? 16)}
            onValueChange={(v: string) => updateData({ pcmBitDepth: Number(v) === 32 ? 32 : 16 })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='16'>int16 LE (OpenAI)</SelectItem>
              <SelectItem value='32'>float32 LE (Qwen)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Trim Start ({data.trimStartSamples ?? 0} samples)</Label>
          <Slider
            value={[data.trimStartSamples ?? 0]}
            min={0}
            max={4800}
            step={24}
            onValueChange={(v: number[]) => updateData({ trimStartSamples: v[0] })}
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Trim End ({data.trimEndSamples ?? 0} samples)</Label>
          <Slider
            value={[data.trimEndSamples ?? 0]}
            min={0}
            max={4800}
            step={24}
            onValueChange={(v: number[]) => updateData({ trimEndSamples: v[0] })}
          />
        </div>
      </div>
    </ScrollArea>
  )
}
