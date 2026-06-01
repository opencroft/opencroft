import { createServerFn } from '@tanstack/react-start';

import { clearDeviceToken } from '@/app/(openclaw)/_server/device-identity';
import { resetGateway } from '@/app/(openclaw)/_server/gateway-client';
import { loadOpenclaw, OpenclawAgent } from '@/app/(openclaw)/openclaw/actions';
import { getSetting, setSetting, updateSetting } from '@/app/(settings)/server/actions';

export interface AiSettings {
  defaultAgentId: string | null;
  gatewayUrl: string | null;
  gatewayToken: string | null;
}

export type AiConnectionStatus =
  | { status: 'ok' }
  | { status: 'not-configured'; reason: string }
  | { status: 'needs-pairing'; reason: string };

export interface AiSettingsState {
  settings: AiSettings;
  agents: OpenclawAgent[];
  connection: AiConnectionStatus;
}

export interface GatewayConfigInput {
  url: string | null;
  token: string | null;
}

const SETTING_ID = 'ai-settings';

const defaults: AiSettings = {
  defaultAgentId: null,
  gatewayUrl: null,
  gatewayToken: null,
};

export const loadAiSettings = createServerFn().handler(async (): Promise<AiSettings> => {
  const row = await getSetting({ data: SETTING_ID });
  return { ...defaults, ...(row?.data ?? {}) };
});

export const saveDefaultAgent = createServerFn({ method: 'POST' }).inputValidator((agentId: string | null) => agentId).handler(async ({ data: agentId }): Promise<AiSettings> => {
  const row = await updateSetting({ data: { id: SETTING_ID, data: { defaultAgentId: agentId } } });
  if (row) {
    return { ...defaults, ...row.data };
  }
  const created = await setSetting({ data: { id: SETTING_ID, data: { ...defaults, defaultAgentId: agentId } } });
  return created.data;
});

export const saveGatewayConfig = createServerFn({ method: 'POST' }).inputValidator((input: GatewayConfigInput) => input).handler(async ({ data: input }): Promise<AiSettings> => {
  const patch = {
    gatewayUrl: input.url?.trim() || null,
    gatewayToken: input.token?.trim() || null,
  };
  const row = await updateSetting({ data: { id: SETTING_ID, data: patch } });
  clearDeviceToken();
  resetGateway();
  if (row) {
    return { ...defaults, ...row.data };
  }
  const created = await setSetting({ data: { id: SETTING_ID, data: { ...defaults, ...patch } } });
  return created.data;
});

export const rePairGateway = createServerFn().handler(async (): Promise<void> => {
  clearDeviceToken();
  resetGateway();
});

export const loadAiSettingsState = createServerFn().handler(async (): Promise<AiSettingsState> => {
  const settings = await loadAiSettings();
  const openclaw = await loadOpenclaw().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 'not-configured' as const, reason };
  });
  if (openclaw.status === 'not-configured') {
    return { settings, agents: [], connection: { status: 'not-configured', reason: openclaw.reason } };
  }
  if (openclaw.status === 'needs-pairing') {
    return { settings, agents: [], connection: { status: 'needs-pairing', reason: openclaw.reason } };
  }
  return { settings, agents: openclaw.agents, connection: { status: 'ok' } };
});
