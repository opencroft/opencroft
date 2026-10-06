// The app's icons in the instance's brand colour. Asserted on rasterized
// pixels rather than on markup: an image renderer is free to ignore styling a
// browser page would honour, and only the pixels show which colour came out.

import assert from 'node:assert/strict'
import test from 'node:test'

import sharp from 'sharp'

import { appIconPng, appIconSvg, isRasterIconName, RASTER_ICONS, type RasterIconName } from '@/app/_server/brand-icons'
import { webManifest } from '@/app/_server/web-manifest'

const GREEN = '34,197,94'
const BLUE = '59,130,246'
const OUTLINE = '240,240,255'
const TILE = '15,15,46'

// Points as fractions of the edge: the middle of the filled cell, the top
// edge of the top-left outline, and the very corner of the square.
async function sample(image: Buffer) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (fx: number, fy: number) => {
    const i = (Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)) * info.channels
    return { rgb: Array.from(data.subarray(i, i + 3)).join(','), alpha: data[i + 3] }
  }
  return { width: info.width, height: info.height, accent: at(0.66, 0.66), outline: at(0.34, 0.22), corner: at(0, 0) }
}

test('the tab icon fills its accent in the chosen colour, and in blue by default', async () => {
  assert.equal((await sample(Buffer.from(appIconSvg('green')))).accent.rgb, GREEN)
  assert.equal((await sample(Buffer.from(appIconSvg('blue')))).accent.rgb, BLUE)
})

for (const name of Object.keys(RASTER_ICONS) as RasterIconName[]) {
  const { size, fullBleed } = RASTER_ICONS[name]

  test(`${name} is ${size}px with a green accent and a light outline on a green instance`, async () => {
    const icon = await sample(await appIconPng('green', name))
    assert.deepEqual([icon.width, icon.height], [size, size])
    assert.equal(icon.accent.rgb, GREEN)
    assert.equal(icon.outline.rgb, OUTLINE)
  })

  test(`${name} ${fullBleed ? 'fills its corners' : 'leaves its corners clear'}`, async () => {
    const { corner } = await sample(await appIconPng('blue', name))
    if (fullBleed) {
      assert.deepEqual(corner, { rgb: TILE, alpha: 255 })
    } else {
      assert.equal(corner.alpha, 0)
    }
  })
}

test('only the listed icon names are icons', () => {
  assert.equal(isRasterIconName('icon-192.png'), true)
  for (const name of ['favicon.svg', 'icon-193.png', '', 'toString', '../icon-192.png']) {
    assert.equal(isRasterIconName(name), false, `${name} is not an icon`)
  }
})

test('every icon the manifest lists carries the colour in its address', () => {
  const manifest = webManifest('green')
  const srcs = [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)].map((icon) => icon.src)
  assert.ok(srcs.length > 0)
  for (const src of srcs) {
    assert.match(src, /\?color=green$/)
  }
})

test('the manifest lists one maskable icon and it is a full-bleed one', () => {
  const maskable = webManifest('blue').icons.filter((icon) => icon.purpose === 'maskable')
  assert.equal(maskable.length, 1)
  const name = maskable[0].src.replace(/^\/icons\//, '').replace(/\?.*$/, '')
  assert.ok(isRasterIconName(name) && RASTER_ICONS[name].fullBleed)
})
