import assert from 'node:assert/strict'
import test from 'node:test'

import { formatTemplate, parseTemplate } from './template'

function text(template: string, values: Record<string, unknown>): string {
  const result = formatTemplate(template, values)
  if (!result.ok) {
    assert.fail(`${template} did not format: ${result.error}`)
  }
  return result.text
}

function error(template: string, values: Record<string, unknown> = {}): string {
  const result = formatTemplate(template, values)
  assert.equal(result.ok, false, `${template} formatted`)
  return result.ok ? '' : result.error
}

test('placeholders are replaced by their values as text', () => {
  assert.equal(text('{name}_{n:03}.png', { name: 'cat', n: 7 }), 'cat_007.png')
  assert.equal(text('{a} {b} {c}', { a: 'x', b: 0.5, c: true }), 'x 0.5 true')
  assert.equal(text('plain', {}), 'plain')
  assert.equal(text('', {}), '')
  assert.equal(text('{a}{a}', { a: 1 }), '11')
})

test('doubled braces are literal', () => {
  assert.equal(text('{{x}} = {x}', { x: 2 }), '{x} = 2')
  assert.equal(text('}}{{', {}), '}{')
})

test('number formats', () => {
  assert.equal(text('{counter:04}', { counter: 7 }), '0007')
  assert.equal(text('{counter:04}', { counter: 12345 }), '12345')
  assert.equal(text('{counter:04}', { counter: -7 }), '-0007')
  assert.equal(text('{counter:02}', { counter: 6.6 }), '07')
  assert.equal(text('{counter:03}', { counter: '42' }), '042')
  assert.equal(text('{ratio:.2f}', { ratio: 0.5 }), '0.50')
  assert.equal(text('{ratio:.0f}', { ratio: 2.5 }), '3')
})

test('date formats write the date in UTC', () => {
  const ms = Date.UTC(2026, 0, 2, 3, 4, 5)
  assert.equal(text('{date:YYYY-MM-DD}', { date: ms }), '2026-01-02')
  assert.equal(text('{t:HH:mm:ss}', { t: ms }), '03:04:05')
  assert.equal(text('{d:YYYYMMDD_HHmmss}', { d: '2026-01-02T03:04:05Z' }), '20260102_030405')
})

test('a placeholder with no value is an error naming it', () => {
  assert.equal(error('{name}.png'), 'Nothing to put in {name}')
  assert.equal(error('{n:04}', { n: null }), 'Nothing to put in {n:04}')
  // Inherited keys are not values.
  assert.equal(error('{toString}'), 'Nothing to put in {toString}')
})

test('a value its format does not take is an error', () => {
  assert.equal(error('{n:04}', { n: 'abc' }), '{n:04} takes a number')
  assert.equal(error('{n:.2f}', { n: true }), '{n:.2f} takes a number')
  assert.equal(error('{d:YYYY}', { d: 'not a date' }), '{d:YYYY} takes a date: epoch milliseconds or an ISO string')
  assert.equal(error('{o}', { o: { a: 1 } }), '{o} takes text, a number or true / false')
  assert.equal(error('{o}', { o: Number.NaN }), '{o} takes text, a number or true / false')
})

test('parseTemplate lists placeholders and distinct names in order', () => {
  const parsed = parseTemplate('{date:YYYY-MM-DD}_{name}_{counter:04}_{name}')
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.names, ['date', 'name', 'counter'])
  assert.deepEqual(parsed.placeholders, [
    { name: 'date', format: 'YYYY-MM-DD', at: 1 },
    { name: 'name', at: 19 },
    { name: 'counter', format: '04', at: 26 },
    { name: 'name', at: 39 },
  ])
})

test('template mistakes are errors with their 1-based position', () => {
  const message = (template: string) => parseTemplate(template).errors.map((e) => e.message)
  assert.deepEqual(message('a {b'), ['Unclosed "{" at 3'])
  assert.deepEqual(message('a } b'), ['Unmatched "}" at 3'])
  assert.deepEqual(message('{x:zz}'), ['Unknown format "zz" at 1'])
  assert.deepEqual(message('{x:YYYY-Mon}'), ['Unknown format "YYYY-Mon" at 1'])
  assert.deepEqual(message('{x:00}'), ['Unknown format "00" at 1'])
  assert.deepEqual(message('{}'), ['A placeholder needs a name at 1'])
  assert.deepEqual(message('{a b}'), ['"a b" is not a placeholder name at 1'])
  assert.deepEqual(message('{a{b}'), ['Unclosed "{" at 1'])
  assert.equal(parseTemplate('{x:zz}').errors[0].position, 1)
  assert.equal(error('ok {x:zz}', { x: 1 }), 'Unknown format "zz" at 4')
})

test('a default format applies to a placeholder written without one, and only to it', () => {
  const at = Date.UTC(2026, 9, 30, 14, 5, 9)
  const defaults = { d: 'YYYY-MM-DD' }
  const format = (template: string) => formatTemplate(template, { d: at, n: 7 }, defaults)
  assert.deepEqual(format('{d}'), { ok: true, text: '2026-10-30' })
  assert.deepEqual(format('{d:HHmm}'), { ok: true, text: '1405' })
  assert.deepEqual(format('{n}'), { ok: true, text: '7' })
  assert.deepEqual(formatTemplate('{d}', { d: at }), { ok: true, text: String(at) })
})
