'use client'

// The pictures waiting to go with the next message.
//
// A picked file becomes a chip IMMEDIATELY, drawn from a local object URL, and
// uploads behind that chip. The reader recognises their own screenshot at the
// moment they picked it, and the round trip is not something they should have
// to watch — but it is also not something a send may outrun, so a send awaits
// whatever is still in flight (see `collect`).
//
// What the message carries is the stored id, handed over beside the words at
// send -- never written into them. See attachments.ts in agent-client.

import { useCallback, useEffect, useRef, useState } from 'react'

import { readAttachableImage } from '@/app/_authed/(agent)/_lib/attachment-file'
import { attachImage } from '@/app/_authed/(agent)/_server/acp'

/** One picture in the composer, in whichever state it has reached. */
export interface ComposerAttachment {
  /** Local identity, assigned on pick. The stored id arrives later, or never. */
  localId: string
  name: string
  /** An object URL for the picked file — what the chip draws. */
  previewUrl: string
  /** The stored row's id, once the upload has landed. */
  id?: string
  mimeType?: string
  uploading: boolean
  error?: string
}

export interface MessageAttachments {
  items: readonly ComposerAttachment[]
  /** Take files from any of the three gestures: the plus, a paste, a drop. */
  onFiles: (files: File[]) => void
  remove: (localId: string) => void
  /**
   * The stored ids of everything that made it, with the pending uploads
   * awaited first, and the row emptied.
   *
   * One call per send, and it clears: the pictures belong to the message that
   * just went, and a second send must not carry them again.
   */
  collect: () => Promise<string[]>
  /** Whether anything is attached — what decides if the row is drawn at all. */
  any: boolean
}

let counter = 0
const nextLocalId = () => {
  counter += 1
  return `att-local-${counter}`
}

export function useMessageAttachments(tabKey: string): MessageAttachments {
  const [items, setItems] = useState<readonly ComposerAttachment[]>([])
  // The in-flight uploads, so a send can wait for them rather than race them.
  const pending = useRef(new Map<string, Promise<void>>())
  // Read by `collect`, which must see the list as it is at the moment of the
  // send and not as it was when the callback was made.
  const itemsRef = useRef(items)
  itemsRef.current = items

  // An object URL is a document-lifetime lease on the file's bytes; without
  // this, a session of picking and removing pictures leaks every one of them.
  const urls = useRef(new Set<string>())
  useEffect(
    () => () => {
      for (const url of urls.current) {
        URL.revokeObjectURL(url)
      }
      urls.current.clear()
    },
    [],
  )

  const release = useCallback((url: string) => {
    if (urls.current.delete(url)) {
      URL.revokeObjectURL(url)
    }
  }, [])

  const onFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const localId = nextLocalId()
        const previewUrl = URL.createObjectURL(file)
        urls.current.add(previewUrl)
        setItems((previous) => [...previous, { localId, name: file.name, previewUrl, uploading: true }])
        const upload = (async () => {
          try {
            const read = await readAttachableImage(file)
            const stored = await attachImage({ data: { tabKey, ...read } })
            setItems((previous) =>
              previous.map((item) =>
                item.localId === localId
                  ? { ...item, id: stored.id, mimeType: stored.mimeType, uploading: false }
                  : item,
              ),
            )
          } catch (error) {
            // The chip stays, carrying the reason. A picture that vanished on
            // pick would leave the reader believing it was attached.
            setItems((previous) =>
              previous.map((item) =>
                item.localId === localId
                  ? {
                      ...item,
                      uploading: false,
                      error: error instanceof Error ? error.message : 'could not be attached',
                    }
                  : item,
              ),
            )
          } finally {
            pending.current.delete(localId)
          }
        })()
        pending.current.set(localId, upload)
      }
    },
    [tabKey],
  )

  const remove = useCallback(
    (localId: string) => {
      setItems((previous) => {
        const going = previous.find((item) => item.localId === localId)
        if (going) {
          release(going.previewUrl)
        }
        return previous.filter((item) => item.localId !== localId)
      })
    },
    [release],
  )

  const collect = useCallback(async () => {
    // Settled rather than all: one failed upload must not hold back the
    // message or the pictures that did land. Each failure has already said so
    // in its own chip.
    await Promise.allSettled([...pending.current.values()])
    const sending = itemsRef.current
    const ids = sending.flatMap((item) => (item.id ? [item.id] : []))
    for (const item of sending) {
      release(item.previewUrl)
    }
    setItems([])
    return ids
  }, [release])

  return { items, onFiles, remove, collect, any: items.length > 0 }
}
