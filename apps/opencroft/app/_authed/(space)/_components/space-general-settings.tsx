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

import { SpaceIconSettings } from '@/app/_authed/(space)/_components/space-icon-settings'
import { deleteSpace, renameSpace } from '@/app/_authed/(space)/_server/actions'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  space: SpaceSummary
}

/**
 * The General tab of a space's settings: name, icon, and the Danger Zone --
 * deleting the space. Moving individual apps elsewhere first is each app's
 * own settings page (its Transfer action), not a bulk action here.
 *
 * Renaming MOVES THE SPACE'S ADDRESS (the slug follows the name), so a
 * successful rename navigates to the settings page under the new slug; a
 * name whose address another space holds is refused with the reason shown,
 * not suffixed (see the registry's rename).
 */
export function SpaceGeneralSettings({ space }: Props) {
  const router = useRouter()

  const [name, setName] = useState(space.name)
  const [renameError, setRenameError] = useState<string | undefined>()
  const [renaming, setRenaming] = useState(false)

  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | undefined>()

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

  async function handleDelete() {
    setDeleteConfirm(false)
    setDeleteError(undefined)
    const ok = await deleteSpace({ data: space.slug })
    if (!ok) {
      setDeleteError('That space could not be found.')
      return
    }
    await router.navigate({ to: '/spaces' })
    router.invalidate()
  }

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
          <Label>Delete space</Label>
          <p className='text-xs text-muted-foreground'>
            Deletes the space with everything still in it — its graphs, nodes and app instances. Transfer apps out
            first, from their own settings pages, if any of it should survive.
          </p>
          <div>
            <Button variant='destructive' onClick={() => setDeleteConfirm(true)}>
              Delete space
            </Button>
          </div>
          {deleteError && <p className='text-sm text-destructive'>{deleteError}</p>}
        </Flex>
      </Flex>

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
