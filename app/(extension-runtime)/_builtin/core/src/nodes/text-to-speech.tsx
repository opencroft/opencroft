import {
  React,
  NodeFrame,
  InputHandle,
  OutputHandle,
  broadcast,
  getStream,
  icons,
  subscribe,
  toast,
  useNodeContext,
  type AudioChunk,
  type Stream,
  type TextChunk,
} from '@ext/host';

import {
  createSentenceAccumulator,
  flushAccumulator,
  takeSentences,
} from '../sentences';
import { AssistantSelector, useAssistant } from './openai-assistant';

const { useEffect, useRef, useState } = React;

export interface TextToSpeechData {
  assistantId: string;
  splitSentences: boolean;
}

function pcmMime(sampleRate: number, bitDepth: number): string {
  return `audio/pcm;rate=${sampleRate};bits=${bitDepth}`;
}

async function streamSynthesize(
  sentence: string,
  assistant: ReturnType<typeof useAssistant>,
  onPcmChunk: (chunk: Uint8Array) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!assistant) {
    throw new Error('No assistant configured');
  }
  const bitDepth = assistant.pcmBitDepth === 32 ? 32 : 16;
  const bytesPerSample = bitDepth / 8;

  const res = await fetch('/api/openai-speech-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiBase: assistant.ttsApiBase || 'https://api.openai.com/v1',
      apiKey: assistant.ttsApiKey,
      model: assistant.ttsModel,
      voice: assistant.voice,
      input: sentence,
      format: 'pcm',
      speed: typeof assistant.ttsSpeed === 'number' ? assistant.ttsSpeed : 1.0,
      stream: true,
      instructions: assistant.ttsInstructions?.trim() || undefined,
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
  }
  const reader = res.body.getReader();
  let leftover: Uint8Array | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    let bytes: Uint8Array = value;
    if (leftover) {
      const merged = new Uint8Array(leftover.byteLength + value.byteLength);
      merged.set(leftover);
      merged.set(value, leftover.byteLength);
      bytes = merged;
      leftover = null;
    }
    const aligned = bytes.byteLength - (bytes.byteLength % bytesPerSample);
    if (aligned < bytes.byteLength) {
      leftover = bytes.slice(aligned);
    }
    if (aligned === 0) {
      continue;
    }
    onPcmChunk(bytes.subarray(0, aligned));
  }
}

export function TextToSpeechNode({ id, data, selected }: { id: string; data: TextToSpeechData; selected?: boolean }) {
  const inbound = useNodeContext<Stream<TextChunk>>(id, 'text-in');
  const assistant = useAssistant(data.assistantId);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const stream = inbound?.value;
    if (!stream) {
      return;
    }
    const out = getStream<AudioChunk>(id, 'audio-out');
    const acc = createSentenceAccumulator();
    const splitSentences = data.splitSentences !== false;

    const speak = async (sentence: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      const sampleRate = assistant?.pcmSampleRate || 24000;
      const bitDepth = assistant?.pcmBitDepth === 32 ? 32 : 16;
      const mime = pcmMime(sampleRate, bitDepth);
      let pending: Blob | null = null;
      try {
        await streamSynthesize(
          sentence,
          assistant,
          (chunk: Uint8Array) => {
            if (pending) {
              broadcast(out, { data: pending, final: false });
            }
            pending = new Blob([chunk as unknown as BlobPart], { type: mime });
          },
          controller.signal,
        );
        const last = pending ?? new Blob([], { type: mime });
        broadcast(out, { data: last, final: true });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          toast.error(`TTS failed: ${(err as Error).message}`);
        }
      } finally {
        setBusy(false);
      }
    };

    const enqueue = (sentence: string) => {
      queueRef.current = queueRef.current.then(() => speak(sentence));
    };

    return subscribe(stream, (chunk: TextChunk) => {
      acc.buf += chunk.text;
      if (splitSentences) {
        for (const sentence of takeSentences(acc)) {
          enqueue(sentence);
        }
      }
      if (chunk.final) {
        const rest = splitSentences ? flushAccumulator(acc) : acc.buf;
        acc.buf = '';
        if (rest.trim()) {
          enqueue(rest);
        }
      }
    });
  }, [id, inbound?.value, assistant, data.splitSentences]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const subtitle = !assistant?.ttsModel?.trim()
    ? 'no assistant'
    : !inbound
      ? 'No input'
      : busy
        ? 'Speaking'
        : 'Listening';

  return (
    <NodeFrame
      icon={icons.Speech}
      title='Text to Speech'
      subtitle={subtitle}
      selected={selected ?? false}
      loading={busy}
      input={<InputHandle type='text-stream' id='text-in' />}
      output={<OutputHandle type='audio-stream' id='audio-out' />}
    />
  );
}

export function TextToSpeechInspector({ data, updateData }: { nodeId: string; data: TextToSpeechData; updateData: (p: Partial<TextToSpeechData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <label className='flex flex-col gap-1 text-xs'>
        <span>Assistant</span>
        <AssistantSelector
          value={data.assistantId ?? ''}
          onChange={(v: string) => updateData({ assistantId: v })}
        />
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.splitSentences !== false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ splitSentences: e.target.checked })}
        />
        Split into sentences (speak earlier)
      </label>
    </div>
  );
}

export const TEXT_TO_SPEECH_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Text' },
  { id: 'audio-out', contextType: 'audio-stream', role: 'source' as const, label: 'Audio' },
];

export function textToSpeechExposeOutput(handleId: string, _data: unknown, _typeId: string, nodeId: string): Stream<AudioChunk> | undefined {
  if (handleId === 'audio-out') {
    return getStream<AudioChunk>(nodeId, 'audio-out');
  }
  return undefined;
}
