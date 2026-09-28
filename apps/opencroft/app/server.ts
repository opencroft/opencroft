import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'
import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'

import { ensureServerStarted } from '@/server/startup'

// TanStack Start custom server entry. Runs once at server boot (in the server
// build context): starts the docker-ps poller + event scheduler, preloads
// spaces, auto-installs extensions.
const ready = ensureServerStarted()

const fetch = createStartHandler(defaultStreamHandler)

export type ServerEntry = { fetch: RequestHandler<Register> }

export function createServerEntry(entry: ServerEntry): ServerEntry {
  return {
    async fetch(...args) {
      await ready
      return await entry.fetch(...args)
    },
  }
}

export default createServerEntry({ fetch })
