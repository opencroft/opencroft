// THE REGRESSION THIS FILE PINS: an extension bundle compiled before
// shortcuts moved from `{ key }` (a character) to `{ code }` (the physical
// key) keeps running exactly as compiled after this ships -- an app deploy
// does not touch already-installed extension bundles. Without the fallback
// in resolveShortcutCode, that bundle's `sc.code` reads as undefined and its
// shortcut goes silently dead the moment this merges -- the same class of
// failure this whole change exists to fix, just one hop later (a legacy
// compiled declaration instead of a layout switch). Found live: an
// installed extension declares `shortcut: { key: 'g' }`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { resolveShortcutCode } = await import('./canvas-overlay')

/** A shortcut declaration in either shape -- the current `code`, the legacy
 * `key` an already-compiled bundle carries, or (deliberately, for one test)
 * both at once. The current CommandModeShortcut type no longer allows `key`
 * to be written directly, which is the whole point of the type change; this
 * is the one place a test needs to construct the shape anyway. */
function declare(props: { code?: string; key?: string }): Parameters<typeof resolveShortcutCode>[0] {
  return props as unknown as Parameters<typeof resolveShortcutCode>[0]
}

test('a current-shape declaration resolves on its own code', () => {
  assert.equal(resolveShortcutCode(declare({ code: 'KeyG' })), 'KeyG')
})

test('a legacy `key`-only declaration (an already-compiled bundle) still resolves', () => {
  assert.equal(resolveShortcutCode(declare({ key: 'g' })), 'KeyG')
})

test('a legacy declaration is case-insensitive, same as the current field would be', () => {
  assert.equal(resolveShortcutCode(declare({ key: 'G' })), 'KeyG')
})

test('`code` wins over a stray legacy `key` on the same object', () => {
  assert.equal(resolveShortcutCode(declare({ code: 'KeyG', key: 'x' })), 'KeyG')
})

test('a legacy declaration outside a-z resolves to nothing, rather than guessing', () => {
  // The old field was only ever used for letters -- a digit or punctuation
  // legacy value was never a real declaration this shim needs to honour.
  assert.equal(resolveShortcutCode(declare({ key: '1' })), undefined)
  assert.equal(resolveShortcutCode(declare({ key: ',' })), undefined)
})

test('neither field present resolves to nothing', () => {
  assert.equal(resolveShortcutCode(declare({})), undefined)
})

dom.cleanup()
