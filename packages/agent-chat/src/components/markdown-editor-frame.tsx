import type { ReactNode } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'cn'

/*
 * What the markdown editor's text sits in, for each of its looks: the box with
 * the toolbar, and the flat field. No TipTap here, so a host can draw the
 * editor's place while the editor itself loads.
 */

/**
 * How the editor looks.
 *
 * `toolbar` (the default): a box with the toolbar on top. The usual choice:
 * any text that may run to several lines uses it, a document's or a
 * description's alike.
 *
 * `field`: a flat input field with no frame and no toolbar, for content that
 * may well be a single line, such as a message in a messenger or a comment on
 * a task. Right-click is the browser's own menu, with its spelling
 * suggestions. Selected text gets the selection bar beside it, with the most
 * used text styles and `⋮`, which lists everything else the toolbar offers
 * except Undo and Redo.
 */
export type MarkdownEditorVariant = 'toolbar' | 'field'

/**
 * Where the text sits in the field: level with the field's edges, as a flat
 * input sets its text, and inset only above and below. For the editable
 * element itself, which the host makes as tall as the field, so a press
 * anywhere in the field lands in the text.
 */
export const MARKDOWN_EDITOR_FIELD_TEXT_CLASS = 'py-1.5'

export interface MarkdownEditorFieldProps {
  /** The editable text. */
  children: ReactNode
  className?: string
}

/**
 * The `field` look's frame: no border, background or toolbar, only the text,
 * like the agent chat's message input. A right-click in it is the browser's
 * own; what a toolbar would offer comes from the selection bar.
 */
export function MarkdownEditorField({ children, className }: MarkdownEditorFieldProps) {
  return (
    // The text decides the height, from a textarea's 4rem up. The explicit
    // minimum also replaces a flex item's content-sized one, so a field
    // stretched by its host (`flex-1`) keeps the host's height and its
    // children scroll inside it.
    <div data-slot='markdown-editor-field' className={cn('flex min-h-16 min-w-0', className)}>
      <div className='flex min-h-0 min-w-0 flex-1 flex-col'>{children}</div>
    </div>
  )
}

/** The `toolbar` look's frame: a bordered box, the toolbar above the text. */
export function MarkdownEditorBox({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <Flex data-slot='markdown-editor' className={cn('rounded-md border bg-background min-h-0', className)}>
      {children}
    </Flex>
  )
}

/**
 * The editor's frame with no text in it yet, the size the editor takes once
 * it has loaded, so the page does not jump when it arrives.
 */
export function MarkdownEditorPlaceholder({
  variant = 'toolbar',
  className,
  contentClassName,
}: {
  variant?: MarkdownEditorVariant
  className?: string
  contentClassName?: string
}) {
  return variant === 'field' ? (
    <MarkdownEditorField className={className}>
      <div className={contentClassName ?? MARKDOWN_EDITOR_FIELD_TEXT_CLASS} />
    </MarkdownEditorField>
  ) : (
    <MarkdownEditorBox className={className} />
  )
}
