import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

import { buildExtensionCss } from './compiler'
import { EXTENSION_UTILITY_LAYER } from './css-cascade-layers'

// The first assertions ever made about a compiled extension stylesheet. Until
// the cascade-layer split these tests cover, nothing checked this artefact's
// content at all — which is how one collision between an extension's utilities
// and the host's reached a user through two different extensions without any
// build, test or log saying a word.

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-css-layers-'))

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

async function buildFrom(name: string, markup: string): Promise<string> {
  const srcDir = path.join(scratch, name)
  await fs.mkdir(srcDir, { recursive: true })
  await fs.writeFile(path.join(srcDir, 'component.tsx'), `export const C = () => <div className='${markup}' />\n`)
  return buildExtensionCss(srcDir)
}

test('a variant lands in the extension layer and a plain utility stays in utilities', async () => {
  // The exact pair from the reported defect: a container-query variant that has
  // to override the base utility beside it on the same element.
  const css = await buildFrom('split', 'hidden @[560px]:block')

  assert.ok(
    css.includes(`@layer theme, base, components, utilities, ${EXTENSION_UTILITY_LAYER};`),
    'the sheet must declare the extension layer after utilities',
  )

  const boundary = css.indexOf(`@layer ${EXTENSION_UTILITY_LAYER} {`)
  assert.ok(boundary > 0, 'expected an extension-utilities block in the compiled sheet')
  const utilitiesHalf = css.slice(0, boundary)
  const extensionHalf = css.slice(boundary)

  assert.match(utilitiesHalf, /@layer utilities \{/)
  assert.ok(utilitiesHalf.includes('.hidden'), '`hidden` belongs in the utilities layer')
  assert.ok(!utilitiesHalf.includes('560px'), 'the variant must not be emitted into the utilities layer')

  assert.ok(extensionHalf.includes('560px'), 'the variant belongs in the extension layer')
  assert.ok(!extensionHalf.includes('.hidden'), '`hidden` must not be duplicated into the extension layer')
})

test('an extension using no variants gets no extension layer rather than an empty one', async () => {
  // Emptiness is its own answer here: the second pass emits the entry preamble
  // whether or not it has candidates, so "no variants" has to mean no second
  // pass rather than a second copy of the preamble wrapping nothing.
  const css = await buildFrom('plain-only', 'hidden flex')

  assert.ok(css.includes('.hidden'), 'the plain utilities are still compiled')
  assert.ok(
    !css.includes(`@layer ${EXTENSION_UTILITY_LAYER} {`),
    'an extension with no variants must not carry an empty extension layer',
  )
})

test('an extension using only variants still declares the layer order', async () => {
  // The mirror of the case above, and the one that would break the fix
  // silently: without a `utilities` pass nothing else establishes the layer
  // statement, so the extension layer would have to be ordered by the host's
  // sheet appending it — which is exactly the behaviour being relied on.
  const css = await buildFrom('variant-only', '@[560px]:block')

  assert.ok(
    css.includes(`@layer theme, base, components, utilities, ${EXTENSION_UTILITY_LAYER};`),
    'the layer statement travels with whichever pass runs',
  )
  assert.ok(css.includes(`@layer ${EXTENSION_UTILITY_LAYER} {`), 'the variant is emitted into the extension layer')
})
