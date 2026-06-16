import { icons, inspectorIntent, invoke, NodeFrame, OutputHandle, React, useGraphNodes, useReactFlow } from '@ext/host'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Terminal,
} from '@ext/ui'

import { InspectorFilesBody, PinButton, PinnedBody, StatsList } from '../shared'

void Badge

const { useCallback, useEffect, useState } = React

export interface ServerData {
  name: string
  address: string
  username: string
  port: number
  password?: string
  keyPath?: string
}

interface ServerStats {
  os: string
  cpu: string
  memory: string
  storage: string
}

function serverConfigFrom(data: ServerData) {
  return {
    address: data.address,
    port: data.port ?? 22,
    username: data.username || 'root',
    password: data.password,
    keyPath: data.keyPath,
  }
}

function useServerStats(data: ServerData) {
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(async () => {
    if (!data.address) {
      setStats(null)
      return
    }
    setLoading(true)
    try {
      const out = await invoke<ServerStats>('server.getStats', serverConfigFrom(data))
      setStats(out)
    } catch {
      setStats(null)
    } finally {
      setLoading(false)
    }
  }, [data.address, data.port, data.username, data.password, data.keyPath])
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
    const stores = nodes.filter((n) => n.type === 'core-key-store')
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
        <icons.Loader2 className='h-3 w-3 animate-spin mr-1.5' />
        Loading keys…
      </div>
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

export function ServerNode({ id, data, selected }: { id: string; data: ServerData; selected?: boolean }) {
  const { stats, loading, refresh } = useServerStats(data)
  const rf = useReactFlow()
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
      rf.setNodes((nds) => nds.map((n: { id: string }) => ({ ...n, selected: n.id === id })))
      inspectorIntent.open(id, tab)
    },
    [id, rf, data.address],
  )

  const openTerminal = useCallback(() => openInspector('terminal'), [openInspector])
  const openFiles = useCallback(() => openInspector('files'), [openInspector])

  const title = data.name || 'Server'
  const subtitle = `${data.username || 'root'}@${data.address || '?'}:${data.port || 22}`
  return (
    <NodeFrame
      icon={icons.Server}
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
                { icon: icons.Monitor, value: stats.os },
                { icon: icons.Cpu, value: stats.cpu },
                { icon: icons.MemoryStick, value: stats.memory },
                { icon: icons.HardDrive, value: stats.storage },
              ]}
            />
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>no stats</div>
          )
        }
        output={
          <>
            <OutputHandle type='terminal-context' id='terminal'>
              <PinButton icon={icons.TerminalSquare} label='Terminal' onClick={openTerminal} />
            </OutputHandle>
            <OutputHandle type='filesystem-target' id='fs-out'>
              <PinButton icon={icons.FolderOpen} label='Files' onClick={openFiles} />
            </OutputHandle>
          </>
        }
      />
    </NodeFrame>
  )
}

export function ServerInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: ServerData
  updateData: (p: Partial<ServerData>) => void
}) {
  const { stats, loading, refresh } = useServerStats(data)

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
      <div className='flex flex-col gap-1'>
        <Label>Password (optional)</Label>
        <Input type='password' value={data.password ?? ''} onChange={(e) => updateData({ password: e.target.value })} />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>SSH Key</Label>
        <KeyStoreKeySelector value={data.keyPath ?? ''} onChange={(v) => updateData({ keyPath: v || undefined })} />
      </div>
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
          keyPath: data.keyPath,
        },
      }}
    />
  )
}

export function ServerFilesTab({
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
          privateKey: data.keyPath,
          basePath: '/',
        },
      }}
    />
  )
}
