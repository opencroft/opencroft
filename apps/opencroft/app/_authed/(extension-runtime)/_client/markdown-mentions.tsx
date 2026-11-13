'use client'

import { installMarkdownMentions } from 'agent-chat/markdown-mentions'
import { useEffect } from 'react'

import { createMentionSource } from '@/app/_authed/(extension-runtime)/_client/markdown-mention-source'
import { listMentionableAccounts } from '@/app/_authed/(extension-runtime)/_server/actions'

/**
 * Installs who the markdown editor's `@` list offers: the people and agents
 * of this instance. Mounted once, in the signed-in shell, so every editor has
 * it -- a documentation page, a Markdown node, an instruction field.
 */
export function MarkdownMentionsHost() {
  useEffect(() => {
    installMarkdownMentions(createMentionSource(() => listMentionableAccounts()))
    return () => installMarkdownMentions(null)
  }, [])
  return null
}
