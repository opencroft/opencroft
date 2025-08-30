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

import { streamTranscribe } from '../asr';

const { useEffect, useRef, useState } = React;

export interface AsrData {
  model: string;
  url: string;
}

interface PcmMeta {
  sampleRate: number;
  bitDepth: number;
}

function parsePcmMeta(type: string): PcmMeta | null {
  if (!type.startsWith('audio/pcm')) {
    return null;
  }
  const rate = /rate=(\d+)/.exec(type);
  const bits = /bits=(\d+)/.exec(type);
  return {
    sampleRate: rate ? Number(rate[1]) : 24000,
    bitDepth: bits ? Number(bits[1]) : 16,
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function pcmToWav(pcm: Uint8Array, meta: PcmMeta): Blob {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(pos + i, s.charCodeAt(i));
    }
  };
  const bytesPerSample = meta.bitDepth / 8;
  const formatCode = meta.bitDepth === 32 ? 3 : 1;
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, meta.sampleRate, true);
  view.setUint32(28, meta.sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, meta.bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return new Blob([wav as unknown as BlobPart], { type: 'audio/wav' });
}

export function AsrNode({ id, data, selected }: { id: string; data: AsrData; selected?: boolean }) {
  const inbound = useNodeContext<Stream<AudioChunk>>(id, 'audio-in');
  const [busy, setBusy] = useState(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const bufferRef = useRef<Uint8Array[]>([]);
  const mimeRef = useRef<string>('');

  useEffect(() => {
    const stream = inbound?.value;
    if (!stream) {
      return;
    }
    const out = getStream<TextChunk>(id, 'text-out');

    const transcribe = async () => {
      const parts = bufferRef.current;
      const mime = mimeRef.current || 'audio/wav';
      bufferRef.current = [];
      mimeRef.current = '';
      if (parts.length === 0) {
        return;
      }
      setBusy(true);
      try {
        const pcm = parsePcmMeta(mime);
        const blob = pcm
          ? pcmToWav(concatBytes(parts), pcm)
          : new Blob(parts as unknown as BlobPart[], { type: mime });
        await streamTranscribe({
          blob,
          model: data.model,
          url: data.url,
          onToken: (piece: string) => broadcast(out, { text: piece, final: false }),
        });
        broadcast(out, { text: '', final: true });
      } catch (err) {
        toast.error(`ASR failed: ${(err as Error).message}`);
      } finally {
        setBusy(false);
      }
    };

    return subscribe(stream, (chunk: AudioChunk) => {
      queueRef.current = queueRef.current.then(async () => {
        const bytes = new Uint8Array(await chunk.data.arrayBuffer());
        if (bytes.byteLength > 0) {
          bufferRef.current.push(bytes);
          if (!mimeRef.current) {
            mimeRef.current = chunk.data.type;
          }
        }
        if (chunk.final) {
          await transcribe();
        }
      });
    });
  }, [id, inbound?.value, data.model, data.url]);

  return (
    <NodeFrame
      icon={icons.Ear}
      title='Speech Recognition'
      subtitle={inbound ? (busy ? 'Transcribing…' : 'Listening') : 'No input'}
      selected={selected ?? false}
      loading={busy}
      input={<InputHandle type='audio-stream' id='audio-in' />}
      output={<OutputHandle type='text-stream' id='text-out' />}
    />
  );
}

export function AsrInspector({ data, updateData }: { nodeId: string; data: AsrData; updateData: (p: Partial<AsrData>) => void }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='flex flex-col gap-1 text-xs'>
        <span>Model</span>
        <input
          className='h-8 rounded border bg-transparent px-2 text-xs'
          value={data.model ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ model: e.target.value })}
          placeholder='Qwen/Qwen3-ASR-0.6B'
        />
      </label>
      <label className='flex flex-col gap-1 text-xs'>
        <span>URL (optional)</span>
        <input
          className='h-8 rounded border bg-transparent px-2 text-xs'
          value={data.url ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ url: e.target.value })}
          placeholder='/api/asr/transcribe'
        />
      </label>
    </div>
  );
}

export const ASR_HANDLES = [
  { id: 'audio-in', contextType: 'audio-stream', role: 'target' as const, label: 'Audio' },
  { id: 'text-out', contextType: 'text-stream', role: 'source' as const, label: 'Text' },
];

export function asrExposeOutput(handleId: string, _data: unknown, _typeId: string, nodeId: string): Stream<TextChunk> | undefined {
  if (handleId === 'text-out') {
    return getStream<TextChunk>(nodeId, 'text-out');
  }
  return undefined;
}
