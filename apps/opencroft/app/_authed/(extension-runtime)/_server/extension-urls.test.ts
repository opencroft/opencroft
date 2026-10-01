// The URLs an extension is given for itself. The shape is defined once, in
// _extension-id.ts; this file holds every place that hands it out to that
// definition: the server host, the client shim the compiler generates, and the
// routes that answer it.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { type ExtensionUrlKind, extensionUrl, extensionUrlBase } from '@/app/_authed/(extension-runtime)/_extension-id'
import { extensionScopedExports } from './compiler'
import { createHost } from './host'

const ID = 'acme.widgets'
const ORIGIN = 'https://instance.example.com'
const KINDS: ExtensionUrlKind[] = ['assets', 'http']

test('the url base is /api/ext/<extensionId>, and the sub-trees hang off it', () => {
  assert.equal(extensionUrlBase(ID), '/api/ext/acme.widgets')
  assert.equal(extensionUrl(ID, 'assets', 'img/logo.png'), '/api/ext/acme.widgets/assets/img/logo.png')
  assert.equal(extensionUrl(ID, 'http', 'registry'), '/api/ext/acme.widgets/http/registry')
  // A leading slash is dropped rather than doubled.
  assert.equal(extensionUrl(ID, 'http', '/registry'), '/api/ext/acme.widgets/http/registry')
  assert.equal(extensionUrl(ID, 'http', '///registry'), '/api/ext/acme.widgets/http/registry')
})

test('the server host offers the base, both sub-trees and an absolute form', () => {
  const host = createHost(ID)
  const request = new Request(`${ORIGIN}/api/ext/${ID}/http/hook?x=1`)

  assert.equal(host.extensionId, ID)
  assert.equal(host.urlBase, '/api/ext/acme.widgets')
  assert.equal(host.assetUrl('a/b.png'), '/api/ext/acme.widgets/assets/a/b.png')
  assert.equal(host.routeUrl('registry'), '/api/ext/acme.widgets/http/registry')
  // The origin comes from the request; the path is whatever relative URL is given.
  assert.equal(host.absoluteUrl(request), `${ORIGIN}/api/ext/acme.widgets`)
  assert.equal(host.absoluteUrl(request, host.routeUrl('registry')), `${ORIGIN}/api/ext/acme.widgets/http/registry`)
  assert.equal(host.absoluteUrl(request, host.assetUrl('a/b.png')), `${ORIGIN}/api/ext/acme.widgets/assets/a/b.png`)
})

test('the absolute form follows the origin the request arrived on', () => {
  const host = createHost(ID)

  assert.equal(
    host.absoluteUrl(new Request('http://127.0.0.1:9999/api/ext/acme.widgets/http/x'), host.routeUrl('registry')),
    'http://127.0.0.1:9999/api/ext/acme.widgets/http/registry',
  )
})

/** The generated client code for one scoped name, run against the given page origin. */
function shimValue(name: string, origin = ORIGIN): unknown {
  const entry = extensionScopedExports(ID).find((candidate) => candidate.name === name)
  assert.ok(entry, `${name} is one of the extension-scoped exports`)
  // The shim's `__host.extensionUrl` is the client host's raw form of the same helper.
  const host = { extensionUrl, callAction: () => undefined, callNodeAction: () => undefined }
  return new Function('__host', 'location', `return (${entry.code})`)(host, { origin })
}

test('the client shim binds the same URLs to the extension being built', () => {
  const assetUrl = shimValue('assetUrl') as (path: string) => string
  const routeUrl = shimValue('routeUrl') as (path: string) => string
  const absoluteUrl = shimValue('absoluteUrl') as (url?: string) => string

  assert.equal(shimValue('extensionId'), ID)
  assert.equal(shimValue('urlBase'), '/api/ext/acme.widgets')
  assert.equal(assetUrl('a/b.png'), '/api/ext/acme.widgets/assets/a/b.png')
  assert.equal(assetUrl('/a/b.png'), '/api/ext/acme.widgets/assets/a/b.png')
  assert.equal(routeUrl('registry'), '/api/ext/acme.widgets/http/registry')
  assert.equal(absoluteUrl(), `${ORIGIN}/api/ext/acme.widgets`)
  assert.equal(absoluteUrl(routeUrl('registry')), `${ORIGIN}/api/ext/acme.widgets/http/registry`)
})

test('the client shim and the server host give the same URLs for the same extension', () => {
  const host = createHost(ID)
  const assetUrl = shimValue('assetUrl') as (path: string) => string
  const routeUrl = shimValue('routeUrl') as (path: string) => string

  assert.equal(assetUrl('x/y'), host.assetUrl('x/y'))
  assert.equal(routeUrl('x/y'), host.routeUrl('x/y'))
  assert.equal(shimValue('urlBase'), host.urlBase)
})

// The routes are directories under server/routes/api/ext, which no code can
// derive a URL from; so the URL the helper builds is walked down them.
test('every URL the helper builds has a route file at its place', async () => {
  const routesRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'server', 'routes', 'api', 'ext')

  assert.deepEqual(await readdir(routesRoot), ['[extensionId]'], 'the id is the only segment under /api/ext')
  const idDir = path.join(routesRoot, '[extensionId]')
  assert.ok((await readdir(idDir)).includes('[file].ts'), `${extensionUrlBase(ID)}/<file> has no route`)
  for (const kind of KINDS) {
    // <base>/<kind>/<path>: the kind is the directory right under the id's.
    const [, , , directory] = extensionUrl(ID, kind, 'x').split('/').slice(1)
    assert.equal(directory, kind)
    assert.ok((await readdir(idDir)).includes(kind), `${extensionUrl(ID, kind, 'x')} has no route directory`)
  }
})
