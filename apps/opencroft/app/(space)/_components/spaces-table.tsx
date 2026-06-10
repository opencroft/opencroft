'use client'

import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'
import { Flex } from 'ui/layout/flex'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/layout/scrollpage'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/table'
import { Toggle } from 'ui/toggle'
import { Link, useRouter } from '@tanstack/react-router'
import { Download, Pencil, Pin, Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { createSpace, deleteSpace, importSpace, listSpaces, renameSpace, setSpacePinned } from '@/app/(space)/_server/actions'
import type { SpaceExport, SpaceSummary } from '@/app/(space)/_server/types'

interface Props {
  initialSpaces: SpaceSummary[]
}

interface RenameState {
  slug: string
  name: string
}

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

export function SpacesTable({ initialSpaces }: Props) {
  const router = useRouter()
  const [spaces, setSpaces] = useState<SpaceSummary[]>(initialSpaces)
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function refresh() {
    setSpaces(await listSpaces())
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) {
      return
    }
    const space = await createSpace({ data: name })
    setNewOpen(false)
    setNewName('')
    await refresh()
    router.navigate({ to: `/space/${space.slug}` })
  }

  async function handleRename() {
    if (!renameState) {
      return
    }
    const name = renameState.name.trim()
    if (!name) {
      return
    }
    await renameSpace({ data: { slug: renameState.slug, name } })
    setRenameState(null)
    await refresh()
    router.invalidate()
  }

  async function handleDelete(slug: string) {
    if (spaces.length <= 1) {
      return
    }
    const ok = await deleteSpace({ data: slug })
    if (!ok) {
      return
    }
    await refresh()
    router.invalidate()
  }

  async function handleTogglePin(slug: string, pinned: boolean) {
    await setSpacePinned({ data: { slug, pinned: !pinned } })
    await refresh()
    router.invalidate()
  }

  function handleExport(slug: string) {
    window.location.href = `/api/spaces/${encodeURIComponent(slug)}/export`
  }

  function handleImportClick() {
    fileInput.current?.click()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) {
      return
    }
    const text = await file.text()
    const payload = JSON.parse(text) as SpaceExport
    const space = await importSpace({ data: payload })
    await refresh()
    router.navigate({ to: `/space/${space.slug}` })
  }

  return (
    <ScrollPage>
      <ScrollHeader>
        <Flex row withGaps align='center' justify='between' className='w-full'>
          <h1 className='text-lg font-semibold'>Spaces</h1>
          <Flex row withGaps>
            <Button variant='outline' size='sm' onClick={handleImportClick}>
              <Upload /> Import
            </Button>
            <Button size='sm' onClick={() => setNewOpen(true)}>
              <Plus /> New
            </Button>
          </Flex>
        </Flex>
      </ScrollHeader>

      <ScrollContent className='p-4'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className='w-12' />
              <TableHead>Slug</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className='w-32 text-right'>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {spaces.map((space) => (
              <TableRow key={space.id}>
                <TableCell>
                  <Link to={`/space/${space.slug}`} className='font-medium hover:underline'>
                    {space.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Button variant='ghost' size='icon' onClick={() => setRenameState({ slug: space.slug, name: space.name })}>
                    <Pencil />
                  </Button>
                </TableCell>
                <TableCell className='text-muted-foreground'>{space.slug}</TableCell>
                <TableCell className='text-muted-foreground'>{formatDate(space.updatedAt)}</TableCell>
                <TableCell className='text-muted-foreground'>{formatDate(space.createdAt)}</TableCell>
                <TableCell>
                  <Flex row align='center' justify='end'>
                    <Toggle pressed={space.pinned} onPressedChange={() => handleTogglePin(space.slug, space.pinned)} aria-label={space.pinned ? 'Unpin' : 'Pin'}>
                      <Pin />
                    </Toggle>
                    <Button variant='ghost' size='icon' onClick={() => handleExport(space.slug)}>
                      <Download />
                    </Button>
                    <Button variant='ghost' size='icon' disabled={spaces.length <= 1} onClick={() => handleDelete(space.slug)}>
                      <Trash2 />
                    </Button>
                  </Flex>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ScrollContent>

      <input ref={fileInput} type='file' accept='application/json' className='hidden' onChange={handleImportFile} />

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

      <Dialog open={!!renameState} onOpenChange={(open) => !open && setRenameState(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename space</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameState?.name ?? ''}
            onChange={(e) => setRenameState((s) => (s ? { ...s, name: e.target.value } : s))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRename()
              }
            }}
          />
          <DialogFooter>
            <Button variant='ghost' onClick={() => setRenameState(null)}>
              Cancel
            </Button>
            <Button onClick={handleRename}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollPage>
  )
}
