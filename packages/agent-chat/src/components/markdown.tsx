import type { ComponentProps } from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from 'ui/lib/utils'

import { CodeBlock } from './code-block'
import { MermaidDiagram } from './mermaid-diagram'

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

/**
 * The code inside a fenced block, read from the markdown tree rather than from
 * the rendered children.
 *
 * `pre` is overridden rather than `code` because `code` is also every inline
 * span, and a fence with no language is indistinguishable from inline code by
 * its props alone. The tree says plainly which is which, and it carries the
 * text unescaped, which is what a code block and a copy button both need.
 *
 * Anything that is not exactly one `code` element of plain text -- a `pre` a
 * plugin built, a fence something else has already decorated -- is not ours to
 * claim, and the caller renders it as it always did.
 */
function fencedCode(node: ExtraProps['node']): { code: string; language?: string } | null {
  const only = node?.children?.length === 1 ? node.children[0] : undefined
  if (only?.type !== 'element' || only.tagName !== 'code') {
    return null
  }
  let text = ''
  for (const part of only.children) {
    if (part.type !== 'text') {
      return null
    }
    text += part.value
  }
  const classes = only.properties?.className
  const language = Array.isArray(classes)
    ? classes.map(String).find((name) => name.startsWith('language-'))?.slice('language-'.length)
    : undefined
  // Markdown always ends a fence's content with a newline. Keeping it would add
  // an empty last line to every block, and put one on the clipboard too.
  return { code: text.replace(/\n$/, ''), language }
}

function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & ExtraProps) {
  const fence = fencedCode(node)
  if (!fence) {
    return <pre {...props}>{children}</pre>
  }
  // A `mermaid` fence is a picture somebody wrote in text. Rendering it as code
  // would be technically true and useless, which is why the language decides
  // what the block IS rather than only how it is coloured.
  if (fence.language === 'mermaid') {
    return <MermaidDiagram chart={fence.code} />
  }
  return <CodeBlock code={fence.code} language={fence.language} />
}

const markdownComponents: Components = { a: MarkdownLink, pre: MarkdownPre }

// What survives in an inline rendering: the spans a sentence can carry. A
// block construct is unwrapped to its text rather than dropped, so nothing the
// author wrote goes missing -- it only stops being a paragraph, list or heading,
// which a label or a one-line hint has no room for (and `<label>` does not
// permit: its content model is phrasing content only).
const inlineElements = ['a', 'strong', 'em', 'del', 'code', 'br']

export interface MarkdownProps {
  /** The markdown source. */
  text: string
  /**
   * Added to the prose wrapper. For the container queries and clamps a
   * particular surface needs -- not for restyling the prose itself, which is
   * `prose-chat`'s job and is shared on purpose.
   */
  className?: string
  /**
   * Whose type the text is set in.
   *
   * - `chat` (default): the conversation's own size, colour and line height.
   * - `inherit`: whatever the surrounding element already sets. For markdown
   *   that sits inside another component's text -- a form's muted hint, a
   *   heading -- and has to look exactly like the plain text it replaces. Only
   *   the base type defers; the element treatments (links, code, lists) are
   *   `prose-chat`'s and scale from it. Set that type on a surrounding
   *   element, not through `className`: the prose rules are unlayered CSS and
   *   outrank utility classes on the wrapper itself.
   */
  typography?: 'chat' | 'inherit'
  /**
   * Render as a run of text in a `span`, with block constructs unwrapped to
   * their content. For phrasing-only contexts such as a `<label>`.
   */
  inline?: boolean
}

/**
 * Chat content, rendered.
 *
 * The prose styling is `prose-chat`, so anything rendered through this reads as
 * the same voice as the conversation rather than as a second treatment of the
 * same markdown.
 */
export function Markdown({ text, className, typography = 'chat', inline = false }: MarkdownProps) {
  const Wrapper = inline ? 'span' : 'div'
  return (
    <Wrapper className={cn('prose-chat', typography === 'inherit' && 'prose-chat-inherit', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        {...(inline ? { allowedElements: inlineElements, unwrapDisallowed: true } : {})}
      >
        {text}
      </ReactMarkdown>
    </Wrapper>
  )
}
