// The module reads the instance's brand colour from its environment once, on
// import -- so this file sets the variable before importing it, and owns the
// module for that reason; the parsing rules are pinned in brand-color.test.ts.

import assert from 'node:assert/strict'
import test from 'node:test'

const ENV = 'OPENCROFT_BRAND_COLOR'

test('an unknown value starts the instance in blue with one warning naming the value', async () => {
  const saved = process.env[ENV]
  const originalWarn = console.warn
  const warnings: string[] = []
  process.env[ENV] = 'grene'
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '))
  }
  try {
    const { BRAND_COLOR_ENV, brandColor, warnOnUnknownBrandColor } = await import('@/app/_server/brand-color')
    assert.equal(BRAND_COLOR_ENV, ENV)
    assert.equal(brandColor, 'blue')
    warnOnUnknownBrandColor()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /OPENCROFT_BRAND_COLOR="grene" is not a palette colour; using blue/)
  } finally {
    console.warn = originalWarn
    if (saved === undefined) {
      delete process.env[ENV]
    } else {
      process.env[ENV] = saved
    }
  }
})
