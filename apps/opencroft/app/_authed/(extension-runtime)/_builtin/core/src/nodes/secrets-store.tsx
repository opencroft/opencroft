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
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Input,
  Label,
  SecretInput,
} from '@opencroft/client/ui'
import type { SecretRecipe } from '@opencroft/server/secrets'
import { Copy, Dices, EllipsisVertical, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { type DeleteOutcome, describeReference, type NodeReference, type RenameOutcome } from './delete-refusal-shared'
import { type RandomValueChoice, RandomValueDialog, type RandomValueTarget } from './random-value-dialog'
import { randomValueMode, startingPassword, startingRandom } from './secret-recipe-shared'
import {
  applyAnyway,
  duplicateRows,
  mergeWritten,
  type RefusedChange,
  removeSecretRow,
  rowTarget,
  type SecretEdit,
  type SecretRow,
  saveSecrets,
} from './secrets-store-save'
import { type LoginPassword, SetPasswordDialog, type SetPasswordTarget } from './set-password-dialog'

export interface SecretsData {
  secretKeys: string[]
}

export function SecretsStoreNode({ data, selected }: { data: SecretsData; selected?: boolean }) {
  const keys = data.secretKeys ?? []
  return (
    <NodeFrame
      icon={ShieldCheck}
      title='Secrets Store'
      subtitle={keys.length > 0 ? `${keys.length} secrets` : 'empty'}
      selected={selected ?? false}
    >
      {keys.length > 0 ? (
        <div className='flex flex-col gap-0.5 text-[10px] font-mono'>
          {keys.slice(0, 5).map((k) => (
            <div key={k} className='flex justify-between'>
              <span>{k}</span>
              <span className='text-muted-foreground tracking-widest'>•••</span>
            </div>
          ))}
        </div>
      ) : null}
    </NodeFrame>
  )
}

function formatEditedAt(iso?: string): string {
  if (!iso) {
    return 'unsaved'
  }
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const NAME_REQUIRED = 'Give the secret a name, or remove the row.'
const NAME_SHARED = 'Another row has this name. Rename one of them, or remove a row.'

// Copies what the field holds now, an unsaved edit included. The write starts
// inside the click: WebKit allows the clipboard only while the gesture runs.
// Outside a secure context there is no clipboard, and an unfocused document
// rejects the write; both end in the error toast.
function copyValue(name: string, value: string) {
  const write = navigator.clipboard?.writeText(value) ?? Promise.reject(new Error('No clipboard'))
  write.then(
    () => toast.success(name ? `Copied ${name}` : 'Copied', { duration: 1500 }),
    () => toast.error('Could not copy to the clipboard'),
  )
}

interface SecretRowEditorProps {
  row: SecretRow
  /** Why Save refused the row's name; undefined while the name is fine. */
  nameError: string | undefined
  /** The name Random value… and Set password… write under; undefined disables them (see `rowTarget`). */
  target: string | undefined
  onChange: (field: 'key' | 'value', v: string) => void
  onRemove: () => void
  /** Opens the Random value dialog, behind Rotate… where the row offers it and Random value… elsewhere. */
  onRandom: () => void
  onSetPassword: () => void
}

function SecretRowEditor({
  row,
  nameError,
  target,
  onChange,
  onRemove,
  onRandom,
  onSetPassword,
}: SecretRowEditorProps) {
  const name = row.savedKey ?? row.key.trim()
  // Rotate is offered only where the store can make the next value by the secret's recipe, never on
  // a value someone brought, and only once the row's own edits are saved.
  const mode = randomValueMode(row)
  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex items-center gap-1'>
        <Input
          value={row.key}
          onChange={(e) => onChange('key', e.target.value)}
          placeholder='KEY'
          autoComplete='off'
          aria-label='Secret name'
          aria-invalid={nameError !== undefined || undefined}
          className='h-7 text-xs font-mono flex-1 min-w-0'
        />
        <SecretInput
          value={row.value}
          onChange={(e) => onChange('value', e.target.value)}
          placeholder='value'
          aria-label={name ? `Value of ${name}` : 'Secret value'}
          className='h-7 flex-1 min-w-0'
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant='ghost'
                size='icon'
                className='h-7 w-7 shrink-0'
                aria-label={name ? `${name} actions` : 'Secret actions'}
              />
            }
          >
            <EllipsisVertical className='h-3 w-3' />
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='min-w-40'>
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={row.value === ''} onClick={() => copyValue(name, row.value)}>
                <Copy /> Copy
              </DropdownMenuItem>
              {mode === 'rotate' ? (
                <DropdownMenuItem disabled={row.dirty} onClick={onRandom}>
                  <RefreshCw /> Rotate…
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={target === undefined || (mode === 'replace' && row.dirty)}
                  onClick={onRandom}
                >
                  <Dices /> Random value…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled={target === undefined} onClick={onSetPassword}>
                <KeyRound /> Set password…
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant='destructive' onClick={onRemove}>
              <Trash2 /> Delete
              <DropdownMenuShortcut>on Save</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {nameError !== undefined ? (
        <div className='pl-1 text-[10px] text-destructive' role='alert'>
          {nameError}
        </div>
      ) : (
        <div className='pl-1 text-[10px] text-muted-foreground'>edited {formatEditedAt(row.updatedAt)}</div>
      )}
    </div>
  )
}

interface OrphanRow {
  id: string
  storeId: string
  key: string
  updatedAt: string
}

/** A row as `secretsStore.getSecrets` answers it. */
interface StoredSecret {
  id: string
  key: string
  value: string
  recipe: SecretRecipe | null
  rotatable: boolean
  updatedAt: string
}

function storedRow(s: StoredSecret): SecretRow {
  return {
    rowId: crypto.randomUUID(),
    id: s.id,
    savedKey: s.key,
    key: s.key,
    value: s.value,
    savedValue: s.value,
    recipe: s.recipe,
    rotatable: s.rotatable,
    updatedAt: s.updatedAt,
    dirty: false,
  }
}

/** How the in-use confirm names the changes it holds back: deletes, renames, or both. */
function refusedWording(items: RefusedChange[]) {
  const renames = items.filter((item) => item.rename).length
  if (renames === 0) {
    return { renames: false, done: 'deleted', verb: 'delete', action: 'Delete anyway' }
  }
  if (renames === items.length) {
    return { renames: true, done: 'renamed', verb: 'rename', action: 'Rename anyway' }
  }
  return { renames: true, done: 'deleted or renamed', verb: 'delete or rename', action: 'Save anyway' }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SecretsStoreInspector({ nodeId }: { nodeId: string }) {
  const [edit, setEdit] = useState<SecretEdit>({ rows: [], removed: [] })
  const [unnamed, setUnnamed] = useState<string[]>([])
  const [shared, setShared] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<RefusedChange[]>([])
  const [randomTarget, setRandomTarget] = useState<RandomValueTarget | null>(null)
  const [orphans, setOrphans] = useState<OrphanRow[]>([])
  const [orphanError, setOrphanError] = useState<string | null>(null)
  const [confirmOrphan, setConfirmOrphan] = useState<OrphanRow | null>(null)
  const [passwordTarget, setPasswordTarget] = useState<SetPasswordTarget | null>(null)
  const [writing, setWriting] = useState(false)
  const dirty = edit.removed.length > 0 || edit.rows.some((r) => r.dirty)

  const reload = useCallback(async () => {
    const secrets = await invoke<StoredSecret[]>('secretsStore.getSecrets', nodeId)
    setEdit({ rows: secrets.map(storedRow), removed: [] })
    setUnnamed([])
    setShared([])
    try {
      setOrphans(await invoke<OrphanRow[]>('secretsStore.listOrphans', nodeId))
      setOrphanError(null)
    } catch (err) {
      setOrphans([])
      setOrphanError(errorText(err))
    }
  }, [nodeId])

  const deleteOrphan = useCallback(
    async ({ id, key }: OrphanRow) => {
      setConfirmOrphan(null)
      try {
        await invoke('secretsStore.deleteOrphan', nodeId, id)
        toast.success(`Deleted orphan ${key}`)
      } catch (err) {
        toast.error(`Could not delete ${key}: ${String(err)}`)
      }
      await reload()
    },
    [nodeId, reload],
  )

  useEffect(() => {
    reload()
  }, [reload])

  const persist = useCallback(async () => {
    setSaving(true)
    try {
      const result = await saveSecrets(edit.rows, edit.removed, {
        deleteSecret: (key) => invoke<DeleteOutcome>('secretsStore.deleteSecret', nodeId, key),
        renameSecret: (from, to) => invoke<RenameOutcome>('secretsStore.renameSecret', nodeId, from, to),
        setSecret: (key, value) => invoke('secretsStore.setSecret', nodeId, key, value),
      })
      if (result.status === 'unnamed') {
        setUnnamed(result.rowIds)
        toast.error('Not saved: a secret has no name')
        return
      }
      if (result.status === 'duplicate') {
        setShared(result.rowIds)
        toast.error('Not saved: two secrets have the same name')
        return
      }
      // The rows that did save are shown even when another one did not. The
      // node's key index needs nothing from here: the server re-derives it
      // after every write to the store.
      await reload()
      if (result.failed.length > 0) {
        toast.error(`Could not save ${result.failed.join('; ')}`)
      }
      if (result.refused.length > 0) {
        setRefused(result.refused)
      } else if (result.failed.length === 0) {
        toast.success('Secrets saved')
      }
    } finally {
      setSaving(false)
    }
  }, [edit, nodeId, reload])

  // A secret a node started naming after the confirm opened is not deleted or
  // renamed: the confirm opens again, listing every node that names it now.
  const handleAnyway = useCallback(
    async (items: RefusedChange[]) => {
      setRefused([])
      const result = await applyAnyway(items, {
        deleteListed: (key, shown) => invoke<DeleteOutcome>('secretsStore.deleteSecret', nodeId, key, shown),
        renameListed: (from, to, shown) => invoke<RenameOutcome>('secretsStore.renameSecret', nodeId, from, to, shown),
        setSecret: (key, value) => invoke('secretsStore.setSecret', nodeId, key, value),
      })
      for (const key of result.deleted) {
        toast.success(`Deleted ${key}`)
      }
      for (const { from, to } of result.renamed) {
        toast.success(`Renamed ${from} to ${to}`)
      }
      if (result.failed.length > 0) {
        toast.error(`Could not save ${result.failed.join('; ')}`)
      }
      await reload()
      setRefused(result.refused)
    },
    [nodeId, reload],
  )

  const addRow = useCallback(() => {
    const rowId = crypto.randomUUID()
    setEdit((prev) => ({ ...prev, rows: [...prev.rows, { rowId, key: '', value: '', dirty: true }] }))
  }, [])

  const updateRow = useCallback((index: number, field: 'key' | 'value', v: string) => {
    setEdit((prev) => ({
      ...prev,
      rows: prev.rows.map((r, i) => (i === index ? { ...r, [field]: v, dirty: true } : r)),
    }))
  }, [])

  const removeRow = useCallback((index: number) => {
    setEdit((prev) => removeSecretRow(prev, index))
  }, [])

  // After a write from a row's menu: that row shows what the store now holds,
  // and every other row keeps its unsaved edit.
  const showWritten = useCallback(
    async (key: string) => {
      const fresh = (await invoke<StoredSecret[]>('secretsStore.getSecrets', nodeId)).find((s) => s.key === key)
      if (fresh) {
        setEdit((prev) => mergeWritten(prev, key, storedRow(fresh)))
      }
    },
    [nodeId],
  )

  // One dialog for Random value… and Rotate…, on new and stored rows alike, its
  // fields started from the recipe. Replacing a stored value names who stops
  // working, so the nodes are looked up first.
  const openRandom = useCallback(
    async (row: SecretRow, key: string) => {
      const start = startingRandom(row.recipe)
      const mode = randomValueMode(row)
      if (mode === 'create') {
        setRandomTarget({ key, mode, references: [], ...start })
        return
      }
      try {
        const references = await invoke<NodeReference[]>('secretsStore.references', nodeId, key)
        setRandomTarget({ key, mode, references, ...start })
      } catch (err) {
        toast.error(`Could not check what uses ${key}: ${errorText(err)}`)
      }
    },
    [nodeId],
  )

  // The value is made on the server, so it never travels back in the answer;
  // the row shows it behind the eye. Rotate goes through the store's rotate,
  // which refuses a secret its recipe cannot remake; a new value, or one in
  // place of a typed value or a password, is written by generate, which creates
  // the name or replaces what it holds.
  const writeRandom = useCallback(
    async ({ key, mode }: RandomValueTarget, choice: RandomValueChoice) => {
      const rotate = mode === 'rotate'
      setWriting(true)
      try {
        await invoke(rotate ? 'secretsStore.rotateSecret' : 'secretsStore.generate', nodeId, key, choice)
        setRandomTarget(null)
        toast.success(rotate ? `Rotated ${key}` : `Saved ${key}`)
        await showWritten(key)
      } catch (err) {
        toast.error(`Could not ${rotate ? 'rotate' : 'save'} ${key}: ${errorText(err)}`)
      } finally {
        setWriting(false)
      }
    },
    [nodeId, showWritten],
  )

  const setPassword = useCallback(
    async (key: string, { login, password, basic }: LoginPassword) => {
      setWriting(true)
      try {
        await invoke('secretsStore.setPassword', nodeId, key, login, password, basic)
        setPasswordTarget(null)
        toast.success(`Saved ${key}`)
        await showWritten(key)
      } catch (err) {
        toast.error(`Could not save ${key}: ${errorText(err)}`)
      } finally {
        setWriting(false)
      }
    },
    [nodeId, showWritten],
  )

  // A new row whose name the store already holds under another row, or whose
  // row was deleted and waits for Save, would write over that secret, so Random
  // value… and Set password… are off until it is renamed.
  const savedKeys = new Set([
    ...edit.rows.flatMap((r) => (r.savedKey === undefined ? [] : [r.savedKey])),
    ...edit.removed,
  ])
  const wording = refusedWording(refused)
  // A refused name stays marked until its row is given a name of its own.
  const sharedNow = new Set(duplicateRows(edit.rows))
  const nameErrorOf = (row: SecretRow): string | undefined => {
    if (unnamed.includes(row.rowId) && !row.key.trim()) {
      return NAME_REQUIRED
    }
    return shared.includes(row.rowId) && sharedNow.has(row.rowId) ? NAME_SHARED : undefined
  }
  const targetOf = (row: SecretRow): string | undefined => {
    const target = rowTarget(row)
    return row.savedKey === undefined && target !== undefined && savedKeys.has(target) ? undefined : target
  }

  return (
    <div className='flex flex-col gap-3'>
      <Label className='text-xs'>Secrets</Label>
      <div className='flex flex-col gap-2'>
        {edit.rows.map((r, i) => (
          <SecretRowEditor
            key={r.rowId}
            row={r}
            nameError={nameErrorOf(r)}
            onChange={(field, v) => updateRow(i, field, v)}
            target={targetOf(r)}
            onRemove={() => removeRow(i)}
            onRandom={() => {
              const key = targetOf(r)
              if (key !== undefined) {
                void openRandom(r, key)
              }
            }}
            onSetPassword={() => {
              const key = targetOf(r)
              if (key !== undefined) {
                setPasswordTarget({ key, exists: r.savedKey !== undefined, ...startingPassword(r.recipe) })
              }
            }}
          />
        ))}
      </div>
      <div className='flex gap-1'>
        <Button variant='outline' size='sm' className='h-7 text-xs flex-1' onClick={addRow}>
          <Plus className='h-3 w-3 mr-1' /> Add Secret
        </Button>
        <Button size='sm' className='h-7 text-xs' onClick={persist} disabled={!dirty || saving}>
          Save
        </Button>
      </div>
      <SetPasswordDialog
        target={passwordTarget}
        busy={writing}
        onCancel={() => setPasswordTarget(null)}
        onSubmit={(entered) => passwordTarget && void setPassword(passwordTarget.key, entered)}
      />
      <RandomValueDialog
        target={randomTarget}
        busy={writing}
        onCancel={() => setRandomTarget(null)}
        onSubmit={(choice) => randomTarget && void writeRandom(randomTarget, choice)}
      />
      {orphans.length > 0 ? (
        <div className='flex flex-col gap-1 mt-3 pt-3 border-t'>
          <Label className='text-xs text-amber-600'>Orphan secrets ({orphans.length}) — from deleted stores</Label>
          <div className='text-[10px] text-muted-foreground'>
            These rows still live in the DB but no Secrets Store node owns them. They can shadow your active secrets at
            lookup time.
          </div>
          <div className='flex flex-col gap-0.5 mt-1'>
            {orphans.map((o) => (
              <div key={o.id} className='flex items-center gap-1 text-xs font-mono'>
                <span className='flex-1 truncate' title={`storeId: ${o.storeId}`}>
                  {o.key}
                </span>
                <span className='text-[10px] text-muted-foreground'>{formatEditedAt(o.updatedAt)}</span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-6 w-6'
                  onClick={() => setConfirmOrphan(o)}
                  aria-label={`Delete orphan ${o.key}`}
                  title='Delete orphan row'
                >
                  <Trash2 className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {orphanError ? (
        <div className='flex flex-col gap-1 mt-3 pt-3 border-t'>
          <Label className='text-xs text-amber-600'>Orphan secrets — not checked</Label>
          <div className='text-[10px] text-muted-foreground'>{orphanError}</div>
        </div>
      ) : null}
      <AlertDialog
        open={refused.length > 0}
        onOpenChange={(open) => {
          if (!open) {
            setRefused([])
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {refused.length === 1
                ? `${refused[0].key} is still in use`
                : `${refused.length} secrets are still in use`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Not {wording.done}: these nodes and apps still name {refused.length === 1 ? 'it' : 'them'}. If you{' '}
              {wording.verb} {refused.length === 1 ? 'it' : 'them'} anyway, they will fail at their next use or deploy.
              A container already running keeps the value it started with until then.
              {wording.renames ? ' A renamed secret is found again once they name the new name.' : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className='flex flex-col gap-1 text-xs'>
            {refused.map(({ key, rename, references }) => (
              <li key={key}>
                <span className='font-mono'>{key}</span>
                {rename ? (
                  <>
                    {' → '}
                    <span className='font-mono'>{rename.to}</span>
                  </>
                ) : null}
                : {references.map(describeReference).join(', ')}
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => void handleAnyway(refused)}>
              {wording.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmOrphan !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmOrphan(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete orphan secret {confirmOrphan?.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              It belongs to a Secrets Store node that no longer exists. The row and its value are deleted. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmOrphan && void deleteOrphan(confirmOrphan)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
