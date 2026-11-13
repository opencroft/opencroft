import assert from 'node:assert/strict'
import test from 'node:test'

import { RE2JS } from 're2js'

import { compilePattern, MAX_PATTERN_GROUPS, MAX_PATTERN_LENGTH, type Pattern } from './pattern'

function compiled(source: string, ignoreCase = false): Pattern {
  const result = compilePattern(source, ignoreCase)
  if (!result.ok) {
    assert.fail(`${source} did not compile: ${result.error}`)
  }
  return result.pattern
}

function error(source: string): string {
  const result = compilePattern(source, false)
  assert.equal(result.ok, false, `${source} compiled`)
  return result.ok ? '' : result.error
}

function replaced(source: string, text: string, replacement: string, all = true): [string, number] {
  const result = compiled(source).replace(text, replacement, all)
  if (!result.ok) {
    assert.fail(`${replacement} did not replace: ${result.error}`)
  }
  return [result.text, result.count]
}

function replaceError(source: string, replacement: string): string {
  const result = compiled(source).replace('x', replacement, true)
  assert.equal(result.ok, false, `${replacement} replaced`)
  return result.ok ? '' : result.error
}

test('search finds the first match and the text of each group, named or numbered', () => {
  const p = compiled('(?<year>\\d{4})-(?<month>\\d{2})(-(\\d{2}))?')
  assert.deepEqual(p.groups, [{ number: 1, name: 'year' }, { number: 2, name: 'month' }, { number: 3 }, { number: 4 }])
  assert.deepEqual(p.search('report 2026-10.pdf, 2027-01'), { text: '2026-10', groups: ['2026', '10', '', ''] })
  assert.deepEqual(p.search('2026-10-31'), { text: '2026-10-31', groups: ['2026', '10', '-31', '31'] })
  assert.equal(p.search('no date'), null)
})

test('a group that takes no part in the match reads as empty text', () => {
  assert.deepEqual(compiled('(a)|(b)').search('b'), { text: 'b', groups: ['', 'b'] })
})

test('the inline flags and ignoreCase change what matches', () => {
  assert.equal(compiled('abc').search('ABC'), null)
  assert.equal(compiled('abc', true).search('ABC')?.text, 'ABC')
  assert.equal(compiled('(?i)abc').search('ABC')?.text, 'ABC')
  assert.equal(compiled('^b').search('a\nb'), null)
  assert.equal(compiled('(?m)^b').search('a\nb')?.text, 'b')
  assert.equal(compiled('a.b').search('a\nb'), null)
  assert.equal(compiled('(?s)a.b').search('a\nb')?.text, 'a\nb')
})

test('a match is cut from the text by its characters, astral ones included', () => {
  assert.deepEqual(compiled('é(.)').search('xxé😀z'), { text: 'é😀', groups: ['😀'] })
  assert.deepEqual(replaced('.', 'x😀', '[$&]'), ['[x][😀]', 2])
})

test('a pattern that would backtrack exponentially answers in linear time', () => {
  const p = compiled('(a+)+$')
  const started = performance.now()
  assert.equal(p.search(`${'a'.repeat(40)}b`), null)
  assert.equal(p.search(`${'a'.repeat(100_000)}b`), null)
  // A backtracking engine takes minutes on the first text alone.
  assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`)
})

test('backreferences and lookaround are refused, naming the feature', () => {
  assert.match(error('(\\w)\\1'), /^Backreferences such as \\1 are not supported/)
  assert.match(error('(?<w>\\w)\\k<w>'), /^Backreferences/)
  for (const lookaround of ['a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b']) {
    assert.match(error(lookaround), /^Lookaround such as/, lookaround)
  }
})

test('a pattern that does not compile says why, in the engine words', () => {
  assert.equal(error('('), 'Missing closing ): `(`')
  assert.equal(error('[z-a]'), 'Invalid character class range: `z-a`')
  assert.equal(error('(?<a>x)(?<a>y)'), 'Duplicate capture group name: `a`')
})

test('an empty pattern, a long one, a bad group name and too many groups are errors', () => {
  assert.equal(error(''), 'The pattern is empty')
  assert.equal(error('a'.repeat(MAX_PATTERN_LENGTH + 1)), `The pattern is longer than ${MAX_PATTERN_LENGTH} characters`)
  assert.ok(compilePattern('a'.repeat(MAX_PATTERN_LENGTH), false).ok)
  assert.equal(error('(?<1a>x)'), '"1a" is not a group name: start it with a letter or _')
  assert.equal(
    error('(a)'.repeat(MAX_PATTERN_GROUPS + 1)),
    `The pattern has 33 groups, more than ${MAX_PATTERN_GROUPS}`,
  )
  assert.ok(compilePattern('(a)'.repeat(MAX_PATTERN_GROUPS), false).ok)
})

test('replace substitutes $n, $<name>, $& and $$', () => {
  assert.deepEqual(replaced('(\\w+)@(\\w+)', 'ann@home bob@work', '$2 at $1'), ['home at ann work at bob', 2])
  assert.deepEqual(replaced('(\\w+)@(\\w+)', 'ann@home bob@work', '$2 at $1', false), ['home at ann bob@work', 1])
  assert.deepEqual(replaced('(?<user>\\w+)@', 'ann@home', '<$<user>>'), ['<ann>home', 1])
  assert.deepEqual(replaced('\\d+', 'a1b22', '[$&]'), ['a[1]b[22]', 2])
  assert.deepEqual(replaced('x', 'axb', '$$5'), ['a$5b', 1])
})

test('any other $ in a replacement is itself', () => {
  assert.deepEqual(replaced('x', 'x', '$ $0 $a $< $'), ['$ $0 $a $< $', 1])
})

test('$ and two digits name a group when the pattern has that many, else one digit and a digit', () => {
  const twelve = `${'(.)'.repeat(12)}`
  assert.deepEqual(replaced(twelve, 'abcdefghijkl', '$12$1'), ['la', 1])
  assert.deepEqual(replaced('(a)', 'a', '$10'), ['a0', 1])
})

test('a reference to a group the pattern does not have is an error', () => {
  assert.equal(replaceError('(a)(b)', '$3'), '$3: the pattern has 2 groups')
  assert.equal(replaceError('(a)', '$2'), '$2: the pattern has 1 group')
  assert.equal(replaceError('a', '$1'), '$1: the pattern has no groups')
  assert.equal(replaceError('(?<x>a)', '$<y>'), '$<y>: the pattern has no group named "y"')
})

test('no match leaves the text as it is, and empty matches are replaced between characters', () => {
  assert.deepEqual(replaced('z', 'abc', '-'), ['abc', 0])
  assert.deepEqual(replaced('a*', 'baaac', '-'), ['-b--c-', 4])
})

test('a pattern is compiled once per distinct text and flags, however often it is read', (t) => {
  const compile = t.mock.method(RE2JS, 'compile')
  const source = 'pattern-compiled-once-(\\d+)'
  for (let i = 0; i < 5; i++) {
    compilePattern(source, false)
  }
  compilePattern(source, true)
  // A pattern that does not compile is kept too: its error is the same on every read.
  compilePattern(`${source}(`, false)
  compilePattern(`${source}(`, false)
  assert.equal(compile.mock.callCount(), 3)
})

test('a compiled pattern reuses its last search and replacement for the same text', () => {
  const p = compiled('(?<n>\\d+)')
  const first = p.search('a 12')
  assert.equal(p.search('a 12'), first)
  assert.notEqual(p.search('b 3'), first)
  const replacedOnce = p.replace('a 12', '[$1]', true)
  assert.equal(p.replace('a 12', '[$1]', true), replacedOnce)
  assert.notEqual(p.replace('a 12', '[$1]', false), replacedOnce)
})
