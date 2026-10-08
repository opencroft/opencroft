import { legacy } from '@opencroft/client'

const {
  Input,
  Label,
  React,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Textarea,
  invoke,
} = legacy

import type { AgentData } from './agent'
import { KeyValueEditor } from './key-value-editor'

const { useCallback, useEffect, useState } = React

// Suggested voices for OpenAI-compatible speech endpoints that expose no
// `/audio/voices` list of their own.
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer']

// What the endpoint supports, probed server-side from `<base>/audio/voices` and
// its OpenAPI schema (see core `tts.capabilities`). Lets the tab offer the real
// voice presets and only show / enable knobs the endpoint actually accepts.
interface TtsCapabilities {
  voices: string[]
  supportsInstructions: boolean
  supportsTemperature: boolean
  supportsSeed: boolean
  schemaKnown: boolean
}

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
  const [caps, setCaps] = useState<TtsCapabilities | null>(null)

  const loadCaps = useCallback(async () => {
    if (!data.ttsApiBase?.startsWith('http')) {
      setCaps(null)
      return
    }
    try {
      setCaps(
        await invoke<TtsCapabilities>('tts.capabilities', {
          baseUrl: data.ttsApiBase,
          apiKey: data.ttsApiKey,
          headers: data.ttsHeaders,
        }),
      )
    } catch {
      setCaps(null)
    }
    // Serialised: the probe has to re-run when a header is edited, and the
    // array identity changes on every keystroke.
  }, [data.ttsApiBase, data.ttsApiKey, JSON.stringify(data.ttsHeaders ?? [])])

  // Refresh whenever the endpoint, key or headers change — voices and
  // supported knobs are endpoint-specific, and an authenticated endpoint
  // reports neither until the headers are right.
  useEffect(() => {
    loadCaps()
  }, [loadCaps])

  const voices = caps?.voices ?? []
  const voiceOptions = Array.from(new Set([...(data.voice ? [data.voice] : []), ...voices]))
  const instructionsBlocked = Boolean(caps?.schemaKnown && !caps.supportsInstructions)

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        <div className='flex flex-col gap-1'>
          <Label>API Base</Label>
          <Input
            autoComplete='off'
            value={data.ttsApiBase ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsApiBase: e.target.value })}
            placeholder='http://localhost:8880/v1'
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>API Key</Label>
          {/* Not a login: the browser is told so, or it offers saved passwords here. */}
          <Input
            type='password'
            autoComplete='one-time-code'
            value={data.ttsApiKey ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsApiKey: e.target.value })}
            placeholder='not-needed'
          />
        </div>
        <KeyValueEditor
          label='Request headers (optional)'
          entries={data.ttsHeaders ?? []}
          onChange={(ttsHeaders) => updateData({ ttsHeaders })}
          valuePlaceholder='value or secret:NAME'
        />
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
          {voices.length > 0 ? (
            <Select
              value={data.voice ?? ''}
              onValueChange={(v) => {
                if (v !== null) {
                  updateData({ voice: v })
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder='Select a voice' />
              </SelectTrigger>
              <SelectContent>
                {voiceOptions.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <>
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
            </>
          )}
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
            placeholder={
              instructionsBlocked ? 'Not supported by this endpoint' : 'Speak cheerfully, like a friendly radio host.'
            }
            className='text-xs min-h-[60px]'
            disabled={instructionsBlocked}
          />
          {instructionsBlocked ? (
            <span className='text-[10px] text-muted-foreground'>This endpoint does not accept voice instructions.</span>
          ) : null}
        </div>
        {caps?.supportsTemperature ? (
          <div className='flex flex-col gap-1'>
            <Label>Temperature</Label>
            <Input
              type='number'
              step='0.05'
              min='0'
              max='2'
              value={data.ttsTemperature ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                updateData({ ttsTemperature: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              placeholder='1.0'
            />
          </div>
        ) : null}
        {caps?.supportsSeed ? (
          <div className='flex flex-col gap-1'>
            <Label>Seed</Label>
            <Input
              type='number'
              step='1'
              value={data.ttsSeed ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                updateData({ ttsSeed: e.target.value === '' ? undefined : Math.floor(Number(e.target.value)) })
              }
              placeholder='(random)'
            />
          </div>
        ) : null}
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
            items={{ '16': 'int16 LE (OpenAI)', '32': 'float32 LE (Qwen)' }}
            onValueChange={(v) => {
              if (v !== null) {
                updateData({ pcmBitDepth: Number(v) === 32 ? 32 : 16 })
              }
            }}
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
            onValueChange={(v) => updateData({ trimStartSamples: Array.isArray(v) ? v[0] : v })}
          />
        </div>
        <div className='flex flex-col gap-1'>
          <Label>Trim End ({data.trimEndSamples ?? 0} samples)</Label>
          <Slider
            value={[data.trimEndSamples ?? 0]}
            min={0}
            max={4800}
            step={24}
            onValueChange={(v) => updateData({ trimEndSamples: Array.isArray(v) ? v[0] : v })}
          />
        </div>
      </div>
    </ScrollArea>
  )
}
