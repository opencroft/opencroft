import { legacy } from '@opencroft/client'
const { AgentAvatar, Button, Input, InputHandle, Label, NodeFrame, React, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, icons, invoke } = legacy

import type { KeyValue } from './key-value-editor'
import { useSecretKeys } from './secrets'

const { useCallback, useRef, useState, useEffect } = React

export interface AgentData {
  name: string
  avatar?: string
  /** Local agent-client profile. */
  providerId?: string
  adapterId?: string
  model?: string
  apiKeySecret?: string
  defaultModeId?: string
  /** Optional OpenAI-compatible base-URL override (wins over the provider endpoint). */
  baseUrl?: string
  /** System prompt for the Custom (native) harness; ignored by ACP agents. */
  systemPrompt?: string
  /** Reasoning effort (e.g. 'low' | 'medium' | 'high'); empty = off. */
  reasoningEffort?: string
  /** Sampling temperature for the Custom (native) harness. */
  temperature?: number
  /** When set, the harness runs inside this Docker container via `docker exec`,
   * with its workspace at /agents/<agent-slug>. Empty = run on the host. */
  containerName?: string
  /** Opt-in (default off) for the idle-session reaper to unload this agent's
   * sessions once idle longer than autoUnloadIdleMinutes. Off by default
   * because unloading kills any background work an idle session still owns. */
  autoUnloadIdle?: boolean
  /** Idle threshold in minutes for autoUnloadIdle; unset uses the reaper's own default. */
  autoUnloadIdleMinutes?: number
  /** Speech profile (Speech tab): OpenAI-compatible speech endpoint and
   * output-format knobs, read from the node's data by speech consumers. */
  ttsApiBase?: string
  ttsApiKey?: string
  /** Extra request headers for every TTS call, merged over the defaults — so a
   * custom `Authorization` replaces the `ttsApiKey` Bearer shorthand rather
   * than colliding with it. A value of `secret:NAME` is resolved from the
   * Secrets Store server-side at request time; anything else is sent as typed. */
  ttsHeaders?: KeyValue[]
  ttsModel?: string
  voice?: string
  ttsSpeed?: number
  ttsInstructions?: string
  /** Optional sampling knobs, shown only when the endpoint advertises them. */
  ttsTemperature?: number
  ttsSeed?: number
  pcmSampleRate?: number
  pcmBitDepth?: 16 | 32
  trimStartSamples?: number
  trimEndSamples?: number
  /** Speech-recognition profile (Speech Recognition tab): OpenAI-compatible
   * transcription endpoint, read from the node's data by speech-to-text
   * consumers. */
  asrApiBase?: string
  asrApiKey?: string
  /** Extra request headers for every ASR call — same merge and `secret:NAME`
   * handling as `ttsHeaders`. */
  asrHeaders?: KeyValue[]
  asrModel?: string
  asrLanguage?: string
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

export function AgentNode({ data, selected }: { id: string; data: AgentData; selected?: boolean }) {
  return (
    <NodeFrame icon={icons.User} title={data.name || 'Agent'} selected={selected ?? false}>
      <div className='flex flex-col gap-1.5'>
        <InputHandle type='agent-instruction' id='instructions-in'>
          <span className='text-[10px] text-muted-foreground'>Instructions</span>
        </InputHandle>
        <InputHandle type='agent-job' id='agent-in'>
          <span className='text-[10px] text-muted-foreground'>Jobs</span>
        </InputHandle>
      </div>
    </NodeFrame>
  )
}

export function AgentInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handlePick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) {
        return
      }
      const url = await readAsDataUrl(file)
      updateData({ avatar: url })
      e.target.value = ''
    },
    [updateData],
  )

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Avatar</Label>
        <div className='flex items-center gap-2'>
          <AgentAvatar avatar={data.avatar} name={data.name} size='lg' />
          <Button variant='outline' size='sm' onClick={() => inputRef.current?.click()}>
            <icons.Upload className='h-3 w-3 mr-1' />
            {data.avatar ? 'Change' : 'Upload'}
          </Button>
          {data.avatar ? (
            <Button variant='ghost' size='sm' onClick={() => updateData({ avatar: undefined })}>
              <icons.Trash2 className='h-3 w-3' />
            </Button>
          ) : null}
          <input ref={inputRef} type='file' accept='image/*' className='hidden' onChange={handlePick} />
        </div>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Agent name'
        />
      </div>
    </div>
  )
}

// ─── Agent Profile Tab (local agent-client backend) ─────────────────

interface AgentCatalog {
  adapters: { id: string; label: string; protocol: string; kind: 'acp' | 'native'; supportsOauthLogin: boolean }[]
  providers: { id: string; label: string; models: string[]; protocols: string[] }[]
}

const NO_SECRET = '__none__'
const NO_REASONING = '__default__'

export function AgentProfileTab({
  data,
  updateData,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
}) {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const secretKeys = useSecretKeys()

  useEffect(() => {
    invoke<AgentCatalog>('agent.listAgentCatalog')
      .then(setCatalog)
      .catch(() => setCatalog(null))
  }, [])

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        {catalog ? (
          <LocalProfileFields data={data} updateData={updateData} catalog={catalog} secretKeys={secretKeys} />
        ) : (
          <p className='text-xs text-muted-foreground'>Loading profile options…</p>
        )}
      </div>
    </ScrollArea>
  )
}

function LocalProfileFields({
  data,
  updateData,
  catalog,
  secretKeys,
}: {
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
  catalog: AgentCatalog
  secretKeys: string[]
}) {
  const provider = catalog.providers.find((p) => p.id === data.providerId)
  const adapter = catalog.adapters.find((a) => a.id === data.adapterId)
  const adapters = catalog.adapters.filter(
    (a) => a.protocol === 'native' || (provider ? provider.protocols.includes(a.protocol) : true),
  )
  const models = provider?.models ?? []
  const isNative = adapter?.kind === 'native'

  // Computed per the actual selected model (not a static catalog), so it also
  // covers a model discovered from an OpenAI-compatible endpoint or typed in
  // by hand — the static AGENT_PROVIDERS list never has those.
  const [efforts, setEfforts] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    if (!data.model) {
      setEfforts([])
      return
    }
    invoke<string[]>('agent.reasoningEfforts', data.model)
      .then((levels) => {
        if (!cancelled) {
          setEfforts(levels)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEfforts([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [data.model])

  const [discovered, setDiscovered] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const modelOptions = Array.from(new Set([...(data.model ? [data.model] : []), ...models, ...discovered]))

  const loadModels = useCallback(async () => {
    if (!data.baseUrl) {
      return
    }
    setLoadingModels(true)
    try {
      setDiscovered(
        await invoke<string[]>('agent.listModels', { baseUrl: data.baseUrl, apiKeySecret: data.apiKeySecret }),
      )
    } catch {
      setDiscovered([])
    } finally {
      setLoadingModels(false)
    }
  }, [data.baseUrl, data.apiKeySecret])

  // OpenAI-compatible endpoints expose no static catalog, so read
  // `<baseUrl>/models` and refresh whenever the endpoint or key changes.
  useEffect(() => {
    if (data.baseUrl?.startsWith('http')) {
      loadModels()
    } else {
      setDiscovered([])
    }
  }, [data.baseUrl, loadModels])

  return (
    <div className='flex flex-col gap-3'>
      <ProfileSelect
        label='Provider'
        value={data.providerId}
        placeholder='Select provider…'
        options={catalog.providers.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(v) => updateData({ providerId: v })}
      />
      <ProfileSelect
        label='Harness'
        value={data.adapterId}
        placeholder='Select harness…'
        options={adapters.map((a) => ({ value: a.id, label: a.label }))}
        onChange={(v) => updateData({ adapterId: v })}
      />
      <div className='flex flex-col gap-1'>
        <div className='flex items-center justify-between'>
          <Label className='text-xs'>Model</Label>
          {data.baseUrl ? (
            <Button
              variant='ghost'
              size='sm'
              className='h-5 px-1.5 text-[10px]'
              onClick={loadModels}
              disabled={loadingModels}
            >
              <icons.RefreshCw className={`size-2.5 mr-1 ${loadingModels ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          ) : null}
        </div>
        <Select value={data.model || ''} onValueChange={(v: string) => updateData({ model: v })}>
          <SelectTrigger className='h-8 text-xs'>
            <SelectValue placeholder='Select model…' />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((m) => (
              <SelectItem key={m} value={m} className='text-xs'>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {adapter?.supportsOauthLogin ? (
        <OauthAccountSection adapterId={adapter.id} />
      ) : (
        <div className='flex flex-col gap-1'>
          <Label className='text-xs'>API key secret</Label>
          <Select
            value={data.apiKeySecret || NO_SECRET}
            onValueChange={(v: string) => updateData({ apiKeySecret: v === NO_SECRET ? '' : v })}
          >
            <SelectTrigger className='h-8 text-xs'>
              <SelectValue placeholder='None' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SECRET}>None</SelectItem>
              {secretKeys.map((k) => (
                <SelectItem key={k} value={k} className='font-mono text-xs'>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {secretKeys.length === 0 ? (
            <p className='text-[10px] text-muted-foreground'>
              Add a Secrets Store node with the provider key to reference it here.
            </p>
          ) : null}
        </div>
      )}
      {efforts.length > 0 ? (
        <div className='flex flex-col gap-1'>
          <Label className='text-xs'>Reasoning effort</Label>
          <Select
            value={data.reasoningEffort || NO_REASONING}
            onValueChange={(v: string) => updateData({ reasoningEffort: v === NO_REASONING ? '' : v })}
          >
            <SelectTrigger className='h-8 text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_REASONING}>Default</SelectItem>
              {efforts.map((e) => (
                <SelectItem key={e} value={e} className='text-xs capitalize'>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Base URL</Label>
        <Input
          className='h-8 text-xs'
          value={data.baseUrl ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ baseUrl: e.target.value })}
          placeholder='Provider default'
        />
        <p className='text-[10px] text-muted-foreground'>Optional OpenAI-compatible endpoint override.</p>
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Docker container</Label>
        <Input
          className='h-8 text-xs'
          value={data.containerName ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ containerName: e.target.value })}
          placeholder='Run on host'
        />
        <p className='text-[10px] text-muted-foreground'>
          Optional. Runs the harness inside this container via <code>docker exec</code>.
        </p>
      </div>
      <div className='flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <input
            type='checkbox'
            checked={data.autoUnloadIdle ?? false}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ autoUnloadIdle: e.target.checked })}
            className='rounded border-input'
          />
          <Label
            className='text-xs cursor-pointer'
            onClick={() => updateData({ autoUnloadIdle: !data.autoUnloadIdle })}
          >
            Auto-unload idle sessions
          </Label>
        </div>
        <p className='text-[10px] text-muted-foreground'>
          Frees the process of this agent's sessions once idle past the threshold below. Off by default — unloading
          kills any background work an idle session still owns.
        </p>
        {data.autoUnloadIdle ? (
          <div className='flex flex-col gap-1 pl-6'>
            <Label className='text-xs'>Idle threshold (minutes)</Label>
            <Input
              className='h-8 text-xs'
              type='number'
              min={1}
              step={1}
              value={data.autoUnloadIdleMinutes ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                updateData({
                  autoUnloadIdleMinutes: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              placeholder='45'
            />
          </div>
        ) : null}
      </div>
      {isNative ? <NativeProfileFields data={data} updateData={updateData} /> : null}
      {data.containerName ? (
        <p className='text-[10px] text-muted-foreground'>
          Runs in container <code>{data.containerName}</code> at <code>/agents/&lt;agent-slug&gt;</code>.
        </p>
      ) : (
        <p className='text-[10px] text-muted-foreground'>
          Runs in a persistent per-agent workspace: <code>data/agent-workspace/&lt;agent-slug&gt;</code>.
        </p>
      )}
    </div>
  )
}

// System prompt + temperature only apply to the in-process Custom (native)
// harness; ACP agents carry their own prompt and manage their own sampling.
// Connect/disconnect UI for harnesses that keep their own file-based OAuth
// credentials (see agent-client's oauth-login): the harness prints a consent
// URL, the user signs in and pastes the authorization code back, and the
// harness stores and rotates the tokens itself.
function OauthAccountSection({ adapterId }: { adapterId: string }) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState<{ loginId: string; authUrl: string } | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    invoke<{ connected: boolean }>('agent.oauthStatus', adapterId)
      .then((s: { connected: boolean }) => setConnected(s.connected))
      .catch(() => setConnected(null))
  }, [adapterId])

  useEffect(() => {
    setLogin(null)
    setCode('')
    setError('')
    refresh()
  }, [refresh])

  const start = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      setLogin(await invoke<{ loginId: string; authUrl: string }>('agent.oauthStart', adapterId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [adapterId])

  const submit = useCallback(async () => {
    if (!login || !code.trim()) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await invoke<{ ok: boolean; error?: string }>('agent.oauthSubmitCode', {
        loginId: login.loginId,
        code,
      })
      if (result.ok) {
        setLogin(null)
        setCode('')
        refresh()
      } else {
        setError(result.error || 'Login failed')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [login, code, refresh])

  const disconnect = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await invoke('agent.oauthDisconnect', adapterId)
      setLogin(null)
      setCode('')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [adapterId, refresh])

  return (
    <div className='flex flex-col gap-1'>
      <Label className='text-xs'>Account</Label>
      {connected ? (
        <div className='flex items-center gap-2'>
          <p className='flex-1 text-xs text-muted-foreground'>
            Connected — credentials are stored and rotated by the harness.
          </p>
          <Button variant='outline' size='sm' onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        </div>
      ) : login ? (
        <div className='flex flex-col gap-1.5'>
          <p className='text-[10px] text-muted-foreground'>
            Open the sign-in page, approve access, then paste the authorization code below.
          </p>
          <a href={login.authUrl} target='_blank' rel='noreferrer' className='break-all text-xs underline'>
            Open Google sign-in
          </a>
          <div className='flex items-center gap-2'>
            <Input
              value={code}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
              placeholder='Authorization code'
              className='h-8 text-xs'
            />
            <Button size='sm' onClick={submit} disabled={busy || !code.trim()}>
              Submit
            </Button>
          </div>
        </div>
      ) : (
        <div className='flex items-center gap-2'>
          <p className='flex-1 text-xs text-muted-foreground'>Not connected.</p>
          <Button variant='outline' size='sm' onClick={start} disabled={busy || connected === null}>
            {busy ? 'Starting…' : 'Connect'}
          </Button>
        </div>
      )}
      {error ? <p className='text-[10px] text-destructive'>{error}</p> : null}
    </div>
  )
}

function NativeProfileFields({ data, updateData }: { data: AgentData; updateData: (p: Partial<AgentData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>System prompt</Label>
        <Textarea
          className='text-xs'
          rows={4}
          value={data.systemPrompt ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ systemPrompt: e.target.value })}
          placeholder='Custom harness system prompt…'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Temperature</Label>
        <Input
          className='h-8 text-xs'
          type='number'
          min={0}
          max={2}
          step={0.1}
          value={data.temperature ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            updateData({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          placeholder='Provider default'
        />
      </div>
    </div>
  )
}

function ProfileSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
}: {
  label: string
  value: string | undefined
  placeholder: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  return (
    <div className='flex flex-col gap-1'>
      <Label className='text-xs'>{label}</Label>
      <Select value={value || ''} onValueChange={onChange}>
        <SelectTrigger className='h-8 text-xs'>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className='text-xs'>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
