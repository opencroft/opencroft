'use client';

import { useEffect, useState, useTransition } from 'react';

import {
  AiSettingsState,
  loadAiSettingsState,
  rePairGateway,
  saveDefaultAgent,
  saveGatewayConfig,
} from '@/app/(settings)/settings/ai/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function buildNodesUrl(gatewayUrl: string | null | undefined): string | null {
  if (!gatewayUrl) {
    return null;
  }
  try {
    const url = new URL(gatewayUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/nodes';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export default function AiSettings() {
  const [state, setState] = useState<AiSettingsState | null>(null);
  const [agentPending, startAgentSave] = useTransition();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [gatewayPending, startGatewaySave] = useTransition();

  useEffect(() => {
    loadAiSettingsState().then((s) => {
      setState(s);
      setUrl(s.settings.gatewayUrl ?? '');
      setToken(s.settings.gatewayToken ?? '');
    });
  }, []);

  const onAgentChange = (agentId: string) => {
    startAgentSave(async () => {
      const settings = await saveDefaultAgent({ data: agentId || null });
      setState((prev) => (prev ? { ...prev, settings } : prev));
    });
  };

  const onSaveGateway = () => {
    startGatewaySave(async () => {
      const settings = await saveGatewayConfig({ data: { url, token } });
      const next = await loadAiSettingsState();
      setState({ ...next, settings });
    });
  };

  const onRePair = () => {
    startGatewaySave(async () => {
      await rePairGateway();
      const next = await loadAiSettingsState();
      setState(next);
    });
  };

  if (!state) {
    return (
      <div className='p-6'>
        <h1 className='text-2xl font-bold mb-4'>AI</h1>
        <p className='text-muted-foreground'>Loading...</p>
      </div>
    );
  }

  const agentValue = state.settings.defaultAgentId ?? '';
  const gatewayDirty = (url ?? '') !== (state.settings.gatewayUrl ?? '')
    || (token ?? '') !== (state.settings.gatewayToken ?? '');
  const nodesUrl = buildNodesUrl(state.settings.gatewayUrl);

  return (
    <div className='p-6 space-y-8'>
      <h1 className='text-2xl font-bold'>AI</h1>

      <section className='space-y-2 max-w-md'>
        <label className='text-sm font-medium'>OpenClaw gateway URL</label>
        <p className='text-sm text-muted-foreground'>
          WebSocket URL of the OpenClaw gateway. Leave empty to use the <code>OPENCLAW_GATEWAY_URL</code> env var.
        </p>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder='ws://host:port'
          disabled={gatewayPending}
        />

        <label className='text-sm font-medium pt-3 block'>OpenClaw gateway token</label>
        <p className='text-sm text-muted-foreground'>
          Pairing token for the gateway. Leave empty to use the <code>OPENCLAW_GATEWAY_TOKEN</code> env var.
        </p>
        <Input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder='paste pairing token'
          type='password'
          disabled={gatewayPending}
        />

        <div className='pt-2 flex gap-2'>
          <Button onClick={onSaveGateway} disabled={gatewayPending || !gatewayDirty}>
            {gatewayPending ? 'Saving...' : 'Save gateway'}
          </Button>
          <Button variant='outline' onClick={onRePair} disabled={gatewayPending}>
            Re-pair device
          </Button>
        </div>
        <p className='text-xs text-muted-foreground'>
          Clears the cached device token so OpenClaw can issue a fresh one on the next connect.
        </p>
      </section>

      <section className='space-y-2 max-w-md'>
        <label className='text-sm font-medium'>Default agent</label>
        <p className='text-sm text-muted-foreground'>
          Used for messages sent from the command bar.
        </p>
        {state.connection.status === 'not-configured' ? (
          <p className='text-xs text-muted-foreground'>
            Configure the gateway above to load agents.
          </p>
        ) : state.connection.status === 'needs-pairing' ? (
          <div className='text-xs text-muted-foreground space-y-1'>
            <p>
              OpenClaw isn&apos;t paired yet. <code className='break-all'>{state.connection.reason}</code>
            </p>
            {nodesUrl ? (
              <p>
                Approve this device at{' '}
                <a href={nodesUrl} target='_blank' rel='noreferrer' className='underline'>
                  {nodesUrl}
                </a>
                .
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <Select value={agentValue} onValueChange={onAgentChange} disabled={agentPending || state.agents.length === 0}>
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='Select an agent...' />
              </SelectTrigger>
              <SelectContent>
                {state.agents.map((agent) => (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {state.agents.length === 0 && (
              <p className='text-xs text-muted-foreground'>No agents available.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
