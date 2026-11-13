import { useId, useState } from 'react'
import { Input } from 'ui/components/ui/input'
import { Label } from 'ui/components/ui/label'

import { MarkdownInlinePopover, type MarkdownInlinePopoverAnchor } from './markdown-inline-popover'

export interface MarkdownHintPopoverProps {
  open: boolean
  anchor: MarkdownInlinePopoverAnchor
  /** The note, as the field starts on each opening: empty for a new hint. */
  text: string
  /** Apply with the note; offered once the note has more than whitespace. */
  onApply: (text: string) => void
  /** See `MarkdownInlinePopoverProps.onCancel`. */
  onCancel: (returnFocus: boolean) => void
  /** Offered for a hint that already exists. */
  onRemove?: () => void
}

/**
 * Adding or editing a hint in the markdown editor: the inline popover with
 * one field, the note shown over the selected content.
 */
export function MarkdownHintPopover({ open, anchor, text, onApply, onCancel, onRemove }: MarkdownHintPopoverProps) {
  const id = useId()
  const [value, setValue] = useState(text)
  // Every opening starts from what the host passes, not from the last one's typing.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setValue(text)
    }
  }

  return (
    <MarkdownInlinePopover
      label='Hint'
      open={open}
      anchor={anchor}
      canApply={value.trim() !== ''}
      onApply={() => onApply(value.trim())}
      onCancel={onCancel}
      onRemove={onRemove}
    >
      <div className='flex flex-col gap-1.5'>
        <Label htmlFor={`${id}-text`}>Hint</Label>
        <Input
          id={`${id}-text`}
          value={value}
          placeholder='Shown on hover or tap'
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    </MarkdownInlinePopover>
  )
}
