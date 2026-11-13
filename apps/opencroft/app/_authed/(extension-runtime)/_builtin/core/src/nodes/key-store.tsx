import { invoke } from '@opencroft/client/actions'
import { NodeFrame } from '@opencroft/client/canvas'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  ControlledInput,
  Flex,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from '@opencroft/client/ui'
import { Check, Copy, KeyRound, Plus, Trash2, Upload } from 'lucide-react'
import { type DragEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { type DeleteOutcome, describeReference, type NodeReference } from './delete-refusal-shared'

interface KeyEntry {
  name: string
  type: string
  fingerprint: string
  hasPublicKey: boolean
  inWsl: boolean
}
export interface KeyStoreData {
  keyNames: string[]
}

export function KeyStoreNode({ data, selected }: { data: KeyStoreData; selected?: boolean }) {
  const names = data.keyNames ?? []
  return (
    <NodeFrame
      icon={KeyRound}
      title='Key Store'
      subtitle={names.length > 0 ? `${names.length} keys` : 'empty'}
      selected={selected ?? false}
    >
      {names.length > 0 ? (
        <div className='flex flex-col gap-0.5 text-[10px] font-mono text-muted-foreground'>
          {names.slice(0, 5).map((n) => (
            <div key={n}>{n}</div>
          ))}
          {names.length > 5 ? <div>+{names.length - 5} more</div> : null}
        </div>
      ) : null}
    </NodeFrame>
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function KeyItem({
  entry,
  hasWsl,
  onCopyPublic,
  onDelete,
  onToggleWsl,
}: {
  entry: KeyEntry
  /** Whether the host is Windows, with WSL to copy the key into. */
  hasWsl: boolean
  onCopyPublic: () => void
  onDelete: () => void
  onToggleWsl: () => void
}) {
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
        {entry.hasPublicKey ? (
          <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1' onClick={onCopyPublic}>
            <Copy className='h-2.5 w-2.5 mr-0.5' /> Pub
          </Button>
        ) : null}
        {hasWsl ? (
          entry.inWsl ? (
            <Button
              variant='ghost'
              size='sm'
              className='h-5 text-[10px] px-1'
              onClick={onToggleWsl}
              title='Remove the copy from WSL'
            >
              <Check className='h-2.5 w-2.5 mr-0.5' /> WSL
            </Button>
          ) : (
            <Button
              variant='ghost'
              size='sm'
              className='h-5 text-[10px] px-1'
              onClick={onToggleWsl}
              title='Copy the key into ~/.ssh/keys in WSL'
            >
              <Upload className='h-2.5 w-2.5 mr-0.5' /> To WSL
            </Button>
          )
        ) : null}
        <Button
          variant='ghost'
          size='sm'
          className='h-5 text-[10px] px-1 ml-auto text-destructive'
          onClick={onDelete}
          aria-label={`Delete ${entry.name}`}
          title='Delete key'
        >
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
    (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles],
  )

  const cls =
    'flex flex-col items-center justify-center gap-1.5 rounded border-2 border-dashed p-4 cursor-pointer transition-colors ' +
    (dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-muted-foreground/50')

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: file drop is a pointer-only gesture; the button inside is the keyboard route to the same file picker
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <button type='button' className={`${cls} w-full`} onClick={() => inputRef.current?.click()}>
        <Upload className='h-4 w-4 text-muted-foreground' />
        <span className='text-xs text-muted-foreground'>Drop key files or click to browse</span>
      </button>
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

// `keyNames` is the server's to write: it brings the list to the store's keys
// whenever they are written or read, this inspector's load included.
export function KeyStoreInspector({
  nodeId,
}: {
  nodeId: string
  data: KeyStoreData
  updateData: (p: Partial<KeyStoreData>) => void
}) {
  const [keys, setKeys] = useState<KeyEntry[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('ed25519')
  const [hasWsl, setHasWsl] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ name: string; references: NodeReference[] } | null>(null)

  useEffect(() => {
    invoke<boolean>('keyStore.hasWsl').then(setHasWsl, () => setHasWsl(false))
  }, [])

  const load = useCallback(async () => {
    setKeys(await invoke<KeyEntry[]>('keyStore.listKeys', nodeId))
  }, [nodeId])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = useCallback(
    async (name: string) => {
      if (!name.trim()) {
        return
      }
      try {
        await invoke('keyStore.createKey', nodeId, name.trim(), newType)
        setNewName('')
        await load()
        toast.success('Key created')
      } catch (err) {
        toast.error(`Could not create key: ${errorText(err)}`)
      }
    },
    [newType, nodeId, load],
  )

  const handleImport = useCallback(
    async (name: string, content: string) => {
      try {
        await invoke('keyStore.importKey', nodeId, name, content)
        await load()
        toast.success(`Imported ${name}`)
      } catch (err) {
        toast.error(`Could not import ${name}: ${errorText(err)}`)
      }
    },
    [nodeId, load],
  )

  // The confirm names the nodes that lose their key, so they are looked up first.
  const askDelete = useCallback(
    async (name: string) => {
      try {
        setConfirmDelete({ name, references: await invoke<NodeReference[]>('keyStore.references', nodeId, name) })
      } catch (err) {
        toast.error(`Could not check what uses ${name}: ${errorText(err)}`)
      }
    },
    [nodeId],
  )

  // The delete goes past exactly the nodes the confirm listed. A node that
  // started using the key after the confirm opened refuses the delete, and
  // the confirm opens again listing it.
  const handleDelete = useCallback(
    async ({ name, references }: { name: string; references: NodeReference[] }) => {
      setConfirmDelete(null)
      try {
        const shown = references.map((ref) => ref.nodeId)
        const outcome = await invoke<DeleteOutcome>('keyStore.deleteKey', nodeId, name, shown)
        if ('refused' in outcome) {
          setConfirmDelete({ name, references: outcome.refused.references })
          return
        }
        toast.success(`Deleted ${name}`)
      } catch (err) {
        toast.error(`Could not delete ${name}: ${errorText(err)}`)
      }
      await load()
    },
    [nodeId, load],
  )

  const handleCopyPublic = useCallback(
    async (name: string) => {
      try {
        const pub = await invoke<string>('keyStore.readPublicKey', nodeId, name)
        await navigator.clipboard.writeText(pub.trim())
        toast.success('Public key copied')
      } catch (err) {
        toast.error(`Could not read public key: ${String(err)}`)
      }
    },
    [nodeId],
  )

  const handleToggleWsl = useCallback(
    async (entry: KeyEntry) => {
      try {
        if (entry.inWsl) {
          await invoke('keyStore.removeKeyFromWsl', entry.name)
          toast.success(`Removed ${entry.name} from WSL`)
        } else {
          await invoke('keyStore.copyKeyToWsl', nodeId, entry.name)
          toast.success(`Copied ${entry.name} to WSL`)
        }
        await load()
      } catch (err) {
        toast.error(`WSL update failed: ${String(err)}`)
      }
    },
    [nodeId, load],
  )

  return (
    <div className='flex flex-col gap-3'>
      <Flex row className='gap-1'>
        <ControlledInput
          value={newName}
          onValueChanged={setNewName}
          onAccepted={handleCreate}
          placeholder='Key name'
          aria-label='Name of the key to create'
          className='flex-1 h-7 text-xs'
        />
        <Select
          value={newType}
          items={{ ed25519: 'Ed25519', rsa: 'RSA', ecdsa: 'ECDSA' }}
          onValueChange={(v) => {
            if (v !== null) {
              setNewType(v)
            }
          }}
        >
          <SelectTrigger className='h-7 text-xs w-24' aria-label='Key type'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='ed25519'>Ed25519</SelectItem>
            <SelectItem value='rsa'>RSA</SelectItem>
            <SelectItem value='ecdsa'>ECDSA</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size='sm'
          className='h-7 text-xs'
          onClick={() => handleCreate(newName)}
          disabled={!newName.trim()}
          aria-label='Create key'
          title='Create key'
        >
          <Plus className='h-3 w-3' />
        </Button>
      </Flex>
      <Separator />
      {keys.length > 0 ? (
        <Flex className='gap-1.5'>
          {keys.map((k) => (
            <KeyItem
              key={k.name}
              entry={k}
              hasWsl={hasWsl}
              onCopyPublic={() => handleCopyPublic(k.name)}
              onDelete={() => void askDelete(k.name)}
              onToggleWsl={() => handleToggleWsl(k)}
            />
          ))}
        </Flex>
      ) : (
        <div className='text-xs text-muted-foreground italic'>No keys yet</div>
      )}
      <ImportDropZone onImport={handleImport} />
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDelete && confirmDelete.references.length > 0
                ? `${confirmDelete.name} is still in use`
                : `Delete ${confirmDelete?.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The private and public key are deleted from this store. This cannot be undone.
              {confirmDelete && confirmDelete.references.length > 0
                ? ' These nodes use it, and their next SSH connection fails:'
                : ' No node on this instance names it as its key. A host that has its public key installed keeps it.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmDelete && confirmDelete.references.length > 0 ? (
            <ul className='flex flex-col gap-1 text-xs'>
              {confirmDelete.references.map((ref) => (
                <li key={ref.nodeId}>{describeReference(ref)}</li>
              ))}
            </ul>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => confirmDelete && void handleDelete(confirmDelete)}>
              {confirmDelete && confirmDelete.references.length > 0 ? 'Delete anyway' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
