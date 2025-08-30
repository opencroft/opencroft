import {
  React,
  NodeFrame,
  icons,
  toast,
} from '@ext/host';
import {
  Button,
  Label,
  Textarea,
} from '@ext/ui';

import {
  newScheduleState,
  type ScheduleState,
} from '../audio-pcm';
import {
  createSentenceAccumulator,
  flushAccumulator,
  takeSentences,
} from '../sentences';
import { speakSentence as ttsSpeak } from '../speak';
import { AssistantSelector, useAssistant } from './openai-assistant';

const { useCallback, useEffect, useRef, useState } = React;

export interface OpenAIChatSpeechData {
  assistantId: string;
  systemPrompt: string;
  userPrompt: string;
  splitSentences: boolean;
}

export function OpenAIChatSpeechNode({ data, selected }: { data: OpenAIChatSpeechData; selected?: boolean }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [hasSpoken, setHasSpoken] = useState(false);
  const assistant = useAssistant(data.assistantId);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const scheduleRef = useRef<ScheduleState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

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
    const freq = new Uint8Array(bins);
    const tick = () => {
      analyser.getByteFrequencyData(freq);
      const w = canvas.width;
      const h = canvas.height;
      g.clearRect(0, 0, w, h);
      const barCount = Math.min(32, bins);
      const barW = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = freq[Math.floor((i / barCount) * bins)] / 255;
        const bh = Math.max(1, v * h);
        g.fillStyle = `oklch(0.72 0.18 ${40 + v * 60})`;
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
    if (running && canvasRef.current && analyserRef.current) {
      drawSpectrum();
    }
  }, [running, drawSpectrum]);

  const canRun = !!assistant?.chatModel?.trim()
    && !!assistant?.ttsModel?.trim()
    && !!assistant?.voice?.trim()
    && !!data.userPrompt?.trim();

  const speakSentence = useCallback(async (sentence: string) => {
    const ctx = audioCtxRef.current;
    const analyser = analyserRef.current;
    const state = scheduleRef.current;
    if (!ctx || !analyser || !state || !assistant) {
      return;
    }
    await ttsSpeak(sentence, {
      ctx,
      dest: analyser,
      state,
      sampleRate: assistant.pcmSampleRate || 24000,
      bitDepth: assistant.pcmBitDepth === 32 ? 32 : 16,
      apiBase: assistant.ttsApiBase || 'https://api.openai.com/v1',
      apiKey: assistant.ttsApiKey,
      model: assistant.ttsModel,
      voice: assistant.voice,
      speed: typeof assistant.ttsSpeed === 'number' ? assistant.ttsSpeed : 1.0,
      trimStartSamples: assistant.trimStartSamples ?? 0,
      trimEndSamples: assistant.trimEndSamples ?? 0,
      signal: abortRef.current?.signal,
    });
  }, [assistant]);

  const run = useCallback(async () => {
    if (!canRun || !assistant) {
      return;
    }
    setRunning(true);
    setError('');
    setHasSpoken(false);

    audioCtxRef.current?.close();
    const sampleRate = assistant.pcmSampleRate || 24000;
    const ctx = new AudioContext({ sampleRate });
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    analyser.connect(ctx.destination);
    analyserRef.current = analyser;
    scheduleRef.current = newScheduleState(ctx);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const base = (assistant.chatApiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const messages: { role: string; content: string }[] = [];
      if (data.systemPrompt?.trim()) {
        messages.push({ role: 'system', content: data.systemPrompt });
      }
      messages.push({ role: 'user', content: data.userPrompt });

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (assistant.chatApiKey?.trim()) {
        headers['Authorization'] = `Bearer ${assistant.chatApiKey}`;
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: assistant.chatModel, messages, stream: true }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const acc = createSentenceAccumulator();
      let chain: Promise<void> = Promise.resolve();
      let sseBuf = '';

      const enqueue = (sentence: string) => {
        chain = chain.then(() => speakSentence(sentence)).catch((err) => {
          toast.error(`Speech failed: ${(err as Error).message}`);
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        sseBuf += decoder.decode(value, { stream: true });
        let nl = sseBuf.indexOf('\n\n');
        while (nl !== -1) {
          const line = sseBuf.slice(0, nl).trim();
          sseBuf = sseBuf.slice(nl + 2);
          nl = sseBuf.indexOf('\n\n');
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            continue;
          }
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              acc.buf += delta;
              if (data.splitSentences !== false) {
                for (const sentence of takeSentences(acc)) {
                  setHasSpoken(true);
                  enqueue(sentence);
                }
              }
            }
          } catch {
            // ignore malformed events
          }
        }
      }
      const rest = flushAccumulator(acc);
      if (rest) {
        setHasSpoken(true);
        enqueue(rest);
      }
      await chain;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        audioCtxRef.current?.close();
        audioCtxRef.current = null;
      } else {
        const msg = (err as Error).message || String(err);
        setError(msg);
        toast.error(`Chat → Speech failed: ${msg}`);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [canRun, data, speakSentence, assistant]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <NodeFrame
      icon={icons.MessageCircle}
      title='Chat → Speech'
      subtitle={`${assistant?.chatModel || '—'} → ${assistant?.ttsModel || '—'}`}
      status={error ? 'error' : hasSpoken ? 'success' : 'neutral'}
      selected={selected ?? false}
      loading={running}
      extra={
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
      }
    >
      <div className='flex flex-col gap-1'>
        {running || hasSpoken ? (
          <canvas
            ref={canvasRef}
            width={200}
            height={24}
            className='nodrag nopan w-full h-6 rounded-sm bg-black/40'
          />
        ) : error ? (
          <div className='text-[10px] text-destructive line-clamp-3'>{error}</div>
        ) : running ? (
          <div className='text-[10px] text-muted-foreground italic'>thinking…</div>
        ) : (
          <div className='text-[10px] text-muted-foreground italic'>no output yet</div>
        )}
      </div>
    </NodeFrame>
  );
}

export function OpenAIChatSpeechInspector({
  data, updateData,
}: { nodeId: string; data: OpenAIChatSpeechData; updateData: (p: Partial<OpenAIChatSpeechData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Assistant</Label>
        <AssistantSelector
          value={data.assistantId ?? ''}
          onChange={(v: string) => updateData({ assistantId: v })}
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.splitSentences !== false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ splitSentences: e.target.checked })}
        />
        Split into sentences (faster first audio)
      </label>
      <div className='flex flex-col gap-1'>
        <Label>System Prompt (optional)</Label>
        <Textarea
          value={data.systemPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ systemPrompt: e.target.value })}
          placeholder='You are a helpful assistant.'
          className='text-xs min-h-[80px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>User Prompt</Label>
        <Textarea
          value={data.userPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ userPrompt: e.target.value })}
          placeholder='Ask something…'
          className='text-xs min-h-[120px]'
        />
      </div>
    </div>
  );
}
