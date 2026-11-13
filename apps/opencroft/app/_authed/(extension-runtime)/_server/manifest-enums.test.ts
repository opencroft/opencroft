// An enum a manifest declares: a handle type with cases, qualified like every
// handle type, and refused by name when its cases or an input of it are malformed.
import assert from 'node:assert/strict'
import test from 'node:test'

import { type DeclaredManifest, normalizeManifest } from './manifest'

const ID = 'acme.images'
const CASES = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
]

function manifest(cases: unknown, handle: Record<string, unknown> = {}): DeclaredManifest {
  return {
    id: ID,
    name: 'Images',
    version: '1.0.0',
    handleTypes: [{ id: 'format', label: 'Image format', color: 'red', cases }],
    nodes: [
      {
        type: 'convert',
        name: 'Convert',
        handles: [{ id: 'format', role: 'target', handleType: 'format', ...handle }],
      },
    ],
  } as DeclaredManifest
}

test('an enum comes back qualified with its cases', () => {
  const normalized = normalizeManifest(manifest(CASES, { default: 'png' }), ID)
  assert.deepEqual(normalized.handleTypes, [{ id: `${ID}.format`, label: 'Image format', color: 'red', cases: CASES }])
  assert.equal(normalized.nodes?.[0].handles?.[0].handleType, `${ID}.format`)
})

test('an enum with no cases, a malformed case value or one value twice is refused, naming the enum', () => {
  assert.throws(() => normalizeManifest(manifest([]), ID), /enum "format" with no cases/)
  assert.throws(() => normalizeManifest(manifest('png'), ID), /enum "format" with no cases/)
  assert.throws(() => normalizeManifest(manifest([{ value: 'p n g' }]), ID), /enum "format" with the case "p n g"/)
  assert.throws(() => normalizeManifest(manifest([{ value: 'x'.repeat(65) }]), ID), /a case value is 1 to 64/)
  assert.throws(() => normalizeManifest(manifest([{ value: 'png' }, { value: 'png' }]), ID), /"png" twice/)
})

test("an input of one of the extension's enums takes inline and a default among its cases, and nothing else", () => {
  assert.doesNotThrow(() => normalizeManifest(manifest(CASES, { inline: false }), ID))
  assert.throws(
    () => normalizeManifest(manifest(CASES, { default: 'gif' }), ID),
    /the default "gif", which is not one of its cases \(png, jpeg\)/,
  )
  assert.throws(() => normalizeManifest(manifest(CASES, { multiline: true }), ID), /with multiline: an enum's input/)
  assert.throws(() => normalizeManifest(manifest(CASES, { options: [{ value: 'a' }] }), ID), /with options/)
})
