import {
  React,
  NodeFrame,
  icons,
  toast,
} from '@ext/host';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@ext/ui';

import { AssistantSelector, useAssistant } from './openai-assistant';

const { useCallback, useEffect, useRef, useState } = React;

export interface OpenAIAudioData {
  assistantId: string;
  input: string;
  format: string;
}

const FORMATS: { value: string; label: string }[] = [
  { value: 'mp3', label: 'mp3' },
  { value: 'opus', label: 'opus' },
  { value: 'aac', label: 'aac' },
  { value: 'flac', label: 'flac' },
  { value: 'wav', label: 'wav' },
  { value: 'pcm', label: 'pcm (stream)' },
];

const MEDIA_SOURCE_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  opus: 'audio/webm; codecs="opus"',
};

function supportsMediaSource(format: string): boolean {
  if (typeof MediaSource === 'undefined') {
    return false;
  }
  const mime = MEDIA_SOURCE_MIME[format];
  return !!mime && MediaSource.isTypeSupported(mime);
}

async function appendChunk(sb: SourceBuffer, chunk: Uint8Array): Promise<void> {
  if (sb.updating) {
    await new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }));
  }
  sb.appendBuffer(chunk as unknown as BufferSource);
  await new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }));
}

function pcmBytesToFloat32(bytes: Uint8Array, bitDepth: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bitDepth === 32) {
    const samples = Math.floor(bytes.byteLength / 4);
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

function concatPcmChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function pcmToWav(pcm: Uint8Array, sampleRate: number, bitDepth: number): Blob {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(pos + i, s.charCodeAt(i));
    }
  };
  const bytesPerSample = bitDepth / 8;
  const formatCode = bitDepth === 32 ? 3 : 1; // 3 = IEEE float, 1 = PCM int
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, 1, true);        // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return new Blob([wav], { type: 'audio/wav' });
}

export function OpenAIAudioNode({ data, selected }: { data: OpenAIAudioData; selected?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [blobUrl, setBlobUrl] = useState('');
  const [hasAudio, setHasAudio] = useState(false);
  const chunksRef = useRef<Uint8Array[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, [blobUrl]);

  const drawSpectrum = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) {
      return;
    }
    const g = canvas.getContext('2d');
    if (!g) {
      return;
    }
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const w = canvas.width;
      const h = canvas.height;
      g.clearRect(0, 0, w, h);
      const barCount = Math.min(32, bins);
      const barW = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = data[Math.floor((i / barCount) * bins)] / 255;
        const bh = Math.max(1, v * h);
        g.fillStyle = `oklch(0.72 0.18 ${320 - v * 60})`;
        g.fillRect(i * barW, h - bh, barW - 1, bh);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    tick();
  }, []);

  useEffect(() => {
    if (hasAudio && data.format === 'pcm' && canvasRef.current && analyserRef.current) {
      drawSpectrum();
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [hasAudio, data.format, drawSpectrum]);

  const assistant = useAssistant(data.assistantId);
  const canRun = !!assistant?.ttsModel?.trim() && !!assistant?.voice?.trim() && !!data.input?.trim();

  const run = useCallback(async () => {
    if (!canRun || !assistant) {
      return;
    }
    setRunning(true);
    setError('');
    setHasAudio(false);
    chunksRef.current = [];
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl('');
    }

    const format = data.format || 'mp3';
    const stream = format === 'pcm';
    const sampleRate = assistant.pcmSampleRate || 24000;
    const params = {
      apiBase: assistant.ttsApiBase || 'https://api.openai.com/v1',
      apiKey: assistant.ttsApiKey,
      model: assistant.ttsModel,
      voice: assistant.voice,
      input: data.input,
      format,
      speed: typeof assistant.ttsSpeed === 'number' ? assistant.ttsSpeed : 1.0,
      stream,
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/openai-speech-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }

      const audio = audioRef.current;
      if (!audio) {
        throw new Error('audio element missing');
      }

      if (format === 'pcm') {
        const bitDepth = (assistant?.pcmBitDepth ?? data.pcmBitDepth) === 32 ? 32 : 16;
        const bytesPerSample = bitDepth / 8;
        audioCtxRef.current?.close();
        const ctx = new AudioContext({ sampleRate });
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.75;
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
        setHasAudio(true);
        let nextStart = ctx.currentTime;
        let leftover: Uint8Array | null = null;
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunksRef.current.push(value);
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
          const floats = pcmBytesToFloat32(bytes.subarray(0, aligned), bitDepth);
          const buffer = ctx.createBuffer(1, floats.length, sampleRate);
          buffer.getChannelData(0).set(floats);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(analyser);
          const when = Math.max(nextStart, ctx.currentTime);
          src.start(when);
          nextStart = when + buffer.duration;
        }
        return;
      }

      const useMs = stream && supportsMediaSource(format);
      if (useMs) {
        const ms = new MediaSource();
        const url = URL.createObjectURL(ms);
        setBlobUrl(url);
        setHasAudio(true);
        audio.src = url;

        await new Promise<void>((resolve) => ms.addEventListener('sourceopen', () => resolve(), { once: true }));
        const sb = ms.addSourceBuffer(MEDIA_SOURCE_MIME[format]);

        audio.play().catch(() => {});

        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunksRef.current.push(value);
          await appendChunk(sb, value);
        }
        if (!sb.updating) {
          ms.endOfStream();
        } else {
          await new Promise<void>((resolve) => sb.addEventListener('updateend', () => resolve(), { once: true }));
          ms.endOfStream();
        }
      } else {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunksRef.current.push(value);
        }
        const blob = new Blob(chunksRef.current as unknown as BlobPart[], {
          type: MEDIA_SOURCE_MIME[format] || 'audio/mpeg',
        });
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setHasAudio(true);
        audio.src = url;
        audio.play().catch(() => {});
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        audioCtxRef.current?.close();
        audioCtxRef.current = null;
      } else {
        const msg = (err as Error).message || String(err);
        setError(msg);
        toast.error(`OpenAI TTS failed: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [canRun, data, blobUrl, assistant]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const download = useCallback(() => {
    if (chunksRef.current.length === 0) {
      return;
    }
    const format = data.format || 'mp3';
    const sampleRate = assistant?.pcmSampleRate || 24000;
    let blob: Blob;
    let filename: string;
    if (format === 'pcm') {
      const bitDepth = assistant?.pcmBitDepth === 32 ? 32 : 16;
      blob = pcmToWav(concatPcmChunks(chunksRef.current), sampleRate, bitDepth);
      filename = 'speech.wav';
    } else {
      blob = new Blob(chunksRef.current as unknown as BlobPart[], {
        type: MEDIA_SOURCE_MIME[format] || 'audio/mpeg',
      });
      filename = `speech.${format}`;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [data.format, assistant]);

  const status = error ? 'error' : hasAudio ? 'success' : 'neutral';

  return (
    <NodeFrame
      icon={icons.AudioLines}
      title='OpenAI Audio'
      subtitle={`${assistant?.ttsModel || 'no assistant'} · ${assistant?.voice || '—'}`}
      status={status}
      selected={selected ?? false}
      loading={running}
      extra={
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={running ? stop : run}
            disabled={!running && !canRun}
          >
            {running ? (
              <icons.Square className='h-2.5 w-2.5 shrink-0' />
            ) : (
              <icons.Play className='h-2.5 w-2.5 shrink-0' />
            )}
          </Button>
          {hasAudio ? (
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              onClick={download}
            >
              <icons.Download className='h-2.5 w-2.5 shrink-0' />
            </Button>
          ) : null}
        </div>
      }
    >
      <div className='flex flex-col gap-1'>
        <audio
          ref={audioRef}
          controls
          className={`nodrag nopan w-full h-8 ${hasAudio && data.format !== 'pcm' ? '' : 'hidden'}`}
        />
        {hasAudio && data.format === 'pcm' ? (
          <canvas
            ref={canvasRef}
            width={200}
            height={28}
            className='nodrag nopan w-full h-7 rounded-sm bg-black/40'
          />
        ) : !hasAudio && running ? (
          <div className='text-[10px] text-muted-foreground italic'>streaming…</div>
        ) : !hasAudio && error ? (
          <div className='text-[10px] text-destructive line-clamp-3'>{error}</div>
        ) : !hasAudio ? (
          <div className='text-[10px] text-muted-foreground italic'>no audio yet</div>
        ) : null}
      </div>
    </NodeFrame>
  );
}

export function OpenAIAudioInspector({
  data, updateData,
}: { nodeId: string; data: OpenAIAudioData; updateData: (p: Partial<OpenAIAudioData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Assistant</Label>
        <AssistantSelector
          value={data.assistantId ?? ''}
          onChange={(v: string) => updateData({ assistantId: v })}
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Format</Label>
        <Select value={data.format || 'mp3'} onValueChange={(v: string) => updateData({ format: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {FORMATS.map((f) => (
              <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Input Text</Label>
        <Textarea
          value={data.input ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ input: e.target.value })}
          placeholder='Text to synthesize…'
          className='text-xs min-h-[140px]'
        />
      </div>
    </div>
  );
}
