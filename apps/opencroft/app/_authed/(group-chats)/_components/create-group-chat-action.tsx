'use client'

// Creating a group chat, from the list's `action` slot.
//
// The form itself is the kit's `CreateGroupChatForm` and is not reshaped here.
// This owns only what a form component should not: the request, the pending
// flag, the error text it is given to display, and where to go afterwards.

import { useNavigate, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from 'ui/dialog'
import { CreateGroupChatForm } from 'ui/group-chat/create-group-chat-form'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { createMyGroupChat } from '@/app/_authed/(group-chats)/_server/actions'

export function CreateGroupChatAction() {
  const navigate = useNavigate()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async () => {
    const trimmed = topic.trim()
    if (!trimmed) {
      // The server refuses an empty topic too; catching it here keeps the
      // round trip out of an obviously-invalid submit.
      setError('A group chat needs a topic.')
      return
    }
    setError(undefined)
    setSubmitting(true)
    try {
      const chat = await createMyGroupChat({ data: trimmed })
      setOpen(false)
      setTopic('')
      // The list this action sits on is loader-driven, so it has to be told
      // the data changed — otherwise going back would show a stale list
      // without the new chat.
      await router.invalidate()
      await navigate({ to: '/group-chats/$groupChatId', params: { groupChatId: chat.id } })
    } catch (e) {
      setError(failureMessage(e, 'The group chat could not be created.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size='sm' variant='outline'>
          <Plus className='size-3.5' />
          New group chat
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New group chat</DialogTitle>
        </DialogHeader>
        <CreateGroupChatForm
          topic={topic}
          onTopicChange={(value) => {
            setTopic(value)
            if (error) {
              setError(undefined)
            }
          }}
          onSubmit={() => void submit()}
          submitting={submitting}
          error={error}
        />
      </DialogContent>
    </Dialog>
  )
}
