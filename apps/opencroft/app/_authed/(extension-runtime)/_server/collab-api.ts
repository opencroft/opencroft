import type { HostCollabApi } from '@opencroft/server'

import { markdownDocName } from '@/lib/markdown-doc-protocol'
import {
  editMarkdownDoc,
  flushMarkdownDocs,
  readMarkdownDoc,
  registerMarkdownDocs,
  whileMarkdownDocsClosed,
} from '@/server/collab/markdown-docs'

/**
 * An extension's view of the shared documents: every kind it names is its own,
 * so one extension can neither serve nor reach another's documents.
 */
export function collabApiFor(extensionId: string): HostCollabApi {
  const owner = (kind: string) => {
    if (kind.includes(':') || kind.includes('/')) {
      throw new Error(`A document kind holds no colon or slash: "${kind}"`)
    }
    return `${extensionId}/${kind}`
  }
  return {
    markdown: {
      register: (kind, storage) => registerMarkdownDocs(owner(kind), storage),
      documentName: (kind, key) => markdownDocName(owner(kind), key),
      read: (kind, key) => readMarkdownDoc(owner(kind), key),
      edit: (kind, key, origin, change) => editMarkdownDoc(owner(kind), key, origin, change),
      flush: (kind, key) => flushMarkdownDocs(owner(kind), key),
      whileClosed: (kind, keys, change, options) => whileMarkdownDocsClosed(owner(kind), keys, change, options),
    },
  }
}
