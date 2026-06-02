'use client'

import { Badge } from '@opencroft/ui-kit/badge'
import { Button } from '@opencroft/ui-kit/button'
import { Flex } from '@opencroft/ui-kit/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@opencroft/ui-kit/select'
import { Separator } from '@opencroft/ui-kit/separator'
import type { Node, NodeProps } from '@xyflow/react'
import { Check, Copy, KeyRound, Plus, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { copyKeyToWsl, createKey, deleteKey, importKey, type KeyEntry, listKeys, readPublicKey, removeKeyFromWsl } from '@/app/(legacy-app-dashboard)/_legacy/nodes/key-store/actions'
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/node-card'
import { ControlledInput } from '@/components/ui/input/controlled-input'

export type KeyStoreData = {
  keyNames: string[]
}

export type KeyStoreNode = Node<KeyStoreData, 'key-store'>

function KeyStoreComponent({ data, selected }: NodeProps<KeyStoreNode>) {
  const names = data.keyNames ?? []

  return (
    <NodeCard selected={selected} accent='oklch(0.8 0.15 80)'>
      <NodeCardHeader icon={KeyRound} iconClassName='text-amber-400' title='Key Store' extra={<span className='text-[10px] text-muted-foreground tabular-nums'>{names.length}</span>} />
      {names.length > 0 && (
        <NodeCardContent>
          <div className='flex flex-col gap-0.5'>
            {names.map((name, i) => (
              <div key={i} className='flex items-center gap-1.5 text-xs font-mono text-foreground/70'>
                <KeyRound className='h-2.5 w-2.5 text-muted-foreground' />
                {name}
              </div>
            ))}
          </div>
        </NodeCardContent>
      )}
    </NodeCard>
  )
}

function KeyItem({ entry, onCopyPublic, onDelete, onToggleWsl }: { entry: KeyEntry; onCopyPublic: () => void; onDelete: () => void; onToggleWsl: () => void }) {
  return (
    <div className='flex flex-col gap-1 rounded border p-2'>
      <div className='flex items-center gap-1.5'>
        <KeyRound className='h-3 w-3 text-muted-foreground' />
        <span className='text-xs font-mono flex-1'>{entry.name}</span>
        <Badge variant='outline' className='text-[9px] h-4'>
          {entry.type}
        </Badge>
      </div>
      <div className='text-[10px] font-mono text-muted-foreground truncate'>{entry.fingerprint}</div>
      <div className='flex gap-1 mt-1'>
        {entry.hasPublicKey && (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onCopyPublic}>
            <Copy className='h-2.5 w-2.5 mr-0.5' /> Pub
          </Button>
        )}
        {entry.inWsl ? (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onToggleWsl}>
            <Check className='h-2.5 w-2.5 mr-0.5' /> WSL
          </Button>
        ) : (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onToggleWsl}>
            <Upload className='h-2.5 w-2.5 mr-0.5' /> To WSL
          </Button>
        )}
        <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1 ml-auto text-destructive' onClick={onDelete}>
          <Trash2 className='h-2.5 w-2.5' />
        </Button>
      </div>
    </div>
  )
}

function ImportDropZone({ onImport }: { onImport: (name: string, content: string) => Promise<void> }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) {
        const content = await file.text()
        await onImport(file.name, content)
      }
    },
    [onImport],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles],
  )

  return (
    <div
      className={`flex flex-col items-center justify-center gap-1.5 rounded border-2 border-dashed p-4 cursor-pointer transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-muted-foreground/50'}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <Upload className='h-4 w-4 text-muted-foreground' />
      <p className='text-xs text-muted-foreground'>Drop key files or click to browse</p>
      <input
        ref={inputRef}
        type='file'
        className='hidden'
        multiple
        onChange={(e) => {
          if (e.target.files) {
            handleFiles(e.target.files)
          }
        }}
      />
    </div>
  )
}

function KeyStoreSettings({ id, updateData, onDirtyChange, onLoadingChange }: NodeSettingsProps<KeyStoreData>) {
  const [keys, setKeys] = useState<KeyEntry[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('ed25519')

  const load = useCallback(async () => {
    const list = await listKeys({ data: id })
    setKeys(list)
    updateData({ keyNames: list.map((k) => k.name) })
  }, [id, updateData])

  useEffect(() => {
    onLoadingChange(true)
    load().then(() => onLoadingChange(false))
  }, [id])

  useEffect(() => {
    onDirtyChange(false, () => {})
  }, [onDirtyChange])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) {
      return
    }
    await createKey({ data: { storeId: id, name: newName.trim(), keyType: newType } })
    setNewName('')
    await load()
    toast.success('Key created')
  }, [id, newName, newType, load])

  const handleImport = useCallback(
    async (name: string, content: string) => {
      await importKey({ data: { storeId: id, name, content } })
      await load()
      toast.success(`Imported ${name}`)
    },
    [id, load],
  )

  const handleDelete = useCallback(
    async (name: string) => {
      await deleteKey({ data: { storeId: id, name } })
      await load()
      toast.success('Key deleted')
    },
    [id, load],
  )

  const handleCopyPublic = useCallback(
    async (name: string) => {
      const pub = await readPublicKey({ data: { storeId: id, name } })
      await navigator.clipboard.writeText(pub.trim())
      toast.success('Public key copied')
    },
    [id],
  )

  const handleToggleWsl = useCallback(
    async (entry: KeyEntry) => {
      if (entry.inWsl) {
        await removeKeyFromWsl({ data: entry.name })
        toast.success(`Removed ${entry.name} from WSL`)
      } else {
        await copyKeyToWsl({ data: { storeId: id, name: entry.name } })
        toast.success(`Copied ${entry.name} to WSL`)
      }
      await load()
    },
    [id, load],
  )

  return (
    <div className='flex flex-col gap-3'>
      <Flex row className='gap-1'>
        <ControlledInput value={newName} onValueChanged={setNewName} onAccepted={handleCreate} placeholder='Key name' className='flex-1 h-7 text-xs' />
        <Select value={newType} onValueChange={setNewType}>
          <SelectTrigger className='h-7 text-xs w-24'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='ed25519'>Ed25519</SelectItem>
            <SelectItem value='rsa'>RSA</SelectItem>
            <SelectItem value='ecdsa'>ECDSA</SelectItem>
          </SelectContent>
        </Select>
        <Button size='sm' className='h-7 text-xs' onClick={handleCreate} disabled={!newName.trim()}>
          <Plus className='h-3 w-3' />
        </Button>
      </Flex>

      <Separator />

      {keys.length > 0 && (
        <Flex className='gap-1.5'>
          {keys.map((k) => (
            <KeyItem key={k.name} entry={k} onCopyPublic={() => handleCopyPublic(k.name)} onDelete={() => handleDelete(k.name)} onToggleWsl={() => handleToggleWsl(k)} />
          ))}
        </Flex>
      )}

      <ImportDropZone onImport={handleImport} />
    </div>
  )
}

export const keyStoreDefinition: NodeTypeDefinition<KeyStoreData> = {
  type: 'key-store',
  label: 'Key Store',
  icon: KeyRound,
  group: 'Storage',
  defaultData: () => ({ keyNames: [] }),
  component: KeyStoreComponent,
  settings: KeyStoreSettings,
}
