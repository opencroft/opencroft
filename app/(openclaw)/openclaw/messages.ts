export type OpenclawPart =
  | { type: 'text'; text: string }
  | {
    type: 'tool-call';
    id: string;
    name: string;
    args: unknown;
    result?: { text: string; isError?: boolean };
  };

export interface OpenclawMessage {
  role: 'user' | 'assistant';
  parts: OpenclawPart[];
  timestamp: number;
  model?: string;
}

export interface RawChatMessage {
  role: string;
  content?: RawContentPart[] | string;
  timestamp?: number;
  model?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  __openclaw?: { id?: string; seq?: number };
}

export function messageId(msg: RawChatMessage): string | null {
  return msg.__openclaw?.id ?? null;
}

export interface RawContentPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

export function normalizeHistory(raw: RawChatMessage[]): OpenclawMessage[] {
  const results = new Map<string, { text: string; isError?: boolean }>();
  for (const item of raw) {
    if (item.role === 'toolResult' && item.toolCallId) {
      results.set(item.toolCallId, {
        text: extractText(item.content),
        isError: item.isError,
      });
    }
  }
  const out: OpenclawMessage[] = [];
  for (const item of raw) {
    if (item.role === 'toolResult') {
      continue;
    }
    const role = item.role === 'user' ? 'user' : 'assistant';
    const rawParts = toParts(item.content, results);
    const parts = role === 'user' ? rawParts.map(cleanUserPart) : rawParts.map(cleanAssistantPart);
    const visible = parts.filter(isVisiblePart);
    if (visible.length === 0) {
      continue;
    }
    out.push({
      role,
      parts: visible,
      timestamp: item.timestamp ?? 0,
      model: item.model,
    });
  }
  return out;
}

function isVisiblePart(part: OpenclawPart): boolean {
  if (part.type === 'text') {
    return part.text.trim().length > 0;
  }
  return true;
}

function cleanUserPart(part: OpenclawPart): OpenclawPart {
  if (part.type !== 'text') {
    return part;
  }
  return { type: 'text', text: stripMetadata(part.text) };
}

function cleanAssistantPart(part: OpenclawPart): OpenclawPart {
  if (part.type !== 'text') {
    return part;
  }
  return { type: 'text', text: stripControlTokens(part.text) };
}

function stripControlTokens(text: string): string {
  return text.replace(/\b(NO_REPLY|HEARTBEAT_OK)\b/g, '').trim();
}

function stripMetadata(text: string): string {
  let out = text;
  out = out.replace(/[A-Za-z ]+\(untrusted metadata\):\s*```json[\s\S]*?```\s*/g, '');
  out = out.replace(/^System:\s*\[[^\]]+\][^\n]*?:\s*/, '');
  return out.trim();
}

function toParts(
  content: RawContentPart[] | string | undefined,
  results: Map<string, { text: string; isError?: boolean }>,
): OpenclawPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((part) => toPart(part, results));
}

function toPart(raw: RawContentPart, results: Map<string, { text: string; isError?: boolean }>): OpenclawPart {
  if (raw.type === 'toolCall') {
    const id = raw.id ?? '';
    return {
      type: 'tool-call',
      id,
      name: raw.name ?? '',
      args: raw.arguments,
      result: results.get(id),
    };
  }
  return { type: 'text', text: raw.text ?? '' };
}

function extractText(content: RawContentPart[] | string | undefined): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n\n');
}
