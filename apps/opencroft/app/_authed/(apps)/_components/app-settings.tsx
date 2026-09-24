'use client'

import type { AppDefinition } from '@opencroft/client'
import { useRouter } from '@tanstack/react-router'
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
import { Input } from 'ui/input'
import { Label } from 'ui/label'
import { Flex } from 'ui/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'

import { removeSpaceApp, renameSpaceApp, transferSpaceApp, updateSpaceApp } from '@/app/_authed/(apps)/_server/actions'
import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  spaceSlug: string
  instance: SpaceAppInstance
  /**
   * The App the instance is of — parameter specs and update mode. Absent when
   * the providing extension is gone; the name and the danger zone still work,
   * only the parameters cannot be edited.
   */
  meta?: AppMeta
  /** Every space, for the transfer target picker. */
  spaces: SpaceSummary[]
}

/** Whether the edited values differ from what the instance holds — trimmed, since the server trims on save. */
function paramsChanged(values: Record<string, string>, instance: SpaceAppInstance): boolean {
  const before = instance.params
  const keys = new Set([...Object.keys(values), ...Object.keys(before)])
  return [...keys].some((key) => (values[key] ?? '').trim() !== (before[key] ?? ''))
}

/**
 * One App instance's settings page: rename (in place — the address never
 * moves), parameter editing (recreates the instance unless its App updates in
 * place, and says so first), and the danger zone — transferring the instance
 * to another space and removing it. Everything the Apps list used to spread
 * over per-row buttons, behind the row itself.
 */
export function AppSettings({ spaceSlug, instance, meta, spaces }: Props) {
  const router = useRouter()

  const [name, setName] = useState(instance.name)
  const [renameError, setRenameError] = useState<string>()
  const [renaming, setRenaming] = useState(false)

  const [values, setValues] = useState<Record<string, string>>({ ...instance.params })
  const [paramsError, setParamsError] = useState<string>()
  const [savingParams, setSavingParams] = useState(false)
  const [recreateConfirm, setRecreateConfirm] = useState(false)

  const [transferTarget, setTransferTarget] = useState('')
  const [transferConfirm, setTransferConfirm] = useState(false)
  const [transferError, setTransferError] = useState<string>()
  const [transferring, setTransferring] = useState(false)

  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [removeError, setRemoveError] = useState<string>()
  const [removing, setRemoving] = useState(false)

  // The extension's client half, for Apps that ship a custom parameter form.
  const { items: definitions } = useProvided<AppDefinition>('apps', loadAllExtensions)
  const CustomForm = meta ? definitions.find((d) => d.slug === meta.slug)?.form : undefined
  const Icon = resolveIcon(meta?.icon)

  const backToApps = () =>
    router.navigate({ to: '/space/$slug/settings', params: { slug: spaceSlug }, search: { section: 'apps' } })

  async function handleRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === instance.name || renaming) {
      return
    }
    setRenameError(undefined)
    setRenaming(true)
    try {
      await renameSpaceApp({ data: { spaceSlug, instanceId: instance.id, name: trimmed } })
      router.invalidate()
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenaming(false)
    }
  }

  // Editing PARAMETERS recreates the instance (its stored data is deleted) —
  // that is confirmed explicitly, not implied by a Save button. Apps whose
  // server module updates in place skip the confirmation.
  function handleSaveParams() {
    if (!meta || savingParams || !paramsChanged(values, instance)) {
      return
    }
    if (meta.updatesInPlace) {
      void saveParams()
      return
    }
    setRecreateConfirm(true)
  }

  async function saveParams() {
    setRecreateConfirm(false)
    setParamsError(undefined)
    setSavingParams(true)
    try {
      await updateSpaceApp({ data: { spaceSlug, instanceId: instance.id, params: values } })
      router.invalidate()
    } catch (error) {
      setParamsError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingParams(false)
    }
  }

  async function handleTransfer() {
    if (!transferTarget || transferring) {
      return
    }
    setTransferConfirm(false)
    setTransferError(undefined)
    setTransferring(true)
    try {
      await transferSpaceApp({ data: { spaceSlug, instanceId: instance.id, targetSpaceSlug: transferTarget } })
      // The instance no longer lives in this space, so neither does this page.
      await backToApps()
      router.invalidate()
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferring(false)
    }
  }

  async function handleRemove() {
    setRemoveConfirm(false)
    setRemoveError(undefined)
    setRemoving(true)
    try {
      await removeSpaceApp({ data: { spaceSlug, instanceId: instance.id } })
      await backToApps()
      router.invalidate()
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoving(false)
    }
  }

  const targetName = spaces.find((s) => s.slug === transferTarget)?.name ?? transferTarget

  return (
    <Flex withGaps className='w-full gap-8'>
      <Flex row withGaps align='center' className='w-full'>
        <Icon className='size-5 shrink-0 text-muted-foreground' />
        <Flex className='min-w-0 flex-1'>
          <span className='font-medium'>{meta?.title ?? instance.appSlug}</span>
          {/* The instance's public address, minted from its name. A rename moves
              it, which is why the Name field below says so: the old address stops
              resolving rather than redirecting. */}
          <span className='text-xs text-muted-foreground'>
            Address: {spaceSlug}.{instance.slug}
          </span>
        </Flex>
      </Flex>

      <Flex withGaps className='w-full'>
        <h2 className='text-base font-semibold'>Name</h2>
        <Flex row withGaps className='w-full max-w-md'>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label='App name' />
          <Button onClick={handleRename} disabled={renaming || !name.trim() || name.trim() === instance.name}>
            {renaming ? 'Saving…' : 'Save'}
          </Button>
        </Flex>
        <p className='text-xs text-muted-foreground'>
          Saving a new name moves the address above with it. Links and agent targets written against the old address
          stop working — they are not redirected.
        </p>
        {renameError && <p className='text-sm text-destructive'>{renameError}</p>}
      </Flex>

      {meta && (CustomForm || (meta.parameters ?? []).length > 0) && (
        <Flex withGaps className='w-full'>
          <h2 className='text-base font-semibold'>Parameters</h2>
          {CustomForm ? (
            <CustomForm
              spaceSlug={spaceSlug}
              params={values}
              onChange={(next) => {
                setValues(next)
                setParamsError(undefined)
              }}
            />
          ) : (
            <Flex withGaps className='w-full max-w-md'>
              {(meta.parameters ?? []).map((spec) => (
                <Flex key={spec.id} withGaps className='w-full'>
                  <Label htmlFor={`app-param-${spec.id}`}>
                    {spec.label}
                    {spec.required ? ' *' : ''}
                  </Label>
                  <Input
                    id={`app-param-${spec.id}`}
                    value={values[spec.id] ?? ''}
                    placeholder={spec.placeholder}
                    onChange={(e) => {
                      setValues((prev) => ({ ...prev, [spec.id]: e.target.value }))
                      setParamsError(undefined)
                    }}
                  />
                  {spec.description && <p className='text-xs text-muted-foreground'>{spec.description}</p>}
                </Flex>
              ))}
            </Flex>
          )}
          <div>
            <Button onClick={handleSaveParams} disabled={savingParams || !paramsChanged(values, instance)}>
              {savingParams ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {paramsError && <p className='text-sm text-destructive'>{paramsError}</p>}
        </Flex>
      )}

      <Flex withGaps className='w-full rounded-md border border-destructive/50 p-4'>
        <h2 className='text-base font-semibold text-destructive'>Danger Zone</h2>

        <Flex withGaps className='w-full'>
          <Label>Transfer app</Label>
          <p className='text-xs text-muted-foreground'>
            Move this app — with whatever data it owns — to another space. Its address changes to the target space's.
          </p>
          <Flex row withGaps className='w-full max-w-md'>
            <Select
              value={transferTarget || null}
              items={spaces.filter((s) => s.slug !== spaceSlug).map((s) => ({ value: s.slug, label: s.name }))}
              onValueChange={(value) => {
                if (value === null) {
                  return
                }
                setTransferTarget(value)
                setTransferError(undefined)
              }}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='Choose a space' />
              </SelectTrigger>
              <SelectContent>
                {spaces
                  .filter((s) => s.slug !== spaceSlug)
                  .map((s) => (
                    <SelectItem key={s.slug} value={s.slug}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              variant='destructive'
              onClick={() => setTransferConfirm(true)}
              disabled={transferring || !transferTarget}
            >
              {transferring ? 'Transferring…' : 'Transfer'}
            </Button>
          </Flex>
          {transferError && <p className='text-sm text-destructive'>{transferError}</p>}
        </Flex>

        <Flex withGaps className='w-full'>
          <Label>Remove app</Label>
          <p className='text-xs text-muted-foreground'>
            The app is unloaded and everything it stored is deleted. Transfer it instead if the data should survive.
          </p>
          <div>
            <Button variant='destructive' onClick={() => setRemoveConfirm(true)} disabled={removing}>
              {removing ? 'Removing…' : 'Remove app'}
            </Button>
          </div>
          {removeError && <p className='text-sm text-destructive'>{removeError}</p>}
        </Flex>
      </Flex>

      <AlertDialog open={recreateConfirm} onOpenChange={setRecreateConfirm}>
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
            <AlertDialogAction onClick={() => void saveParams()}>Recreate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={transferConfirm} onOpenChange={setTransferConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Transfer {instance.name} to {targetName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The app moves to {targetName} with everything it owns, and its address changes to the target space's.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleTransfer}>Transfer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeConfirm} onOpenChange={setRemoveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {instance.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The app instance and everything it stored are deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
