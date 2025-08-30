'use server';

import { gateway, GatewayNotConfiguredError, PairingPendingError } from '@/app/(openclaw)/_server/gateway-client';
import { RawChatMessage } from '@/app/(openclaw)/openclaw/messages';
import { getSetting } from '@/app/(settings)/server/actions';

export interface OpenclawSession {
  key: string;
  updatedAt: number;
  title?: string;
  lastMessage?: string;
}

export interface OpenclawAgent {
  agentId: string;
  name: string;
  isDefault: boolean;
  sessions: OpenclawSession[];
  sessionCount: number;
}

export type OpenclawState =
  | { status: 'ok'; agents: OpenclawAgent[] }
  | { status: 'needs-pairing'; deviceId: string; requestId: string | null; reason: string }
  | { status: 'not-configured'; reason: string };

interface AgentEntry {
  id: string;
  name?: string;
  isDefault?: boolean;
}

interface AgentsListPayload {
  agents?: AgentEntry[];
  items?: AgentEntry[];
}

interface SessionsListPayload {
  count?: number;
  sessions?: OpenclawSession[];
}

interface ChatHistoryPayload {
  messages?: RawChatMessage[];
}

export async function loadOpenclaw(): Promise<OpenclawState> {
  if (!(await isGatewayConfigured())) {
    return { status: 'not-configured', reason: 'OpenClaw gateway URL and token are not set' };
  }
  try {
    const agents = await fetchAgents();
    return { status: 'ok', agents };
  } catch (error) {
    if (isErrorNamed(error, 'GatewayNotConfiguredError') || error instanceof GatewayNotConfiguredError) {
      return { status: 'not-configured', reason: (error as Error).message };
    }
    if (isErrorNamed(error, 'PairingPendingError') || error instanceof PairingPendingError) {
      const e = error as PairingPendingError;
      return {
        status: 'needs-pairing',
        deviceId: e.deviceId ?? '',
        requestId: e.requestId ?? null,
        reason: e.message,
      };
    }
    if (isScopeError(error)) {
      return {
        status: 'needs-pairing',
        deviceId: gateway().getIdentity().deviceId,
        requestId: null,
        reason: error.message,
      };
    }
    throw error;
  }
}

async function isGatewayConfigured(): Promise<boolean> {
  const row = await getSetting<{ gatewayUrl?: string; gatewayToken?: string }>('ai-settings');
  const url = row?.data?.gatewayUrl?.trim() || process.env.OPENCLAW_GATEWAY_URL;
  const token = row?.data?.gatewayToken?.trim() || process.env.OPENCLAW_GATEWAY_TOKEN;
  return Boolean(url && token);
}

function isErrorNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

async function fetchAgents(): Promise<OpenclawAgent[]> {
  const list = await gateway().call<AgentsListPayload>('agents.list', {});
  const entries = list.agents ?? list.items ?? [];
  return Promise.all(entries.map(loadAgent));
}

async function loadAgent(entry: AgentEntry): Promise<OpenclawAgent> {
  const payload = await gateway().call<SessionsListPayload>('sessions.list', {
    agentId: entry.id,
    limit: 1000,
    includeDerivedTitles: true,
    includeLastMessage: true,
    includeUnknown: true,
  });
  return {
    agentId: entry.id,
    name: entry.name ?? entry.id,
    isDefault: Boolean(entry.isDefault),
    sessions: payload.sessions ?? [],
    sessionCount: payload.count ?? 0,
  };
}

export async function deleteSession(key: string): Promise<void> {
  await gateway().call('sessions.delete', { key });
}

export async function loadSession(key: string): Promise<RawChatMessage[]> {
  const payload = await gateway().call<ChatHistoryPayload>('chat.history', {
    sessionKey: key,
    limit: 200,
  });
  return payload.messages ?? [];
}

export interface OpenclawCommand {
  name: string;
  textAliases: string[];
  description: string;
  category: string;
  acceptsArgs: boolean;
}

interface CommandsListPayload {
  commands?: OpenclawCommand[];
}

export async function listCommands(): Promise<OpenclawCommand[]> {
  const payload = await gateway().call<CommandsListPayload>('commands.list', {});
  return payload.commands ?? [];
}

export async function sendMessage(key: string, text: string): Promise<void> {
  const command = parseCommand(text);
  if (command) {
    await runCommand(key, command);
    return;
  }
  await gateway().call('chat.send', {
    sessionKey: key,
    message: text,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function runCommand(key: string, command: { name: string; args: string }): Promise<void> {
  if (command.name === 'stop' || command.name === 'abort') {
    await gateway().call('chat.abort', { sessionKey: key });
    return;
  }
  await gateway().call('chat.send', {
    sessionKey: key,
    message: `/${command.name}${command.args ? ' ' + command.args : ''}`,
    idempotencyKey: crypto.randomUUID(),
  });
}

function parseCommand(text: string): { name: string; args: string } | null {
  const match = text.trim().match(/^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }
  return { name: match[1].toLowerCase(), args: match[2] ?? '' };
}

function isScopeError(error: unknown): error is Error {
  return error instanceof Error && /missing scope/i.test(error.message);
}
