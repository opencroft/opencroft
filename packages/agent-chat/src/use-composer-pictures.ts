'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { EditPicture } from './user-parts'

/** What a host's upload answers with: the stored id a message names the picture
 *  by, and the size it is stored at -- which is what actually travels, after
 *  whatever re-encoding the host does. */
export interface UploadedPicture {
  id: string
  byteSize: number
}

/** The host's half of attaching a picture: store the file, answer with its id.
 *  Refusal is a thrown error, whose message the chip shows. */
export type UploadPicture = (file: File) => Promise<UploadedPicture>

/** One picture in the composer, in whichever state it has reached. */
export interface ComposerPicture {
  /** Local identity. The stored id arrives with the upload, or never. */
  key: string
  name: string
  src?: string
  id?: string
  byteSize?: number
  uploading: boolean
  error?: string
}

/** Pictures by slot: one list for the message being written, and one per
 *  message of a turn open for editing. */
export type PictureSlots = Readonly<Record<string, readonly ComposerPicture[]>>

/** The slot holding the pictures of the message being written. */
export const COMPOSE_SLOT = 'compose'

export interface ComposerPictures {
  slots: PictureSlots
  /** Attach picked, pasted or dropped files to a slot, uploading each. */
  add: (slot: string, files: File[]) => void
  remove: (slot: string, key: string) => void
  /** Replace every slot whose name starts with `prefix` by the ones given --
   *  what opening, resetting and leaving an edit are. */
  seed: (prefix: string, lists: Readonly<Record<string, readonly EditPicture[]>>) => void
  /** Every upload in flight settled, then the slots as they now stand: what a
   *  send or a commit reads, so a picture picked a second earlier goes with it. */
  settled: () => Promise<PictureSlots>
}

let counter = 0
const nextKey = () => {
  counter += 1
  return `picture-${counter}`
}

/**
 * The composer's pictures, owned beside its text so that every rule about what
 * a message carries -- paging an edit, resetting it, leaving it, sending --
 * treats pictures and words the same way.
 *
 * An upload patches its picture by KEY, in whichever slot holds it by then: a
 * reader who pages away from a message mid-upload still finds the picture
 * there, finished, when they page back.
 *
 * Object URLs made for a picked file are this hook's and are revoked when the
 * picture leaves. A picture seeded from a delivered message draws the host's
 * own `src`, which is not this hook's to revoke.
 */
export function useComposerPictures(upload: UploadPicture | undefined): ComposerPictures {
  // The ref is the truth and the state its render copy: every change is
  // computed from the ref and written to both at once, so `settled` can read the
  // outcome of an upload the moment it lands rather than whenever React next
  // renders.
  const [slots, setSlots] = useState<PictureSlots>({})
  const slotsRef = useRef(slots)
  const write = useCallback((next: PictureSlots) => {
    slotsRef.current = next
    setSlots(next)
  }, [])
  const pending = useRef(new Map<string, Promise<void>>())
  const owned = useRef(new Set<string>())
  const uploadRef = useRef(upload)
  uploadRef.current = upload

  useEffect(
    () => () => {
      for (const url of owned.current) {
        URL.revokeObjectURL(url)
      }
      owned.current.clear()
    },
    [],
  )

  const release = useCallback((pictures: readonly ComposerPicture[]) => {
    for (const picture of pictures) {
      if (picture.src && owned.current.delete(picture.src)) {
        URL.revokeObjectURL(picture.src)
      }
    }
  }, [])

  const patch = useCallback(
    (key: string, change: Partial<ComposerPicture>) => {
      write(
        Object.fromEntries(
          Object.entries(slotsRef.current).map(([slot, list]) => [
            slot,
            list.map((picture) => (picture.key === key ? { ...picture, ...change } : picture)),
          ]),
        ),
      )
    },
    [write],
  )

  const add = useCallback(
    (slot: string, files: File[]) => {
      const send = uploadRef.current
      if (!send) {
        return
      }
      for (const file of files) {
        const key = nextKey()
        const src = URL.createObjectURL(file)
        owned.current.add(src)
        const current = slotsRef.current
        write({ ...current, [slot]: [...(current[slot] ?? []), { key, name: file.name, src, uploading: true }] })
        const done = send(file)
          .then(({ id, byteSize }) => patch(key, { id, byteSize, uploading: false }))
          .catch((error: unknown) =>
            patch(key, { uploading: false, error: error instanceof Error ? error.message : 'could not be attached' }),
          )
          .finally(() => pending.current.delete(key))
        pending.current.set(key, done)
      }
    },
    [patch, write],
  )

  const remove = useCallback(
    (slot: string, key: string) => {
      const list = slotsRef.current[slot] ?? []
      release(list.filter((picture) => picture.key === key))
      write({ ...slotsRef.current, [slot]: list.filter((picture) => picture.key !== key) })
    },
    [release, write],
  )

  const seed = useCallback(
    (prefix: string, lists: Readonly<Record<string, readonly EditPicture[]>>) => {
      const entries = Object.entries(slotsRef.current)
      release(entries.filter(([slot]) => slot.startsWith(prefix)).flatMap(([, list]) => list))
      const kept = entries.filter(([slot]) => !slot.startsWith(prefix))
      const seeded = Object.entries(lists).map(([slot, list]) => [
        slot,
        list.map((picture): ComposerPicture => ({ ...picture, key: nextKey(), uploading: false })),
      ])
      write(Object.fromEntries([...kept, ...seeded]))
    },
    [release, write],
  )

  const settled = useCallback(async () => {
    await Promise.allSettled([...pending.current.values()])
    return slotsRef.current
  }, [])

  return { slots, add, remove, seed, settled }
}

/** The stored ids a slot's pictures will travel as: only those that made it. */
export function storedIds(pictures: readonly ComposerPicture[] | undefined): string[] {
  return (pictures ?? []).flatMap((picture) => (picture.id && !picture.error ? [picture.id] : []))
}

/**
 * What a send has to say when pictures in `slots` could not be attached, or
 * undefined when none failed.
 *
 * A failed picture has no stored id, so a send that went ahead would carry the
 * others and drop it without a word: the chip that said why is cleared with
 * the composer. So the send is refused and the composer says which picture
 * failed and why, in words, until the reader removes it.
 */
export function failedPicturesNotice(slots: readonly (readonly ComposerPicture[] | undefined)[]): string | undefined {
  const failed = slots.flatMap((pictures) => (pictures ?? []).filter((picture) => picture.error))
  if (failed.length === 0) {
    return undefined
  }
  const named = failed.map((picture) => `${picture.name} (${picture.error})`).join('; ')
  return failed.length === 1
    ? `A picture could not be attached: ${named}. Remove it to send the message without it.`
    : `${failed.length} pictures could not be attached: ${named}. Remove them to send the message without them.`
}
