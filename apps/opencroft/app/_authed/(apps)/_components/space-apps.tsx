'use client'

import type { AppDefinition } from '@opencroft/client'
import { Link } from '@tanstack/react-router'
import { Pencil, Trash2 } from 'lucide-react'
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
} from 'ui/alert-dialog'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { Flex } from 'ui/layout/flex'
import { Tabs, TabsContent, TabsList, TabsTrigger } from 'ui/tabs'

import {
  addSpaceApp,
  listSpaceApps,
  removeSpaceApp,
  renameSpaceApp,
  updateSpaceApp,
} from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import { instanceSlugFor } from '@/app/_authed/(space)/_server/slug'

interface Props {
  spaceSlug: string
  /** Every App extensions provide, from the manifests. */
  apps: AppMeta[]
  initialInstances: SpaceAppInstance[]
}

/** The add/edit dialog's subject: which App, the name and values typed so far, and — when editing — which instance. */
interface FormState {
  app: AppMeta
  /** The instance's name — the host's field, required for every App. */
  name: string
  values: Record<string, string>
  /** Present when editing an existing instance. */
  instanceId?: string
  /** Why the last submit was refused, shown under the form. */
  error?: string
}

/** "label: value" for each declared parameter the instance has a value for. */
function paramsSummary(instance: SpaceAppInstance, meta: AppMeta | undefined): string {
  return (meta?.parameters ?? [])
    .filter((spec) => instance.params[spec.id])
    .map((spec) => `${spec.label}: ${instance.params[spec.id]}`)
    .join(' · ')
}

/** Whether the edited values differ from what the instance holds — trimmed, since the server trims on save. */
function paramsChanged(values: Record<string, string>, instance: SpaceAppInstance | undefined): boolean {
  const before = instance?.params ?? {}
  const keys = new Set([...Object.keys(values), ...Object.keys(before)])
  return [...keys].some((key) => (values[key] ?? '').trim() !== (before[key] ?? ''))
}

export function SpaceApps({ spaceSlug, apps, initialInstances }: Props) {
  const [instances, setInstances] = useState<SpaceAppInstance[]>(initialInstances)
  // Which pane is showing: the space's installed apps, or the catalog to add
  // from. Controlled so a completed add lands the reader back on Installed.
  const [tab, setTab] = useState<'installed' | 'add'>('installed')
  const [search, setSearch] = useState('')
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  // Editing PARAMETERS recreates the instance (its stored data is deleted) —
  // that is confirmed explicitly, not implied by a Save button. Apps whose
  // server module updates in place skip the confirmation, and a pure rename
  // never recreates at all: the name is the host's field, edited in place.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The extensions' client halves, for Apps that ship a custom parameter
  // form. Matched by slug, like dashboards match their components.
  const { items: definitions } = useProvided<AppDefinition>('apps', loadAllExtensions)

  const query = search.trim().toLowerCase()
  const catalog = query
    ? apps.filter((app) =>
        [app.title, app.description ?? '', app.slug].some((text) => text.toLowerCase().includes(query)),
      )
    : apps

  async function refresh() {
    setInstances(await listSpaceApps({ data: spaceSlug }))
  }

  /** Every add opens the form — the name is required whatever the App declares. */
  function handlePick(app: AppMeta) {
    setForm({ app, name: '', values: {} })
  }

  const editedInstance = form?.instanceId ? instances.find((instance) => instance.id === form.instanceId) : undefined

  async function handleSubmit() {
    if (!form || saving) {
      return
    }
    const name = form.name.trim()
    if (!name) {
      setForm((s) => (s ? { ...s, error: 'Every app needs a name.' } : s))
      return
    }
    if (form.instanceId) {
      if (paramsChanged(form.values, editedInstance) && !form.app.updatesInPlace) {
        setConfirmOpen(true)
        return
      }
      await handleSaveEdit()
      return
    }
    setSaving(true)
    try {
      await addSpaceApp({
        data: { spaceSlug, extensionId: form.app.extensionId, appSlug: form.app.slug, name, params: form.values },
      })
    } catch (error) {
      setForm((s) => (s ? { ...s, error: error instanceof Error ? error.message : String(error) } : s))
      return
    } finally {
      setSaving(false)
    }
    setForm(null)
    await refresh()
    setTab('installed')
  }

  async function handleRecreate() {
    setConfirmOpen(false)
    await handleSaveEdit()
  }

  // One save path for an edit: the rename (always in place) and, when values
  // actually differ, the parameter update — whether THAT recreates or updates
  // in place is the server's routing (handleInstanceUpdated), not the client's.
  async function handleSaveEdit() {
    if (!form?.instanceId || saving) {
      return
    }
    setSaving(true)
    try {
      const name = form.name.trim()
      if (name && name !== editedInstance?.name) {
        await renameSpaceApp({ data: { spaceSlug, instanceId: form.instanceId, name } })
      }
      if (paramsChanged(form.values, editedInstance)) {
        await updateSpaceApp({
          data: { spaceSlug, instanceId: form.instanceId, params: form.values },
        })
      }
    } catch (error) {
      setForm((s) => (s ? { ...s, error: error instanceof Error ? error.message : String(error) } : s))
      return
    } finally {
      setSaving(false)
    }
    setForm(null)
    await refresh()
  }

  async function handleRemove(instance: SpaceAppInstance) {
    await removeSpaceApp({ data: { spaceSlug, instanceId: instance.id } })
    await refresh()
  }

  const CustomForm = form ? definitions.find((d) => d.slug === form.app.slug)?.form : undefined
  // What the form's address line reads: the minted slug when editing, a live
  // preview of what the typed name will mint when adding.
  const formSlug = form
    ? editedInstance
      ? editedInstance.slug
      : form.name.trim()
        ? instanceSlugFor(form.name)
        : '…'
    : ''

  return (
    <Flex withGaps className='w-full'>
      <h2 className='text-base font-semibold'>Apps</h2>

      <Tabs value={tab} onValueChange={(next) => setTab(next as 'installed' | 'add')} className='w-full'>
        <TabsList>
          <TabsTrigger value='installed'>Installed</TabsTrigger>
          <TabsTrigger value='add'>Add</TabsTrigger>
        </TabsList>

        <TabsContent value='installed'>
          {instances.length === 0 ? (
            <p className='text-sm text-muted-foreground'>No apps added yet.</p>
          ) : (
            <Flex withGaps className='w-full'>
              {instances.map((instance) => {
                const meta = apps.find(
                  (app) => app.extensionId === instance.extensionId && app.slug === instance.appSlug,
                )
                const Icon = resolveIcon(meta?.icon)
                const summary = paramsSummary(instance, meta)
                const subtitle = [meta?.title ?? instance.appSlug, summary].filter(Boolean).join(' · ')
                return (
                  <Flex key={instance.id} row withGaps align='center' className='w-full rounded-md border p-3'>
                    <Link
                      to='/space/$slug/app/$instanceId'
                      params={{ slug: spaceSlug, instanceId: instance.id }}
                      className='flex min-w-0 flex-1 items-center gap-3 hover:opacity-80'
                    >
                      <Icon className='size-5 shrink-0 text-muted-foreground' />
                      <Flex className='min-w-0 flex-1'>
                        <span className='font-medium'>{instance.name}</span>
                        <span className='truncate text-xs text-muted-foreground'>{subtitle}</span>
                      </Flex>
                    </Link>
                    {meta && (
                      <Button
                        variant='ghost'
                        size='icon'
                        aria-label='Edit'
                        title='Edit'
                        onClick={() =>
                          setForm({
                            app: meta,
                            name: instance.name,
                            values: { ...instance.params },
                            instanceId: instance.id,
                          })
                        }
                      >
                        <Pencil />
                      </Button>
                    )}
                    <Button
                      variant='ghost'
                      size='icon'
                      aria-label='Remove'
                      title='Remove'
                      onClick={() => handleRemove(instance)}
                    >
                      <Trash2 />
                    </Button>
                  </Flex>
                )
              })}
            </Flex>
          )}
        </TabsContent>

        <TabsContent value='add'>
          <Flex withGaps className='w-full'>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search apps…' />
            {catalog.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                {apps.length === 0 ? 'No apps available.' : 'No apps match the search.'}
              </p>
            ) : (
              catalog.map((app) => {
                const Icon = resolveIcon(app.icon)
                return (
                  <button
                    key={`${app.extensionId}/${app.slug}`}
                    type='button'
                    className='flex w-full items-center gap-3 rounded-md border p-3 text-left hover:bg-accent'
                    onClick={() => handlePick(app)}
                  >
                    <Icon className='size-5 shrink-0 text-muted-foreground' />
                    <Flex className='min-w-0 flex-1'>
                      <span className='font-medium'>{app.title}</span>
                      {app.description && (
                        <span className='truncate text-xs text-muted-foreground'>{app.description}</span>
                      )}
                    </Flex>
                  </button>
                )
              })
            )}
          </Flex>
        </TabsContent>
      </Tabs>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.app.title}</DialogTitle>
          </DialogHeader>
          <Flex withGaps className='w-full'>
            <Label htmlFor='app-instance-name'>Name *</Label>
            <Input
              id='app-instance-name'
              autoFocus={!form?.instanceId}
              value={form?.name ?? ''}
              onChange={(e) => setForm((s) => (s ? { ...s, name: e.target.value, error: undefined } : s))}
            />
          </Flex>
          {CustomForm && form ? (
            <CustomForm
              spaceSlug={spaceSlug}
              params={form.values}
              onChange={(values) => setForm((s) => (s ? { ...s, values, error: undefined } : s))}
            />
          ) : (
            <Flex withGaps className='w-full'>
              {(form?.app.parameters ?? []).map((spec) => (
                <Flex key={spec.id} withGaps className='w-full'>
                  <Label htmlFor={`app-param-${spec.id}`}>
                    {spec.label}
                    {spec.required ? ' *' : ''}
                  </Label>
                  <Input
                    id={`app-param-${spec.id}`}
                    value={form?.values[spec.id] ?? ''}
                    placeholder={spec.placeholder}
                    onChange={(e) =>
                      setForm((s) =>
                        s ? { ...s, values: { ...s.values, [spec.id]: e.target.value }, error: undefined } : s,
                      )
                    }
                  />
                  {spec.description && <p className='text-xs text-muted-foreground'>{spec.description}</p>}
                </Flex>
              ))}
            </Flex>
          )}
          {/* The instance's address, minted from the name once at creation.
              A live preview while adding; the settled, immovable fact while
              editing — a rename deliberately does not change it. */}
          <p className='text-xs text-muted-foreground'>
            Address: {spaceSlug}.{formSlug}
          </p>
          {form?.error && <p className='text-sm text-destructive'>{form.error}</p>}
          <DialogFooter>
            <Button variant='ghost' onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving || !form?.name.trim()}>
              {saving ? 'Saving…' : form?.instanceId ? 'Save' : 'Add'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Recreate this app?</AlertDialogTitle>
            <AlertDialogDescription>
              Saving new parameters recreates the app instance: it is unloaded, its stored data is deleted, and it is
              initialized again from the new parameters. Data the app kept may be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRecreate}>Recreate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
