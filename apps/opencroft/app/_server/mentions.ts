import { referencesInMarkdown } from 'agent-chat/components/markdown-reference-scan'
import type { ReferenceRecogniser } from 'agent-chat/components/markdown-references'

import { accountsByUsername, type ResolvedAccount } from '@/app/_server/account-directory'
import { MENTION_PATTERN, mentionedUsername } from '@/app/_shared/username'

/**
 * Who a markdown text mentions, by the rule a reader sees: a mention is what
 * renders as a mention chip. The markdown resolver draws `@<username>` in
 * prose and never in code, a link's label or raw HTML; this finds the same
 * ones by the renderer's own walk, so whatever is drawn as a mention is what
 * notifies, and nothing else is.
 *
 * SERVER-ONLY: it reads the username store.
 */

const MENTION_RECOGNISERS: ReferenceRecogniser[] = [{ kind: 'mention', match: 'text', pattern: MENTION_PATTERN }]

/** The usernames a markdown text mentions, in order and each once, whether or not an account holds them. */
export function mentionedUsernames(markdown: string): string[] {
  const found = referencesInMarkdown(markdown, MENTION_RECOGNISERS).map((reference) => mentionedUsername(reference.id))
  return [...new Set(found)]
}

/** One account a text mentions, and the username it was mentioned by. */
export interface Mention extends ResolvedAccount {
  username: string
}

/**
 * The accounts a markdown text mentions, in order. A username resolves to at
 * most one account, a retired one to the account that held it; one no account
 * answers to mentions nobody. Two usernames of one account count once.
 */
export async function mentionsIn(markdown: string): Promise<Mention[]> {
  const usernames = mentionedUsernames(markdown)
  if (usernames.length === 0) {
    return []
  }
  const accounts = await accountsByUsername(usernames)
  const seen = new Set<string>()
  const mentions: Mention[] = []
  for (const username of usernames) {
    const account = accounts[username]
    const key = account && `${account.kind}:${account.id}`
    if (account && !seen.has(key)) {
      seen.add(key)
      mentions.push({ ...account, username })
    }
  }
  return mentions
}
