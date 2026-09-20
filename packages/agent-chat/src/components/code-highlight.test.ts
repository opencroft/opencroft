import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveLanguage } from './code-highlight'

// What a fence resolves to decides whether a block is coloured at all, and the
// inputs are whatever an agent happened to type above the code. These are the
// forms seen in real transcripts.

test('the short names agents actually write resolve to grammars', () => {
  assert.equal(resolveLanguage('ts'), 'typescript')
  assert.equal(resolveLanguage('sh'), 'bash')
  assert.equal(resolveLanguage('py'), 'python')
  assert.equal(resolveLanguage('yml'), 'yaml')
  assert.equal(resolveLanguage('jsx'), 'tsx')
})

test('a full grammar name resolves to itself', () => {
  assert.equal(resolveLanguage('typescript'), 'typescript')
  assert.equal(resolveLanguage('json'), 'json')
})

test('case and surrounding space do not decide whether code gets colour', () => {
  assert.equal(resolveLanguage('  TS  '), 'typescript')
  assert.equal(resolveLanguage('Bash'), 'bash')
})

test('only the first word of an info string is the language', () => {
  // Fences in the wild carry line ranges and titles after the language, and a
  // block that lost its colours because somebody highlighted a line would be a
  // silly way to lose them.
  assert.equal(resolveLanguage('ts {1,3}'), 'typescript')
  assert.equal(resolveLanguage('bash title="install"'), 'bash')
  assert.equal(resolveLanguage('js:server.js'), 'javascript')
})

test('an absent or unknown language is null rather than a guess', () => {
  // Null is the ordinary answer, not a failure: the caller renders plain text,
  // which is what an unhighlightable block should look like.
  assert.equal(resolveLanguage(undefined), null)
  assert.equal(resolveLanguage(''), null)
  assert.equal(resolveLanguage('hcl'), null)
  assert.equal(resolveLanguage('mermaid'), null)
})

test('an alias never resolves to a grammar that is not loadable', () => {
  // The alias table and the grammar table are written separately, so an alias
  // pointing at a name nobody can import would be a silent hole: resolveLanguage
  // would hand back a language and the highlighter would then fail on it.
  const aliased = [
    'cjs',
    'c++',
    'console',
    'cs',
    'dockerfile',
    'golang',
    'js',
    'jsx',
    'kt',
    'makefile',
    'md',
    'mdx',
    'mjs',
    'patch',
    'py',
    'rb',
    'rs',
    'sh',
    'shell',
    'ts',
    'yml',
    'zsh',
  ]
  for (const alias of aliased) {
    const resolved = resolveLanguage(alias)
    assert.ok(resolved, `alias ${alias} resolved to nothing`)
    assert.equal(resolveLanguage(resolved), resolved, `alias ${alias} resolved to ${resolved}, which is not a grammar`)
  }
})
