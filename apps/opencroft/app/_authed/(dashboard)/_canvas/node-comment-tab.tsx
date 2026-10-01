'use client'

import type { ChangeEvent } from 'react'
import { Textarea } from 'ui/textarea'

import type { NodeData } from '@/app/_authed/(extension-runtime)/_types'

interface NodeCommentTabProps {
  data: NodeData
  updateData: (patch: Record<string, unknown>) => void
}

// A comment written some other way than this tab (a graph tool, say) has no
// edit time, and says so rather than reading as brand new or absent.
function editedLabel(comment: string, editedAt: Date | null): string {
  if (!comment) {
    return 'No comment yet.'
  }
  return editedAt ? `Edited ${editedAt.toLocaleString()}` : 'Edit time not recorded.'
}

// A node's comment: free-text documentation of what the node is, kept in its
// data so agents reading the node get it with everything else. Nothing checks
// it against the node, so it carries the time it was last edited, shown here,
// for a reader to judge whether it is still true.
export function NodeCommentTab({ data, updateData }: NodeCommentTabProps) {
  const comment = typeof data.comment === 'string' ? data.comment : ''
  const editedAt = typeof data.commentUpdatedAt === 'string' ? new Date(data.commentUpdatedAt) : null

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    // An emptied comment is removed rather than stored blank, and its time with it.
    updateData(
      text.length > 0
        ? { comment: text, commentUpdatedAt: new Date().toISOString() }
        : { comment: undefined, commentUpdatedAt: undefined },
    )
  }

  return (
    <div className='flex flex-col gap-2'>
      <Textarea
        value={comment}
        onChange={onChange}
        placeholder='What this node is and what it is for…'
        className='min-h-32'
        aria-label='Node comment'
      />
      <p className='text-xs text-muted-foreground'>{editedLabel(comment, editedAt)}</p>
    </div>
  )
}
