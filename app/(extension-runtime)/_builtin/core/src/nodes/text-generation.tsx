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
  type Stream,
  type TextChunk,
} from '@ext/host';

import { AssistantSelector, useAssistant } from './openai-assistant';

const { useEffect, useRef, useState } = React;

export interface TextGenerationData {
  assistantId: string;
  systemPrompt: string;
}

export function TextGenerationNode({ id, data, selected }: { id: string; data: TextGenerationData; selected?: boolean }) {
  const inbound = useNodeContext<Stream<TextChunk>>(id, 'text-in');
  const assistant = useAssistant(data.assistantId);
  const [busy, setBusy] = useState(false);
  const bufferRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const stream = inbound?.value;
    if (!stream) {
      return;
    }
    const out = getStream<TextChunk>(id, 'text-out');

    const run = async (prompt: string) => {
      if (!assistant?.chatModel?.trim()) {
        toast.error('Text Generation: no chat model configured on assistant');
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      try {
        const base = (assistant.chatApiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (assistant.chatApiKey?.trim()) {
          headers['Authorization'] = `Bearer ${assistant.chatApiKey}`;
        }
        const messages: { role: string; content: string }[] = [];
        if (data.systemPrompt?.trim()) {
          messages.push({ role: 'system', content: data.systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: assistant.chatModel,
            messages,
            temperature: typeof assistant.temperature === 'number' ? assistant.temperature : 0.7,
            stream: true,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf('\n\n');
          while (idx !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            idx = buf.indexOf('\n\n');
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                broadcast(out, { text: delta, final: false });
              }
            } catch {
              // skip
            }
          }
        }
        broadcast(out, { text: '', final: true });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          toast.error(`Generation failed: ${(err as Error).message}`);
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    };

    return subscribe(stream, (chunk: TextChunk) => {
      bufferRef.current += chunk.text;
      if (chunk.final) {
        const prompt = bufferRef.current;
        bufferRef.current = '';
        void run(prompt);
      }
    });
  }, [id, inbound?.value, assistant, data.systemPrompt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const subtitle = !assistant?.chatModel?.trim()
    ? 'no assistant'
    : !inbound
      ? 'No input'
      : busy
        ? 'Thinking'
        : 'Listening';

  return (
    <NodeFrame
      icon={icons.Sparkles}
      title='Text Generation'
      subtitle={subtitle}
      selected={selected ?? false}
      loading={busy}
      input={<InputHandle type='text-stream' id='text-in' />}
      output={<OutputHandle type='text-stream' id='text-out' />}
    />
  );
}

export function TextGenerationInspector({ data, updateData }: { nodeId: string; data: TextGenerationData; updateData: (p: Partial<TextGenerationData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <label className='flex flex-col gap-1 text-xs'>
        <span>Assistant</span>
        <AssistantSelector
          value={data.assistantId ?? ''}
          onChange={(v: string) => updateData({ assistantId: v })}
        />
      </label>
      <label className='flex flex-col gap-1 text-xs'>
        <span>System Prompt (optional)</span>
        <textarea
          value={data.systemPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ systemPrompt: e.target.value })}
          placeholder='You are a helpful assistant.'
          className='min-h-[80px] rounded border bg-transparent px-2 py-1 text-xs font-mono'
        />
      </label>
    </div>
  );
}

export const TEXT_GENERATION_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Prompt' },
  { id: 'text-out', contextType: 'text-stream', role: 'source' as const, label: 'Text' },
];

export function textGenerationExposeOutput(handleId: string, _data: unknown, _typeId: string, nodeId: string): Stream<TextChunk> | undefined {
  if (handleId === 'text-out') {
    return getStream<TextChunk>(nodeId, 'text-out');
  }
  return undefined;
}
