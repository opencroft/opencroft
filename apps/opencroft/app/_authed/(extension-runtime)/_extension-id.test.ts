import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extensionIdOfType,
  isLocalFolder,
  isReservedOwner,
  localFolderFor,
  parseExtensionId,
  parseType,
  qualifyType,
  resolveTypeRef,
  slugifyPart,
} from './_extension-id'

test('an extension id is two slugs joined by one dot', () => {
  assert.deepEqual(parseExtensionId('acme.widgets'), { owner: 'acme', extension: 'widgets' })
  assert.deepEqual(parseExtensionId('local.my-ext-2'), { owner: 'local', extension: 'my-ext-2' })
})

test('anything else is not an extension id', () => {
  for (const id of [
    'acme',
    'acme.widgets.gauge',
    'acme/widgets',
    'Acme.widgets',
    'acme..',
    '.widgets',
    'ac_me.widgets',
    '',
  ]) {
    assert.equal(parseExtensionId(id), null, id)
  }
})

test('builtin and local are the reserved owners', () => {
  assert.equal(isReservedOwner('builtin'), true)
  assert.equal(isReservedOwner('local'), true)
  assert.equal(isReservedOwner('acme'), false)
})

test('a local folder is one owned by local', () => {
  assert.equal(isLocalFolder('local.widgets'), true)
  assert.equal(isLocalFolder('acme.widgets'), false)
  assert.equal(isLocalFolder('.staging-local.widgets-1-1'), false)
})

test('the local folder of an extension name is a local folder and an extension id', () => {
  assert.equal(localFolderFor('widgets'), 'local.widgets')
  assert.equal(isLocalFolder(localFolderFor('widgets')), true)
  assert.deepEqual(parseExtensionId(localFolderFor('widgets')), { owner: 'local', extension: 'widgets' })
})

test('slugifying a part turns every other character into a hyphen, dots included', () => {
  assert.equal(slugifyPart('Foo.Bar_baz'), 'foo-bar-baz')
  assert.equal(slugifyPart('--x--'), 'x')
  assert.equal(slugifyPart('foo.bar'), slugifyPart('foo-bar'), 'two sources can meet on one slug')
})

test('a qualified type names its extension: the first two slugs', () => {
  assert.equal(qualifyType('acme.widgets', 'gauge'), 'acme.widgets.gauge')
  assert.equal(extensionIdOfType('acme.widgets.gauge'), 'acme.widgets')
  assert.equal(extensionIdOfType('builtin.core.terminal-context'), 'builtin.core')
})

test('a bare type, or anything but exactly three slugs, names no extension', () => {
  for (const type of [
    'localhost',
    'acme.widgets',
    'acme.widgets.gauge.extra',
    'acme..gauge',
    'Acme.widgets.gauge',
    'local/acme.widgets.gauge',
  ]) {
    assert.equal(extensionIdOfType(type), null, type)
    assert.equal(parseType(type), null, type)
  }
})

test('a qualified type splits into its extension and the bare type it declared', () => {
  assert.deepEqual(parseType('acme.widgets.gauge'), { extensionId: 'acme.widgets', bare: 'gauge' })
})

test("a bare type reference is the referring extension's own, a qualified one is kept", () => {
  assert.equal(resolveTypeRef('acme.widgets', 'gauge'), 'acme.widgets.gauge')
  assert.equal(resolveTypeRef('acme.widgets', 'builtin.core.text-stream'), 'builtin.core.text-stream')
})
