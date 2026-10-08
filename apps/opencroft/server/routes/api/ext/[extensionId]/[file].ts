import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defineEventHandler } from 'nitro/h3'

import { ensureExtensionBuilt } from '@/app/_authed/(extension-runtime)/_server/loader'
import { extDistDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import { extRouteParams } from '@/app/_authed/(extension-runtime)/_server/route-params'
import { requireSession } from '@/app/_server/require-session'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Covers both the client bundle's sourcemap and a split build's per-chunk
  // ones, linked from their bundle rather than inlined so only a browser with
  // devtools open pays for them. Served from here so they get the same
  // immutable caching as the bundle they belong to.
  '.map': 'application/json; charset=utf-8',
}

// Freshness is carried by the `?v=` the caller puts on the URL, which
// identifies the built artifact (see clientBundleVersion): a rebuilt bundle is
// requested under a new URL, and an unchanged one is never re-downloaded. A
// caller that wants a guaranteed-fresh copy — the extension editor reloading
// its own rebuild — passes a unique value, which misses by construction. A
// split build's chunks don't need the `?v=` at all: their filename is a
// content hash, so a different version is already a different URL.
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

// Serves a built extension's dist/ output at /api/ext/<extensionId>/<file> —
// the entry bundles (client.js, server.js), the client stylesheet, sourcemaps,
// and (once code-splitting is in use) generated chunk files, whose hashed
// names this route can't whitelist by exact name. Lives in the Nitro
// serverDir (not a TanStack route) because the URL ends in a file extension,
// which Vite's dev server otherwise intercepts as a static asset before it
// can reach a TanStack server route.
export default defineEventHandler(async (event) => {
  const denied = await requireSession(event.req)
  if (denied) return denied
  const params = await extRouteParams(event)
  if (!params) {
    return new Response('Not found', { status: 404 })
  }
  const { extensionId, file } = params
  const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()]
  if (!contentType) {
    return new Response('Not found', { status: 404 })
  }
  const distRoot = extDistDir(extensionId)
  const target = path.join(distRoot, file)
  // `file` is a single dynamic-route segment, so `path.join` can't actually
  // escape `distRoot` today — same guard as the assets route next door,
  // kept because this route now serves whatever is in `dist/` (chunk names
  // are generated, not a fixed whitelist) rather than depending on the
  // router shape above it to stay single-segment forever.
  if (path.relative(distRoot, target).startsWith('..')) {
    return new Response('Forbidden', { status: 403 })
  }
  try {
    await ensureExtensionBuilt(extensionId)
  } catch (err) {
    return new Response(String(err), { status: 500 })
  }
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
