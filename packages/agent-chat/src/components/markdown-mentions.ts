import type { MentionCandidate } from './mention-autocomplete'

/**
 * Who the markdown editor offers after an `@`.
 *
 * This package knows no accounts. A host installs one source
 * (`installMarkdownMentions`) that finds them, and every markdown editor asks
 * it, the way every markdown surface reads the one installed reference
 * source. Installed rather than passed as a prop so that it reaches every
 * editor the host has -- its own and the ones its plugins draw -- without each
 * of them being handed it.
 *
 * With nothing installed, `@` is an ordinary character and no list opens.
 */
export interface MarkdownMentionSource {
  /**
   * The candidates for what has been typed after the `@`, which may be
   * nothing, in the order to show them. Asked again as the query changes;
   * `signal` aborts once a newer query or a closed list makes the answer moot.
   */
  search(query: string, signal: AbortSignal): Promise<readonly MentionCandidate[]>
}

let installed: MarkdownMentionSource | null = null

/** Replace the source every markdown editor asks, or remove it with null. */
export function installMarkdownMentions(source: MarkdownMentionSource | null): void {
  installed = source
}

export function getMarkdownMentions(): MarkdownMentionSource | null {
  return installed
}
