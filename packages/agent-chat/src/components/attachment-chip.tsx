'use client'

import { AlertCircle, Loader2, X } from 'lucide-react'
import { type ComponentPropsWithoutRef, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

// The thumbnail's edge, in one place. Small enough that a row of chips sits
// above the composer without pushing the message being written off the screen,
// large enough that a reader can tell two screenshots apart.
const THUMB = 'size-10'

export interface AttachmentChipProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  // What the reader called it: the chip's first line, and its tooltip.
  name: string
  // Where the thumbnail comes from. Absent while there is nothing to draw yet
  // -- a local object URL is usually available immediately and a stored one
  // arrives later, and both are the host's to produce.
  src?: string
  // The size it travels at, in bytes -- after whatever re-encoding the host
  // does, which is why it is the host's to say. Absent while unknown: the
  // second line then shows the resolution alone.
  byteSize?: number
  // Whether the picture is still on its way to wherever the host keeps it. The
  // chip appears the moment it is picked, so this is the state it is usually
  // born in.
  uploading?: boolean
  // Why it will not be sent, when it will not. Present replaces the thumbnail
  // with a mark and puts the sentence in the tooltip -- a chip that looked fine
  // and silently did not travel is the failure this whole row exists against.
  error?: string
  // Take it back off the message. Always offered, in every state: a chip the
  // reader cannot clear is worse than no chip.
  onRemove: () => void
}

/** A byte count as a reader reads it: `340 KB`, `2.4 MB`. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const kb = bytes / 1024
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  return `${(kb / 1024).toFixed(1)} MB`
}

// One picture a message will carry, drawn above the composer.
//
// A THUMBNAIL AND TWO LINES. The thumbnail is how a reader tells their own
// screenshots apart; the lines beside it say which file it is and what will
// actually travel -- the name, then the resolution and the size -- in the room
// to the right of the picture that would otherwise sit empty.
//
// The resolution is read from the picture itself once it has loaded, so it is
// right for every source and no host has to supply it. The size is the host's,
// because only the host knows what it re-encoded the file to.
//
// IT CARRIES ITS OWN REMOVE CONTROL, unlike the selection quoted beside it in
// the same row. That quotation is published by something else and dropped by
// that publisher; an attachment has no other owner, which makes this row the
// only place it can be undone. The control is offered in every state,
// including a failed one.
//
// THE THREE STATES ARE TOLD BY SHAPE. Uploading dims the picture under a
// spinner; a failure replaces it with a mark and says why in the tooltip; ready
// is just the picture. None of the three is carried by colour alone.
//
// Presentational and fully controlled: it draws what it is handed. Picking,
// re-encoding, uploading and what the message says about any of it are the
// host's.
export function AttachmentChip({
  name,
  src,
  byteSize,
  uploading,
  error,
  onRemove,
  className,
  ...rest
}: AttachmentChipProps) {
  // Keyed to the src it was measured from, so a chip handed a different
  // picture never shows the previous one's resolution.
  const [measured, setMeasured] = useState<{ src: string; width: number; height: number } | null>(null)
  const resolution = measured && measured.src === src ? `${measured.width}×${measured.height}` : undefined
  const details = [resolution, byteSize === undefined ? undefined : formatByteSize(byteSize)]
    .filter(Boolean)
    .join(' · ')
  const title = error ? `${name} — ${error}` : name
  return (
    <div
      {...rest}
      // No frame of its own: the picture and the words beside it are the
      // chip, and a box around both reads as a card rather than as a file.
      // `group` so the remove control can be quiet until the chip is
      // approached; `min-w-0` on the text is what lets a long name truncate
      // inside the width cap instead of widening the chip.
      className={cn('group flex max-w-56 shrink-0 items-center gap-2', className)}
      title={title}
    >
      {/* The picture carries its own rounding, and a muted fill only while
          there is no picture to show, so an empty or failed one still has a
          shape. The remove control sits on its corner: it belongs to the
          picture, not to the words beside it. */}
      <span className={cn('relative shrink-0 overflow-hidden rounded-md', (error || !src) && 'bg-muted', THUMB)}>
        {error ? (
          <span className='flex size-full items-center justify-center' aria-hidden='true'>
            <AlertCircle className='size-4 text-destructive' />
          </span>
        ) : src ? (
          // A plain img: the host hands over an object URL or a stored one, and
          // a framework's image component would want dimensions this component
          // learns only by loading it. Decorative, since the name is on screen
          // beside it.
          <img
            src={src}
            alt=''
            onLoad={(event) =>
              setMeasured({
                src,
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            className={cn('size-full object-cover', uploading && 'opacity-40')}
          />
        ) : (
          <span className='block size-full' aria-hidden='true' />
        )}
        {uploading && !error ? (
          <span className='absolute inset-0 flex items-center justify-center'>
            <Loader2 className='size-4 animate-spin text-muted-foreground' />
          </span>
        ) : null}
        <Button
          type='button'
          variant='ghost'
          size='icon'
          // Quiet until the chip is approached, and always present to a
          // keyboard: `opacity-0` still takes focus and `focus-visible` brings
          // it back, so the control is discoverable without a pointer.
          // A small round button inset from the corner, so the picture's own
          // rounding never clips it into an odd shape.
          className='absolute top-0.5 right-0.5 size-4 rounded-full bg-background/90 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
          // The composer keeps focus when this is pressed -- losing it
          // mid-sentence to a control beside the box is its own small betrayal.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
          title={`Remove ${name}`}
          aria-label={`Remove ${name}`}
        >
          <X className='size-3' />
        </Button>
      </span>
      <span className='flex min-w-0 flex-col text-xs leading-tight'>
        <span className='truncate font-medium'>{name}</span>
        {details ? <span className='truncate tabular-nums text-muted-foreground'>{details}</span> : null}
        {/* The reason, for everything that does not show tooltips. A sibling
            rather than an `aria-label` on the mark: a generic span has no role
            to carry one, so such a label is dropped unread. */}
        {error ? <span className='sr-only'>{error}</span> : null}
      </span>
    </div>
  )
}
