'use client'

import { Link } from '@tanstack/react-router'
import { type Node, type NodeProps, useReactFlow } from '@xyflow/react'
import { Check, Container, Cpu, Download, FolderOpen, HardDrive, Loader2, MemoryStick, Monitor, RefreshCw, Server, Terminal, TerminalSquare, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { Flex } from 'ui/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'
import { Separator } from 'ui/separator'
import { Spinner } from 'ui/spinner'
import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { useSettingsDraft } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/use-settings-draft'
import { type KeyEntry, listKeys } from '@/app/(legacy-app-dashboard)/_legacy/nodes/key-store/actions'
import { applyServerConfig, resolveServer } from '@/app/(legacy-app-dashboard)/_legacy/nodes/server/actions'
import { ButtonPin, HANDLE_EXECUTION, HANDLE_FILESYSTEM } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/button-pin'
import { PinnedNode, StatsList } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/pinned-node'
import { spawnFileBrowserWindow, spawnTerminalWindow } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/spawn-window'
import { checkDocker, getServerStats, installDockerUbuntu, type ServerStats } from '@/app/(server)/_server/remote'
import { type DockerFeature, type ServerFeature, type SshFeature, slug } from '@/app/(server)/_server/types'

export type ServerData = {
  name: string
  address: string
  features: ServerFeature[]
}

export type ServerNode = Node<ServerData, 'server'>

function getSsh(features: ServerFeature[] | undefined): SshFeature | undefined {
  return features?.find((f) => f.type === 'ssh') as SshFeature | undefined
}

function getDocker(features: ServerFeature[] | undefined): DockerFeature | undefined {
  return features?.find((f) => f.type === 'docker') as DockerFeature | undefined
}

function hasDocker(features: ServerFeature[] | undefined): boolean {
  return features?.some((f) => f.type === 'docker') ?? false
}

function buildTerminalConfig(data: ServerData): import('@opencroft/terminal').TerminalConfig | null {
  const ssh = getSsh(data.features)
  if (!ssh) {
    return null
  }
  if (ssh.keyPath && (ssh.keyPath.startsWith('/') || /^[A-Z]:\\/i.test(ssh.keyPath))) {
    return {
      type: 'local',
      config: {
        shell: 'ssh',
        args: ['-i', ssh.keyPath, '-o', 'StrictHostKeyChecking=no', '-p', String(ssh.port ?? 22), `${ssh.username || 'root'}@${data.address}`],
      },
    }
  }
  if (ssh.keyPath) {
    return { type: 'local', config: { shell: 'ssh', args: [slug(data.name)] } }
  }
  return {
    type: 'ssh',
    config: { host: data.address, port: ssh.port ?? 22, username: ssh.username || 'root', password: ssh.password },
  }
}

function ServerComponent({ data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<ServerNode>) {
  const ssh = getSsh(data.features)
  const { setNodes } = useReactFlow()
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!ssh || !data.address || !data.name) {
      return
    }
    setLoading(true)
    setError(false)
    resolveServer({ data: { name: data.name, address: data.address, features: data.features ?? [] } })
      .then((s) => getServerStats({ data: s }))
      .then((s) => {
        setStats(s)
        setLoading(false)
      })
      .catch(() => {
        setError(true)
        setLoading(false)
      })
  }, [data.name, data.address])

  const openTerminal = useCallback(async () => {
    if (!ssh || !data.name) {
      return
    }
    const resolved = await resolveServer({ data: { name: data.name, address: data.address, features: data.features ?? [] } })
    const termConfig = buildTerminalConfig({ ...data, features: resolved.features })
    if (!termConfig) {
      return
    }
    setNodes((nds) => [...nds, spawnTerminalWindow({ title: data.name, x: positionAbsoluteX, y: positionAbsoluteY }, termConfig)])
  }, [data, ssh, positionAbsoluteX, positionAbsoluteY, setNodes])

  const openFiles = useCallback(async () => {
    if (!ssh || !data.name) {
      return
    }
    const resolved = await resolveServer({ data: { name: data.name, address: data.address, features: data.features ?? [] } })
    const rSsh = getSsh(resolved.features)
    if (!rSsh) {
      return
    }
    setNodes((nds) => [
      ...nds,
      spawnFileBrowserWindow(
        { title: data.name, x: positionAbsoluteX, y: positionAbsoluteY },
        {
          id: `server:${slug(data.name)}`,
          name: data.name,
          type: 'ssh',
          config: {
            host: data.address,
            port: rSsh.port ?? 22,
            username: rSsh.username || 'root',
            password: rSsh.password,
            privateKey: rSsh.keyPath,
            basePath: '/',
          },
        },
      ),
    ])
  }, [data, ssh, positionAbsoluteX, positionAbsoluteY, setNodes])

  const status = loading ? ('warning' as const) : error ? ('destructive' as const) : stats ? ('success' as const) : undefined

  return (
    <PinnedNode
      selected={selected}
      loading={loading}
      accent='oklch(0.7 0.18 300)'
      icon={Server}
      iconClassName='text-purple-400'
      status={status}
      title={data.name || 'Server'}
      subtitle={ssh ? `${ssh.username || 'root'}@${data.address}` : data.address || undefined}
      input={
        stats ? (
          <StatsList
            items={[
              { icon: Monitor, value: stats.os },
              { icon: Cpu, value: stats.cpu },
              { icon: MemoryStick, value: stats.memory },
              { icon: HardDrive, value: stats.storage },
            ]}
          />
        ) : undefined
      }
      output={
        ssh && data.name ? (
          <>
            <ButtonPin handleId={HANDLE_EXECUTION} icon={TerminalSquare} label='Terminal' side='right' onClick={openTerminal} />
            <ButtonPin handleId={HANDLE_FILESYSTEM} icon={FolderOpen} label='Files' side='right' onClick={openFiles} />
            {hasDocker(data.features) && (
              <div className='nodrag nopan'>
                <Link to={`/docker/containers/${slug(data.name)}`}>
                  <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1.5'>
                    <Container className='h-2.5 w-2.5 mr-0.5' /> Docker
                  </Button>
                </Link>
              </div>
            )}
          </>
        ) : undefined
      }
    />
  )
}

function updateFeature(features: ServerFeature[], type: string, patch: Partial<ServerFeature>): ServerFeature[] {
  return features.map((f) => (f.type === type ? { ...f, ...patch } : f))
}

// --- Key Selector that loads from key-store nodes ---

function KeyStoreKeySelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { getNodes } = useReactFlow()
  const [keys, setKeys] = useState<{ ref: string; name: string; type: string }[] | null>(null)

  useEffect(() => {
    const stores = getNodes().filter((n) => n.type === 'key-store')
    Promise.all(
      stores.map(async (store) => {
        const list = await listKeys({ data: store.id })
        return list.map((k: KeyEntry) => ({
          ref: `${store.id}:${k.name}`,
          name: k.name,
          type: k.type,
        }))
      }),
    ).then((results) => setKeys(results.flat()))
  }, [getNodes])

  if (!keys) {
    return (
      <Flex row align='center' className='h-7 px-2 text-xs text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin mr-1.5' />
        Loading keys...
      </Flex>
    )
  }

  return (
    <Select value={value || '__none'} onValueChange={(v) => onChange(v === '__none' ? '' : v)}>
      <SelectTrigger className='h-7 text-xs'>
        <SelectValue placeholder='No key' />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value='__none'>No key</SelectItem>
        {keys.map((k) => (
          <SelectItem key={k.ref} value={k.ref}>
            {k.name} ({k.type})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// --- Docker sub-section ---

function DockerSubSection({ feature, serverData, onUpdate }: { feature: DockerFeature; serverData: ServerData; onUpdate: (f: DockerFeature) => void }) {
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const busy = checking || installing

  const handleCheck = async () => {
    setChecking(true)
    const server = await resolveServer({ data: { name: serverData.name, address: serverData.address, features: serverData.features } })
    const installed = await checkDocker({ data: server })
    onUpdate({ ...feature, installed })
    setChecking(false)
    toast.success(installed ? 'Docker is installed' : 'Docker not found')
  }

  const handleInstall = async () => {
    setInstalling(true)
    const server = await resolveServer({ data: { name: serverData.name, address: serverData.address, features: serverData.features } })
    await installDockerUbuntu({ data: server })
    onUpdate({ ...feature, installed: true })
    setInstalling(false)
    toast.success('Docker installed')
  }

  const StatusIcon = feature.installed === true ? Check : feature.installed === false ? X : null

  const statusText = feature.installed === undefined ? 'Status unknown' : feature.installed ? 'Docker is installed' : 'Docker not installed'

  return (
    <>
      <Flex row align='center' className='gap-1.5'>
        <Container className='h-3.5 w-3.5 text-muted-foreground' />
        <span className='text-xs flex-1'>{statusText}</span>
        {StatusIcon && <StatusIcon className={`h-3.5 w-3.5 ${feature.installed ? 'text-green-500' : 'text-red-500'}`} />}
      </Flex>
      <Flex row className='gap-1'>
        <Button variant='outline' size='sm' className='h-6 text-[10px]' onClick={handleCheck} disabled={busy}>
          {checking ? <Spinner className='h-3 w-3' /> : 'Check'}
        </Button>
        {feature.installed === false && (
          <Button variant='outline' size='sm' className='h-6 text-[10px]' onClick={handleInstall} disabled={busy}>
            {installing ? (
              <Spinner className='h-3 w-3' />
            ) : (
              <>
                <Download className='h-3 w-3 mr-0.5' />
                Install (Ubuntu)
              </>
            )}
          </Button>
        )}
      </Flex>
    </>
  )
}

// --- Stats sub-section ---

function StatsSubSection({ serverData }: { serverData: ServerData }) {
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [loading, setLoading] = useState(false)

  const s = slug(serverData.name)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const server = await resolveServer({ data: { name: serverData.name, address: serverData.address, features: serverData.features } })
      setStats(await getServerStats({ data: server }))
    } catch {
      toast.error('Failed to fetch stats')
    }
    setLoading(false)
  }, [serverData.name, serverData.address])

  useEffect(() => {
    if (serverData.address && getSsh(serverData.features)) {
      refresh()
    }
  }, [serverData.name, serverData.address])

  if (!stats && !loading) {
    return null
  }

  return (
    <>
      <Flex row align='center' className='gap-1'>
        <Label className='text-xs font-medium flex-1'>Status</Label>
        <Button variant='ghost' size='icon' className='h-5 w-5' onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
        </Button>
        <Link to={`/terminal/${s}`}>
          <Button variant='ghost' size='icon' className='h-5 w-5'>
            <TerminalSquare className='h-3 w-3' />
          </Button>
        </Link>
        <Link to={`/files/${s}`}>
          <Button variant='ghost' size='icon' className='h-5 w-5'>
            <FolderOpen className='h-3 w-3' />
          </Button>
        </Link>
        {hasDocker(serverData.features) && (
          <Link to={`/docker/containers/${s}`}>
            <Button variant='ghost' size='icon' className='h-5 w-5'>
              <Container className='h-3 w-3' />
            </Button>
          </Link>
        )}
      </Flex>
      {loading && !stats ? (
        <Flex align='center' justify='center' className='py-2'>
          <Spinner className='size-3' />
        </Flex>
      ) : (
        stats && (
          <div className='grid grid-cols-2 gap-1'>
            {[
              { icon: Monitor, label: 'OS', value: stats.os },
              { icon: Cpu, label: 'CPU', value: stats.cpu },
              { icon: MemoryStick, label: 'Mem', value: stats.memory },
              { icon: HardDrive, label: 'Disk', value: stats.storage },
            ].map((item) => (
              <Flex key={item.label} row align='center' className='gap-1 text-[10px]'>
                <item.icon className='h-3 w-3 text-muted-foreground shrink-0' />
                <span className='text-muted-foreground'>{item.label}</span>
                <span className='font-medium truncate'>{item.value}</span>
              </Flex>
            ))}
          </div>
        )
      )}
    </>
  )
}

// --- Main settings ---

function ServerSettings(props: NodeSettingsProps<ServerData>) {
  const { draft, update } = useSettingsDraft(props, async (data) => {
    await applyServerConfig({ data: { name: data.name, address: data.address, features: data.features ?? [] } })
  })

  const ssh = getSsh(draft.features)
  const docker = getDocker(draft.features)
  const features = draft.features ?? []

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Name</Label>
        <Input value={draft.name ?? ''} onChange={(e) => update({ name: e.target.value })} className='h-7 text-xs' />
        {draft.name && <span className='text-[10px] text-muted-foreground'>{slug(draft.name)}</span>}
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Address</Label>
        <Input value={draft.address ?? ''} onChange={(e) => update({ address: e.target.value })} className='h-7 text-xs font-mono' />
      </div>

      <Separator />

      {ssh ? (
        <>
          <div className='flex items-center justify-between'>
            <Label className='text-xs font-medium'>SSH</Label>
            <Button
              variant='ghost'
              size='icon'
              className='h-5 w-5'
              onClick={() => {
                update({ features: features.filter((f: ServerFeature) => f.type !== 'ssh' && f.type !== 'docker') })
              }}
            >
              <Trash2 className='h-3 w-3' />
            </Button>
          </div>
          <div className='flex flex-col gap-1'>
            <Label className='text-xs'>Username</Label>
            <Input
              value={ssh.username || ''}
              onChange={(e) => update({ features: updateFeature(features, 'ssh', { username: e.target.value }) })}
              placeholder='root'
              className='h-7 text-xs font-mono'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label className='text-xs'>Port</Label>
            <Input
              value={ssh.port || ''}
              onChange={(e) => update({ features: updateFeature(features, 'ssh', { port: parseInt(e.target.value) || undefined }) })}
              placeholder='22'
              className='h-7 text-xs font-mono'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label className='text-xs'>Password</Label>
            <Input
              type='password'
              value={ssh.password || ''}
              onChange={(e) => update({ features: updateFeature(features, 'ssh', { password: e.target.value }) })}
              autoComplete='one-time-code'
              className='h-7 text-xs font-mono'
            />
          </div>
          <div className='flex flex-col gap-1'>
            <Label className='text-xs'>SSH Key</Label>
            <KeyStoreKeySelector value={ssh.keyPath || ''} onChange={(v) => update({ features: updateFeature(features, 'ssh', { keyPath: v || undefined }) })} />
          </div>

          <Separator />

          {docker ? (
            <>
              <div className='flex items-center justify-between'>
                <Label className='text-xs font-medium'>Docker</Label>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-5 w-5'
                  onClick={() => {
                    update({ features: features.filter((f: ServerFeature) => f.type !== 'docker') })
                  }}
                >
                  <Trash2 className='h-3 w-3' />
                </Button>
              </div>
              <DockerSubSection feature={docker} serverData={draft} onUpdate={(f) => update({ features: updateFeature(features, 'docker', f) })} />
            </>
          ) : (
            <Button
              variant='outline'
              size='sm'
              className='h-7 text-xs'
              onClick={() => {
                update({ features: [...features, { type: 'docker' }] })
              }}
            >
              <Container className='h-3 w-3 mr-1' /> Add Docker
            </Button>
          )}

          <Separator />

          <StatsSubSection serverData={draft} />
        </>
      ) : (
        <Button
          variant='outline'
          size='sm'
          className='h-7 text-xs'
          onClick={() => {
            update({ features: [...features, { type: 'ssh', username: 'root' }] })
          }}
        >
          <Terminal className='h-3 w-3 mr-1' /> Add SSH
        </Button>
      )}
    </div>
  )
}

export const serverDefinition: NodeTypeDefinition<ServerData> = {
  type: 'server',
  label: 'Server',
  icon: Server,
  group: 'Infrastructure',
  defaultData: () => ({
    name: '',
    address: '',
    features: [],
  }),
  component: ServerComponent,
  settings: ServerSettings,
}
