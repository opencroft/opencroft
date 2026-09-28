import assert from 'node:assert/strict'
import test from 'node:test'

import { appBasePath, appInstanceBase, appPathOf, isFullPageRoute, resolveAppHref } from './app-routes'

test('an App address names its instance page, and nothing else is taken for one', () => {
  assert.equal(appInstanceBase('my-space.my-app'), '/space/my-space/app/my-app')
  assert.equal(appBasePath(`${appInstanceBase('s.a')}/item/K-1`), '/space/s/app/a')
  for (const bad of ['my-app', '.my-app', 'my-space.', 's.a.b', 's.a/../b', 's.a?x', 's/x.a']) {
    assert.throws(() => appInstanceBase(bad), /An App address is "<space>.<app>"/, bad)
  }
})

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

test('a full-page pattern names exactly the pages it covers', () => {
  const patterns = ['/component/*/preview/**', '/print/*']
  for (const path of [
    '/component/button/preview',
    '/component/button/preview/example:examples/sizes.tsx',
    '/print/K-1',
    '/print/K-1?copy=2',
  ]) {
    assert.equal(isFullPageRoute(patterns, path), true, path)
  }
  // The pages around them keep the chrome: the component page itself, a
  // segment `*` would need but is missing, a second segment `*` cannot take,
  // a prefix that only looks alike, and the bare address.
  for (const path of [
    '/component/button',
    '/component/preview',
    '/print',
    '/print/K-1/extra',
    '/component/button/previews',
    '/',
  ]) {
    assert.equal(isFullPageRoute(patterns, path), false, path)
  }
})

test('an App that declares no full-page routes has none', () => {
  assert.equal(isFullPageRoute(undefined, '/component/button/preview'), false)
  assert.equal(isFullPageRoute([], '/'), false)
})
