import {
  React,
  NodeFrame,
  InputHandle,
  icons,
  subscribe,
  toast,
  useNodeContext,
  type AudioChunk,
  type Stream,
} from '@ext/host';

const { useCallback, useEffect, useRef, useState } = React;

export type SpeakerData = Record<string, never>;

interface PcmMeta {
  sampleRate: number;
  bitDepth: number;
}

function parsePcmMeta(type: string): PcmMeta | null {
  if (!type.startsWith('audio/pcm')) {
    return null;
  }
  const rateMatch = /rate=(\d+)/.exec(type);
  const bitsMatch = /bits=(\d+)/.exec(type);
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const bitDepth = bitsMatch ? Number(bitsMatch[1]) : 16;
  return { sampleRate, bitDepth };
}

function pcmBytesToFloat32(bytes: ArrayBuffer, bitDepth: number): Float32Array {
  const view = new DataView(bytes);
  if (bitDepth === 32) {
    const samples = Math.floor(bytes.byteLength / 4);
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i += 1) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export function SpeakerNode({ id, selected }: { id: string; data: SpeakerData; selected?: boolean }) {
  const inbound = useNodeContext<Stream<AudioChunk>>(id, 'audio-in');
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartRef = useRef<number>(0);
  const playEndRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);

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
      for (let i = 0; i < barCount; i += 1) {
        const v = data[Math.floor((i / barCount) * bins)] / 255;
        const bh = Math.max(1, v * h);
        g.fillStyle = `oklch(0.72 0.18 ${40 + v * 40})`;
        g.fillRect(i * barW, h - bh, barW - 1, bh);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    tick();
  }, []);

  const ensureContext = useCallback((sampleRate?: number): { ctx: AudioContext; analyser: AnalyserNode } | null => {
    let ctx = ctxRef.current;
    if (ctx && sampleRate && ctx.sampleRate !== sampleRate) {
      ctx.close().catch(() => {});
      ctx = null;
      ctxRef.current = null;
    }
    if (!ctx) {
      ctx = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext();
      ctxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.75;
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      nextStartRef.current = 0;
      drawSpectrum();
    }
    const analyser = analyserRef.current;
    if (!analyser) {
      return null;
    }
    return { ctx, analyser };
  }, [drawSpectrum]);

  useEffect(() => {
    const stream = inbound?.value;
    if (!stream) {
      return;
    }
    const playPcm = (bytes: ArrayBuffer, meta: PcmMeta) => {
      const handle = ensureContext(meta.sampleRate);
      if (!handle) {
        return;
      }
      const { ctx, analyser } = handle;
      const floats = pcmBytesToFloat32(bytes, meta.bitDepth);
      if (floats.length === 0) {
        return;
      }
      const buffer = ctx.createBuffer(1, floats.length, meta.sampleRate);
      buffer.getChannelData(0).set(floats);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      const startAt = Math.max(ctx.currentTime, nextStartRef.current);
      src.start(startAt);
      nextStartRef.current = startAt + buffer.duration;
      playEndRef.current = nextStartRef.current;
      setPlaying(true);
    };

    const playEncoded = async (blob: Blob) => {
      const handle = ensureContext();
      if (!handle) {
        return;
      }
      const { ctx, analyser } = handle;
      try {
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(analyser);
        const startAt = Math.max(ctx.currentTime, nextStartRef.current);
        src.start(startAt);
        nextStartRef.current = startAt + buf.duration;
        playEndRef.current = nextStartRef.current;
        setPlaying(true);
      } catch (err) {
        toast.error(`Audio decode failed: ${(err as Error).message}`);
      }
    };

    return subscribe(stream, (chunk: AudioChunk) => {
      const blob = chunk.data;
      if (blob.size === 0) {
        return;
      }
      const meta = parsePcmMeta(blob.type);
      if (meta) {
        void blob.arrayBuffer().then((bytes) => playPcm(bytes, meta));
        return;
      }
      void playEncoded(blob);
    });
  }, [inbound?.value, ensureContext]);

  useEffect(() => {
    if (!playing) {
      return;
    }
    const poll = setInterval(() => {
      const ctx = ctxRef.current;
      if (!ctx) {
        return;
      }
      if (ctx.currentTime >= playEndRef.current) {
        setPlaying(false);
      }
    }, 100);
    return () => clearInterval(poll);
  }, [playing]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      ctxRef.current?.close();
      ctxRef.current = null;
    };
  }, []);

  const subtitle = !inbound ? 'No input' : playing ? 'Playing' : 'Listening';

  return (
    <NodeFrame
      icon={icons.AudioLines}
      title='Speaker'
      subtitle={subtitle}
      selected={selected ?? false}
      loading={playing}
      input={<InputHandle type='audio-stream' id='audio-in' />}
      extra={inbound ? (
        <canvas
          ref={canvasRef}
          width={200}
          height={24}
          className='nodrag nopan h-6 w-[200px] rounded-sm bg-black/40'
        />
      ) : undefined}
    />
  );
}

export function SpeakerInspector() {
  return null;
}

export const SPEAKER_HANDLES = [
  { id: 'audio-in', contextType: 'audio-stream', role: 'target' as const, label: 'Audio' },
];
