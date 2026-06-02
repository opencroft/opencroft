import {
  React,
  NodeFrame,
  icons,
  invoke,
  toast,
  createPortal,
  useNodeAccent,
} from '@ext/host';
import {
  Button,
  Label,
  Textarea,
} from '@ext/ui';

import { AssistantSelector, useAssistant } from './openai-assistant';

const { useCallback, useRef, useState } = React;

export interface OpenAIClientData {
  assistantId: string;
  systemPrompt: string;
  userPrompt: string;
}

interface ChatResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

function ResponseOverlay({
  title,
  content,
  onClose,
}: {
  title: string;
  content: string;
  onClose: () => void;
}) {
  const accent = useNodeAccent();
  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(content);
    toast.success('Copied');
  }, [content]);

  return createPortal(
    <div
      className='fixed inset-0 z-[9999] flex flex-col bg-background/95 backdrop-blur-sm'
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className='flex items-center gap-2 px-4 py-2 border-b'>
        <div className='h-2 w-2 rounded-full' style={{ backgroundColor: accent }} />
        <span className='text-sm font-medium flex-1'>{title}</span>
        <Button size='sm' className='h-7 text-xs' onClick={copy}>
          <icons.Copy className='h-3 w-3 mr-1' />
          Copy
        </Button>
        <Button variant='ghost' size='icon' className='h-7 w-7' onClick={onClose}>
          <icons.X className='h-4 w-4' />
        </Button>
      </div>
      <div className='flex-1 min-h-0 overflow-auto p-4'>
        <pre className='text-sm font-mono whitespace-pre-wrap'>{content}</pre>
      </div>
    </div>,
    document.body,
  );
}

export function OpenAIClientNode({ data, selected }: { data: OpenAIClientData; selected?: boolean }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ChatResult | null>(null);
  const [error, setError] = useState('');
  const [viewerOpen, setViewerOpen] = useState(false);
  const genRef = useRef(0);
  const assistant = useAssistant(data.assistantId);

  const canRun = !!assistant?.chatModel?.trim() && !!data.userPrompt?.trim();

  const run = useCallback(async () => {
    if (!canRun || !assistant) {
      return;
    }
    const gen = ++genRef.current;
    setRunning(true);
    setError('');
    try {
      const res = await invoke<ChatResult>('openai.chat', {
        apiBase: assistant.chatApiBase || 'https://api.openai.com/v1',
        apiKey: assistant.chatApiKey,
        model: assistant.chatModel,
        systemPrompt: data.systemPrompt || '',
        userPrompt: data.userPrompt,
        temperature: typeof assistant.temperature === 'number' ? assistant.temperature : 0.7,
      });
      if (gen !== genRef.current) {
        return;
      }
      setResult(res);
    } catch (err) {
      if (gen !== genRef.current) {
        return;
      }
      const msg = (err as Error).message || String(err);
      setError(msg);
      toast.error(`OpenAI request failed: ${msg}`);
    } finally {
      if (gen === genRef.current) {
        setRunning(false);
      }
    }
  }, [canRun, data, assistant]);

  const stop = useCallback(() => {
    genRef.current += 1;
    setRunning(false);
  }, []);

  const status = error ? 'error' : result ? 'success' : 'neutral';
  const preview = result?.content.slice(0, 240) ?? '';
  const truncated = (result?.content.length ?? 0) > 240;

  return (
    <>
      <NodeFrame
        icon={icons.Sparkles}
        title='OpenAI Client'
        subtitle={assistant?.chatModel || 'no assistant'}
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
            {result ? (
              <Button
                variant='ghost'
                size='sm'
                className='nodrag nopan h-5 text-[10px] px-1.5'
                onClick={() => setViewerOpen(true)}
              >
                <icons.ScrollText className='h-2.5 w-2.5 shrink-0' />
              </Button>
            ) : null}
          </div>
        }
      >
        <div className='flex flex-col gap-1'>
          {running ? (
            <div className='text-[10px] text-muted-foreground italic'>thinking…</div>
          ) : result ? (
            <>
              <pre className='text-[10px] font-mono whitespace-pre-wrap line-clamp-6 text-muted-foreground'>
                {preview}{truncated ? '…' : ''}
              </pre>
              <div className='text-[9px] text-muted-foreground'>
                {result.model} · {result.promptTokens}+{result.completionTokens} tokens
              </div>
            </>
          ) : error ? (
            <div className='text-[10px] text-destructive line-clamp-3'>{error}</div>
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>no response yet</div>
          )}
        </div>
      </NodeFrame>

      {viewerOpen && result ? (
        <ResponseOverlay
          title={`OpenAI — ${result.model}`}
          content={result.content}
          onClose={() => setViewerOpen(false)}
        />
      ) : null}
    </>
  );
}

export function OpenAIClientInspector({
  data, updateData,
}: { nodeId: string; data: OpenAIClientData; updateData: (p: Partial<OpenAIClientData>) => void }) {
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
