'use client'

// Edit dialogs for a group chat's name and topic, for a thread's title, and
// the thread delete confirm -- the host side of the kit's
// onEditName/onEditTopic affordances (group-chat-detail.tsx) and of the thread
// row's own Rename/Delete items (group-chat-thread-list.tsx). Same split as
// the members dialog: the kit only carries the affordance, the app owns what
// it opens.
//
// Renaming EITHER a chat or a thread moves the address it is addressed by, not
// only what it is called -- so both dialogs say so, and both can be refused for
// a name whose address is already taken. That refusal arrives as data and is
// shown in place, which is the whole reason these are dialogs rather than
// in-row editing: there is somewhere to put the answer.

import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'
import {
  deleteGroupChatThread,
  renameMyGroupChat,
  renameMyGroupChatThread,
  setMyGroupChatTopic,
} from '@/app/_authed/(group-chats)/_server/actions'

interface EditFieldDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  label: string
  placeholder: string
  value: string
  description?: string
  submit: (value: string) => Promise<GroupChatWriteResult>
}

// Shared shape for both fields below: one required text input, submit
// disabled while it's blank (an empty value is a fault server-side, not a
// refusal -- see actions.ts -- so there is nothing useful to send and no
// refusal to show for it), and a genuine refusal read as data the same way
// the members dialog reads it, via `memberActionRefusal`, rather than a throw.
function EditFieldDialog({
  open,
  onOpenChange,
  title,
  label,
  placeholder,
  value,
  description,
  submit,
}: EditFieldDialogProps) {
  const router = useRouter()
  const [draft, setDraft] = useState(value)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (open) {
      setDraft(value)
      setError(undefined)
    }
  }, [open, value])

  const commit = async () => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    setError(undefined)
    setPending(true)
    try {
      const result = await submit(trimmed)
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setError(refusal)
        return
      }
      onOpenChange(false)
      await router.invalidate()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setError(undefined)
        }
      }}
    >
      <DialogContent className='max-w-sm'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description ? <p className='text-sm text-muted-foreground'>{description}</p> : null}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void commit()
            }
          }}
        />
        {error ? <p className='text-sm text-destructive'>{error}</p> : null}
        <DialogFooter>
          <Button variant='ghost' onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void commit()} disabled={pending || !draft.trim()}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GroupChatRenameDialog({
  open,
  onOpenChange,
  groupChatId,
  name,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupChatId: string
  name: string
}) {
  return (
    <EditFieldDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Rename group chat'
      label='Group chat name'
      placeholder='e.g. Q3 launch planning'
      value={name}
      description='This also moves the address the chat is known by. Anything still using the old one keeps working.'
      submit={(value) => renameMyGroupChat({ data: { groupChatId, name: value } })}
    />
  )
}

export function GroupChatTopicDialog({
  open,
  onOpenChange,
  groupChatId,
  topic,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupChatId: string
  topic: string
}) {
  return (
    <EditFieldDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Edit topic'
      label='Group chat topic'
      placeholder='What is this chat for?'
      value={topic}
      description="Every agent in this chat is told this as what it's for. It isn't shown anywhere else for you beyond this screen."
      submit={(value) => setMyGroupChatTopic({ data: { groupChatId, topic: value } })}
    />
  )
}

/**
 * The confirm behind a thread row's Delete item. The kit's ChatListItem calls
 * onDelete immediately; whether to confirm (and with what copy) is a product
 * call, so the confirm lives host-side and is shared by every surface that
 * offers the item — the group-chat screen and the embedded ChatSelector.
 * Mount it conditionally with `key={threadId}` so each target starts clean.
 */
export function GroupChatThreadDeleteDialog({
  open,
  onOpenChange,
  threadId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threadId: string
}) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()

  const confirm = async () => {
    setError(undefined)
    setDeleting(true)
    try {
      await deleteGroupChatThread({ data: threadId })
      onOpenChange(false)
      await router.invalidate()
    } catch (e) {
      setError(failureMessage(e, 'The thread could not be deleted.'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete thread</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          The conversation, its session and the agent process underneath it will be removed. This cannot be undone.
        </p>
        {error ? <p className='text-sm text-destructive'>{error}</p> : null}
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant='destructive' onClick={() => void confirm()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function GroupChatThreadRenameDialog({
  open,
  onOpenChange,
  threadId,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  threadId: string
  title: string
}) {
  return (
    <EditFieldDialog
      open={open}
      onOpenChange={onOpenChange}
      title='Rename thread'
      label='Thread title'
      placeholder='e.g. Pricing page copy'
      value={title}
      description='This also moves the address the thread is known by. Anything still using the old one keeps working.'
      submit={(value) => renameMyGroupChatThread({ data: { threadId, title: value } })}
    />
  )
}
