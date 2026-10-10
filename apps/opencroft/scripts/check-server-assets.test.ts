// What the server bundle is scanned for: the asset names it links, as the
// built output spells them.

import assert from 'node:assert/strict'
import test from 'node:test'

import { assetReferences } from './check-server-assets.mjs'

// Shapes taken from a real `.output/server`: the router's `?url` import of the
// app stylesheet, and the static asset manifest in index.mjs.
test('an asset linked by the server is found in each way the output names it', () => {
  const router = 'var globals_default = "/assets/globals-CNSlOO8Y.css";'
  const manifest = '"/assets/a-arrow-down-gGZVxdrt.js": {\n\t\t"type": "text/javascript; charset=utf-8",'
  assert.deepEqual(assetReferences(router), ['/assets/globals-CNSlOO8Y.css'])
  assert.deepEqual(assetReferences(manifest), ['/assets/a-arrow-down-gGZVxdrt.js'])
})

test('a name the output repeats is reported once', () => {
  const code = 'a = "/assets/x-1.css"; b = `/assets/x-1.css`; c = \'/assets/x-1.css\''
  assert.deepEqual(assetReferences(code), ['/assets/x-1.css'])
})

// The output also carries the route pattern that serves the folder; it names
// no file, so it must not read as a missing one.
test('a route pattern over the assets folder is not an asset', () => {
  assert.deepEqual(assetReferences('"/assets/**": { maxAge: 31536000 }'), [])
})

// The manifest's own on-disk path is relative to the server folder, not a URL
// the page requests.
test('the manifest path relative to the server folder is not a reference', () => {
  assert.deepEqual(assetReferences('"path": "../public/assets/globals-CNSlOO8Y.css"'), [])
})
