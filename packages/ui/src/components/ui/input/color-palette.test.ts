import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { PALETTE_HUES, PALETTE_SHADES, paletteColor, paletteTextClass } from './color-palette'

/** Splits a brace body at its top-level commas. */
function alternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') {
      depth++
    } else if (body[i] === '}') {
      depth--
    } else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

/** Every string a Tailwind `@source inline` pattern names: comma lists, nested braces, `from..to..step` ranges. */
function expand(pattern: string): string[] {
  const open = pattern.indexOf('{')
  if (open < 0) {
    return [pattern]
  }
  let depth = 0
  let close = open
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') {
      depth++
    } else if (pattern[i] === '}' && --depth === 0) {
      close = i
      break
    }
  }
  const body = pattern.slice(open + 1, close)
  const range = /^(\d+)\.\.(\d+)(?:\.\.(\d+))?$/.exec(body)
  const options = range
    ? Array.from(
        { length: Math.floor((Number(range[2]) - Number(range[1])) / Number(range[3] ?? 1)) + 1 },
        (_, i) => String(Number(range[1]) + i * Number(range[3] ?? 1)),
      )
    : alternatives(body).flatMap(expand)
  const tails = expand(pattern.slice(close + 1))
  return options.flatMap((option) => tails.map((tail) => pattern.slice(0, open) + option + tail))
}

test('the brace expansion reads lists, nesting and stepped ranges', () => {
  assert.deepEqual(expand('a-{x,y}-{1,{2..6..2},9}'), [
    'a-x-1',
    'a-x-2',
    'a-x-4',
    'a-x-6',
    'a-x-9',
    'a-y-1',
    'a-y-2',
    'a-y-4',
    'a-y-6',
    'a-y-9',
  ])
})

test('the stylesheet generates the text class of every palette colour, and of nothing else', () => {
  const css = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8')
  const generated = [...css.matchAll(/@source inline\('([^']*)'\)/g)]
    .flatMap((match) => expand(match[1]))
    .filter((name) => /^text-[a-z]+-\d+$/.test(name))
  const palette = PALETTE_HUES.flatMap((hue) => PALETTE_SHADES.map((shade) => paletteTextClass(`${hue}-${shade}`)))
  assert.ok(generated.length > 0, 'the stylesheet generates no palette text class')
  assert.ok(palette.every((name) => name !== undefined))
  assert.deepEqual([...new Set(generated)].sort(), [...palette].sort())
})

test('a palette id is a hue and a shade of the palette, and nothing else is', () => {
  assert.deepEqual(paletteColor('sky-300'), { hue: 'sky', shade: '300' })
  for (const id of [undefined, '', 'sky', 'sky-550', 'mauve-500', 'primary', 'sky-300-x']) {
    assert.equal(paletteColor(id), undefined, String(id))
    assert.equal(paletteTextClass(id), undefined, String(id))
  }
})
