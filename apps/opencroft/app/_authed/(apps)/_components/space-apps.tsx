'use client'

import type { AppDefinition } from '@opencroft/client'
import { Link } from '@tanstack/react-router'
import { Pencil, Plus, Trash2 } from 'lucide-react'
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

import { addSpaceApp, listSpaceApps, removeSpaceApp, updateSpaceApp } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

interface Props {
  spaceSlug: string
  /** Every App extensions provide, from the manifests. */
  apps: AppMeta[]
  initialInstances: SpaceAppInstance[]
}

/** The add/edit dialog's subject: which App, the values typed so far, and — when editing — which instance. */
interface FormState {
  app: AppMeta
  values: Record<string, string>
  /** Present when editing an existing instance; saving RECREATES it. */
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

export function SpaceApps({ spaceSlug, apps, initialInstances }: Props) {
  const [instances, setInstances] = useState<SpaceAppInstance[]>(initialInstances)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  // Editing recreates the instance (its stored data is deleted) — that is
  // confirmed explicitly, not implied by a Save button.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The extensions' client halves, for Apps that ship a custom parameter
  // form. Matched by slug, like dashboards match their components.
  const { items: definitions } = useProvided<AppDefinition>('apps', loadAllExtensions)

  async function refresh() {
    setInstances(await listSpaceApps({ data: spaceSlug }))
  }

  async function submit(app: AppMeta, values: Record<string, string>) {
    await addSpaceApp({
      data: { spaceSlug, extensionId: app.extensionId, appSlug: app.slug, params: values },
    })
  }

  /** Picking an App with parameters opens the form; one without them is added right away. */
  async function handlePick(app: AppMeta) {
    const definition = definitions.find((d) => d.slug === app.slug)
    setPickerOpen(false)
    if ((app.parameters?.length ?? 0) > 0 || definition?.form) {
      setForm({ app, values: {} })
      return
    }
    await submit(app, {})
    await refresh()
  }

  async function handleSubmit() {
    if (!form || saving) {
      return
    }
    if (form.instanceId) {
      setConfirmOpen(true)
      return
    }
    setSaving(true)
    try {
      await submit(form.app, form.values)
    } catch (error) {
      setForm((s) => (s ? { ...s, error: error instanceof Error ? error.message : String(error) } : s))
      return
    } finally {
      setSaving(false)
    }
    setForm(null)
    await refresh()
  }

  async function handleRecreate() {
    if (!form?.instanceId || saving) {
      return
    }
    setConfirmOpen(false)
    setSaving(true)
    try {
      await updateSpaceApp({
        data: { spaceSlug, instanceId: form.instanceId, params: form.values },
      })
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

  return (
    <Flex withGaps className='w-full'>
      <Flex row withGaps align='center' justify='between' className='w-full'>
        <h2 className='text-base font-semibold'>Apps</h2>
        <Button size='sm' onClick={() => setPickerOpen(true)} disabled={apps.length === 0}>
          <Plus /> Add app
        </Button>
      </Flex>

      {instances.length === 0 ? (
        <p className='text-sm text-muted-foreground'>No apps added yet.</p>
      ) : (
        <Flex withGaps className='w-full'>
          {instances.map((instance) => {
            const meta = apps.find((app) => app.extensionId === instance.extensionId && app.slug === instance.appSlug)
            const definition = definitions.find((d) => d.slug === instance.appSlug)
            const Icon = resolveIcon(meta?.icon)
            const summary = paramsSummary(instance, meta)
            const editable = meta && ((meta.parameters?.length ?? 0) > 0 || definition?.form)
            return (
              <Flex key={instance.id} row withGaps align='center' className='w-full rounded-md border p-3'>
                <Link
                  to='/space/$slug/app/$instanceId'
                  params={{ slug: spaceSlug, instanceId: instance.id }}
                  className='flex min-w-0 flex-1 items-center gap-3 hover:opacity-80'
                >
                  <Icon className='size-5 shrink-0 text-muted-foreground' />
                  <Flex className='min-w-0 flex-1'>
                    <span className='font-medium'>{meta?.title ?? instance.appSlug}</span>
                    <span className='truncate text-xs text-muted-foreground'>
                      {summary || (meta?.description ?? `${instance.extensionId}/${instance.appSlug}`)}
                    </span>
                  </Flex>
                </Link>
                {editable && (
                  <Button
                    variant='ghost'
                    size='icon'
                    onClick={() => setForm({ app: meta, values: { ...instance.params }, instanceId: instance.id })}
                  >
                    <Pencil />
                  </Button>
                )}
                <Button variant='ghost' size='icon' onClick={() => handleRemove(instance)}>
                  <Trash2 />
                </Button>
              </Flex>
            )
          })}
        </Flex>
      )}

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add app</DialogTitle>
          </DialogHeader>
          <Flex withGaps className='w-full'>
            {apps.map((app) => {
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
            })}
          </Flex>
        </DialogContent>
      </Dialog>

      <Dialog open={!!form} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{form?.app.title}</DialogTitle>
          </DialogHeader>
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
          {form?.error && <p className='text-sm text-destructive'>{form.error}</p>}
          <DialogFooter>
            <Button variant='ghost' onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saving}>
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
