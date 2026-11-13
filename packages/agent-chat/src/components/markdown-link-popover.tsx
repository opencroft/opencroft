import { useId, useRef, useState } from 'react'
import { Input } from 'ui/components/ui/input'
import { Label } from 'ui/components/ui/label'

import { MarkdownInlinePopover, type MarkdownInlinePopoverAnchor } from './markdown-inline-popover'

export interface MarkdownLinkPopoverProps {
  open: boolean
  anchor: MarkdownInlinePopoverAnchor
  /** What the link shows, as the fields start on each opening: the selected text, or the link's own. */
  text: string
  /** Where the link goes, as the fields start on each opening; empty for a new link. */
  href: string
  /**
   * Apply with the fields' values; an empty Text means the address shows as
   * its own text. Returns `false` when the address can't be a link, which
   * keeps the popover open and marks the Link field.
   */
  onApply: (text: string, href: string) => boolean
  /** See `MarkdownInlinePopoverProps.onCancel`. */
  onCancel: (returnFocus: boolean) => void
  /** Offered for a link that already exists. */
  onRemove?: () => void
}

/**
 * Adding or editing a link in the markdown editor: the inline popover with a
 * Text and a Link field. Focus starts in Text when there is no text yet, and
 * in Link otherwise.
 */
export function MarkdownLinkPopover({ open, anchor, text, href, onApply, onCancel, onRemove }: MarkdownLinkPopoverProps) {
  const id = useId()
  const textRef = useRef<HTMLInputElement | null>(null)
  const hrefRef = useRef<HTMLInputElement | null>(null)
  const [values, setValues] = useState({ text, href })
  const [refused, setRefused] = useState(false)
  // Every opening starts from what the host passes, not from the last one's typing.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setValues({ text, href })
      setRefused(false)
    }
  }

  return (
    <MarkdownInlinePopover
      label='Link'
      open={open}
      anchor={anchor}
      canApply={values.href.trim() !== ''}
      onApply={() => setRefused(!onApply(values.text, values.href.trim()))}
      onCancel={onCancel}
      onRemove={onRemove}
      initialFocus={text === '' ? textRef : hrefRef}
    >
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`${id}-text`}>Text</Label>
        <Input
          ref={textRef}
          id={`${id}-text`}
          value={values.text}
          placeholder='The address, if left empty'
          onChange={(event) => setValues({ ...values, text: event.target.value })}
        />
      </div>
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`${id}-href`}>Link</Label>
        <Input
          ref={hrefRef}
          id={`${id}-href`}
          value={values.href}
          placeholder='https://'
          aria-invalid={refused || undefined}
          aria-describedby={refused ? `${id}-refused` : undefined}
          onChange={(event) => {
            setValues({ ...values, href: event.target.value })
            setRefused(false)
          }}
        />
        {refused ? (
          <p id={`${id}-refused`} className='text-xs text-destructive'>
            This address can't be used as a link.
          </p>
        ) : null}
      </div>
    </MarkdownInlinePopover>
  )
}
