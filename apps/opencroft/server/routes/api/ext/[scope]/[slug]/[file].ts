import { promises as fs } from 'node:fs'

import { defineEventHandler } from 'nitro/h3'

import { ensureExtensionBuilt } from '@/app/(extension-runtime)/_server/loader'
import { extDistFile } from '@/app/(extension-runtime)/_server/paths'

const ALLOWED_FILES = new Set(['client.js', 'server.js'])

// Serves a built extension bundle at /api/ext/<scope>/<slug>/client.js|server.js.
// Lives in the Nitro serverDir (not a TanStack route) because the URL ends in a
// file extension, which Vite's dev server otherwise intercepts as a static asset
// before it can reach a TanStack server route.
export default defineEventHandler(async (event) => {
  const { scope, slug, file } = event.context.params
  if (!ALLOWED_FILES.has(file)) {
    return new Response('Not found', { status: 404 })
  }
  const extensionId = `${scope}/${slug}`
  try {
    await ensureExtensionBuilt(extensionId)
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
  const target = extDistFile(extensionId, file)
  try {
    const code = await fs.readFile(target, 'utf-8')
    return new Response(code, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    })
  } catch {
    return new Response('Bundle not found', { status: 404 })
  }
})
