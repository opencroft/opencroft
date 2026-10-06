// What the transcript shows for the edit-shaped and skill calls: a line diff
// with added and removed lines marked, the skill named with whether it was
// created or replaced, and a command's output ending in its last lines in the
// preview.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolViewProps } from 'agent-chat/tool-views'
import { renderToStaticMarkup } from 'react-dom/server'
import { askAnswers } from 'ui/tool-views/run-views'
import { skillWriteOutcome } from 'ui/tool-views/skill-views'
import { type ToolViewHost, ToolViewHostProvider } from 'ui/tool-views/tool-view-host'
import { TOOL_VIEWS } from 'ui/tool-views/tool-views'

const host: ToolViewHost = {
  readFile: async () => '',
  readSkill: async () => '',
  describeBackgroundRun: () => undefined,
}

function render(
  tool: string,
  args: Record<string, unknown>,
  result?: ToolViewProps['result'],
  diffs?: ToolViewProps['diffs'],
): string {
  const View = TOOL_VIEWS[tool].body
  return renderToStaticMarkup(
    <ToolViewHostProvider host={host}>
      <View tool={tool} args={args} requestId='request-1' mode='history' result={result} diffs={diffs} />
    </ToolViewHostProvider>,
  )
}

// The markup's text as a reader sees it, without tags or the separators React
// writes between adjacent text nodes.
const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

// The marked lines of a rendered diff, in order, as "+ text" / "- text". A
// line's text may hold the spans that mark its changed words, so it runs to the
// end of its row rather than to the first closing tag.
function markedLines(html: string): string[] {
  return [...html.matchAll(/<span class="sr-only">(added|removed): <\/span><span[^>]*>(.*?)<\/span><\/div>/g)].map(
    ([, kind, text]) => `${kind === 'added' ? '+' : '-'} ${text.replace(/<[^>]*>/g, '')}`,
  )
}

// The text of each word-level mark in a rendered diff, in order, as
// "+ text" / "- text".
function markedWords(html: string): string[] {
  return [...html.matchAll(/<span class="rounded-sm bg-(success|destructive)\/30">([^<]*)<\/span>/g)].map(
    ([, tone, text]) => `${tone === 'success' ? '+' : '-'} ${text}`,
  )
}

test('Edit renders the replaced lines as a diff with its size in the header', () => {
  const html = render(
    'Edit',
    { file_path: 'src/config.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 3' },
    { text: 'ok' },
  )
  assert.deepEqual(markedLines(html), ['- const b = 2', '+ const b = 3'])
  assert.ok(html.includes('src/config.ts'), 'the file is named in the header')
  assert.ok(textOf(html).includes('+1 −1'), 'the header states the diff size')
})

test('a replaced line marks the words that changed, also when unchanged runs around it fold', () => {
  const context = Array.from({ length: 10 }, (_, index) => `const v${index} = ${index}`)
  const html = render(
    'Edit',
    {
      file_path: 'src/config.ts',
      old_string: [...context, 'const b = 2', ...context].join('\n'),
      new_string: [...context, 'const b = 3', ...context].join('\n'),
    },
    { text: 'ok' },
  )
  assert.ok(textOf(html).includes('unchanged lines'), 'the unchanged runs are folded')
  assert.deepEqual(markedLines(html), ['- const b = 2', '+ const b = 3'])
  assert.deepEqual(markedWords(html), ['- 2', '+ 3'])
})

test('a rewritten line is marked whole rather than in part', () => {
  const html = render('Edit', { file_path: 'a.ts', old_string: 'const x = 1', new_string: 'let y = 2' }, { text: 'ok' })
  assert.deepEqual(markedLines(html), ['- const x = 1', '+ let y = 2'])
  assert.deepEqual(markedWords(html), ['- const x = 1', '+ let y = 2'])
})

// The shape claude-agent-acp 0.84.0 sends to a client declaring the AIR
// extension: no replaced text in the arguments, the change only as reported
// diffs — here the two hunks, with their context, of one Edit that changed
// lines 5 and 30 of a 40-line file.
test('Edit renders the diffs the harness reported when its arguments carry no text', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `${index + 1}`)
  const hunk = (at: number, replacement: string) => ({
    path: '/tmp/qa.txt',
    oldText: lines.slice(at - 4, at + 3).join('\n'),
    newText: [...lines.slice(at - 4, at - 1), replacement, ...lines.slice(at, at + 3)].join('\n'),
  })
  const html = render('Edit', { file_path: '/tmp/qa.txt', replace_all: false }, { text: 'ok' }, [
    hunk(5, 'LINE FIVE CHANGED'),
    hunk(30, 'LINE THIRTY CHANGED'),
  ])
  assert.deepEqual(markedLines(html), ['- 5', '+ LINE FIVE CHANGED', '- 30', '+ LINE THIRTY CHANGED'])
  assert.ok(textOf(html).includes('+2 −2'), 'the header states the size of both')
  assert.ok(textOf(html).includes('Change 1 of 2'), 'the parts are the reported regions, not edits')
  assert.ok(!textOf(html).includes('No changes'))
})

test('reported diffs win over the arguments when both are present', () => {
  const html = render('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, { text: 'ok' }, [
    { path: 'a.ts', oldText: 'before\nx', newText: 'before\ny' },
  ])
  assert.deepEqual(markedLines(html), ['- x', '+ y'])
  assert.ok(html.includes('before'), 'the reported context is what is drawn')
})

test('an Edit whose change is neither reported nor in its arguments says so instead of "No changes"', () => {
  const html = render('Edit', { file_path: '/tmp/qa.txt', replace_all: false }, { text: 'ok' })
  assert.ok(textOf(html).includes('The change is not in the transcript.'))
  assert.ok(!textOf(html).includes('No changes'))
  assert.ok(!textOf(html).includes('+0 −0'), 'no diff size is claimed')
})

test('Write renders a reported overwrite as a diff against what the file held', () => {
  const html = render('Write', { file_path: 'notes.md' }, { text: 'ok' }, [
    { path: 'notes.md', oldText: 'old line\nkept', newText: 'new line\nkept' },
  ])
  assert.deepEqual(markedLines(html), ['- old line', '+ new line'])
  assert.ok(textOf(html).includes('+1 −1'))
})

test('Write without a before side renders as a new file, every line added', () => {
  const reported = render('Write', { file_path: 'new.md' }, { text: 'ok' }, [
    { path: 'new.md', oldText: null, newText: 'hello\nworld\n' },
  ])
  assert.deepEqual(markedLines(reported), ['+ hello', '+ world'])
  assert.ok(textOf(reported).includes('+2 −0'))
  assert.deepEqual(markedWords(reported), [], 'an added line with no pair has no word marks')
  const fromArgs = render('Write', { file_path: 'a.md', content: 'body text' }, { text: 'ok' })
  assert.deepEqual(markedLines(fromArgs), ['+ body text'], 'without a report, the arguments are the new file')
})

test('Write whose change is neither reported nor in its arguments says so', () => {
  const html = render('Write', { file_path: 'gone.md' }, { text: 'ok' })
  assert.ok(textOf(html).includes('The change is not in the transcript.'))
  assert.ok(!textOf(html).includes('+0'), 'no diff size is claimed')
})

test('a finished remote_write renders its content as added lines', () => {
  const html = render(
    'remote_write',
    { target: 'node-1/terminal', path: 'notes.md', content: 'one\ntwo' },
    { text: 'ok' },
  )
  assert.deepEqual(markedLines(html), ['+ one', '+ two'])
  assert.ok(textOf(html).includes('+2 −0'))
})

test('MultiEdit renders one diff per edit, numbered', () => {
  const html = render(
    'MultiEdit',
    {
      file_path: 'src/config.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    },
    { text: 'ok' },
  )
  // The dialog holding the full copy is closed, so only the inline preview is
  // in the markup.
  assert.deepEqual(markedLines(html), ['- a', '+ b', '- c', '+ d'])
  assert.ok(textOf(html).includes('Edit 1 of 2'))
  assert.ok(textOf(html).includes('Edit 2 of 2'))
})

test('skill_write names the skill and says it was created, with the body as added lines', () => {
  const html = render(
    'skill_write',
    { name: 'concise-answers', description: 'Keep answers short.', body: 'Answer in two sentences.' },
    { text: 'Skill "concise-answers" created.' },
  )
  assert.ok(html.includes('Create skill'))
  assert.ok(html.includes('concise-answers'))
  assert.ok(html.includes('Keep answers short.'), 'the description is shown')
  assert.deepEqual(markedLines(html), ['+ Answer in two sentences.'])
})

test('skill_write on an existing skill says it was replaced and shows the new body', () => {
  const html = render(
    'skill_write',
    { name: 'concise-answers', description: 'Keep answers short.', body: 'Answer in one sentence.' },
    { text: 'Skill "concise-answers" updated.' },
  )
  assert.ok(html.includes('Update skill'))
  assert.ok(html.includes('Answer in one sentence.'))
  assert.deepEqual(markedLines(html), [], 'the body before the call is not recorded, so there is no diff')
  assert.ok(textOf(html).includes('The previous version was not recorded.'), 'the row says why it shows no diff')
})

test('skill_write outcome is read from the tool answer, and unknown otherwise', () => {
  assert.equal(skillWriteOutcome('Skill "x" created.'), 'created')
  assert.equal(skillWriteOutcome('Skill "x" updated.'), 'updated')
  assert.equal(skillWriteOutcome('Missing required params: name, description, body'), undefined)
  assert.equal(skillWriteOutcome(undefined), undefined)
})

test('skill_edit falls back to the replaced text when the skill cannot be read yet', () => {
  const html = render(
    'skill_edit',
    { name: 'concise-answers', oldString: 'one sentence', newString: 'two sentences' },
    { text: 'Skill "concise-answers" updated.' },
  )
  assert.ok(html.includes('Edit skill'))
  assert.deepEqual(markedLines(html), ['- one sentence', '+ two sentences'])
})

test('remote_exec previews the end of a long output and says how much came before', () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
  const html = render('remote_exec', { target: 'node-1/terminal', command: 'npm test' }, { text: output })
  assert.ok(textOf(html).includes('⋯ 35 earlier lines'), 'the preview says how many lines it left out')
  assert.ok(html.includes('line 36\nline 37\nline 38\nline 39\nline 40'), 'the preview keeps the last lines')
  assert.ok(!html.includes('line 35\n'), 'the preview drops the lines before them')
  assert.ok(html.includes('40 lines'), 'the header states the output size')
})

test('AskUserQuestion records the question and the answer rather than dumping its arguments', () => {
  const html = render(
    'AskUserQuestion',
    { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }] }] },
    { text: 'Blue' },
  )
  assert.ok(html.includes('Colour'))
  assert.ok(html.includes('Which colour?'))
  assert.ok(!html.includes('&quot;options&quot;'), 'the raw arguments are not shown')
})

test('AskUserQuestion still being written shows "Preparing question" with a spinner and no body', () => {
  const html = render('AskUserQuestion', {})
  assert.equal(textOf(html), 'Preparing question')
  assert.ok(html.includes('animate-spin'), 'a spinner sits in the header')
  assert.ok(!html.includes('role="button"'), 'no body block under the header')
})

test('AskUserQuestion that finished without questions shows its reply, not the preparing state', () => {
  const html = render('AskUserQuestion', {}, { text: 'AskUserQuestion called with no valid questions.', isError: true })
  assert.ok(!textOf(html).includes('Preparing'))
  assert.ok(textOf(html).includes('AskUserQuestion called with no valid questions.'))
})

// The reply Claude Code sends back once the card is answered.
const answeredReply = (pairs: string) =>
  `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`

test('AskUserQuestion shows each answer beside its question, not the reply sentence', () => {
  const html = render(
    'AskUserQuestion',
    {
      questions: [
        { question: 'Which colour?', header: 'Colour' },
        { question: 'Which size?', header: 'Size' },
      ],
    },
    { text: answeredReply('"Which colour?"="Blue", "Which size?"="Large"') },
  )
  const text = textOf(html)
  assert.ok(text.includes('Which colour?') && text.includes('Blue'))
  assert.ok(text.includes('Which size?') && text.includes('Large'))
  assert.ok(!text.includes('Your questions have been answered'), 'the reply sentence is not shown')
  assert.ok(text.indexOf('Blue') < text.indexOf('Which size?'), 'each answer sits under its own question')
})

test('AskUserQuestion falls back to the reply as written when it is worded otherwise', () => {
  const html = render(
    'AskUserQuestion',
    { questions: [{ question: 'Which colour?', header: 'Colour' }] },
    {
      text: 'The user answered: Blue.',
    },
  )
  assert.ok(textOf(html).includes('The user answered: Blue.'))
})

test('AskUserQuestion shows the reply as written when only some of its questions can be read out of it', () => {
  const reply = answeredReply('"Which colour?"="Blue"')
  const html = render(
    'AskUserQuestion',
    {
      questions: [
        { question: 'Which colour?', header: 'Colour' },
        { question: 'Which size?', header: 'Size' },
      ],
    },
    { text: reply },
  )
  assert.ok(textOf(html).includes(reply), 'the whole reply is shown, so no answer is lost')
})

test('AskUserQuestion shows the reply as written when a question has only a header', () => {
  const reply = answeredReply('"Colour"="Blue"')
  const html = render('AskUserQuestion', { questions: [{ header: 'Colour' }] }, { text: reply })
  assert.ok(textOf(html).includes(reply))
})

// The CLI quotes nothing it inserts, so the questions the view knows are what
// delimit the items.
test('askAnswers reads unescaped quotes and commas, notes, an unanswered question and the other wording', () => {
  assert.deepEqual(askAnswers(answeredReply('"Say "hi"?"="Yes, "hi"", "Pick"="A, B"'), ['Say "hi"?', 'Pick']), [
    'Yes, "hi"',
    'A, B',
  ])
  assert.deepEqual(
    askAnswers(
      'The user answered: "Size?"=(no option selected) notes: whatever fits, "Colour?"="Blue" selected preview:\n# Blue. Read the answers carefully — they may request clarification.',
      ['Size?', 'Colour?'],
    ),
    ['(no option selected)\nnotes: whatever fits', 'Blue'],
  )
  assert.equal(askAnswers(answeredReply('"Colour?"="Blue"'), ['Colour?', 'Size?']), null, 'a question left out')
  assert.equal(askAnswers('Blue', ['Colour?']), null, 'another wording')
  assert.deepEqual(
    askAnswers(answeredReply('"Again?"="yes", "Again?"="no"'), ['Again?', 'Again?']),
    ['yes', 'no'],
    'two questions with the same text keep their own answers',
  )
})
