import { CircleAlert, EllipsisVertical, KeyRound, PackageSearch, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../alert-dialog'
import { Button } from '../button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { Input } from '../input'
import { Label } from '../label'
import { SecretValueField, type SecretValue } from '../nodes/secret-value-field'
import { Spinner } from '../utils/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import { cn } from 'cn'

/** Where a registry is configured: always there, the environment, or this page. */
export type ExtensionRegistryOrigin = 'default' | 'environment' | 'settings'

/** A registry's repository and the secrets it signs in with, as the dialog edits them. */
export interface ExtensionRegistryDraft {
  /** `owner/repo` or a git URL. */
  repository: string
  /** The username secret, as `secrets` names it. */
  username?: string
  /** The password or token secret, as `secrets` names it. */
  password?: string
}

export interface ExtensionRegistryEntry extends ExtensionRegistryDraft {
  /** Unique per row; what edit and remove are given. */
  key: string
  origin: ExtensionRegistryOrigin
  /** Whether it signs in. */
  needsCredentials: boolean
  /** How many extensions it lists, when it could be read. */
  extensions?: number
  /** Why its latest read failed. */
  error?: string
}

/** What a check of a draft found. */
export type ExtensionRegistryCheck = { extensions: number } | { error: string }

export interface ExtensionRegistriesProps {
  registries: ExtensionRegistryEntry[]
  /** The secrets a username or password can be picked from. Only references cross this component, never values. */
  secrets: string[]
  /** What a secret is shown as, e.g. its store and key. */
  secretLabel?: (secret: string) => string
  /** The list is being read again. */
  refreshing?: boolean
  onRefresh: () => void
  /** Read a draft without saving it. */
  onCheck: (draft: ExtensionRegistryDraft) => Promise<ExtensionRegistryCheck>
  /** Store a new registry (no `key`) or the edited one. A rejection is shown in the dialog. */
  onSave: (draft: ExtensionRegistryDraft, key?: string) => Promise<void>
  /** Remove a registry added here. A rejection is the host's to report. */
  onRemove: (key: string) => Promise<void>
  className?: string
}

const ORIGIN_LABEL: Record<ExtensionRegistryOrigin, string | undefined> = {
  default: 'Default',
  environment: 'From environment',
  settings: undefined,
}

const EMPTY_DRAFT: ExtensionRegistryDraft = { repository: '' }

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function asValue(secret: string | undefined): SecretValue {
  return secret ? { secret } : { value: '' }
}

function fromValue(value: SecretValue): string | undefined {
  return 'secret' in value ? value.secret : undefined
}

function RegistryState({ entry }: { entry: ExtensionRegistryEntry }) {
  if (entry.error) {
    return (
      <span className='flex items-start gap-1 text-xs text-destructive'>
        <CircleAlert className='mt-0.5 size-3 shrink-0' />
        <span className='break-words'>
          {entry.extensions !== undefined ? `${plural(entry.extensions, 'extension', 'extensions')} from an earlier read. ` : ''}
          {entry.error}
        </span>
      </span>
    )
  }
  return (
    <span className='text-muted-foreground'>
      {entry.extensions === undefined ? 'Not read yet' : plural(entry.extensions, 'extension', 'extensions')}
    </span>
  )
}

// One dialog for adding and editing: the same fields, the same check and the
// same save, so a registry is configured the same way whichever way it came in.
function RegistryDialog({
  entry,
  open,
  onOpenChange,
  secrets,
  secretLabel,
  onCheck,
  onSave,
}: {
  entry: ExtensionRegistryEntry | null
  open: boolean
  onOpenChange: (open: boolean) => void
  secrets: string[]
  secretLabel?: (secret: string) => string
  onCheck: ExtensionRegistriesProps['onCheck']
  onSave: ExtensionRegistriesProps['onSave']
}) {
  const [draft, setDraft] = useState<ExtensionRegistryDraft>(EMPTY_DRAFT)
  const [check, setCheck] = useState<ExtensionRegistryCheck | 'checking' | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [openedFor, setOpenedFor] = useState<ExtensionRegistryEntry | null | undefined>(undefined)

  // A fresh draft each time the dialog opens, from the row it opened for.
  if (open && openedFor !== entry) {
    setOpenedFor(entry)
    setDraft(entry ? { repository: entry.repository, username: entry.username, password: entry.password } : EMPTY_DRAFT)
    setCheck(null)
    setSaveError(undefined)
  } else if (!open && openedFor !== undefined) {
    setOpenedFor(undefined)
  }

  function change(next: Partial<ExtensionRegistryDraft>) {
    setDraft((current) => ({ ...current, ...next }))
    setCheck(null)
  }

  async function handleCheck() {
    setCheck('checking')
    try {
      setCheck(await onCheck(draft))
    } catch (error) {
      setCheck({ error: errorText(error) })
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(undefined)
    try {
      await onSave(draft, entry?.key)
      onOpenChange(false)
    } catch (error) {
      setSaveError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  const repository = draft.repository.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit registry' : 'Add registry'}</DialogTitle>
          <DialogDescription>
            A git repository with a registry.json at its root. A private one signs in with secrets from a Secrets Store.
          </DialogDescription>
        </DialogHeader>
        <form
          method='post'
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className='flex flex-col gap-4'>
            <div className='flex flex-col gap-1'>
              <Label htmlFor='extension-registry-repository'>Repository</Label>
              <Input
                id='extension-registry-repository'
                className='font-mono text-xs'
                placeholder='owner/repo or https://git.example.com/org/registry.git'
                value={draft.repository}
                onChange={(event) => change({ repository: event.target.value })}
                autoComplete='off'
                spellCheck={false}
              />
            </div>
            <SecretValueField
              label='Username'
              value={asValue(draft.username)}
              secrets={secrets}
              secretLabel={secretLabel}
              onChange={(value) => change({ username: fromValue(value) })}
              allowTyped={false}
              placeholder='None: x-access-token, as for a token'
            />
            <SecretValueField
              label='Password or token'
              value={asValue(draft.password)}
              secrets={secrets}
              secretLabel={secretLabel}
              onChange={(value) => change({ password: fromValue(value) })}
              allowTyped={false}
              placeholder='None: read without signing in'
            />
            <div className='flex flex-wrap items-center gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={!repository || check === 'checking'}
                  onClick={() => void handleCheck()}
                >
                  {check === 'checking' ? <Spinner /> : <PackageSearch />} Check
                </Button>
                {check && check !== 'checking' ? (
                  'error' in check ? (
                    <p role='alert' className='min-w-0 flex-1 text-xs text-destructive'>
                      {check.error}
                    </p>
                  ) : (
                    <p className='text-xs text-muted-foreground'>
                      Lists {plural(check.extensions, 'extension', 'extensions')}.
                    </p>
                  )
                ) : null}
            </div>
            {saveError ? (
              <p role='alert' className='text-sm text-destructive'>
                {saveError}
              </p>
            ) : null}
          </div>
          <DialogFooter className='mt-6'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={!repository || saving}>
              {saving ? <Spinner /> : null} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ExtensionRegistries({
  registries,
  secrets,
  secretLabel,
  refreshing,
  onRefresh,
  onCheck,
  onSave,
  onRemove,
  className,
}: ExtensionRegistriesProps) {
  const [editing, setEditing] = useState<ExtensionRegistryEntry | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [removing, setRemoving] = useState<ExtensionRegistryEntry | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)

  function openDialog(entry: ExtensionRegistryEntry | null) {
    setEditing(entry)
    setDialogOpen(true)
  }

  async function handleRemove() {
    if (!removing) {
      return
    }
    setRemoveBusy(true)
    try {
      await onRemove(removing.key)
    } finally {
      setRemoveBusy(false)
      setRemoving(null)
    }
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <p className='text-sm text-muted-foreground'>
          Where the Extensions page and agents search for extensions, and install them from.
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          <Button type='button' variant='outline' disabled={refreshing} onClick={onRefresh}>
            {refreshing ? <Spinner /> : <RefreshCw />} Refresh
          </Button>
          <Button type='button' onClick={() => openDialog(null)}>
            <Plus /> Add registry
          </Button>
        </div>
      </div>

      <div className='rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead className='hidden sm:table-cell'>Sign-in</TableHead>
              <TableHead>State</TableHead>
              <TableHead className='w-10'>
                <span className='sr-only'>Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {registries.map((entry) => {
              const origin = ORIGIN_LABEL[entry.origin]
              return (
                <TableRow key={entry.key} className='align-top'>
                  <TableCell className='max-w-72 whitespace-normal'>
                    <span className='font-mono text-xs break-all'>{entry.repository}</span>
                    {origin ? <span className='block text-xs text-muted-foreground'>{origin}</span> : null}
                  </TableCell>
                  <TableCell className='hidden text-muted-foreground sm:table-cell'>
                    {entry.needsCredentials ? (
                      <span className='flex items-center gap-1'>
                        <KeyRound className='size-3' /> Credentials
                      </span>
                    ) : (
                      'Public'
                    )}
                  </TableCell>
                  <TableCell className='max-w-72 whitespace-normal'>
                    <RegistryState entry={entry} />
                  </TableCell>
                  <TableCell className='text-right'>
                    {entry.origin === 'settings' ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon-sm'
                              aria-label={`Actions for ${entry.repository}`}
                            />
                          }
                        >
                          <EllipsisVertical />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => openDialog(entry)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem variant='destructive' onClick={() => setRemoving(entry)}>
                            <Trash2 /> Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <RegistryDialog
        entry={editing}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        secrets={secrets}
        secretLabel={secretLabel}
        onCheck={onCheck}
        onSave={onSave}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this registry?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.repository} is no longer searched. Extensions already installed from it stay installed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' disabled={removeBusy} onClick={() => void handleRemove()}>
              {removeBusy ? <Spinner /> : null} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
