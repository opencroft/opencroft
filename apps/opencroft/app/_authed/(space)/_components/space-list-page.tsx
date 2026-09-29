'use client'

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'
import { SpaceList } from 'ui/spaces/space-list'

import { createSpace, setSpacePinned } from '@/app/_authed/(space)/_server/actions'
import type { SpaceSummary } from '@/app/_authed/(space)/_server/types'

interface Props {
  /**
   * The route loader's list, rendered as given rather than copied into state:
   * a space created or deleted anywhere else reaches this page through the
   * loader, and a copy would keep showing the list it was mounted with.
   */
  spaces: SpaceSummary[]
  /** Open the new-space dialog straight away. */
  startNew?: boolean
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

export function SpaceListPage({ spaces, startNew = false }: Props) {
  const router = useRouter()
  const [newOpen, setNewOpen] = useState(startNew)
  const [newName, setNewName] = useState('')

  async function handleCreate() {
    const name = newName.trim()
    if (!name) {
      return
    }
    const space = await createSpace({ data: name })
    setNewOpen(false)
    setNewName('')
    // Every loader holding the list (this page's, the title bar's selector)
    // refetches, so the new space is there on the way back too.
    await router.invalidate()
    router.navigate({ to: `/space/${space.slug}` })
  }

  async function handleTogglePin(slug: string, pinned: boolean) {
    await setSpacePinned({ data: { slug, pinned } })
    await router.invalidate()
  }

  return (
    <ScrollPage>
      <ScrollContent className='min-h-full p-4'>
        <SpaceList
          spaces={spaces.map((space) => ({
            slug: space.slug,
            name: space.name,
            icon: space.icon,
            pinned: space.pinned,
            updatedAt: formatDate(space.updatedAt),
            createdAt: formatDate(space.createdAt),
          }))}
          hrefFor={(slug) => `/space/${encodeURIComponent(slug)}`}
          settingsHrefFor={(slug) => `/space/${encodeURIComponent(slug)}/settings`}
          onNavigate={(href) => router.navigate({ to: href })}
          onCreate={() => setNewOpen(true)}
          onTogglePin={handleTogglePin}
        />
      </ScrollContent>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder='Space name'
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreate()
              }
            }}
          />
          <DialogFooter>
            <Button variant='ghost' onClick={() => setNewOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollPage>
  )
}
