import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defineEventHandler } from 'nitro/h3'

import { requireSession } from '@/app/_server/require-session'
import { extDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import { extRouteParams } from '@/app/_authed/(extension-runtime)/_server/route-params'

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
}

// Serves extension static assets at /api/ext/<extensionId>/assets/<...>. In the
// Nitro serverDir (not a TanStack route) so extension-laden paths (.wasm, .onnx,
// .png, …) reach the handler instead of Vite's dev static layer.
export default defineEventHandler(async (event) => {
  const denied = await requireSession(event.req)
  if (denied) return denied
  const params = await extRouteParams(event)
  if (!params) {
    return new Response('Not found', { status: 404 })
  }
  const { extensionId, path: splat } = params
  const segments = (splat ?? '').split('/').filter(Boolean)
  const assetsRoot = path.join(extDir(extensionId), 'assets')
  const target = path.join(assetsRoot, ...segments)
  if (path.relative(assetsRoot, target).startsWith('..')) {
    return new Response('Forbidden', { status: 403 })
  }
  try {
    const file = await fs.readFile(target)
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    return new Response(file as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
})
