'use client'

// Edit dialogs for a group chat's name and topic -- the host side of the kit's
// onEditName/onEditTopic affordances (group-chat-detail.tsx). Same split as the
// members dialog and the delete confirm: the kit only carries the affordance,
// the app owns what it opens.

import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'

import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'
import { renameMyGroupChat, setMyGroupChatTopic } from '@/app/_authed/(group-chats)/_server/actions'

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
