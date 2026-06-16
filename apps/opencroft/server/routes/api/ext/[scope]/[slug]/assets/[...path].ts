import { promises as fs } from 'node:fs'
import path from 'node:path'

import { defineEventHandler } from 'nitro/h3'

import { extDir } from '@/app/(extension-runtime)/_server/paths'

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
}

// Serves extension static assets at /api/ext/<scope>/<slug>/assets/<...>. In the
// Nitro serverDir (not a TanStack route) so extension-laden paths (.wasm, .onnx,
// .png, …) reach the handler instead of Vite's dev static layer.
export default defineEventHandler(async (event) => {
  const { scope, slug, path: splat } = event.context.params
  const segments = (splat ?? '').split('/').filter(Boolean)
  const extensionId = `${scope}/${slug}`
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
