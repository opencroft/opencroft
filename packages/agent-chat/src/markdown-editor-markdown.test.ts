import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import type { JSONContent } from '@tiptap/core'

import { markdownConverter } from './markdown-editor-schema'

// The converter alone: no editor and no DOM, which is how a server runs it.
const markdown = markdownConverter()

function roundTrip(source: string): string {
  return markdown.serialize(markdown.parse(source))
}

/** A document of one paragraph per line given, each holding that line as plain text. */
function typed(...lines: string[]): JSONContent {
  return {
    type: 'doc',
    content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  }
}

test('the schema and converter import no component, so a server can load them', () => {
  // A server bundles what it imports: a `.tsx` file, React or the UI package
  // in this graph puts a component -- and a JSX transform -- into the server.
  const reached = new Set<string>()
  const visit = (file: string) => {
    if (reached.has(file)) {
      return
    }
    reached.add(file)
    const source = readFileSync(join(import.meta.dirname, file), 'utf8')
    for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^'"]*?from '([^']+)'/gm)) {
      assert.ok(!/^(react|react-dom|ui)(\/|$)|^@tiptap\/react/.test(specifier), `${file} imports ${specifier}`)
      if (specifier.startsWith('.')) {
        const base = join(file, '..', specifier)
        const next = [`${base}.ts`, `${base}.tsx`].find((path) => existsSync(join(import.meta.dirname, path)))
        assert.ok(next, `${file} imports ${specifier}, which resolves`)
        visit(next)
      }
    }
  }
  visit('markdown-editor-schema.ts')
  assert.deepEqual(
    [...reached].filter((file) => file.endsWith('.tsx')),
    [],
  )
})

test('an ampersand is written as typed unless it would read back as an entity', () => {
  // Pins the replaced text encoder: the manager's own writes every `&` as `&amp;`.
  assert.equal(markdown.serialize(typed('Tom & Jerry')), 'Tom & Jerry')
  assert.equal(markdown.serialize(typed('write &amp; to get &')), 'write &amp;amp; to get &')
  assert.equal(roundTrip('write &amp;amp; to get &'), 'write &amp;amp; to get &')
})

test('angle brackets are written as entities and read back as the characters', () => {
  assert.equal(markdown.serialize(typed('a <b> c')), 'a &lt;b&gt; c')
  assert.deepEqual(markdown.parse('a &lt;b&gt; c').content?.[0].content, [{ type: 'text', text: 'a <b> c' }])
})

test('typed text that starts like a heading, a list item or a fence reads back as the same text', () => {
  const lines = ['# not a heading', '- not an item', '+ not an item', '1. not a step', '2) not a step', ':::note']
  const saved = markdown.serialize(typed(...lines))
  assert.equal(
    saved,
    '\\# not a heading\n\n\\- not an item\n\n\\+ not an item\n\n1\\. not a step\n\n2\\) not a step\n\n\\:::note',
  )
  assert.deepEqual(markdown.parse(saved), typed(...lines))
})

test('an escaped fence on its own is a paragraph of text, not a block', () => {
  assert.deepEqual(markdown.parse('\\:::note'), typed(':::note'))
  assert.deepEqual(markdown.parse('before\n\n\\:::note\n\nafter'), typed('before', ':::note', 'after'))
})

test('an icon is read wherever it starts, and the double-colon form never is', () => {
  const icons = (source: string) =>
    (markdown.parse(source).content?.[0].content ?? []).filter((node) => node.type === 'markdownIcon').length
  assert.equal(icons(':icon[star]'), 1)
  assert.equal(icons('a:icon[star]'), 1)
  assert.equal(icons('::icon[star]'), 0)
  assert.equal(icons('a::icon[star]'), 0)
  assert.equal(roundTrip('::icon[star]'), '::icon\\[star\\]')
})

test('a hard break is a backslash at the end of the line, and the next line is escaped too', () => {
  const doc: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'first' }, { type: 'hardBreak' }, { type: 'text', text: '# second' }],
      },
    ],
  }
  assert.equal(markdown.serialize(doc), 'first\\\n\\# second')
  assert.deepEqual(markdown.parse('first\\\n\\# second'), doc)
})

test('a line break inside a paragraph is a space, as the page renders it', () => {
  assert.equal(roundTrip('one\ntwo'), 'one two')
  assert.equal(
    roundTrip('1. a long step\n   wrapped onto a second line\n2. next'),
    '1. a long step wrapped onto a second line\n2. next',
  )
})

test('HTML other than <br> reads back as its own characters', () => {
  assert.deepEqual(markdown.parse('call <name> here').content?.[0].content, [
    { type: 'text', text: 'call <name> here' },
  ])
  assert.equal(roundTrip('call <name> here'), 'call &lt;name&gt; here')
  assert.equal(roundTrip('<details>x</details>'), '&lt;details&gt;x&lt;/details&gt;')
})

test('<br> in a table cell is a line break, written back as <br>', () => {
  const source = '| a | b |\n| --- | --- |\n| one<br>two | x\\|y |'
  const cell = markdown.parse(source).content?.[0].content?.[1].content?.[0].content?.[0]
  assert.deepEqual(cell?.content, [{ type: 'text', text: 'one' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }])
  assert.equal(roundTrip(source), source)
})

test('a code block in a numbered step keeps its indentation on every save', () => {
  const source = '1. Run it:\n   ```\n   npm test\n   ```\n2. Read the result.'
  assert.equal(roundTrip(source), source)
  assert.equal(roundTrip(roundTrip(source)), source)
})

test('formatting inside a numbered step is kept', () => {
  assert.equal(roundTrip('1. **bold** and `code`\n2. *em*'), '1. **bold** and `code`\n2. *em*')
})

test('task items keep their boxes', () => {
  assert.equal(roundTrip('- [ ] todo\n- [x] done'), '- [ ] todo\n- [x] done')
})

test('a link whose text is its address is an autolink, written unescaped', () => {
  assert.equal(roundTrip('see <https://example.com/a_b>'), 'see <https://example.com/a_b>')
  assert.equal(roundTrip('[the docs](https://example.com/a_b)'), '[the docs](https://example.com/a_b)')
})

test('empty markdown is an empty paragraph, and an empty paragraph is empty markdown', () => {
  assert.deepEqual(markdown.parse(''), { type: 'doc', content: [{ type: 'paragraph' }] })
  assert.equal(markdown.serialize({ type: 'doc', content: [{ type: 'paragraph' }] }), '')
})

test('a trailing empty paragraph writes no trailing blank lines', () => {
  assert.equal(
    markdown.serialize({ type: 'doc', content: [...(typed('text').content ?? []), { type: 'paragraph' }] }),
    'text',
  )
})

/*
 * A real corpus, when one is named: every markdown file under
 * MARKDOWN_ROUND_TRIP_CORPUS is read and written back twice, and the second
 * pass must change nothing. The first pass may normalise -- that is reviewed
 * once, by hand -- but a document whose markdown keeps changing would rewrite
 * itself on every save.
 */
const corpus = process.env.MARKDOWN_ROUND_TRIP_CORPUS

test('every document in the corpus is stable after one save', {
  skip: corpus ? false : 'MARKDOWN_ROUND_TRIP_CORPUS names no directory of .md files to read',
}, () => {
  assert.ok(corpus && existsSync(corpus), `no directory at ${corpus}`)
  const files = readdirSync(corpus).filter((file) => file.endsWith('.md'))
  assert.ok(files.length > 0, `no .md files in ${corpus}`)
  const unstable = files.filter((file) => {
    const once = roundTrip(readFileSync(join(corpus, file), 'utf8'))
    return roundTrip(once) !== once
  })
  assert.deepEqual(unstable, [], `${unstable.length} of ${files.length} documents change again on a second save`)
})
