import { promises as fs } from 'node:fs'

import { defineEventHandler } from 'nitro/h3'

import { requireSession } from '@/app/_server/require-session'
import { ensureExtensionBuilt } from '@/app/(extension-runtime)/_server/loader'
import { extDistFile } from '@/app/(extension-runtime)/_server/paths'

const CONTENT_TYPES: Record<string, string> = {
  'client.js': 'application/javascript; charset=utf-8',
  'server.js': 'application/javascript; charset=utf-8',
  'client.css': 'text/css; charset=utf-8',
  // The client bundle's sourcemap, linked from it rather than inlined so that
  // only a browser with devtools open pays for it. Served from here so it gets
  // the same immutable caching as the bundle — a debugging session should not
  // re-download it on every reload.
  'client.js.map': 'application/json; charset=utf-8',
}

// Freshness is carried by the `?v=` the caller puts on the URL, which
// identifies the built artifact (see clientBundleVersion): a rebuilt bundle is
// requested under a new URL, and an unchanged one is never re-downloaded. A
// caller that wants a guaranteed-fresh copy — the extension editor reloading
// its own rebuild — passes a unique value, which misses by construction.
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

// Serves a built extension bundle at /api/ext/<scope>/<slug>/client.js|server.js.
// Lives in the Nitro serverDir (not a TanStack route) because the URL ends in a
// file extension, which Vite's dev server otherwise intercepts as a static asset
// before it can reach a TanStack server route.
export default defineEventHandler(async (event) => {
  const denied = await requireSession(event.req)
  if (denied) return denied
  const { scope, slug, file } = event.context.params
  const contentType = CONTENT_TYPES[file]
  if (!contentType) {
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
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
      },
    })
  } catch {
    // Extensions built before CSS generation existed have no client.css yet;
    // serve an empty sheet until their next rebuild instead of a 404. Not
    // cached: unlike a real bundle there is no built artifact for the URL's
    // version to identify, so a later build must not be shadowed by this.
    if (file === 'client.css') {
      return new Response('', { status: 200, headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' } })
    }
    return new Response('Bundle not found', { status: 404 })
  }
})
