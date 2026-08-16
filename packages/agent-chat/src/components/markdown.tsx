import type { ComponentProps } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from 'ui/lib/utils'

// `rel="noopener noreferrer"` travels with `target="_blank"` -- without it the
// opened page keeps a handle on the one it came from.
//
// This is the reason the renderer is a component rather than a prop anywhere it
// is needed. Passed as a slot, every consumer would have to re-establish the
// behaviour, and one that handed over a bare renderer would lose it silently:
// a security property degrading with no visible symptom. Owning it here makes
// the guarantee a property of the code instead of something each surface
// remembers -- and a second surface rendering the same agent-authored markdown
// gets it by depending on this, not by copying it.
function MarkdownLink({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  return <a {...props} target='_blank' rel='noopener noreferrer' />
}

const markdownLinkComponents: Components = { a: MarkdownLink }

export interface MarkdownProps {
  /** The markdown source. */
  text: string
  /**
   * Added to the prose wrapper. For the container queries and clamps a
   * particular surface needs -- not for restyling the prose itself, which is
   * `prose-chat`'s job and is shared on purpose.
   */
  className?: string
}

/**
 * Chat content, rendered.
 *
 * The prose styling is `prose-chat`, so anything rendered through this reads as
 * the same voice as the conversation rather than as a second treatment of the
 * same markdown.
 */
export function Markdown({ text, className }: MarkdownProps) {
  return (
    <div className={cn('prose-chat', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownLinkComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
