import assert from 'node:assert/strict'
import { test } from 'node:test'

import { type MarkdownDiffItem, markdownBlocks, markdownDiff } from './markdown-diff'

test('a document splits into its top-level blocks, each the markdown it was written with', () => {
  const doc = [
    '# Title',
    '',
    'A paragraph with **bold**',
    'across two lines.',
    '',
    '- one',
    '- two',
    '',
    '```ts',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    ':::note',
    'Inside a callout.',
    '',
    'Still inside.',
    ':::',
  ].join('\n')
  assert.deepEqual(markdownBlocks(doc).blocks, [
    '# Title',
    'A paragraph with **bold**\nacross two lines.',
    '- one\n- two',
    '```ts\nconst a = 1\n\nconst b = 2\n```',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    ':::note\nInside a callout.\n\nStill inside.\n:::',
  ])
})

test('link definitions are kept apart from the blocks, for every block to be drawn with', () => {
  const { blocks, definitions } = markdownBlocks('See [the guide][g].\n\n[g]: https://example.com/guide\n\nMore.')
  assert.deepEqual(blocks, ['See [the guide][g].', 'More.'])
  assert.equal(definitions, '[g]: https://example.com/guide')
})

const diff = (before: string, after: string, context?: number) =>
  markdownDiff(markdownBlocks(before), markdownBlocks(after), context)

test('two equal documents have no changes', () => {
  assert.deepEqual(diff('# A\n\nText.', '# A\n\nText.'), [])
})

// The same page as an editor saves it: paragraphs unwrapped, an underscore in a
// heading escaped, a table's cells padded and its delimiter row respaced.
const written = [
  '### list_extensions',
  '',
  'Agents that behave identically may spell the same mode',
  'differently (`acceptEdits` vs',
  '`accept_edits`), leaving a **UI nothing',
  'stable** to attach an icon to.',
  '',
  '| | Tool |',
  '|---|---|',
  '| | `get_extension` |',
  '',
  '```json',
  '{ "name":  "create_extension" }',
  '```',
].join('\n')
const saved = [
  '### list\\_extensions',
  '',
  'Agents that behave identically may spell the same mode differently (`acceptEdits` vs `accept_edits`), leaving a **UI nothing stable** to attach an icon to.',
  '',
  '|  | Tool |',
  '| --- | --- |',
  '|  | `get_extension` |',
  '',
  '```json',
  '{ "name":  "create_extension" }',
  '```',
].join('\n')

test('a block spelled differently but drawn the same is unchanged', () => {
  assert.deepEqual(diff(written, saved), [])
})

test('an unchanged block is drawn as the later version spells it', () => {
  const items = diff(`# Title\n\n${written}`, `# Title, renamed\n\n${saved}`, 4)
  assert.deepEqual(items[0], { kind: 'pair', removed: '# Title', added: '# Title, renamed' })
  assert.deepEqual(
    items.slice(1),
    markdownBlocks(saved).blocks.map((block) => ({ kind: 'same', block })),
  )
})

test("whitespace a code block draws is a change, and so is a line break's kind", () => {
  const code = (body: string) => `\`\`\`json\n${body}\n\`\`\``
  assert.equal(diff(code('{ "a":  1 }'), code('{ "a": 1 }')).length, 1)
  // A hard break (two trailing spaces) draws a new line; a soft one does not.
  assert.equal(diff('one  \ntwo', 'one two').length, 1)
})

test('a changed block is a pair of its two versions, between the unchanged blocks around it', () => {
  assert.deepEqual(diff('# A\n\nOpens at eight.\n\nEnd.', '# A\n\nOpens at nine.\n\nEnd.'), [
    { kind: 'same', block: '# A' },
    { kind: 'pair', removed: 'Opens at eight.', added: 'Opens at nine.' },
    { kind: 'same', block: 'End.' },
  ])
})

test('a run of changes pairs removed with added in order; the blocks left over stand alone', () => {
  assert.deepEqual(diff('Keep.\n\nOld one.\n\nOld two.', 'Keep.\n\nNew one.'), [
    { kind: 'same', block: 'Keep.' },
    { kind: 'pair', removed: 'Old one.', added: 'New one.' },
    { kind: 'removed', block: 'Old two.' },
  ])
  assert.deepEqual(diff('Keep.', 'Keep.\n\nAdded.'), [
    { kind: 'same', block: 'Keep.' },
    { kind: 'added', block: 'Added.' },
  ])
})

test('an empty earlier version is a new document: every block is added', () => {
  assert.deepEqual(diff('', '# New\n\nText.'), [
    { kind: 'added', block: '# New' },
    { kind: 'added', block: 'Text.' },
  ])
})

test('a long unchanged run folds, keeping `context` blocks beside the change', () => {
  const before = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Old.'].join('\n\n')
  const after = ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'New.'].join('\n\n')
  assert.deepEqual(diff(before, after, 1), [
    { kind: 'fold', blocks: ['One.', 'Two.', 'Three.', 'Four.'] },
    { kind: 'same', block: 'Five.' },
    { kind: 'pair', removed: 'Old.', added: 'New.' },
  ])
})

// The parts of a diff that is one block drawn in parts.
const partsOf = (items: MarkdownDiffItem[]): MarkdownDiffItem[] => {
  const [only, ...rest] = items
  assert.equal(rest.length, 0)
  assert.equal(only?.kind, 'parts')
  return only.kind === 'parts' ? only.parts : []
}

test('a changed code block is the line diff of its code, with each version fence', () => {
  const code = (body: string) => `\`\`\`ts\n${body}\n\`\`\``
  assert.deepEqual(diff(code('const a = 1\nconst b = 2'), code('const a = 1\nconst b = 3')), [
    {
      kind: 'code',
      removed: 'const a = 1\nconst b = 2',
      added: 'const a = 1\nconst b = 3',
      fence: { removed: 'ts', added: 'ts' },
    },
  ])
})

test('a code block whose language or meta changed is the line diff of its code, with the change of its fence', () => {
  assert.deepEqual(diff('```yaml\na: 1\n```', '```json\n{ "a": 1 }\n```'), [
    { kind: 'code', removed: 'a: 1', added: '{ "a": 1 }', fence: { removed: 'yaml', added: 'json' } },
  ])
  assert.deepEqual(diff('```yaml\na: 1\n```', '```json\na: 1\n```'), [
    { kind: 'code', removed: 'a: 1', added: 'a: 1', fence: { removed: 'yaml', added: 'json' } },
  ])
  assert.deepEqual(diff('```ts\nconst a = 1\n```', '```ts title="a.ts"\nconst a = 2\n```'), [
    { kind: 'code', removed: 'const a = 1', added: 'const a = 2', fence: { removed: 'ts', added: 'ts title="a.ts"' } },
  ])
  assert.deepEqual(diff('```\nplain\n```', '```sh\nplain\n```'), [
    { kind: 'code', removed: 'plain', added: 'plain', fence: { removed: '', added: 'sh' } },
  ])
})

test('a code block that became a diagram, or stopped being one, is a pair', () => {
  const pair = (before: string, after: string) => [{ kind: 'pair', removed: before, added: after }]
  assert.deepEqual(diff('```text\nA --> B\n```', '```mermaid\nA --> B\n```'), pair('```text\nA --> B\n```', '```mermaid\nA --> B\n```'))
  assert.deepEqual(diff('```mermaid\nA --> B\n```', '```text\nA --> B\n```'), pair('```mermaid\nA --> B\n```', '```text\nA --> B\n```'))
})

test('a changed diagram is a pair, drawn as its two pictures rather than its source', () => {
  const before = '```mermaid\ngraph TD\n  A --> B\n```'
  const after = '```mermaid\ngraph TD\n  A --> C\n```'
  assert.deepEqual(diff(before, after), [{ kind: 'pair', removed: before, added: after }])
})

test('a changed list marks only the items that changed, the unchanged ones drawn as runs', () => {
  const list = (third: string) => ['- one', '- two', `- ${third}`, '- four', '- five'].join('\n')
  assert.deepEqual(diff(list('three'), list('three, changed')), [
    {
      kind: 'parts',
      of: 'items',
      parts: [
        { kind: 'same', block: '- one\n- two' },
        { kind: 'pair', removed: '- three', added: '- three, changed' },
        { kind: 'same', block: '- four\n- five' },
      ],
    },
  ])
})

test('an item added to or removed from a list is that item alone', () => {
  assert.deepEqual(diff('- one\n- two\n- three', '- one\n- three\n- four'), [
    {
      kind: 'parts',
      of: 'items',
      parts: [
        { kind: 'same', block: '- one' },
        { kind: 'removed', block: '- two' },
        { kind: 'same', block: '- three' },
        { kind: 'added', block: '- four' },
      ],
    },
  ])
})

test('an item of an ordered list keeps its number when drawn on its own', () => {
  const parts = partsOf(diff('1. one\n2. two\n3. three', '1. one\n2. two\n3. three!'))
  assert.deepEqual(parts[1], { kind: 'pair', removed: '3. three', added: '3. three!' })
})

test('a change in a nested list draws the item above it once, with the nested change under it', () => {
  const before = ['- fruit', '  - apples', '  - pears', '- nuts'].join('\n')
  const after = ['- fruit', '  - apples', '  - plums', '- nuts'].join('\n')
  assert.deepEqual(diff(before, after), [
    {
      kind: 'parts',
      of: 'items',
      parts: [
        {
          kind: 'nested',
          head: '- fruit',
          parts: [
            { kind: 'same', block: '- apples' },
            { kind: 'pair', removed: '- pears', added: '- plums' },
          ],
        },
        { kind: 'same', block: '- nuts' },
      ],
    },
  ])
})

test('a list that changed only in how it holds its items is one pair', () => {
  // Loose items draw as paragraphs; no single item differs.
  assert.deepEqual(diff('- one\n- two', '- one\n\n- two'), [{ kind: 'pair', removed: '- one\n- two', added: '- one\n\n- two' }])
})

// What a run of a loose list's items is drawn with: a definition after a blank
// line in its last item, at that item's content column, which draws nothing and
// keeps the run loose.
const loose = (run: string, indent = 2, label = 'loose-list-item') => `${run}\n\n${' '.repeat(indent)}[${label}]: #`

test('a changed item of a loose list is drawn alone, as loose as in its list', () => {
  assert.deepEqual(diff('- one\n\n- two\n\n- three', '- one\n\n- 2\n\n- three'), [
    {
      kind: 'parts',
      of: 'items',
      parts: [
        { kind: 'same', block: loose('- one') },
        { kind: 'pair', removed: loose('- two'), added: loose('- 2') },
        { kind: 'same', block: loose('- three') },
      ],
    },
  ])
})

test('an item added to a loose list is that item alone, as loose as in its list', () => {
  assert.deepEqual(partsOf(diff('- one\n\n- two', '- one\n\n- two\n\n- three')), [
    { kind: 'same', block: loose('- one\n\n- two') },
    { kind: 'added', block: loose('- three') },
  ])
})

test('an item of a loose ordered list keeps its number and its looseness, the definition at its content column', () => {
  const parts = partsOf(diff('9. nine\n\n10. ten', '9. nine\n\n10. ten!'))
  assert.deepEqual(parts[1], { kind: 'pair', removed: loose('10. ten', 4), added: loose('10. ten!', 4) })
})

test('an item of a loose task list is drawn alone, the definition at its content column, not past its checkbox', () => {
  assert.deepEqual(partsOf(diff('- [ ] one\n\n- [x] two\n\n- [ ] three', '- [ ] one\n\n- [x] 2\n\n- [ ] three')), [
    { kind: 'same', block: loose('- [ ] one') },
    { kind: 'pair', removed: loose('- [x] two'), added: loose('- [x] 2') },
    { kind: 'same', block: loose('- [ ] three') },
  ])
})

test('an item added to a loose task list is that item alone, as loose as in its list', () => {
  assert.deepEqual(partsOf(diff('- [ ] one\n\n- [x] two', '- [ ] one\n\n- [x] two\n\n- [ ] three')), [
    { kind: 'same', block: loose('- [ ] one\n\n- [x] two') },
    { kind: 'added', block: loose('- [ ] three') },
  ])
})

test('a list loose through one item draws its tight-written items loose', () => {
  // The second item's two paragraphs make the whole list loose.
  const before = '- one\n- two\n\n  more\n- three'
  const after = '- one\n- two\n\n  more\n- 3'
  assert.deepEqual(partsOf(diff(before, after)), [
    { kind: 'same', block: loose('- one\n- two\n\n  more') },
    { kind: 'pair', removed: loose('- three'), added: loose('- 3') },
  ])
})

test('the definition takes a label the document does not use', () => {
  const doc = (last: string) => `- see [loose-list-item]\n\n- ${last}\n\n[loose-list-item]: https://example.com`
  assert.deepEqual(partsOf(diff(doc('old'), doc('new')))[1], {
    kind: 'pair',
    removed: loose('- old', 2, 'loose-list-item-2'),
    added: loose('- new', 2, 'loose-list-item-2'),
  })
})

test('an item loose in itself draws its text once, as a paragraph, with its nested change under it', () => {
  // The blank line makes the item, and so its list, loose: its text is a
  // paragraph, and so is the text drawn above the nested change.
  const before = '- fruit\n\n  - apples\n  - pears'
  const after = '- fruit\n\n  - apples\n  - plums'
  assert.deepEqual(partsOf(diff(before, after)), [
    {
      kind: 'nested',
      head: loose('- fruit'),
      parts: [
        { kind: 'same', block: '- apples' },
        { kind: 'pair', removed: '- pears', added: '- plums' },
      ],
    },
  ])
})

test('an item with a reference link is narrowed, drawn with its link definitions', () => {
  const doc = (last: string) => `- see [the guide][g]\n- ${last}\n\n[g]: https://example.com/guide`
  assert.deepEqual(partsOf(diff(doc('old'), doc('new'))), [
    { kind: 'same', block: '- see [the guide][g]' },
    { kind: 'pair', removed: '- old', added: '- new' },
  ])
})

test('a paragraph with hard breaks marks only the lines that changed', () => {
  assert.deepEqual(diff('Opens at eight\\\nCloses at dusk\\\nNo dogs', 'Opens at nine\\\nCloses at dusk\\\nNo dogs'), [
    {
      kind: 'parts',
      of: 'lines',
      parts: [
        { kind: 'pair', removed: 'Opens at eight', added: 'Opens at nine' },
        { kind: 'same', block: 'Closes at dusk\\\nNo dogs' },
      ],
    },
  ])
})

test('a paragraph whose line would draw as another block on its own is one pair', () => {
  // `2. ` cannot start a list inside a paragraph, but it does on a line of its own.
  const before = 'Steps\\\n2. pick'
  const after = 'Steps\\\n2. pick all'
  assert.deepEqual(diff(before, after), [{ kind: 'pair', removed: before, added: after }])
})
