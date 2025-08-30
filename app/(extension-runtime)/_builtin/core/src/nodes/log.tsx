import {
  React,
  NodeFrame,
  InputHandle,
  icons,
  subscribe,
  useNodeContext,
  type Stream,
  type TextChunk,
} from '@ext/host';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ScrollArea,
} from '@ext/ui';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

interface LogEntry {
  id: number;
  at: number;
  text: string;
}

export interface LogData {
  max: number;
}

const DEFAULT_MAX = 500;

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LogNode({ id, data, selected }: { id: string; data: LogData; selected?: boolean }) {
  const inbound = useNodeContext<Stream<TextChunk>>(id, 'text-in');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const bufferRef = useRef('');
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const max = data.max && data.max > 0 ? data.max : DEFAULT_MAX;

  useEffect(() => {
    const stream = inbound?.value;
    if (!stream) {
      return;
    }
    return subscribe(stream, (chunk: TextChunk) => {
      bufferRef.current += chunk.text;
      if (!chunk.final) {
        return;
      }
      const text = bufferRef.current.trim();
      bufferRef.current = '';
      if (!text) {
        return;
      }
      seqRef.current += 1;
      const entry: LogEntry = { id: seqRef.current, at: Date.now(), text };
      setEntries((prev: LogEntry[]) => {
        const next = prev.length >= max ? prev.slice(prev.length - max + 1) : prev.slice();
        next.push(entry);
        return next;
      });
    });
  }, [inbound?.value, max]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, entries]);

  const latest = entries[entries.length - 1];
  const subtitle = !inbound ? 'No input' : `${entries.length} entries`;

  const clear = useCallback(() => {
    setEntries([]);
    bufferRef.current = '';
  }, []);

  const copy = useCallback(() => {
    const text = entries.map((e) => `[${formatTime(e.at)}] ${e.text}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }, [entries]);

  const preview = useMemo(() => {
    if (!latest) {
      return inbound ? 'Waiting for input…' : '';
    }
    const text = latest.text.replace(/\s+/g, ' ');
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }, [latest, inbound]);

  return (
    <NodeFrame
      icon={icons.ScrollText}
      title='Log'
      subtitle={subtitle}
      selected={selected ?? false}
      input={<InputHandle type='text-stream' id='text-in' />}
      extra={
        <div className='nodrag nopan flex items-center gap-1'>
          {preview && (
            <span className='text-[10px] font-mono text-muted-foreground truncate max-w-[220px]'>
              {preview}
            </span>
          )}
          <Button
            variant='ghost'
            size='icon'
            className='h-7 w-7 shrink-0'
            onClick={() => setOpen(true)}
            disabled={entries.length === 0}
            title='Open log'
          >
            <icons.Maximize2 className='h-3 w-3' />
          </Button>
        </div>
      }
    >
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Log ({entries.length})</DialogTitle>
          </DialogHeader>
          <ScrollArea className='h-[420px] rounded border bg-muted/20 p-2'>
            <div ref={scrollRef} className='font-mono text-xs whitespace-pre-wrap break-words flex flex-col gap-1'>
              {entries.map((e: LogEntry) => (
                <div key={e.id}>
                  <span className='text-muted-foreground'>[{formatTime(e.at)}]</span>{' '}
                  <span>{e.text}</span>
                </div>
              ))}
              {entries.length === 0 && (
                <div className='text-muted-foreground italic'>Empty</div>
              )}
            </div>
          </ScrollArea>
          <div className='flex items-center gap-2 justify-end'>
            <Button variant='ghost' size='sm' onClick={copy}>
              <icons.Copy className='h-3 w-3 mr-1' /> Copy
            </Button>
            <Button variant='ghost' size='sm' onClick={clear}>
              <icons.Trash2 className='h-3 w-3 mr-1' /> Clear
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </NodeFrame>
  );
}

export function LogInspector({ data, updateData }: { nodeId: string; data: LogData; updateData: (p: Partial<LogData>) => void }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='flex flex-col gap-1 text-xs'>
        <span>Max entries</span>
        <input
          type='number'
          min={1}
          className='h-8 rounded border bg-transparent px-2 text-xs'
          value={data.max ?? DEFAULT_MAX}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ max: Number(e.target.value) || DEFAULT_MAX })}
        />
      </label>
    </div>
  );
}

export const LOG_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Text' },
];
