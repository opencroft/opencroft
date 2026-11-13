import { WindowShell } from '@opencroft/client/canvas'
import { Markdown, MarkdownEditor } from '@opencroft/client/markdown'
import { Input, Label, ScrollArea } from '@opencroft/client/ui'
import { FileText } from 'lucide-react'
import type { ChangeEvent } from 'react'

export interface MarkdownWindowData {
  title: string
  /** The markdown the window renders. */
  text: string
}

/**
 * The text lives in the node, so the window has no close: closing a window removes its node, and
 * with it the text.
 */
export function MarkdownWindowNode({
  id,
  data,
  selected,
}: {
  id: string
  data: MarkdownWindowData
  selected?: boolean
}) {
  return (
    <WindowShell id={id} selected={selected} icon={FileText} title={data.title || 'Markdown'} closable={false}>
      {/* The right padding clears the scrollbar (w-2.5), which overlays the viewport's edge. */}
      <ScrollArea className='h-full' innerClassName='pl-2 pr-3 select-text'>
        {data.text ? (
          <Markdown text={data.text} />
        ) : (
          <div className='text-[11px] text-muted-foreground italic'>Write markdown in the Details tab.</div>
        )}
      </ScrollArea>
    </WindowShell>
  )
}

/**
 * The text is edited in the documentation's editor, which writes markdown back into `text` with
 * every edit. A write to `text` from elsewhere (an agent's) arrives in the open editor in place:
 * only what changed is replaced, the caret stays, and undo leaves it alone.
 *
 * Declared with `inspectorFullHeight`: the editor takes the height the inspector has left below
 * the title and scrolls inside its own frame.
 */
export function MarkdownWindowInspector({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: MarkdownWindowData
  updateData: (p: Partial<MarkdownWindowData>) => void
}) {
  return (
    // The padding is the one the inspector gives a Details tab that it wraps in a scroll area.
    <div className='flex min-h-0 flex-1 flex-col gap-3 px-4 py-2'>
      <div className='flex flex-col gap-1'>
        <Label>Title</Label>
        <Input
          value={data.title ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ title: e.target.value })}
          placeholder='Markdown'
        />
      </div>
      <div className='flex min-h-0 flex-1 flex-col gap-1'>
        <Label>Markdown</Label>
        <MarkdownEditor
          // One editor per node: its undo history belongs to the text it was opened on.
          key={nodeId}
          value={data.text ?? ''}
          onChange={(text) => updateData({ text })}
          placeholder='Write markdown…'
          // A field among the inspector's fields: formatting is on the bar over selected text.
          variant='field'
          className='flex-1'
        />
      </div>
    </div>
  )
}
