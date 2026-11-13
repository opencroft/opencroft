import { invoke } from '@opencroft/client/actions'
import { inspectorIntent, NodeFrame, OutputHandle, useGraphNodes } from '@opencroft/client/canvas'
import { extensionId } from '@opencroft/client/extension'
import { SecretValueField } from '@opencroft/client/secrets'
import { Terminal } from '@opencroft/client/terminal'
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@opencroft/client/ui'
import {
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  Monitor,
  Server,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { InspectorFilesBody, PinButton, PinnedBody, StatsList } from '../shared'
import { storedType } from './stored-type'

export interface ServerData {
  name: string
  address: string
  username: string
  port: number
  /** Typed, or `secret:NAME`, resolved server-side where the SSH connection is dialled. */
  password?: string
  keyPath?: string
}

interface ServerStats {
  os: string
  cpu: string
  memory: string
  storage: string
}

// `nodeId` is the Server node: a `secret:NAME` password resolves from the Secrets Stores on its graph.
function serverConfigFrom(
  nodeId: string,
  data: Pick<ServerData, 'address' | 'port' | 'username' | 'password' | 'keyPath'>,
) {
  return {
    address: data.address,
    port: data.port ?? 22,
    username: data.username || 'root',
    password: data.password,
    credentialsScope: nodeId,
    keyPath: data.keyPath,
  }
}

function useServerStats(nodeId: string, data: ServerData) {
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [loading, setLoading] = useState(false)
  const { address, port, username, password, keyPath } = data
  const refresh = useCallback(async () => {
    if (!address) {
      setStats(null)
      return
    }
    setLoading(true)
    try {
      const out = await invoke<ServerStats>(
        'server.getStats',
        serverConfigFrom(nodeId, { address, port, username, password, keyPath }),
      )
      setStats(out)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [nodeId, address, port, username, password, keyPath])
  return { stats, loading, refresh }
}

interface KeyRef {
  ref: string
  name: string
  type: string
}

function KeyStoreKeySelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const nodes = useGraphNodes()
  const [keys, setKeys] = useState<KeyRef[] | null>(null)

  useEffect(() => {
    const stores = nodes.filter((n) => n.type === storedType(extensionId, 'core-key-store'))
    if (stores.length === 0) {
      setKeys([])
      return
    }
    Promise.all(
      stores.map(async (store) => {
        const list = await invoke<{ name: string; type: string }[]>('keyStore.listKeys', store.id)
        return list.map((k) => ({ ref: `${store.id}:${k.name}`, name: k.name, type: k.type }))
      }),
    ).then((results) => setKeys(results.flat()))
  }, [nodes])

  if (!keys) {
    return (
      <div className='flex items-center h-7 px-2 text-xs text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin mr-1.5' />
        Loading keys…
      </div>
    )
  }

  return (
    <Select
      value={value || '__none'}
      items={[
        { value: '__none', label: 'No key' },
        ...keys.map((k) => ({ value: k.ref, label: `${k.name} (${k.type})` })),
      ]}
      onValueChange={(v) => {
        if (v !== null) {
          onChange(v === '__none' ? '' : v)
        }
      }}
    >
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

export function ServerNode({ id, data, selected }: { id: string; data: ServerData; selected?: boolean }) {
  const { stats, loading, refresh } = useServerStats(id, data)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!data.address) {
      setLoaded(true)
      return
    }
    refresh().finally(() => setLoaded(true))
  }, [refresh, data.address])

  const openInspector = useCallback(
    (tab: string) => {
      if (!data.address) {
        return
      }
      inspectorIntent.open(id, tab)
    },
    [id, data.address],
  )

  const openTerminal = useCallback(() => openInspector('terminal'), [openInspector])

  const title = data.name || 'Server'
  const subtitle = `${data.username || 'root'}@${data.address || '?'}:${data.port || 22}`
  return (
    <NodeFrame
      icon={Server}
      title={title}
      subtitle={subtitle}
      status={!data.address ? 'neutral' : stats ? 'success' : !loaded ? 'neutral' : 'error'}
      selected={selected ?? false}
      loading={loading || !loaded}
    >
      <PinnedBody
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
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>no stats</div>
          )
        }
        output={
          <OutputHandle type='terminal-context' id='terminal'>
            <PinButton icon={TerminalSquare} label='Terminal' onClick={openTerminal} />
          </OutputHandle>
        }
      />
    </NodeFrame>
  )
}

interface HostKeyStatus {
  trusted: boolean
  fingerprint?: string
  error?: string
}

// Host-key trust: docker's `ssh://` transport (and any OpenSSH-based path)
// verifies the remote host key and fails closed when it isn't pinned. Surface
// that state and let the user pin it explicitly — no silent auto-trust.
function HostKeySection({ data }: { data: ServerData }) {
  const [status, setStatus] = useState<HostKeyStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    if (!data.address) {
      setStatus(null)
      return
    }
    setBusy(true)
    try {
      setStatus(await invoke<HostKeyStatus>('server.hostKeyStatus', data.address, data.port || 22))
    } catch (err) {
      setStatus({ trusted: false, error: String(err) })
    } finally {
      setBusy(false)
    }
  }, [data.address, data.port])

  useEffect(() => {
    check()
  }, [check])

  const accept = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await invoke<HostKeyStatus>('server.acceptHostKey', data.address, data.port || 22))
      toast.success('Host key accepted')
    } catch (err) {
      toast.error(`Could not accept host key: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [data.address, data.port])

  if (!data.address) {
    return null
  }

  return (
    <div className='flex flex-col gap-1'>
      <Label>Host key</Label>
      {status?.trusted ? (
        <div className='flex items-center gap-1.5 text-xs text-muted-foreground'>
          <ShieldCheck className='h-3.5 w-3.5 text-green-500 shrink-0' />
          <span className='font-mono break-all'>{status.fingerprint ? status.fingerprint : 'Trusted'}</span>
        </div>
      ) : (
        <div className='flex flex-col gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 p-2'>
          <div className='flex items-start gap-1.5 text-xs'>
            <ShieldAlert className='h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5' />
            <span>
              Host key not pinned — Docker/SSH transports will fail host-key verification until you accept it.
            </span>
          </div>
          {status?.fingerprint ? (
            <div className='text-[10px] font-mono text-muted-foreground break-all'>{status.fingerprint}</div>
          ) : null}
          {status?.error ? <div className='text-[10px] text-destructive break-all'>{status.error}</div> : null}
          <Button size='sm' className='h-7 text-xs' onClick={accept} disabled={busy || !status?.fingerprint}>
            {busy ? 'Working…' : 'Accept host key'}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ServerInspector({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: ServerData
  updateData: (p: Partial<ServerData>) => void
}) {
  const { stats, loading, refresh } = useServerStats(nodeId, data)
  const [installing, setInstalling] = useState(false)

  const installKey = useCallback(async () => {
    if (!data.keyPath || !data.address) {
      return
    }
    setInstalling(true)
    try {
      await invoke('server.installKey', serverConfigFrom(nodeId, data), data.keyPath)
      toast.success('Public key installed on server')
    } catch (err) {
      toast.error(`Install failed: ${String(err)}`)
    } finally {
      setInstalling(false)
    }
  }, [nodeId, data])

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input value={data.name ?? ''} onChange={(e) => updateData({ name: e.target.value })} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Address</Label>
        <Input value={data.address ?? ''} onChange={(e) => updateData({ address: e.target.value })} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Username</Label>
        <Input value={data.username ?? 'root'} onChange={(e) => updateData({ username: e.target.value })} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Port</Label>
        <Input type='number' value={data.port ?? 22} onChange={(e) => updateData({ port: Number(e.target.value) })} />
      </div>
      <SecretValueField
        label='Password (optional)'
        value={data.password}
        onChange={(password) => updateData({ password })}
      />
      <div className='flex flex-col gap-1'>
        <Label>SSH Key</Label>
        <KeyStoreKeySelector value={data.keyPath ?? ''} onChange={(v) => updateData({ keyPath: v || undefined })} />
        {data.keyPath ? (
          <Button
            variant='outline'
            size='sm'
            className='h-7 text-xs mt-1'
            onClick={installKey}
            disabled={installing || !data.address}
          >
            {installing ? 'Installing…' : 'Install key on server'}
          </Button>
        ) : null}
      </div>
      <HostKeySection data={data} />
      <Separator />
      <Button size='sm' className='h-7 text-xs' onClick={refresh} disabled={!data.address || loading}>
        {loading ? 'Refreshing…' : 'Refresh stats'}
      </Button>
      {stats ? (
        <div className='flex flex-col gap-1 text-xs font-mono'>
          <div>OS: {stats.os}</div>
          <div>CPU: {stats.cpu}</div>
          <div>RAM: {stats.memory}</div>
          <div>Disk: {stats.storage}</div>
        </div>
      ) : null}
    </div>
  )
}

export function ServerTerminalTab({
  nodeId,
  data,
}: {
  nodeId: string
  data: ServerData
  updateData: (p: Partial<ServerData>) => void
}) {
  if (!data.address) {
    return <div className='p-3 text-xs text-muted-foreground italic'>Configure server address to use the terminal.</div>
  }
  return (
    <Terminal
      connection={{
        type: 'ssh',
        config: {
          host: data.address,
          port: data.port || 22,
          username: data.username || 'root',
          password: data.password,
          credentialsScope: nodeId,
          keyPath: data.keyPath,
        },
      }}
    />
  )
}

export function ServerFilesTab({
  nodeId,
  data,
}: {
  nodeId: string
  data: ServerData
  updateData: (p: Partial<ServerData>) => void
}) {
  if (!data.address) {
    return <div className='p-3 text-xs text-muted-foreground italic'>Configure server address to browse files.</div>
  }
  return (
    <InspectorFilesBody
      connection={{
        id: `server:${data.address}:${data.port || 22}`,
        name: data.name || data.address,
        type: 'ssh',
        config: {
          host: data.address,
          port: data.port || 22,
          username: data.username || 'root',
          password: data.password,
          credentialsScope: nodeId,
          privateKey: data.keyPath,
          basePath: '/',
        },
      }}
    />
  )
}
