// Which presses on an option row pick the option. The whole row does, so a
// reader need not aim at the control; a reference chip or a link in the
// option's text does not, because pressing it opens what it names. Pressing a
// picked single choice again unpicks it, so a custom answer can go alone.
//
// Mounted, because which element a press lands on and what the <label> does
// with it is only decided by a DOM.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { contentToAnswers, questionsToElicitation } from 'agent-client/elicitation-form'
import type { ElicitationContentValue, ElicitationSchema } from 'agent-client/types'

import { installTestDom } from '../test-dom'
import { installMarkdownReferences } from './markdown-references'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let AskUser: typeof import('./ask-user').AskUser

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AskUser } = await import('./ask-user'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

const opened: string[] = []

function installChips() {
  installMarkdownReferences({
    recognisers: [{ kind: 'ticket', match: 'text', pattern: /\bABC-[1-9]\d*\b/ }],
    render: (reference) => (
      <button type='button' data-chip={reference.id} onClick={() => opened.push(reference.id)}>
        {reference.id}
      </button>
    ),
  })
}

afterEach(async () => {
  await unmount()
  installMarkdownReferences(null)
  opened.length = 0
})

const OPTIONS = [
  { const: 'a', title: 'Reopen ABC-1', description: 'Moves ABC-2 back too' },
  { const: 'b', title: 'Leave it' },
]

const SELECT: ElicitationSchema = {
  type: 'object',
  properties: { pick: { type: 'string', title: 'Pick', oneOf: OPTIONS } },
  required: ['pick'],
} as ElicitationSchema

const MULTI: ElicitationSchema = {
  type: 'object',
  properties: { picks: { type: 'array', title: 'Picks', items: { anyOf: OPTIONS } } },
  required: ['picks'],
} as ElicitationSchema

async function mount(schema: ElicitationSchema) {
  await unmount()
  const submitted: Record<string, ElicitationContentValue>[] = []
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<AskUser schema={schema} onSubmit={(content) => submitted.push(content)} />))
  return submitted
}

async function press(element: Element | null) {
  assert.ok(element, 'the element to press is on the page')
  await act(async () => (element as HTMLElement).click())
}

const submit = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit')
const optionLabel = (value: string) => container.querySelector(`label[for$="-${value}"]`)

for (const [kind, schema, key, picked] of [
  ['single choice', SELECT, 'pick', 'a'],
  ['multiple choice', MULTI, 'picks', ['a']],
] as const) {
  test(`${kind}: a reference chip in an option's label or description opens without picking the option`, async () => {
    installChips()
    await mount(schema)
    // Checked after each press: a multiple choice toggles, so a second press
    // that picked would undo the first.
    for (const chip of ['ABC-1', 'ABC-2']) {
      await press(container.querySelector(`[data-chip="${chip}"]`))
      assert.equal(submit()?.disabled, true, `${chip}: nothing is picked, so the required question stays unanswered`)
    }
    assert.deepEqual(opened, ['ABC-1', 'ABC-2'])
  })

  test(`${kind}: a press anywhere else on the option's text picks the option`, async () => {
    installChips()
    const submitted = await mount(schema)
    await press(optionLabel('a')?.querySelector('span') ?? null)
    assert.equal(submit()?.disabled, false)
    await press(submit() ?? null)
    assert.deepEqual(submitted, [{ [key]: picked }])
  })
}

// ── Unpicking a single choice ───────────────────────────────────────────────

// The radio control of an option, found through the hidden input beside it.
const radio = (value: string) =>
  [...container.querySelectorAll('[role="radio"]')].find((control) =>
    control.parentElement?.querySelector(`input[value="${value}"]`),
  ) ?? null

const checkedRadios = () =>
  [...container.querySelectorAll('[role="radio"]')]
    .filter((control) => control.getAttribute('aria-checked') === 'true')
    .map((control) => control.parentElement?.querySelector('input')?.value)

async function pressSpace(element: Element | null) {
  assert.ok(element, 'the control to press Space on is on the page')
  const target = element as HTMLElement
  await act(async () => {
    target.focus()
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    target.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }))
  })
}

async function type(input: Element | null | undefined, text: string) {
  assert.ok(input instanceof window.HTMLInputElement, 'the text box is on the page')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, text)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const customBox = () => container.querySelector('input[placeholder="Custom answer (optional)"]')

for (const [way, pressOption] of [
  ['its row', (value: string) => press(optionLabel(value)?.querySelector('span') ?? null)],
  ['its control', (value: string) => press(radio(value))],
  ['Space on its control', (value: string) => pressSpace(radio(value))],
] as const) {
  test(`single choice: pressing the picked option again by ${way} unpicks it`, async () => {
    await mount(SELECT)
    await pressOption('a')
    assert.deepEqual(checkedRadios(), ['a'])
    assert.equal(submit()?.disabled, false)

    await pressOption('a')
    assert.deepEqual(checkedRadios(), [])
    assert.equal(submit()?.disabled, true, 'the required question is unanswered again')

    await pressOption('a')
    assert.deepEqual(checkedRadios(), ['a'], 'a third press picks it again')
  })
}

test('single choice: pressing another option moves the pick rather than clearing it', async () => {
  const submitted = await mount(SELECT)
  await press(radio('a'))
  await press(optionLabel('b')?.querySelector('span') ?? null)
  assert.deepEqual(checkedRadios(), ['b'])
  await press(submit() ?? null)
  assert.deepEqual(submitted, [{ pick: 'b' }])
})

const ONE_QUESTION = [{ title: 'Ship', question: 'Ship it?', options: ['Yes', 'No'] }]

test('single choice with a custom box: unpicking the option sends the custom answer alone', async () => {
  const { schema } = questionsToElicitation(ONE_QUESTION)
  const submitted = await mount(schema)
  await press(radio('Yes'))
  await type(customBox(), 'After the freeze')
  await press(radio('Yes'))
  assert.deepEqual(checkedRadios(), [])
  await press(submit() ?? null)
  assert.deepEqual(submitted, [{ question_0_custom: 'After the freeze' }])
  assert.deepEqual(contentToAnswers(ONE_QUESTION, submitted[0]), { Ship: 'After the freeze' })
})

test('single choice with a custom box: a kept pick and the custom answer are sent together', async () => {
  const { schema } = questionsToElicitation(ONE_QUESTION)
  const submitted = await mount(schema)
  await press(radio('Yes'))
  await type(customBox(), 'After the freeze')
  await press(submit() ?? null)
  assert.deepEqual(submitted, [{ question_0: 'Yes', question_0_custom: 'After the freeze' }])
})

test('a required single choice is answered by its custom box alone', async () => {
  const submitted = await mount({
    type: 'object',
    properties: {
      pick: { type: 'string', title: 'Pick', oneOf: OPTIONS },
      pick_note: { type: 'string', title: 'Note', _meta: { codex: { questionId: 'pick', role: 'user_note' } } },
    },
    required: ['pick'],
  } as ElicitationSchema)
  await press(radio('a'))
  await press(radio('a'))
  assert.equal(submit()?.disabled, true)
  await type(customBox(), 'Neither')
  assert.equal(submit()?.disabled, false)
  await press(submit() ?? null)
  assert.deepEqual(submitted, [{ pick_note: 'Neither' }])
})

test('several questions: unpicking one question leaves the other tabs picks alone', async () => {
  const questions = [
    { title: 'Ship', question: 'Ship it?', options: ['Yes', 'No'] },
    { title: 'Notify', question: 'Tell the team?', options: ['Yes', 'No'] },
  ]
  const submitted = await mount(questionsToElicitation(questions).schema)
  // A tab's text is its title, after a check mark once the question is answered.
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.endsWith(text)) ?? null
  await press(radio('Yes'))
  await press(button('Next'))
  await press(radio('Yes'))
  await press(button('Ship'))
  assert.deepEqual(checkedRadios(), ['Yes'], 'the first tab still shows its pick')
  await press(radio('Yes'))
  assert.deepEqual(checkedRadios(), [])
  await press(button('Notify'))
  assert.deepEqual(checkedRadios(), ['Yes'], 'the second tab keeps its own pick')
  await press(submit() ?? null)
  assert.deepEqual(submitted, [{ question_1: 'Yes' }])
})

// ── Focus never changes the answer ──────────────────────────────────────────

// A radio clicks itself when it takes focus after an Arrow key in its group.
// With one option an Arrow moves focus nowhere, so that request is still
// pending the next time focus arrives, from anywhere.

const ONE_OPTION: ElicitationSchema = {
  type: 'object',
  properties: { pick: { type: 'string', title: 'Pick', oneOf: [OPTIONS[0]] } },
} as ElicitationSchema

async function arrowDown(element: Element | null, modifiers: { ctrlKey?: boolean } = {}) {
  assert.ok(element, 'the element to press ArrowDown on is on the page')
  await act(async () => {
    ;(element as HTMLElement).focus()
    element.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true, ...modifiers }),
    )
  })
}

// A press on an option's text the way a browser delivers it: activating the
// label focuses the control it names, the radio's hidden input, before the
// click. The test DOM skips that focus, so it is made here.
async function pressTextLikeABrowser(value: string) {
  const input = container.querySelector(`input[type="radio"][value="${value}"]`)
  assert.ok(input instanceof window.HTMLInputElement, 'the radio input is on the page')
  await act(async () => input.focus())
  await press(optionLabel(value)?.querySelector('span') ?? null)
}

async function focusFromOutside(element: Element | null) {
  assert.ok(element, 'the element to focus is on the page')
  await act(async () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    ;(element as HTMLElement).focus()
  })
}

test('one option: focus coming back after an Arrow press leaves a pick in place', async () => {
  await mount(ONE_OPTION)
  await press(radio('a'))
  await arrowDown(radio('a'))
  await focusFromOutside(radio('a'))
  assert.deepEqual(checkedRadios(), ['a'])
  await press(radio('a'))
  assert.deepEqual(checkedRadios(), [], 'a press still unpicks it')
})

test('one option: focus coming back after an Arrow press on a chip in its text leaves a pick in place', async () => {
  installChips()
  await mount(ONE_OPTION)
  await press(radio('a'))
  await arrowDown(container.querySelector('[data-chip="ABC-1"]'))
  await focusFromOutside(radio('a'))
  assert.deepEqual(checkedRadios(), ['a'])
})

test('one option: focus coming back after an Arrow press does not pick it', async () => {
  await mount(ONE_OPTION)
  await arrowDown(radio('a'))
  await focusFromOutside(radio('a'))
  assert.deepEqual(checkedRadios(), [])
})

test('single choice: focus coming back after Ctrl+ArrowDown leaves a pick in place', async () => {
  await mount(SELECT)
  await press(radio('a'))
  await arrowDown(radio('a'), { ctrlKey: true })
  assert.deepEqual(checkedRadios(), ['a'], 'Ctrl+ArrowDown moves nothing')
  await focusFromOutside(radio('a'))
  assert.deepEqual(checkedRadios(), ['a'])
})

test('single choice: after Ctrl+ArrowDown, a press on another option text picks that option', async () => {
  await mount(SELECT)
  await press(radio('a'))
  await arrowDown(radio('a'), { ctrlKey: true })
  await pressTextLikeABrowser('b')
  assert.deepEqual(checkedRadios(), ['b'])
})

test('one option: after an Arrow press, a press on its text picks it', async () => {
  await mount(ONE_OPTION)
  await arrowDown(radio('a'))
  await pressTextLikeABrowser('a')
  assert.deepEqual(checkedRadios(), ['a'])
})

test('single choice: an Arrow that lands on the picked option keeps it picked', async () => {
  await mount(SELECT)
  // Picked without focus, so the group's Arrow navigation still starts from
  // the first option.
  await press(radio('b'))
  await arrowDown(radio('a'))
  assert.deepEqual(checkedRadios(), ['b'])
})

test('single choice: an Arrow key still moves the pick to the next option', async () => {
  await mount(SELECT)
  await press(radio('a'))
  await arrowDown(radio('a'))
  assert.deepEqual(checkedRadios(), ['b'])
  await arrowDown(radio('b'))
  assert.deepEqual(checkedRadios(), ['a'], 'and wraps around to the first')
})
