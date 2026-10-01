import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useSyncExternalStore,
} from 'react'
import type { Components, ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import { cn } from 'cn'

import { CodeBlock } from './code-block'
import { MarkdownCallout, type MarkdownCalloutKind } from './markdown-callout'
import { DIRECTIVE_ELEMENTS, remarkDirectiveBlocks } from './markdown-directives'
import {
  getMarkdownReferences,
  REFERENCE_ELEMENT,
  remarkInlineReferences,
  subscribeMarkdownReferences,
} from './markdown-references'
import { MarkdownSpoiler } from './markdown-spoiler'
import { MarkdownTabs } from './markdown-tabs'
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

// A picture in the text takes a fixed-height box before it loads. Markdown
// says nothing about a picture's size, so without one the picture is nothing
// until its bytes land and then suddenly its full height, moving every line
// under it -- long after the reader has settled on them. Fitted inside the box,
// never enlarged, so a small badge stays small; only the width follows the
// picture, and a change in width moves nothing below.
function MarkdownImage({ node: _node, alt = '', className, ...props }: ComponentProps<'img'> & ExtraProps) {
  return <img {...props} alt={alt} className={cn('block h-64 w-full object-scale-down object-left', className)} />
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

// The documentation blocks arrive as the elements `markdown-directives` names,
// carrying only the one attribute each block reads.
type BlockProps<P> = P & ExtraProps & { children?: ReactNode }

function CalloutElement({ kind, title, children }: BlockProps<{ kind: MarkdownCalloutKind; title?: string }>) {
  return (
    <MarkdownCallout kind={kind} title={title}>
      {children}
    </MarkdownCallout>
  )
}

function SpoilerElement({ summary, children }: BlockProps<{ summary?: string }>) {
  return <MarkdownSpoiler summary={summary}>{children}</MarkdownSpoiler>
}

type TabElementProps = BlockProps<{ label?: string }>

function TabsElement({ children }: BlockProps<object>) {
  // Every element child is a tab -- the plugin only claims a `tabs` block whose
  // children all are. What is filtered out is the whitespace between them.
  const tabs = Children.toArray(children)
    .filter((child): child is ReactElement<TabElementProps> => isValidElement(child))
    .map((tab, index) => ({ label: tab.props.label ?? `Tab ${index + 1}`, content: tab.props.children }))
  return <MarkdownTabs tabs={tabs} />
}

// Never rendered on its own: `TabsElement` reads a tab's label and content off
// the element and hands them to the tab strip.
function TabElement({ children }: TabElementProps) {
  return <>{children}</>
}

// An identifier the installed reference source recognised; drawn however that
// source draws it, or as the identifier's own text if the source has gone.
function ReferenceElement({ kind, id, trailing, children }: BlockProps<{ kind: string; id: string; trailing?: string }>) {
  const source = getMarkdownReferences()
  return <>{source ? source.render({ kind, id, trailing: trailing === 'true' }) : children}</>
}

/**
 * The documentation blocks, and the references the installed source
 * recognises (see `./markdown-references`), as the two halves `react-markdown`
 * takes: the remark plugins that read them, and the renderers for the
 * elements those plugins produce.
 *
 * For a surface that renders markdown with its own `react-markdown` for a
 * reason of its own -- a page that stamps source positions onto what it
 * renders, say -- and still has to show the blocks exactly as this component
 * does. Add the plugins after your own and spread the components into yours.
 * `Markdown` itself is built from this, so the two cannot drift apart.
 */
export const markdownDirectiveBlocks = {
  remarkPlugins: [remarkDirective, remarkDirectiveBlocks, remarkInlineReferences],
  // `Components` only knows HTML's element names; the blocks' own names are
  // keys beside them.
  components: {
    [DIRECTIVE_ELEMENTS.callout]: CalloutElement,
    [DIRECTIVE_ELEMENTS.spoiler]: SpoilerElement,
    [DIRECTIVE_ELEMENTS.tabs]: TabsElement,
    [DIRECTIVE_ELEMENTS.tab]: TabElement,
    [REFERENCE_ELEMENT]: ReferenceElement,
  } as Components,
}

const markdownComponents: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownPre,
  ...markdownDirectiveBlocks.components,
}

const remarkPlugins = [remarkGfm, ...markdownDirectiveBlocks.remarkPlugins]

// What survives in an inline rendering: the spans a sentence can carry. A
// block construct is unwrapped to its text rather than dropped, so nothing the
// author wrote goes missing -- it only stops being a paragraph, list or heading,
// which a label or a one-line hint has no room for (and `<label>` does not
// permit: its content model is phrasing content only).
const inlineElements = ['a', 'strong', 'em', 'del', 'code', 'br', REFERENCE_ELEMENT]

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
   *   element, or as a utility through `className`: the prose sits in the
   *   `components` layer, below utilities, so a utility on the wrapper wins.
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
 *
 * Documentation blocks written as directives -- callouts, `details` spoilers
 * and `tabs` -- render as those blocks; any other directive renders as its
 * plain content. Identifiers the installed reference source recognises render
 * as that source draws them; code never does.
 */
export function Markdown({ text, className, typography = 'chat', inline = false }: MarkdownProps) {
  // Read for the re-render alone: the plugin reads the source itself, and a
  // new source -- recognisers arriving after the first paint -- has to run it
  // again.
  useSyncExternalStore(subscribeMarkdownReferences, getMarkdownReferences, getMarkdownReferences)
  const Wrapper = inline ? 'span' : 'div'
  return (
    <Wrapper className={cn('prose-chat', typography === 'inherit' && 'prose-chat-inherit', className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={markdownComponents}
        {...(inline ? { allowedElements: inlineElements, unwrapDisallowed: true } : {})}
      >
        {text}
      </ReactMarkdown>
    </Wrapper>
  )
}
