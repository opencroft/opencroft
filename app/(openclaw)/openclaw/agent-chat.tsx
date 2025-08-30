'use client';

import { ChevronRight, SendIcon, Sparkles } from 'lucide-react';
import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CommandBarMenuItem } from '@/app/(dashboard)/_canvas/command-bar';
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context';
import {
  listCommands,
  loadSession,
  OpenclawCommand,
  sendMessage,
} from '@/app/(openclaw)/openclaw/actions';
import {
  messageId,
  normalizeHistory,
  OpenclawMessage,
  OpenclawPart,
  RawChatMessage,
} from '@/app/(openclaw)/openclaw/messages';
import { Button } from '@/components/ui/button';
import { TypingDots } from '@/components/ui/chat/typing-dots';
import { Flex } from '@/components/ui/layout/flex';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface AgentSession {
  sessionKey: string;
  messages: OpenclawMessage[];
  loading: boolean;
  sending: boolean;
  waiting: boolean;
  botName: string;
  send: (text: string) => void;
}

export function useAgentSession(sessionKey: string, transformOutgoing?: (text: string, isFirstMessage: boolean) => string): AgentSession {
  const [raw, setRaw] = useState<RawChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, startSending] = useTransition();
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    setLoading(true);
    setWaiting(false);
    let active = true;
    const seen = new Set<string>();
    const refresh = async () => {
      const rows = await loadSession(sessionKey);
      if (!active) {
        return;
      }
      seen.clear();
      for (const row of rows) {
        const id = messageId(row);
        if (id) {
          seen.add(id);
        }
      }
      setRaw(rows);
      setLoading(false);
      setWaiting(false);
    };
    refresh();
    const es = new EventSource(`/api/openclaw/sessions/${encodeURIComponent(sessionKey)}/stream`);
    es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data) as RawChatMessage;
      const id = messageId(msg);
      if (!id || seen.has(id)) {
        return;
      }
      seen.add(id);
      setRaw((prev) => [...prev, msg]);
      if (msg.role !== 'user') {
        setWaiting(false);
      }
    });
    es.addEventListener('changed', () => {
      refresh();
    });
    return () => {
      active = false;
      es.close();
    };
  }, [sessionKey]);

  const messages = useMemo(() => normalizeHistory(raw), [raw]);
  const botName = extractBotName(sessionKey);

  const isFirstMessage = messages.length === 0;
  const send = useCallback((value: string) => {
    const payload = transformOutgoing ? transformOutgoing(value, isFirstMessage) : value;
    setWaiting(true);
    startSending(async () => {
      await sendMessage(sessionKey, payload);
    });
  }, [sessionKey, transformOutgoing, isFirstMessage]);

  return useMemo(
    () => ({ sessionKey, messages, loading, sending, waiting, botName, send }),
    [sessionKey, messages, loading, sending, waiting, botName, send],
  );
}

interface AgentChatProps {
  session: AgentSession;
  className?: string;
  emptyText?: string;
}

export function AgentChat({ session, className, emptyText }: AgentChatProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session.messages, session.waiting]);

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto', className)}>
      <Flex justify='end' className='min-h-full min-w-0 gap-3 px-4 py-4'>
        {session.loading ? (
          <div className='text-sm text-muted-foreground'>loading…</div>
        ) : session.messages.length === 0 ? (
          <div className='text-sm text-muted-foreground'>{emptyText ?? 'no messages yet'}</div>
        ) : (
          session.messages.map((m, i) => <MessageRow key={i} message={m} botName={session.botName} />)
        )}
        {session.waiting && <ThinkingIndicator botName={session.botName} />}
      </Flex>
    </div>
  );
}

export function ThinkingIndicator({ botName }: { botName: string }) {
  return (
    <Flex row align='center' className='gap-2 text-xs text-muted-foreground'>
      <span className='uppercase tracking-wide'>{botName}</span>
      <span>is thinking</span>
      <TypingDots variant='primary' size='sm' />
    </Flex>
  );
}

interface AgentChatInputProps {
  session: AgentSession;
  placeholder?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  onSlashOpenChange?: (open: boolean) => void;
}

export function AgentChatInput({ session, placeholder, autoFocus, onFocus, onBlur, onSlashOpenChange }: AgentChatInputProps) {
  const [text, setText] = useState('');
  const [commands, setCommands] = useState<OpenclawCommand[]>([]);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    listCommands().then(setCommands);
  }, []);

  const matches = useMemo(() => findMatches(text, commands), [text, commands]);

  useEffect(() => {
    setHighlight(0);
  }, [matches.length]);

  useEffect(() => {
    onSlashOpenChange?.(matches.length > 0);
  }, [matches.length, onSlashOpenChange]);

  const inputPlaceholder = placeholder ?? `Message ${shortKey(session.sessionKey)}…`;

  const pick = (command: OpenclawCommand) => {
    const alias = command.textAliases[0] ?? `/${command.name}`;
    if (command.acceptsArgs) {
      setText(`${alias} `);
      return;
    }
    setText('');
    session.send(alias);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || session.sending) {
      return;
    }
    if (matches.length > 0) {
      const target = matches[highlight];
      const alias = target.textAliases[0] ?? `/${target.name}`;
      if (value.toLowerCase() === alias.toLowerCase()) {
        setText('');
        session.send(value);
        return;
      }
      pick(target);
      return;
    }
    setText('');
    session.send(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit(event);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setText('');
      return;
    }
    if (matches.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const cmd = matches[highlight];
      if (cmd) {
        const alias = cmd.textAliases[0] ?? `/${cmd.name}`;
        setText(cmd.acceptsArgs ? `${alias} ` : alias);
      }
    }
  };

  const menuNode = useMemo(() => {
    if (matches.length === 0) {
      return null;
    }
    return matches.map((m, i) => (
      <CommandBarMenuItem
        key={m.name}
        active={i === highlight}
        onSelect={() => pick(m)}
        onHover={() => setHighlight(i)}
      >
        <div className='flex items-center gap-2 text-sm'>
          <span className='font-mono'>{m.textAliases[0] ?? `/${m.name}`}</span>
          <span className='ml-auto text-[10px] uppercase tracking-wide text-muted-foreground'>
            {m.category}
          </span>
        </div>
        {m.description && (
          <div className='text-xs text-muted-foreground'>{m.description}</div>
        )}
      </CommandBarMenuItem>
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, highlight]);

  const barNode = useMemo(() => (
    <>
      <Sparkles className='h-4 w-4 ml-1 mt-1.5 shrink-0 text-primary' />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={inputPlaceholder}
        rows={1}
        autoFocus={autoFocus}
        className='min-h-8 max-h-60 border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent resize-none py-1.5'
      />
      <Button
        type='button'
        size='icon'
        variant='ghost'
        className='h-7 w-7 shrink-0 mt-0.5'
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        disabled={!text.trim() || session.sending}
      >
        <SendIcon className='h-4 w-4' />
      </Button>
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [text, session.sending, inputPlaceholder, autoFocus]);

  useOverlayMenu(menuNode);
  useOverlayBar(barNode);

  return null;
}

function findMatches(text: string, commands: OpenclawCommand[]): OpenclawCommand[] {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith('/')) {
    return [];
  }
  return commands
    .filter((c) => c.textAliases.some((a) => a.toLowerCase().startsWith(trimmed)))
    .slice(0, 10);
}

export function MessageRow({ message, botName }: { message: OpenclawMessage; botName: string }) {
  return (
    <Flex className='min-w-0 gap-2'>
      {message.parts.map((part, i) => (
        <PartBlock key={i} role={message.role} part={part} botName={botName} />
      ))}
    </Flex>
  );
}

function PartBlock({ role, part, botName }: {
  role: 'user' | 'assistant';
  part: OpenclawPart;
  botName: string;
}) {
  if (part.type === 'text') {
    const bg = role === 'user' ? 'bg-muted border-1' : 'bg-transparent';
    const visible = stripOpencroftTags(part.text || '…');
    if (!visible.trim()) {
      return null;
    }
    return (
      <Flex className={cn('gap-1.5 rounded-md p-2', bg)}>
        {role === 'assistant' && (
          <div className='text-[10px] uppercase tracking-wide text-muted-foreground'>{botName}</div>
        )}
        <div className='prose-chat'>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{visible}</ReactMarkdown>
        </div>
      </Flex>
    );
  }
  return <ToolBlock name={part.name} args={part.args} result={part.result} />;
}

function ToolBlock({ name, args, result }: {
  name: string;
  args: unknown;
  result?: { text: string; isError?: boolean };
}) {
  const isError = result?.isError === true;
  const [open, setOpen] = useState(false);
  return (
    <Flex className='gap-1.5'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex items-center gap-2 text-xs text-left cursor-pointer'
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className='font-mono font-medium shrink-0'>{name}</span>
        {previewArg(name, args) && (
          <span className='font-mono text-muted-foreground'>{previewArg(name, args)}</span>
        )}
        {!result && <span className='text-muted-foreground shrink-0'>running…</span>}
        {isError && <span className='text-destructive shrink-0'>error</span>}
      </button>
      {open && (
        <div className={cn(
          'rounded-md border bg-muted/30 text-xs overflow-hidden',
          isError && 'border-destructive/60',
        )}>
          <ToolRow label='args'>
            <pre className='max-h-48 overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
              {JSON.stringify(args, null, 2)}
            </pre>
          </ToolRow>
          {result && (
            <>
              <div className='border-t' />
              <ToolRow label='output'>
                <pre className='overflow-y-auto whitespace-pre-wrap break-all text-[11px] text-muted-foreground'>
                  {result.text}
                </pre>
              </ToolRow>
            </>
          )}
        </div>
      )}
    </Flex>
  );
}

function ToolRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex row className='gap-3 px-3 py-2'>
      <div className='w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground pt-0.5'>
        {label}
      </div>
      <div className='flex-1 min-w-0'>{children}</div>
    </Flex>
  );
}

const PREVIEW_ARG: Record<string, string> = {
  edit: 'path',
  read: 'path',
  write: 'path',
  list: 'path',
  glob: 'pattern',
  grep: 'pattern',
  search: 'pattern',
  exec: 'command',
  bash: 'command',
  run: 'command',
  fetch: 'url',
  url: 'url',
  web_fetch: 'url',
};

function previewArg(name: string, args: unknown): string | null {
  const key = PREVIEW_ARG[name.toLowerCase()];
  if (!key || !args || typeof args !== 'object') {
    return null;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value) {
    return null;
  }
  return value;
}

function stripOpencroftTags(text: string): string {
  return text.replace(/<opencroft-[a-z0-9-]+>[\s\S]*?<\/opencroft-[a-z0-9-]+>\s*/gi, '');
}

function shortKey(key: string): string {
  const parts = key.split(':');
  return parts.slice(-1)[0] ?? key;
}

function extractBotName(key: string): string {
  return key.split(':')[1] ?? 'assistant';
}
