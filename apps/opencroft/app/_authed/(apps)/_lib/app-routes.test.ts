import assert from 'node:assert/strict'
import test from 'node:test'

import { appBasePath, appPathOf, resolveAppHref } from './app-routes'

test('the base path is the instance address and nothing past it', () => {
  assert.equal(appBasePath('/space/my-space/app/my-app/item/K-1'), '/space/my-space/app/my-app')
  assert.equal(appBasePath('/space/my-space/app/my-app'), '/space/my-space/app/my-app')
  assert.equal(appBasePath('/space/my-space'), null)
  assert.equal(appBasePath('/space/my-space/settings/app/my-app'), null)
})

test('the App path is what follows the base, and the bare address is the root', () => {
  assert.equal(appPathOf('/space/s/app/a/item/K-1', '/space/s/app/a'), '/item/K-1')
  assert.equal(appPathOf('/space/s/app/a', '/space/s/app/a'), '/')
})

test('an address outside the App has no App path', () => {
  // Another App, including one whose slug starts with this one's.
  assert.equal(appPathOf('/space/s/app/design-kit', '/space/s/app/demo'), null)
  assert.equal(appPathOf('/space/s/app/demo-2/tasks', '/space/s/app/demo'), null)
  // The graph and other host pages.
  assert.equal(appPathOf('/space/s', '/space/s/app/demo'), null)
  assert.equal(appPathOf('/', '/space/s/app/demo'), null)
})

test('an App path is addressed under the instance', () => {
  assert.equal(
    resolveAppHref('/space/s/app/a', '/inbox', '/item/K-1?tab=activity'),
    '/space/s/app/a/item/K-1?tab=activity',
  )
  assert.equal(resolveAppHref('/space/s/app/a', '/inbox', '/'), '/space/s/app/a')
  assert.equal(resolveAppHref('/space/s/app/a', '/inbox', '/?view=all'), '/space/s/app/a?view=all')
})

test('a bare query stays on the current page', () => {
  assert.equal(resolveAppHref('/space/s/app/a', '/inbox', '?status=Done'), '/space/s/app/a/inbox?status=Done')
  assert.equal(resolveAppHref('/space/s/app/a', '/', '?status=Done'), '/space/s/app/a?status=Done')
  // An empty query clears it.
  assert.equal(resolveAppHref('/space/s/app/a', '/inbox', '?'), '/space/s/app/a/inbox')
})

test('an address outside the App is refused', () => {
  for (const to of [
    'https://example.com/',
    '//example.com/x',
    'relative/path',
    '',
    '/../other-app',
    '/item/../..',
    '/./x',
  ]) {
    assert.throws(() => resolveAppHref('/space/s/app/a', '/inbox', to), /App path/, to)
  }
})
