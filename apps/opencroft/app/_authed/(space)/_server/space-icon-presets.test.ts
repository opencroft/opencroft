// The preset ids exist twice on purpose: the database package holds them as
// plain ids for the column default and the server's checks, and the design
// kit's Space Icon holds them with the icon and the colour each one draws.
// The kit cannot import the database and the database must not load a
// component, so this is what keeps the two lists one set.

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isSpaceIconPreset,
  randomSpaceIconValue,
  SPACE_ICON_COLOR_IDS,
  SPACE_ICON_GLYPH_IDS,
} from '@opencroft/db/space-icon-presets'
import { findSpaceIconPreset, SPACE_ICON_COLORS, SPACE_ICON_GLYPHS } from 'ui/spaces/space-icon'

test('the database knows exactly the glyphs and colours the kit draws, in the same order', () => {
  assert.deepEqual(
    SPACE_ICON_GLYPHS.map((g) => g.id),
    SPACE_ICON_GLYPH_IDS,
  )
  assert.deepEqual(
    SPACE_ICON_COLORS.map((c) => c.id),
    SPACE_ICON_COLOR_IDS,
  )
})

test('a preset the database draws is one the kit can draw', () => {
  const first = randomSpaceIconValue(() => 0)
  const last = randomSpaceIconValue(() => 0.999999)
  assert.ok(findSpaceIconPreset(first), `${first} is not a preset the kit knows`)
  assert.ok(findSpaceIconPreset(last), `${last} is not a preset the kit knows`)
  assert.notEqual(first, last)
})

test('the check accepts a known glyph on a known colour and nothing else', () => {
  assert.equal(isSpaceIconPreset('preset:rocket:blue'), true)
  assert.equal(isSpaceIconPreset('preset:rocket:mauve'), false)
  assert.equal(isSpaceIconPreset('preset:comet:blue'), false)
  assert.equal(isSpaceIconPreset('preset:rocket:blue:extra'), false)
  assert.equal(isSpaceIconPreset('data:image/png;base64,AAAA'), false)
})
