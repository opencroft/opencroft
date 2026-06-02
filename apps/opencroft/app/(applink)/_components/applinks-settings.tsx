'use client'

import type { AppLink } from '@opencroft/db'
import { Button } from '@opencroft/ui-kit/button'
import { Input } from '@opencroft/ui-kit/input'
import { Flex } from '@opencroft/ui-kit/layout/flex'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createAppLink, deleteAppLink, getAppLinks, updateAppLink } from '@/app/(applink)/_server/actions'

function AppLinkRow({ link, onDelete, onUpdate }: { link: AppLink; onDelete: (id: string) => void; onUpdate: (data: { id: string; title: string; url: string }) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(link.title)
  const [url, setUrl] = useState(link.url)

  if (!editing) {
    return (
      <Flex row withGaps align='center'>
        <span className='font-medium min-w-32'>{link.title}</span>
        <span className='text-muted-foreground text-sm truncate flex-1'>{link.url}</span>
        <Button variant='ghost' size='icon' onClick={() => setEditing(true)}>
          <Pencil />
        </Button>
        <Button variant='ghost' size='icon' onClick={() => onDelete(link.id)}>
          <Trash2 />
        </Button>
      </Flex>
    )
  }

  const save = () => {
    onUpdate({ id: link.id, title, url })
    setEditing(false)
  }

  return (
    <Flex row withGaps align='center'>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Title' className='w-40' />
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='https://...' className='flex-1' />
      <Button onClick={save}>Save</Button>
      <Button variant='ghost' size='icon' onClick={() => setEditing(false)}>
        <X />
      </Button>
    </Flex>
  )
}

export default function AppLinksSettings() {
  const [links, setLinks] = useState<AppLink[]>([])
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')

  const reload = async () => {
    setLinks(await getAppLinks())
  }

  useEffect(() => {
    reload()
  }, [])

  const add = async () => {
    if (!title || !url) {
      return
    }
    await createAppLink({ data: { title, url } })
    setTitle('')
    setUrl('')
    await reload()
  }

  const remove = async (id: string) => {
    await deleteAppLink({ data: id })
    await reload()
  }

  const update = async (data: { id: string; title: string; url: string }) => {
    await updateAppLink({ data })
    await reload()
  }

  return (
    <Flex withSpacing className='max-w-2xl'>
      <Flex withGaps>
        {links.map((link) => (
          <AppLinkRow key={link.id} link={link} onDelete={remove} onUpdate={update} />
        ))}
      </Flex>
      <Flex row withGaps align='center'>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Title' className='w-40' />
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder='https://...' className='flex-1' />
        <Button size='sm' onClick={add}>
          <Plus /> Add
        </Button>
      </Flex>
    </Flex>
  )
}
