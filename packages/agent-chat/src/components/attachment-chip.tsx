'use client'

import { AlertCircle, Loader2, X } from 'lucide-react'
import type { ComponentPropsWithoutRef } from 'react'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

// The thumbnail's edge, in one place. Small enough that three of them sit in
// the row above the composer without pushing the message being written off the
// screen, large enough that a reader can tell two screenshots apart -- which is
// the entire reason this is a picture and not a filename.
const THUMB = 'size-10'

export interface AttachmentChipProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  // What the reader called it. Not drawn: it is the tooltip and the accessible
  // name, because a picture cannot be read by anything that does not render it.
  name: string
  // Where the thumbnail comes from. Absent while there is nothing to draw yet
  // -- a local object URL is usually available immediately and a stored one
  // arrives later, and both are the host's to produce.
  src?: string
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

// One picture the next message will carry, drawn above the composer.
//
// A THUMBNAIL RATHER THAN A FILENAME. A reader who attached three screenshots
// needs to see which one they are about to remove, and `Screenshot 2026-09-22
// at 02.14.png` distinguishes nothing from `Screenshot 2026-09-22 at 02.15.png`.
// The name is still carried -- as the tooltip and the accessible name -- so
// nothing that cannot render the picture is left with nothing.
//
// IT CARRIES ITS OWN REMOVE CONTROL, unlike the selection quoted beside it in
// the same row. That quotation is published by something else and dropped by
// that publisher, so there is nothing to discard from the composer; an
// attachment has no other owner, which makes this row the only place it can be
// undone. The control is offered in every state, including a failed one: a chip
// the reader cannot clear is worse than no chip.
//
// THE THREE STATES ARE TOLD BY SHAPE. Uploading dims the picture under a
// spinner; a failure replaces it with a mark and says why in the tooltip; ready
// is just the picture. None of the three is carried by colour alone.
//
// Presentational and fully controlled: it draws the src it is handed. Picking,
// re-encoding, uploading and what the message says about any of it are the
// host's.
export function AttachmentChip({ name, src, uploading, error, onRemove, className, ...rest }: AttachmentChipProps) {
  const title = error ? `${name} — ${error}` : name
  return (
    <div
      {...rest}
      // `group` so the remove control can be quiet until the chip is
      // approached; `relative` anchors both the control and the spinner over
      // the picture.
      className={cn('group relative shrink-0 overflow-hidden rounded-md border bg-muted', THUMB, className)}
      title={title}
    >
      {error ? (
        <span className='flex size-full items-center justify-center' aria-label={title}>
          <AlertCircle className='size-4 text-destructive' />
        </span>
      ) : src ? (
        // A plain img: the host hands over an object URL or a stored one, and a
        // framework's image component would want dimensions this component has
        // no way to know.
        // biome-ignore lint/performance/noImgElement: a host-provided blob/object URL, not a static asset
        <img src={src} alt={name} className={cn('size-full object-cover', uploading && 'opacity-40')} />
      ) : (
        <span className='size-full' aria-label={title} />
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
        // Quiet until the chip is approached, and always present to a keyboard:
        // `opacity-0` still takes focus and `focus-visible` brings it back, so
        // the control is discoverable without a pointer.
        className='absolute top-0 right-0 size-4 rounded-none rounded-bl-md bg-background/80 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100'
        // The composer keeps focus when this is pressed -- losing it
        // mid-sentence to a control beside the box is its own small betrayal.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
        title={`Remove ${name}`}
        aria-label={`Remove ${name}`}
      >
        <X className='size-3' />
      </Button>
    </div>
  )
}
