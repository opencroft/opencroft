import {
  React,
  NodeFrame,
  icons,
  toast,
  useReactFlow,
} from '@ext/host';
import {
  Button,
  ChatMessage,
  Label,
  Textarea,
} from '@ext/ui';

import { newScheduleState, type ScheduleState } from '../audio-pcm';
import {
  createSentenceAccumulator,
  flushAccumulator,
  takeSentences,
} from '../sentences';
import { speakSentence } from '../speak';
import { useAsr } from '../use-asr';
import { AssistantSelector, useAssistant } from './openai-assistant';

const { useCallback, useEffect, useRef, useState } = React;

export interface OpenAIChatData {
  assistantId: string;
  systemPrompt: string;
  ttsEnabled: boolean;
  splitSentences: boolean;
  asrMode?: 'ptt' | 'vad';
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
}

export function OpenAIChatNode({ id, data, selected }: { id: string; data: OpenAIChatData; selected?: boolean }) {
  const rf = useReactFlow();
  const assistant = useAssistant(data.assistantId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const scheduleRef = useRef<ScheduleState | null>(null);

  const { recording, transcribing, toggle: toggleMic } = useAsr({
    mode: data.asrMode === 'vad' ? 'vad' : 'ptt',
    onText: (piece: string) => setInput((prev: string) => prev + piece),
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

  const send = useCallback(async (text: string) => {
    if (!assistant?.chatModel?.trim() || !text.trim() || busy) {
      return;
    }
    const userMsg: Message = { role: 'user', content: text };
    const pending: Message = { role: 'assistant', content: '' };
    setMessages((prev: Message[]) => [...prev, userMsg, pending]);
    setBusy(true);

    const history: { role: string; content: string }[] = [];
    if (data.systemPrompt?.trim()) {
      history.push({ role: 'system', content: data.systemPrompt });
    }
    for (const m of messages) {
      history.push({ role: m.role, content: m.content });
    }
    history.push({ role: 'user', content: text });

    const base = (assistant.chatApiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (assistant.chatApiKey?.trim()) {
      headers['Authorization'] = `Bearer ${assistant.chatApiKey}`;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const ttsEnabled = !!data.ttsEnabled && !!assistant.ttsModel?.trim() && !!assistant.voice?.trim();
    const acc = createSentenceAccumulator();
    let ttsChain: Promise<void> = Promise.resolve();

    const sampleRate = assistant.pcmSampleRate || 24000;
    const bitDepth = assistant.pcmBitDepth === 32 ? 32 : 16;

    if (ttsEnabled) {
      if (!audioCtxRef.current || audioCtxRef.current.sampleRate !== sampleRate) {
        audioCtxRef.current?.close();
        const ctx = new AudioContext({ sampleRate });
        audioCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
      }
      scheduleRef.current = newScheduleState(audioCtxRef.current);
    }

    const enqueueSpeak = (sentence: string) => {
      if (!ttsEnabled) {
        return;
      }
      const ctx = audioCtxRef.current;
      const analyser = analyserRef.current;
      const state = scheduleRef.current;
      if (!ctx || !analyser || !state) {
        return;
      }
      ttsChain = ttsChain.then(() => speakSentence(sentence, {
        ctx,
        dest: analyser,
        state,
        sampleRate,
        bitDepth,
        apiBase: assistant.ttsApiBase || 'https://api.openai.com/v1',
        apiKey: assistant.ttsApiKey,
        model: assistant.ttsModel,
        voice: assistant.voice,
        speed: typeof assistant.ttsSpeed === 'number' ? assistant.ttsSpeed : 1.0,
        trimStartSamples: assistant.trimStartSamples ?? 0,
        trimEndSamples: assistant.trimEndSamples ?? 0,
        signal: controller.signal,
      })).catch((err) => {
        if ((err as Error).name !== 'AbortError') {
          toast.error(`Speech failed: ${(err as Error).message}`);
        }
      });
    };

    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: assistant.chatModel,
          messages: history,
          temperature: typeof assistant.temperature === 'number' ? assistant.temperature : 0.7,
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const msg = await res.text().catch(() => '');
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = '';
      let assistantText = '';

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
              assistantText += delta;
              setMessages((prev: Message[]) => {
                const next = prev.slice();
                next[next.length - 1] = { role: 'assistant', content: assistantText };
                return next;
              });
              if (ttsEnabled) {
                acc.buf += delta;
                if (data.splitSentences !== false) {
                  for (const sentence of takeSentences(acc)) {
                    enqueueSpeak(sentence);
                  }
                }
              }
            }
          } catch {
            // ignore bad events
          }
        }
      }
      if (ttsEnabled) {
        const rest = flushAccumulator(acc);
        if (rest) {
          enqueueSpeak(rest);
        }
        await ttsChain;
      }
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if ((err as Error).name === 'AbortError') {
        setMessages((prev: Message[]) => prev.slice(0, -1));
      } else {
        setMessages((prev: Message[]) => {
          const next = prev.slice();
          next[next.length - 1] = { role: 'assistant', content: msg, error: true };
          return next;
        });
        toast.error(`Chat failed: ${msg}`);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, data, messages, assistant]);

  const toggleTts = useCallback(() => {
    rf.setNodes((nodes: { id: string; data: Record<string, unknown> }[]) =>
      nodes.map((n) => (n.id === id
        ? { ...n, data: { ...n.data, ttsEnabled: !n.data.ttsEnabled } }
        : n)),
    );
  }, [id, rf]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
  }, []);

  return (
    <div className='flex flex-col gap-1.5 w-[460px]'>
      {messages.length > 0 ? (
        <div
          ref={scrollRef}
          className='nodrag nopan nowheel flex flex-col justify-end gap-1 overflow-y-auto h-[360px] pt-6'
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0, black 40px, black 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 40px, black 100%)',
          }}
        >
          {messages.map((m: Message, i: number) => (
            <ChatMessage
              key={i}
              text={m.content}
              error={m.error}
              className={m.role === 'user'
                ? 'bg-primary/20 ml-auto max-w-[85%]'
                : 'bg-muted mr-auto max-w-[85%]'}
            />
          ))}
        </div>
      ) : null}
      <NodeFrame
        icon={icons.MessagesSquare}
        title='Chat'
        subtitle={assistant?.chatModel || 'no assistant'}
        selected={selected ?? false}
        loading={busy}
        extra={
          <div className='nodrag nopan flex items-center gap-1 flex-1'>
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7 shrink-0'
              onClick={toggleTts}
              title={data.ttsEnabled ? 'Speech on' : 'Speech off'}
            >
              {data.ttsEnabled ? (
                <icons.Volume2 className='h-3 w-3' />
              ) : (
                <icons.VolumeX className='h-3 w-3 text-muted-foreground' />
              )}
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7 shrink-0'
              onClick={toggleMic}
              disabled={transcribing}
              title={recording ? 'Stop recording' : transcribing ? 'Transcribing…' : 'Record'}
            >
              {recording ? (
                <icons.Square className='h-3 w-3 text-red-500' />
              ) : transcribing ? (
                <icons.Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <icons.Mic className='h-3 w-3 text-muted-foreground' />
              )}
            </Button>
            {messages.length > 0 ? (
              <Button
                variant='ghost'
                size='icon'
                className='h-7 w-7 shrink-0'
                onClick={clear}
              >
                <icons.Trash2 className='h-3 w-3' />
              </Button>
            ) : null}
            <Textarea
              placeholder={busy ? 'Waiting for response…' : 'Write a message…'}
              value={input}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (input.trim()) {
                    const text = input;
                    setInput('');
                    send(text);
                  }
                }
              }}
              className='flex-1 resize-none min-h-0 border-0 bg-transparent focus-visible:ring-0 shadow-none'
            />
            <Button
              variant='ghost'
              size='icon-lg'
              onClick={() => {
                if (input.trim()) {
                  const text = input;
                  setInput('');
                  send(text);
                }
              }}
              disabled={!input.trim() || busy}
            >
              <icons.Send className='h-4 w-4' />
            </Button>
          </div>
        }
      />
    </div>
  );
}

export function OpenAIChatInspector({
  data, updateData,
}: { nodeId: string; data: OpenAIChatData; updateData: (p: Partial<OpenAIChatData>) => void }) {
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
        <Label>System Prompt (optional)</Label>
        <Textarea
          value={data.systemPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ systemPrompt: e.target.value })}
          placeholder='You are a helpful assistant.'
          className='text-xs min-h-[120px]'
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={!!data.ttsEnabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ttsEnabled: e.target.checked })}
        />
        Speak assistant replies
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.asrMode === 'vad'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ asrMode: e.target.checked ? 'vad' : 'ptt' })}
        />
        Continuous mic (VAD): auto-submit utterances
      </label>
      {data.ttsEnabled ? (
        <label className='flex items-center gap-2 text-xs'>
          <input
            type='checkbox'
            checked={data.splitSentences !== false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ splitSentences: e.target.checked })}
          />
          Split into sentences (faster first audio)
        </label>
      ) : null}
    </div>
  );
}
