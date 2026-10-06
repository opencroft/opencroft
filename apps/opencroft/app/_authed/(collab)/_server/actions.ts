import { getSessionUser } from '@opencroft/auth/server'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type { CollabSession } from '@/lib/collab-protocol'
import { markdownDocLineage } from '@/server/collab/markdown-docs'

// The HTTP boundary for opening a shared document: the session is checked
// here, since a server function is callable without the page that uses it.

/**
 * What the signed-in person needs to open a shared markdown document: its
 * name and the lineage to present. Null when there is no such document, or
 * its owner does not let them open it.
 */
export const openMarkdownDoc = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((docName: string) => docName)
  .handler(async ({ data: docName }): Promise<CollabSession | null> => {
    const user = await getSessionUser(getRequest())
    if (!user) {
      throw new Error('Not signed in')
    }
    const lineage = await markdownDocLineage(docName, { id: user.id, name: user.name })
    return lineage ? { docName, lineage } : null
  })
