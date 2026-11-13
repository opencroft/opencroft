import { filterMentions, type MentionCandidate } from 'agent-chat/components/mention-autocomplete'
import type { MarkdownMentionSource } from 'agent-chat/markdown-mentions'

/** How long a fetched list of who can be mentioned is reused before it is fetched again. */
export const MENTION_DIRECTORY_TTL_MS = 60_000

/**
 * The markdown editor's mention source: everyone `load` lists, matched as the
 * chat composer matches its members.
 *
 * The list is fetched on the first `@` rather than at start, so a page where
 * nobody types one never asks, and then reused, so typing a query asks
 * nothing of the server. It is fetched again once it is older than
 * `MENTION_DIRECTORY_TTL_MS`, which is how an agent added since shows up
 * without a reload. A fetch that fails is not kept: the next `@` asks again.
 */
export function createMentionSource(
  load: () => Promise<readonly MentionCandidate[]>,
  now: () => number = Date.now,
): MarkdownMentionSource {
  let directory: { at: number; accounts: Promise<readonly MentionCandidate[]> } | null = null
  return {
    search: async (query) => {
      if (!directory || now() - directory.at > MENTION_DIRECTORY_TTL_MS) {
        const accounts = load()
        const fetched = { at: now(), accounts }
        directory = fetched
        accounts.catch(() => {
          if (directory === fetched) {
            directory = null
          }
        })
      }
      return filterMentions(await directory.accounts, query)
    },
  }
}
