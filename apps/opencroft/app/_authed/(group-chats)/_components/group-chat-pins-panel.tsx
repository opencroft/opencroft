'use client'

// The host side of the kit's pins editor (group-chat-detail.tsx's `panel`
// slot, opened from the header's pin toggle) -- same split as the chat menu
// and the edit dialogs: the kit draws the affordances, this owns the requests
// and the data flow behind them.

import { useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { GroupChatPinsEditor } from 'ui/group-chat/group-chat-pins-editor'

import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { GroupChatPinSummary, GroupChatWriteResult } from '@/app/_authed/(group-chats)/_server/actions'
import { addGroupChatPin, editGroupChatPin, removeGroupChatPin } from '@/app/_authed/(group-chats)/_server/actions'

interface GroupChatPinsPanelProps {
  groupChatId: string
  pins: GroupChatPinSummary[]
}

export function GroupChatPinsPanel({ groupChatId, pins }: GroupChatPinsPanelProps) {
  const refresh = useGroupChatRefresh()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  // Unpinning destroys the note with no way back (see the editor's own
  // header) -- the kit deliberately confirms nothing on the host's behalf, so
  // this is that confirmation, the same shape the thread-delete dialog on this
  // same screen already uses.
  const [unpinTarget, setUnpinTarget] = useState<GroupChatPinSummary | null>(null)

  // A refusal comes back as DATA -- `{ ok: false, code }` -- and is shown in
  // the server's own words; a genuine fault still throws and lands in the
  // catch. The editor's form stays open on a refusal (the promise rejects), so
  // the text is not lost.
  const run = async (action: () => Promise<GroupChatWriteResult>, fallback: string) => {
    setError(undefined)
    setPending(true)
    try {
      const result = await action()
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setError(refusal)
        throw new Error(refusal)
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback)
      throw e
    } finally {
      setPending(false)
    }
  }

  const confirmUnpin = async () => {
    if (!unpinTarget) {
      return
    }
    try {
      await run(() => removeGroupChatPin({ data: unpinTarget.id }), 'That note could not be unpinned.')
      setUnpinTarget(null)
    } catch {
      // Reported through `error` above; the dialog stays so the person can
      // retry or give up.
    }
  }

  return (
    <>
      <GroupChatPinsEditor
        pins={pins.map((pin) => ({ id: pin.id, text: pin.text }))}
        onAdd={(text) => run(() => addGroupChatPin({ data: { groupChatId, text } }), 'That note could not be pinned.')}
        onEdit={(id, text) =>
          run(() => editGroupChatPin({ data: { pinId: id, text } }), 'That note could not be saved.')
        }
        onUnpin={(id) => {
          const pin = pins.find((p) => p.id === id)
          if (pin) {
            setError(undefined)
            setUnpinTarget(pin)
          }
        }}
        pending={pending}
        error={error}
        // The server's own `pin-limit` copy, not a second sentence that means
        // the same thing -- see member-action-refusal.ts's header for why a
        // refusal is read from the one table both the pre-empted press here
        // and a raced one arriving through `error` share.
        capMessage={groupChatAccessMessageForCode('pin-limit')}
      />

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
            <Button variant='outline' onClick={() => setUnpinTarget(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant='destructive' onClick={() => void confirmUnpin()} disabled={pending}>
              {pending ? 'Unpinning…' : 'Unpin'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
