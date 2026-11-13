import { invoke } from '@opencroft/client/actions'
import { NodeFrame } from '@opencroft/client/canvas'
import { type NamedValue, SecretValueField, SecretValueTable } from '@opencroft/client/secrets'
import { TerminalRef, TerminalSelector } from '@opencroft/client/terminal'
import {
  AgentAvatar,
  Button,
  Input,
  Label,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@opencroft/client/ui'
import { IMAGE_INPUT_OPTIONS, imageInputChoice, imageInputFromChoice } from 'agent-client/image-input'
import {
  adapterOffered,
  findAdapter,
  findProvider,
  NATIVE_API_LABELS,
  nativeApisOffered,
  responsesApiOptIn,
} from 'agent-client/resolve'
import type { NativeApi } from 'agent-client/types'
import { RefreshCw, Trash2, Upload, User } from 'lucide-react'
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'

import { profileSendsHeaders } from './agent-headers-shared'

export interface AgentData {
  name: string
  avatar?: string
  /** Local agent-client profile. */
  providerId?: string
  adapterId?: string
  model?: string
  /** The provider key: the NAME of a secret in the Secrets Stores of the
   * node's graph, never a value. */
  apiKeySecret?: string
  defaultModeId?: string
  /** Optional OpenAI-compatible base-URL override (wins over the provider endpoint). */
  baseUrl?: string
  /** Extra request headers for every request the harness makes to `baseUrl`,
   * merged over its own, as `ttsHeaders`. Sent only when the harness can send
   * headers and `baseUrl` is set (`profileSendsHeaders`). */
  endpointHeaders?: NamedValue[]
  /** The endpoint also serves OpenAI's Responses API — what offers Responses-only
   * harnesses (Codex) on a provider that isn't OpenAI itself. */
  responsesApi?: boolean
  /** System prompt for the Custom (native) harness; ignored by ACP agents. Edited in the Instructions tab. */
  systemPrompt?: string
  /** The agent's own instructions (markdown), written as the instruction file in its workspace. */
  workspaceInstructions?: string
  /** Reasoning effort (e.g. 'low' | 'medium' | 'high'); empty = off. */
  reasoningEffort?: string
  /** Sampling temperature for the Custom (native) harness. */
  temperature?: number
  /** The model's context window in tokens. Unset means unknown, and unknown is
   * reported as unknown -- nothing guesses one from the model name. */
  contextWindow?: number
  /** Whether the model takes images, for the Custom (native) harness: the
   * pictures tools return are sent to it. Unset asks the endpoint, and a model
   * the endpoint reports nothing about is sent none. */
  imageInput?: boolean
  /** The model API the Custom (native) harness speaks, among those the provider
   * offers (agent-client `nativeApisOffered`). Unset is the provider's first. */
  nativeApi?: NativeApi
  /** The Docker container an agent ran in before agents ran through
   * terminals. Present only on an agent the server could not move to that
   * container's terminal (placement-migration.ts); nothing runs there. */
  containerName?: string
  /** The terminal the harness runs through, as the "node-id/handle-id" target
   * the TerminalSelector gives. Required for every harness but the Custom
   * one, which runs inside OpenCroft. */
  terminal?: string
  /** The harness's working directory on `terminal`; required while it is set. */
  terminalFolder?: string
  /** Opt-in (default off) for the idle-session reaper to unload this agent's
   * sessions once idle longer than autoUnloadIdleMinutes. Off by default
   * because unloading kills any background work an idle session still owns. */
  autoUnloadIdle?: boolean
  /** Idle threshold in minutes for autoUnloadIdle; unset uses the reaper's own default. */
  autoUnloadIdleMinutes?: number
  /** Speech profile (Speech tab): OpenAI-compatible speech endpoint and
   * output-format knobs, read from the node's data by speech consumers. */
  ttsApiBase?: string
  /** Typed, or `secret:NAME` resolved from the Secrets Store server-side at
   * request time (`secrets.resolveValue`). A typed key is flagged in the tab. */
  ttsApiKey?: string
  /** Extra request headers for every TTS call, merged over the defaults — so a
   * custom `Authorization` replaces the `ttsApiKey` Bearer shorthand rather
   * than colliding with it. A value of `secret:NAME` is resolved from the
   * Secrets Store server-side at request time; anything else is sent as typed,
   * and a typed credential is flagged in the tab. */
  ttsHeaders?: NamedValue[]
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
  /** Typed, or `secret:NAME`, as `ttsApiKey`. */
  asrApiKey?: string
  /** Extra request headers for every ASR call — same merge and `secret:NAME`
   * handling as `ttsHeaders`. */
  asrHeaders?: NamedValue[]
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
  return <NodeFrame icon={User} title={data.name || 'Agent'} selected={selected ?? false} />
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
    async (e: ChangeEvent<HTMLInputElement>) => {
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
            <Upload className='h-3 w-3 mr-1' />
            {data.avatar ? 'Change' : 'Upload'}
          </Button>
          {data.avatar ? (
            <Button variant='ghost' size='sm' onClick={() => updateData({ avatar: undefined })}>
              <Trash2 className='h-3 w-3' />
            </Button>
          ) : null}
          <input ref={inputRef} type='file' accept='image/*' className='hidden' onChange={handlePick} />
        </div>
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Agent name'
        />
      </div>
    </div>
  )
}

// ─── Agent Profile Tab (local agent-client backend) ─────────────────

interface AgentCatalog {
  adapters: {
    id: string
    label: string
    protocol: string
    kind: 'acp' | 'native'
    supportsOauthLogin: boolean
    takesEndpointHeaders: boolean
  }[]
  providers: { id: string; label: string; models: string[] }[]
}

// How a secret field stores a picked secret (`secret:<NAME>`). The node keeps
// `apiKeySecret` as the bare name, which every reader of it resolves, so the
// field's value is converted at the edge.
const SECRET_PREFIX = 'secret:'
const NO_REASONING = '__default__'

export function AgentProfileTab({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
}) {
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)

  useEffect(() => {
    invoke<AgentCatalog>('agent.listAgentCatalog')
      .then(setCatalog)
      .catch(() => setCatalog(null))
  }, [])

  return (
    <ScrollArea className='h-full'>
      <div className='flex flex-col gap-3 p-1'>
        {catalog ? (
          <LocalProfileFields nodeId={nodeId} data={data} updateData={updateData} catalog={catalog} />
        ) : (
          <p className='text-xs text-muted-foreground'>Loading profile options…</p>
        )}
      </div>
    </ScrollArea>
  )
}

function LocalProfileFields({
  nodeId,
  data,
  updateData,
  catalog,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
  catalog: AgentCatalog
}) {
  const provider = catalog.providers.find((p) => p.id === data.providerId)
  const adapter = catalog.adapters.find((a) => a.id === data.adapterId)
  // agent-client's own rule for which harnesses a provider offers, so the list
  // and the harness that runs cannot disagree.
  const providerSpec = findProvider(data.providerId ?? '')
  const adapters = catalog.adapters.filter((a) => {
    const spec = findAdapter(a.id)
    return !providerSpec || !spec || adapterOffered(spec, providerSpec, data)
  })
  const nativeApis = providerSpec ? nativeApisOffered(providerSpec, data) : []
  const responsesOptIn = responsesApiOptIn(providerSpec)
  const models = provider?.models ?? []
  const isNative = adapter?.kind === 'native'
  // A terminal picked here is where the agent runs.
  const terminal = data.terminal?.trim() || ''
  const check = useTerminalCheck({
    nodeId,
    terminal: terminal && !isNative ? terminal : null,
    folder: data.terminalFolder?.trim() ?? '',
    adapterId: data.adapterId,
    providerId: data.providerId,
    baseUrl: data.baseUrl,
  })
  // Turning the opt-in off drops a Responses-only harness the list no longer offers.
  const setResponsesApi = (on: boolean) =>
    updateData({ responsesApi: on, ...(!on && adapter?.protocol === 'openai-responses' ? { adapterId: '' } : {}) })

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

  const sendsHeaders = profileSendsHeaders(adapter?.takesEndpointHeaders ?? false, data.baseUrl)
  const headers = sendsHeaders ? data.endpointHeaders : undefined
  const headersKey = JSON.stringify(headers ?? [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the headers array is keyed by its JSON, so the list is read again on an edit and not on a new array identity
  const loadModels = useCallback(async () => {
    if (!data.baseUrl) {
      return
    }
    setLoadingModels(true)
    try {
      setDiscovered(
        await invoke<string[]>('agent.listModels', {
          nodeId,
          baseUrl: data.baseUrl,
          apiKeySecret: data.apiKeySecret,
          headers,
        }),
      )
    } catch {
      setDiscovered([])
    } finally {
      setLoadingModels(false)
    }
  }, [nodeId, data.baseUrl, data.apiKeySecret, headersKey])

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
              <RefreshCw className={`size-2.5 mr-1 ${loadingModels ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          ) : null}
        </div>
        <Select
          value={data.model || ''}
          onValueChange={(v) => {
            if (v !== null) {
              updateData({ model: v })
            }
          }}
        >
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
        <OauthAccountSection
          adapterId={adapter.id}
          nodeId={nodeId}
          homeKey={[data.name ?? '', terminal, data.terminalFolder ?? ''].join('\u0000')}
        />
      ) : (
        <SecretValueField
          label='API key secret'
          value={data.apiKeySecret ? `${SECRET_PREFIX}${data.apiKeySecret}` : ''}
          onChange={(v) =>
            updateData({ apiKeySecret: v.startsWith(SECRET_PREFIX) ? v.slice(SECRET_PREFIX.length) : '' })
          }
          placeholder='No secret'
          allowTyped={false}
        />
      )}
      {efforts.length > 0 ? (
        <div className='flex flex-col gap-1'>
          <Label className='text-xs'>Reasoning effort</Label>
          <Select
            value={data.reasoningEffort || NO_REASONING}
            items={{ [NO_REASONING]: 'Default' }}
            onValueChange={(v) => {
              if (v !== null) {
                updateData({ reasoningEffort: v === NO_REASONING ? '' : v })
              }
            }}
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
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ baseUrl: e.target.value })}
          placeholder='Provider default'
        />
        <p className='text-[10px] text-muted-foreground'>Optional OpenAI-compatible endpoint override.</p>
      </div>
      {sendsHeaders ? (
        <SecretValueTable
          label='Request headers (optional)'
          nameLabel='Header'
          namePlaceholder='Header-Name'
          entries={data.endpointHeaders}
          onChange={(endpointHeaders) => updateData({ endpointHeaders })}
        />
      ) : null}
      {responsesOptIn ? (
        <div className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <input
              type='checkbox'
              checked={data.responsesApi ?? false}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setResponsesApi(e.target.checked)}
              className='rounded border-input'
            />
            <Label className='text-xs cursor-pointer' onClick={() => setResponsesApi(!data.responsesApi)}>
              Endpoint supports the Responses API
            </Label>
          </div>
          <p className='text-[10px] text-muted-foreground'>
            Offers Codex, which speaks only OpenAI&apos;s Responses API (<code>/responses</code>), and that API for the
            Custom harness. Most OpenAI-compatible servers implement Chat Completions only.
          </p>
        </div>
      ) : null}
      {isNative ? (
        <p className='text-[10px] text-muted-foreground'>
          The Custom harness runs inside OpenCroft, so it uses no terminal.
        </p>
      ) : (
        <div className='flex flex-col gap-1'>
          <Label className='text-xs'>Terminal</Label>
          <TerminalSelector
            value={terminal}
            onChange={(value) => updateData({ terminal: value || undefined })}
            placeholder='Choose a terminal'
          />
          <p className='text-[10px] text-muted-foreground'>
            Required. The harness runs through this terminal: a Localhost node for this server, a server over SSH, or an
            Application's container.
          </p>
          {check ? (
            <TerminalCheckLine check={check} />
          ) : (
            <p className='text-[10px] text-destructive' role='alert'>
              Choose a terminal: the agent does not start without one.
            </p>
          )}
        </div>
      )}
      {terminal && !isNative ? (
        <div className='flex flex-col gap-1'>
          <Label className='text-xs'>Folder</Label>
          <Input
            className='h-8 text-xs'
            value={data.terminalFolder ?? ''}
            onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ terminalFolder: e.target.value })}
            placeholder="The terminal's own directory"
            aria-invalid={check !== null && check !== 'checking' && Boolean(check.folderProblem)}
          />
          <p className='text-[10px] text-muted-foreground'>
            Optional. The working directory on the selected terminal, which must exist there. Empty: the directory the
            terminal starts in, such as a worktree terminal's worktree, a container's working directory or an SSH
            login's home.
          </p>
          {check !== null && check !== 'checking' && check.folderProblem ? (
            <p className='text-[10px] text-destructive' role='alert'>
              {check.folderProblem}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className='flex flex-col gap-1'>
        <div className='flex items-center gap-2'>
          <input
            type='checkbox'
            checked={data.autoUnloadIdle ?? false}
            onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ autoUnloadIdle: e.target.checked })}
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
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateData({
                  autoUnloadIdleMinutes: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
              placeholder='45'
            />
          </div>
        ) : null}
      </div>
      {isNative ? <NativeProfileFields data={data} updateData={updateData} apis={nativeApis} /> : null}
      {/* Outside the gate above, and after it so a native profile keeps the
          field order it always had. */}
      <ContextWindowField data={data} updateData={updateData} />
      {isNative ? null : terminal ? (
        <p className='text-[10px] text-muted-foreground'>
          Runs through terminal <TerminalRef target={terminal} /> in <WorkdirText check={check} />.
        </p>
      ) : data.containerName?.trim() ? (
        <p className='text-[10px] text-destructive' role='alert'>
          Ran in the Docker container <code>{data.containerName.trim()}</code>, and could not be moved to its terminal:
          choose a Terminal above.
        </p>
      ) : null}
    </div>
  )
}

// What agent.checkTerminal answers.
interface TerminalCheck {
  workdir?: string
  folderProblem?: string
  problem?: string
  endpoint?: { reachable: boolean; message: string }
  error?: string
}

// How long a typed Folder or Base URL rests before the terminal is asked about it.
const ENDPOINT_RECHECK_DELAY_MS = 600

// Whether the profile's harness could start on the picked terminal, asked
// again when the terminal, the Folder, the harness or the endpoint changes:
// the directory it works in there, its launcher, and whether its model
// endpoint answers from there (agent.checkTerminal). Null while no terminal
// is to be asked: none is picked, or the Custom harness, which runs inside
// OpenCroft, is chosen.
function useTerminalCheck(ask: {
  nodeId: string
  terminal: string | null
  folder?: string
  adapterId?: string
  providerId?: string
  baseUrl?: string
}): TerminalCheck | 'checking' | null {
  const { nodeId, terminal, folder, adapterId, providerId, baseUrl } = ask
  const [check, setCheck] = useState<TerminalCheck | 'checking'>('checking')
  useEffect(() => {
    if (!terminal) {
      return
    }
    let active = true
    setCheck('checking')
    const timer = setTimeout(() => {
      invoke<TerminalCheck>('agent.checkTerminal', { nodeId, terminal, folder, adapterId, providerId, baseUrl })
        .then((answer) => {
          if (active) {
            setCheck(answer)
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setCheck({ error: e instanceof Error ? e.message : String(e) })
          }
        })
    }, ENDPOINT_RECHECK_DELAY_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [nodeId, terminal, folder, adapterId, providerId, baseUrl])
  return terminal ? check : null
}

// The directory the agent works in, as the terminal check found it.
function WorkdirText({ check }: { check: TerminalCheck | 'checking' | null }) {
  if (check === null || check === 'checking') {
    return <>a folder still being checked</>
  }
  if (check.workdir) {
    return <code>{check.workdir}</code>
  }
  return check.folderProblem ? <>a folder that does not exist there</> : <>a folder the terminal could not name</>
}

// The terminal check's answer about the harness: its launcher and its endpoint.
function TerminalCheckLine({ check }: { check: TerminalCheck | 'checking' }) {
  if (check === 'checking') {
    return <p className='text-[10px] text-muted-foreground'>Checking the terminal…</p>
  }
  const trouble = check.problem ?? check.error
  if (trouble) {
    return (
      <p className='text-[10px] text-destructive' role='alert'>
        {trouble}
      </p>
    )
  }
  return (
    <>
      <p className='text-[10px] text-muted-foreground'>Node.js is available on this terminal.</p>
      {check.endpoint ? (
        <p
          className={`text-[10px] ${check.endpoint.reachable ? 'text-muted-foreground' : 'text-destructive'}`}
          role={check.endpoint.reachable ? undefined : 'alert'}
        >
          {check.endpoint.message}
        </p>
      ) : null}
    </>
  )
}

// What agent.oauthStart answers (agent-client's OauthLoginStart).
type OauthLogin =
  | { kind: 'paste-code'; loginId: string; authUrl: string }
  | { kind: 'device-code'; loginId: string; verificationUrl: string; userCode: string | null; message: string }
  | { kind: 'signed-in' }

// Connect/disconnect UI for harnesses that keep their own file-based OAuth
// credentials (see agent-client's oauth-login), which the harness then stores
// and rotates itself. Two ways in: the harness shows a consent URL and the
// user pastes the authorization code back (paste-code), or it shows a
// verification URL and a one-time code the user enters there while this
// waits (device-code). Every call names the agent node: the login belongs to
// that agent's own harness home. `homeKey` changes with whatever moves that
// home (the agent's name, its container), so the status is read again.
function OauthAccountSection({ adapterId, nodeId, homeKey }: { adapterId: string; nodeId: string; homeKey: string }) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState<Exclude<OauthLogin, { kind: 'signed-in' }> | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    invoke<{ connected: boolean }>('agent.oauthStatus', adapterId, nodeId)
      .then((s: { connected: boolean }) => setConnected(s.connected))
      .catch((e: unknown) => {
        setConnected(null)
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [adapterId, nodeId])

  // homeKey is a trigger, not an input: the server reads the home from the node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: homeKey is only a re-run trigger, the effect does not read it
  useEffect(() => {
    setLogin(null)
    setCode('')
    setError('')
    refresh()
  }, [refresh, homeKey])

  const start = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      const started = await invoke<OauthLogin>('agent.oauthStart', adapterId, nodeId)
      if (started.kind === 'signed-in') {
        refresh()
      } else {
        setLogin(started)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [adapterId, nodeId, refresh])

  // A device-code login finishes on another device; ask until it has.
  const deviceLoginId = login?.kind === 'device-code' ? login.loginId : null
  useEffect(() => {
    if (!deviceLoginId) {
      return
    }
    let active = true
    const wait = async () => {
      while (active) {
        const result = await invoke<{ pending?: true; ok?: boolean; error?: string }>('agent.oauthAwait', deviceLoginId)
        if (!active || result.pending) {
          continue
        }
        setLogin(null)
        if (result.ok) {
          refresh()
        } else {
          setError(result.error || 'Sign-in failed')
        }
        return
      }
    }
    wait().catch((e: unknown) => {
      if (active) {
        setLogin(null)
        setError(e instanceof Error ? e.message : String(e))
      }
    })
    return () => {
      active = false
    }
  }, [deviceLoginId, refresh])

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
      await invoke('agent.oauthDisconnect', adapterId, nodeId)
      setLogin(null)
      setCode('')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [adapterId, nodeId, refresh])

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
      ) : login?.kind === 'device-code' ? (
        <div className='flex flex-col gap-1.5'>
          <p className='text-[10px] text-muted-foreground'>
            Open the sign-in page and enter this code there. This finishes by itself once you have.
          </p>
          <a href={login.verificationUrl} target='_blank' rel='noreferrer' className='break-all text-xs underline'>
            {login.verificationUrl}
          </a>
          {login.userCode ? (
            <code className='select-all self-start rounded-md bg-muted px-2 py-1 font-mono text-sm'>
              {login.userCode}
            </code>
          ) : (
            <p className='text-xs'>{login.message}</p>
          )}
          <div className='flex items-center gap-2'>
            <Spinner className='size-3 text-muted-foreground' />
            <p className='flex-1 text-[10px] text-muted-foreground'>Waiting for the sign-in to finish…</p>
            {/* Disconnect ends the attempt in flight; there is no login yet to remove. */}
            <Button variant='ghost' size='sm' onClick={disconnect} disabled={busy}>
              Cancel
            </Button>
          </div>
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
              onChange={(e: ChangeEvent<HTMLInputElement>) => setCode(e.target.value)}
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

// Temperature and image input only apply to the in-process Custom (native)
// harness; ACP agents manage their own sampling and decide what their model is
// shown. Its system prompt is in the Instructions tab, with every other
// harness's instruction texts.
function NativeProfileFields({
  data,
  updateData,
  apis,
}: {
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
  apis: NativeApi[]
}) {
  return (
    <div className='flex flex-col gap-3'>
      {/* Offered only where there is a choice: a provider with one API runs on it. */}
      {apis.length > 1 ? (
        <ProfileSelect
          label='API'
          value={data.nativeApi && apis.includes(data.nativeApi) ? data.nativeApi : apis[0]}
          placeholder={NATIVE_API_LABELS[apis[0]]}
          options={apis.map((api) => ({ value: api, label: NATIVE_API_LABELS[api] }))}
          onChange={(value) => updateData({ nativeApi: value as NativeApi })}
        />
      ) : null}
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Temperature</Label>
        <Input
          className='h-8 text-xs'
          type='number'
          min={0}
          max={2}
          step={0.1}
          value={data.temperature ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            updateData({ temperature: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          placeholder='Provider default'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <ProfileSelect
          label='Image input'
          value={imageInputChoice(data.imageInput)}
          placeholder='Ask the endpoint'
          options={IMAGE_INPUT_OPTIONS}
          onChange={(value) => updateData({ imageInput: imageInputFromChoice(value) })}
        />
        <span className='text-[10px] text-muted-foreground'>
          Whether the model is shown the images tools return. Ask the endpoint uses the model list's input modalities; a
          model it reports nothing about gets a text note in place of the image.
        </span>
      </div>
    </div>
  )
}

/**
 * The configured context window — shown for EVERY harness, native or bridged.
 *
 * It used to sit inside the native-only block above, and the comment that
 * justifies that block names system prompt and temperature and not this: the
 * window was swept into the gate by proximity rather than by a reason.
 * `knownContextWindow` consults a configured window first and never asks
 * which adapter is in use — and since 2026-09-18 the harness-reported size is
 * the trusted fallback for every harness, so this field is the OVERRIDE for a
 * figure the harness gets wrong or never sends, no longer the only source a
 * bridged session had while reported sizes were withheld.
 *
 * Empty stays meaningful and is the normal case: the chat renders against
 * whatever window the harness reports, and for a harness that reports none it
 * shows tokens used with no proportion.
 *
 * THERE IS A SECOND FIELD FOR THE SAME VALUE: agent-chat's `AgentPresetForm`
 * ("Max context") writes the same `contextWindow`. It is not mounted in this
 * app, which is why ungating it alone changed nothing a person could reach —
 * this copy kept the gate and this copy is the one in the Inspector. If a
 * harness gate is ever argued for again it has to be argued for in both at
 * once, or they disagree and only one of them is visible.
 */
function ContextWindowField({ data, updateData }: { data: AgentData; updateData: (p: Partial<AgentData>) => void }) {
  return (
    <div className='flex flex-col gap-1'>
      <Label className='text-xs'>Context window</Label>
      <Input
        className='h-8 text-xs'
        type='number'
        min={0}
        step={1000}
        value={data.contextWindow ?? ''}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          updateData({ contextWindow: e.target.value === '' ? undefined : Number(e.target.value) })
        }
        placeholder='Reported by the harness'
      />
      {/* Empty means "use what the harness reports", so the placeholder says
          where the figure will come from rather than pretending nobody has
          one. */}
      <span className='text-[10px] text-muted-foreground'>
        Tokens. Leave empty to use the window the harness reports; set it to override that figure.
      </span>
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
      <Select
        value={value || ''}
        items={options}
        onValueChange={(v) => {
          if (v !== null) {
            onChange(v)
          }
        }}
      >
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
