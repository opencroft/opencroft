import {
  React,
  NodeFrame,
  icons,
  useGraphNodes,
} from '@ext/host';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Slider,
  Textarea,
} from '@ext/ui';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];

export interface OpenAIAssistantData {
  name: string;
  chatApiBase: string;
  chatApiKey: string;
  chatModel: string;
  temperature: number;
  ttsApiBase: string;
  ttsApiKey: string;
  ttsModel: string;
  voice: string;
  ttsSpeed: number;
  ttsInstructions: string;
  pcmSampleRate: number;
  pcmBitDepth: 16 | 32;
  trimStartSamples: number;
  trimEndSamples: number;
}

export function OpenAIAssistantNode({ data, selected }: { data: OpenAIAssistantData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.UserRound}
      title={data.name || 'AI Assistant'}
      subtitle={`${data.chatModel || '—'} · ${data.ttsModel || '—'}`}
      selected={selected ?? false}
    >
      <div className='flex flex-col gap-0.5 text-[10px] font-mono text-muted-foreground'>
        {data.chatApiBase ? <div className='truncate'>chat: {data.chatApiBase}</div> : null}
        {data.ttsApiBase ? <div className='truncate'>tts: {data.ttsApiBase}</div> : null}
      </div>
    </NodeFrame>
  );
}

export function OpenAIAssistantInspector({
  data, updateData,
}: { nodeId: string; data: OpenAIAssistantData; updateData: (p: Partial<OpenAIAssistantData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='My Assistant'
        />
      </div>

      <Label className='text-xs font-semibold mt-1'>Chat</Label>
      <div className='flex flex-col gap-1'>
        <Label>API Base</Label>
        <Input
          value={data.chatApiBase ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ chatApiBase: e.target.value })}
          placeholder='https://api.openai.com/v1'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>API Key</Label>
        <Input
          type='password'
          value={data.chatApiKey ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ chatApiKey: e.target.value })}
          placeholder='sk-…'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Model</Label>
        <Input
          value={data.chatModel ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ chatModel: e.target.value })}
          placeholder='gpt-4o-mini'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Temperature</Label>
        <Input
          type='number'
          step='0.1'
          min='0'
          max='2'
          value={data.temperature ?? 0.7}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ temperature: Number(e.target.value) })}
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Speech</Label>
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
          list='openai-assistant-voices'
        />
        <datalist id='openai-assistant-voices'>
          {VOICES.map((v) => <option key={v} value={v} />)}
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
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ pcmSampleRate: Number(e.target.value) || 24000 })}
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>PCM Bit Depth</Label>
        <Select
          value={String(data.pcmBitDepth ?? 16)}
          onValueChange={(v: string) => updateData({ pcmBitDepth: Number(v) === 32 ? 32 : 16 })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
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
  );
}

interface AssistantNode {
  id: string;
  type?: string;
  data: OpenAIAssistantData;
}

export function useAssistantsList(): AssistantNode[] {
  const nodes = useGraphNodes();
  return nodes.filter((n: { type?: string }) => n.type === 'openai-assistant') as AssistantNode[];
}

export function useAssistant(assistantId?: string): OpenAIAssistantData | null {
  const list = useAssistantsList();
  if (!assistantId) {
    return null;
  }
  return list.find((n) => n.id === assistantId)?.data ?? null;
}

export function AssistantSelector({
  value, onChange,
}: { value: string; onChange: (v: string) => void }) {
  const list = useAssistantsList();
  return (
    <Select value={value || '__none'} onValueChange={(v: string) => onChange(v === '__none' ? '' : v)}>
      <SelectTrigger><SelectValue placeholder='No assistant' /></SelectTrigger>
      <SelectContent>
        <SelectItem value='__none'>No assistant</SelectItem>
        {list.map((a) => (
          <SelectItem key={a.id} value={a.id}>{a.data.name || a.id}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
