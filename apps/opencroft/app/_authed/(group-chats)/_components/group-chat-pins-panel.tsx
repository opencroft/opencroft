'use client'

// The host side of the kit's pins panel (group-chat-detail.tsx's `pins`
// slot) -- same split as the members dialog and the edit dialogs: the kit
// draws the affordances, this owns what they open and the data flow behind
// them.

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { GroupChatPinForm } from 'ui/group-chat/group-chat-pin-form'
import { GroupChatPins } from 'ui/group-chat/group-chat-pins'

import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatPinSummary } from '@/app/_authed/(group-chats)/_server/actions'
import { addGroupChatPin, editGroupChatPin, removeGroupChatPin } from '@/app/_authed/(group-chats)/_server/actions'

// Which form is open, if any -- one state rather than two booleans, because
// the panel never has both a compose and an edit open at once.
type PinFormTarget = { kind: 'create' } | { kind: 'edit'; pinId: string; text: string }

interface GroupChatPinsPanelProps {
  groupChatId: string
  pins: GroupChatPinSummary[]
}

export function GroupChatPinsPanel({ groupChatId, pins }: GroupChatPinsPanelProps) {
  const router = useRouter()
  const [formTarget, setFormTarget] = useState<PinFormTarget | null>(null)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string>()
  // Errors from outside the form -- an unpin that did not land -- surface on
  // the panel itself, per the kit's `error` prop; it renders even while the
  // panel is collapsed, which is the point for a failure nobody opened it to see.
  const [panelError, setPanelError] = useState<string>()
  // Unpinning destroys the note with no way back (see group-chat-pins.tsx's
  // own header) -- the kit deliberately confirms nothing on the host's
  // behalf, so this is that confirmation, the same shape the thread-delete
  // dialog on this same screen already uses.
  const [unpinTarget, setUnpinTarget] = useState<GroupChatPinSummary | null>(null)
  const [unpinning, setUnpinning] = useState(false)

  const closeForm = () => {
    setFormTarget(null)
    setFormError(undefined)
  }

  const submitForm = async () => {
    if (!formTarget) {
      return
    }
    setFormError(undefined)
    setSubmitting(true)
    try {
      const result =
        formTarget.kind === 'create'
          ? await addGroupChatPin({ data: { groupChatId, text } })
          : await editGroupChatPin({ data: { pinId: formTarget.pinId, text } })
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setFormError(refusal)
        return
      }
      closeForm()
      await router.invalidate()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'That note could not be saved.')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmUnpin = async () => {
    if (!unpinTarget) {
      return
    }
    setPanelError(undefined)
    setUnpinning(true)
    try {
      const result = await removeGroupChatPin({ data: unpinTarget.id })
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setPanelError(refusal)
        return
      }
      setUnpinTarget(null)
      await router.invalidate()
    } catch (e) {
      setPanelError(e instanceof Error ? e.message : 'That note could not be unpinned.')
    } finally {
      setUnpinning(false)
    }
  }

  return (
    <>
      <GroupChatPins
        pins={pins.map((pin) => ({ id: pin.id, text: pin.text }))}
        onPin={() => {
          setPanelError(undefined)
          setText('')
          setFormTarget({ kind: 'create' })
        }}
        onEditPin={(id) => {
          const pin = pins.find((p) => p.id === id)
          if (!pin) {
            return
          }
          setPanelError(undefined)
          setText(pin.text)
          setFormTarget({ kind: 'edit', pinId: pin.id, text: pin.text })
        }}
        onUnpin={(id) => {
          const pin = pins.find((p) => p.id === id)
          if (!pin) {
            return
          }
          setPanelError(undefined)
          setUnpinTarget(pin)
        }}
        error={panelError}
        // The server's own `pin-limit` copy, not a second sentence that means
        // the same thing -- see member-action-refusal.ts's header for why a
        // refusal is read from the one table both the pre-empted press here
        // and a raced one arriving through `error` share.
        capMessage={groupChatAccessMessageForCode('pin-limit')}
      />

      <Dialog
        open={formTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            closeForm()
          }
        }}
      >
        <DialogContent className='max-w-sm'>
          <DialogHeader>
            <DialogTitle>{formTarget?.kind === 'edit' ? 'Edit pinned note' : 'Pin a note'}</DialogTitle>
          </DialogHeader>
          <GroupChatPinForm
            text={text}
            onTextChange={setText}
            onSubmit={() => void submitForm()}
            onCancel={closeForm}
            mode={formTarget?.kind === 'edit' ? 'edit' : 'create'}
            submitting={submitting}
            error={formError}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={unpinTarget !== null}
        onOpenChange={(next) => {
          if (!next) {
            setUnpinTarget(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unpin note</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground'>This note will be removed. It cannot be recovered.</p>
          <DialogFooter>
            <Button variant='outline' onClick={() => setUnpinTarget(null)} disabled={unpinning}>
              Cancel
            </Button>
            <Button variant='destructive' onClick={() => void confirmUnpin()} disabled={unpinning}>
              {unpinning ? 'Unpinning…' : 'Unpin'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
