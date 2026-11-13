import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { JSONContent } from '@tiptap/core'
import type { Parent, Root, RootContent } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { agentMarkdownConverter } from './agent-markdown'
import { markdownSyntax, remarkLineBreaks } from './markdown-syntax'
import { markdownConverter } from './markdown-editor-schema'

const agent = agentMarkdownConverter()

/**
 * A message as typed into the composer: its text, a line break (Shift+Enter)
 * as a newline, and an empty line between two paragraphs.
 */
function typed(text: string): JSONContent {
  return {
    type: 'doc',
    content: text.split('\n\n').map((paragraph) => ({
      type: 'paragraph',
      content: paragraph
        .split('\n')
        .flatMap((line, index): JSONContent[] => [
          ...(index > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line ? [{ type: 'text', text: line }] : []),
        ]),
    })),
  }
}

/** Whether a link is an address GFM found in the text: its text is the address. */
function isTypedAddress(text: string, url: string): boolean {
  return url === text || url === `http://${text}` || url === `mailto:${text}`
}

/**
 * The text the transcript shows for `markdown`, read the way `Markdown` reads
 * a person's message. Anything drawn as more than text -- emphasis, a heading,
 * a list, a link other than a typed address -- fails, naming what it was.
 */
function transcriptText(markdown: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(markdownSyntax as never)
    .use(remarkLineBreaks)
  const tree = processor.runSync(processor.parse(markdown), markdown) as Root
  const textOf = (node: RootContent): string => {
    switch (node.type) {
      case 'paragraph':
        return node.children.map(textOf).join('')
      case 'text':
        return node.value
      case 'break':
        return '\n'
      case 'link': {
        const text = node.children.map(textOf).join('')
        assert.ok(isTypedAddress(text, node.url), `a link to ${node.url} over ${JSON.stringify(text)}`)
        return text
      }
      default:
        assert.fail(`${JSON.stringify(markdown)} is drawn with a ${node.type}`)
    }
  }
  return tree.children.map(textOf).join('\n\n')
}

/** `doc` without what reading markdown adds and typing doesn't: a typed address's link. */
function asTyped(doc: JSONContent): JSONContent {
  const content = (doc.content ?? []).flatMap((node): JSONContent[] => {
    if (node.type !== 'text') {
      return [asTyped(node)]
    }
    const marks = (node.marks ?? []).filter(
      (mark) => !(mark.type === 'link' && isTypedAddress(node.text ?? '', String(mark.attrs?.href))),
    )
    return [marks.length > 0 ? { ...node, marks } : { type: 'text', text: node.text }]
  })
  // Text nodes that now carry the same marks are one node, as typing makes them.
  const merged = content.reduce<JSONContent[]>((nodes, node) => {
    const last = nodes.at(-1)
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks) === JSON.stringify(node.marks)) {
      nodes[nodes.length - 1] = { ...last, text: `${last.text}${node.text}` }
    } else {
      nodes.push(node)
    }
    return nodes
  }, [])
  return doc.content === undefined ? doc : { ...doc, content: merged }
}

// What a person types, each line a line of its own (Shift+Enter): at least
// every character and line start the transcript's parser reads as syntax.
const TYPED_MESSAGES = [
  'snake_case and 2*3*4 = 24',
  'path/to/file_name.ts:12',
  'see <div> and a & b and </p>',
  'a < b > c and x<y',
  'i<n and a <b and x<y',
  '<div opens a line',
  'text\n<p opens the next',
  '_id alone',
  '_id and _name',
  '_id and snake_case_',
  'http://example.com/a_b_c?x=1&y=2',
  'see https://example.com/_next/_static now',
  'see www.example.com/*a*/~b~/_c_ now',
  'mail _b_c@example.com_ now',
  '[x] [link](text) and [a][b] and ![i](u) and [^1]',
  '~ish and ~one~ and ~~two~~ and 50~60',
  '_x_ and __y__ and snake_case_ and ___',
  'use `code` here and ```three```',
  'x &amp; y &copy; &#123; & z',
  '<https://example.com/x> and mail <a@example.com>',
  'see :icon[star] and :hint[x]{text="y"}',
  'Error:Something and 10:30 and key:value and ::leaf',
  'trailing backslash \\',
  'a \\* b and \\_ and \\\\',
  '50% done | pipe',
  '@alice please look at TASK-12',
  'tab\there',
  '# not a heading',
  '###### also not',
  '- not a list',
  '-5 degrees',
  '+ not a list',
  '1. first',
  '2) second',
  '> not a quote',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  'a | b\n--|--',
  'a | b\n:-|-:',
  'hello\n===',
  'hello\n---',
  'hello\n-',
  '***',
  '```js\ncode\n```',
  '~~~\nfence\n~~~',
  ':::note\nnot a callout\n:::',
  '[a]: https://example.com',
  'line one\nline two\nline three',
  'first paragraph\n\nsecond paragraph',
  '{{ task.key }}: {{ task.summary }}',
  '{{task.key}} and {{ steps.code-review.summary }}\n{{ steps.qa-2.outcome }}',
]

for (const message of TYPED_MESSAGES) {
  test(`typed ${JSON.stringify(message)} reads back as typed, in the transcript and in the editor`, () => {
    const sent = agent.serialize(typed(message))
    assert.equal(transcriptText(sent), message, `sent as ${JSON.stringify(sent)}`)
    assert.deepEqual(asTyped(agent.parse(sent)), typed(message), `sent as ${JSON.stringify(sent)}`)
  })
}

test('plain typing is sent as typed, with no backslashes', () => {
  for (const message of [
    'snake_case and path/to/file_name.ts:12',
    'see a < b and a <= b and a & b and 50~60',
    'for (i = 0; i<n; i++) and x<y and a <b',
    '_id and snake_case',
    'http://example.com/a_b_c?x=1&y=2',
    'see https://example.com/_next/_static and www.example.com/*a*/~b~',
    'the _id at https://example.com/_next and ~5 at www.example.com/~a',
    'Error:Something and 10:30',
    '[x] and [^1] note',
    'line one\nline two',
  ]) {
    assert.equal(agent.serialize(typed(message)), message)
  }
})

test('a line break is sent as a newline, and a stored newline loads as a line break', () => {
  assert.equal(agent.serialize(typed('line one\nline two')), 'line one\nline two')
  assert.deepEqual(agent.parse('line one\nline two'), typed('line one\nline two'))
})

test('stored text with double-brace placeholders loads and saves as it was written', () => {
  // Templates fill `{{ path }}` in after they are saved, so the braces and the path between them must come back unchanged.
  for (const source of [
    '{{task.key}}: {{task.summary}}\n\nRead what **{{steps.review.summary}}** names.\nThen run `npm test`.',
    '{{ task.key }} and {{ steps.code-review.summary }}',
    '- {{task.key}}\n- {{task.summary}}',
    '1. Open {{ task.url }}\n2. Finish with {{ step.name }}',
  ]) {
    assert.equal(agent.serialize(agent.parse(source)), source)
  }
})

test('two lines of a paragraph stay two lines', () => {
  assert.equal(agent.serialize(agent.parse('Read the task.\nThen open the pull request.')), 'Read the task.\nThen open the pull request.')
})

test('a word in angle brackets is written with one backslash, and reads back as typed', () => {
  // `Markdown` drops a tag, so the backslash is what keeps the word on screen; no entity is written.
  assert.equal(agent.serialize(typed('name the <word> here')), 'name the \\<word> here')
  assert.deepEqual(agent.parse('name the \\<word> here'), typed('name the <word> here'))
})

test('an address the editor made a link as it was typed is sent as the address', () => {
  const linked = (text: string, href: string): JSONContent => ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] },
          { type: 'text', text: ' now' },
        ],
      },
    ],
  })
  for (const [text, href] of [
    ['https://example.com/a_b', 'https://example.com/a_b'],
    ['https://example.com/_next/_static', 'https://example.com/_next/_static'],
    ['www.example.com', 'http://www.example.com'],
    ['a@example.com', 'mailto:a@example.com'],
    ['app.py', 'http://app.py'],
  ]) {
    const sent = agent.serialize(linked(text, href))
    assert.equal(sent, `see ${text} now`)
    assert.equal(transcriptText(sent), `see ${text} now`)
  }
})

test('formatting the reader applies is sent as markdown', () => {
  const doc: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'a_b', marks: [{ type: 'code' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        ],
      },
    ],
  }
  assert.equal(agent.serialize(doc), 'a **bold** and `a_b` and [site](https://example.com)')
})

test("the documents' markdown keeps its own escapes", () => {
  // The agent dialect is chosen per editor: a document edited without it is
  // written in the documents' markdown, with entities and backslash escapes.
  assert.equal(markdownConverter().serialize(typed('snake_case <div>')), 'snake\\_case &lt;div&gt;')
  assert.deepEqual(markdownConverter().parse('line one\nline two'), typed('line one line two'))
})

test('without line breaks the transcript reads a single newline as a space', () => {
  // What `Markdown` without `lineBreaks` does, as an agent's reply is read:
  // the reason a person's message is drawn with them.
  const processor = unified()
    .use(remarkParse)
    .use(markdownSyntax as never)
  const tree = processor.runSync(processor.parse('line one\nline two'), 'line one\nline two') as Parent
  const paragraph = tree.children[0] as Parent
  assert.deepEqual(
    paragraph.children.map((node) => node.type),
    ['text'],
  )
})
