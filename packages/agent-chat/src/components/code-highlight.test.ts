import assert from 'node:assert/strict'
import test from 'node:test'

import { highlight, resolveLanguage } from './code-highlight'

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

// The two shapes of output. `code-block` relies on the mark for its box and its
// wrapping; `code-block-editor` relies on there being NO mark, because it draws
// its own box and has to own the padding for the caret to land correctly. Both
// rely on the colours, which is why the colours hang on shiki's own class and
// not on the mark.

test('a highlighted block marks itself as owning its box', async () => {
  const html = await highlight('const answer = 42\n', 'typescript')
  assert.ok(html, 'typescript should highlight')
  assert.match(html, /data-code-block/)
  assert.match(html, /class="shiki/)
  assert.match(html, /--shiki-light:/)
  assert.match(html, /--shiki-dark:/)
})

test('a plain highlight keeps the colours and drops the box', async () => {
  const html = await highlight('const answer = 42\n', 'typescript', { plain: true })
  assert.ok(html, 'typescript should highlight')
  assert.doesNotMatch(html, /data-code-block/)
  // Still coloured: the stylesheet keys colour off shiki's class, so dropping
  // the mark must not drop the theme variables with it.
  assert.match(html, /class="shiki/)
  assert.match(html, /--shiki-light:/)
  // And the user-agent's own `pre` margin and font are overridden inline,
  // because a stylesheet rule would not travel into the design kit copy.
  assert.match(html, /margin:0;padding:0/)
  assert.match(html, /font:inherit/)
})
