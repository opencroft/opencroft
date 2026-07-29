import type { ComponentProps } from 'react'
import type { Components, ExtraProps } from 'react-markdown'

// Every markdown link in chat content opens in a new tab, so following one
// never costs the conversation the reader was in. `noopener` is required
// alongside `target="_blank"` — without it the opened page keeps a handle on
// ours through `window.opener`.
function MarkdownLink({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  return <a {...props} target='_blank' rel='noopener noreferrer' />
}

export const markdownLinkComponents: Components = { a: MarkdownLink }
