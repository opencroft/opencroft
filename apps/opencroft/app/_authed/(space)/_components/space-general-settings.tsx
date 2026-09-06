'use client'

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

import { transferAllSpaceApps } from '@/app/_authed/(apps)/_server/actions'
import { SpaceIconSettings } from '@/app/_authed/(space)/_components/space-icon-settings'
import { deleteSpace, renameSpace } from '@/app/_authed/(space)/_server/actions'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  space: SpaceSummary
  /** Every space, for the transfer target picker. */
  spaces: SpaceSummary[]
}

/**
 * The General tab of a space's settings: name, icon, and the Danger Zone --
 * transferring the space's contents away and deleting the space.
 *
 * Renaming MOVES THE SPACE'S ADDRESS (the slug follows the name), so a
 * successful rename navigates to the settings page under the new slug; a
 * name whose address another space holds is refused with the reason shown,
 * not suffixed (see the registry's rename).
 *
 * "Transfer space" moves every App instance -- graphs included, with their
 * nodes -- to the chosen space, leaving this one empty but alive (a fresh
 * default graph replaces the departed one). Deleting it afterwards is the
 * separate red button below, which is the point of them being two actions:
 * emptying a space and destroying it are different decisions.
 */
export function SpaceGeneralSettings({ space, spaces }: Props) {
  const router = useRouter()

  const [name, setName] = useState(space.name)
  const [renameError, setRenameError] = useState<string | undefined>()
  const [renaming, setRenaming] = useState(false)

  const [transferTarget, setTransferTarget] = useState('')
  const [transferConfirm, setTransferConfirm] = useState(false)
  const [transferError, setTransferError] = useState<string | undefined>()
  const [transferring, setTransferring] = useState(false)
  const [transferred, setTransferred] = useState<number | null>(null)

  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>()

  const lastSpace = spaces.length <= 1

  async function handleRename() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === space.name || renaming) {
      return
    }
    setRenameError(undefined)
    setRenaming(true)
    try {
      const result = await renameSpace({ data: { slug: space.slug, name: trimmed } })
      if (!result.ok) {
        setRenameError(
          result.code === 'slug-taken'
            ? 'Another space already answers to that name. Pick a different one.'
            : 'That space could not be found.',
        )
        return
      }
      // The slug moved with the name -- this page's own address changed.
      await router.navigate({ to: '/space/$slug/settings', params: { slug: result.space.slug } })
      router.invalidate()
    } finally {
      setRenaming(false)
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
      const count = await transferAllSpaceApps({
        data: { spaceSlug: space.slug, targetSpaceSlug: transferTarget },
      })
      setTransferred(count)
      router.invalidate()
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : String(error))
    } finally {
      setTransferring(false)
    }
  }

  async function handleDelete() {
    setDeleteConfirm(false)
    setDeleteError(undefined)
    const ok = await deleteSpace({ data: space.slug })
    if (!ok) {
      setDeleteError('The last remaining space cannot be deleted.')
      return
    }
    await router.navigate({ to: '/spaces' })
    router.invalidate()
  }

  const targetName = spaces.find((s) => s.slug === transferTarget)?.name ?? transferTarget

  return (
    <Flex withGaps className='w-full gap-8'>
      <Flex withGaps className='w-full'>
        <h2 className='text-base font-semibold'>Name</h2>
        <Flex row withGaps className='w-full max-w-md'>
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label='Space name' />
          <Button onClick={handleRename} disabled={renaming || !name.trim() || name.trim() === space.name}>
            {renaming ? 'Saving…' : 'Save'}
          </Button>
        </Flex>
        <p className='text-xs text-muted-foreground'>
          The space's address follows its name — links and agent notes keep resolving through the old one.
        </p>
        {renameError && <p className='text-sm text-destructive'>{renameError}</p>}
      </Flex>

      <SpaceIconSettings spaceSlug={space.slug} initialIcon={space.icon} />

      <Flex withGaps className='w-full rounded-md border border-destructive/50 p-4'>
        <h2 className='text-base font-semibold text-destructive'>Danger Zone</h2>

        <Flex withGaps className='w-full'>
          <Label>Transfer space</Label>
          <p className='text-xs text-muted-foreground'>
            Move everything this space holds — its apps and graphs, nodes included — to another space. This space stays,
            empty, so deleting it afterwards is a separate decision.
          </p>
          <Flex row withGaps className='w-full max-w-md'>
            <Select
              value={transferTarget || undefined}
              onValueChange={(value) => {
                setTransferTarget(value)
                setTransferError(undefined)
                setTransferred(null)
              }}
            >
              <SelectTrigger className='w-full'>
                <SelectValue placeholder='Choose a space' />
              </SelectTrigger>
              <SelectContent>
                {spaces
                  .filter((s) => s.slug !== space.slug)
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
          {transferred !== null && (
            <p className='text-sm text-muted-foreground'>
              Moved {transferred} app instance{transferred === 1 ? '' : 's'} to {targetName}.
            </p>
          )}
        </Flex>

        <Flex withGaps className='w-full'>
          <Label>Delete space</Label>
          <p className='text-xs text-muted-foreground'>
            Deletes the space with everything still in it — its graphs, nodes and app instances. Transfer first if any
            of it should survive.
          </p>
          <div>
            <Button variant='destructive' onClick={() => setDeleteConfirm(true)} disabled={lastSpace}>
              Delete space
            </Button>
          </div>
          {lastSpace && <p className='text-xs text-muted-foreground'>The last remaining space cannot be deleted.</p>}
          {deleteError && <p className='text-sm text-destructive'>{deleteError}</p>}
        </Flex>
      </Flex>

      <AlertDialog open={transferConfirm} onOpenChange={setTransferConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer everything to {targetName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every app instance of {space.name} moves to {targetName}, graphs with all their nodes included. Graph
              addresses change to the target space's; node ids stay the same.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleTransfer}>Transfer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {space.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The space and everything still in it — graphs, nodes, app instances and their data — is deleted. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Flex>
  )
}
