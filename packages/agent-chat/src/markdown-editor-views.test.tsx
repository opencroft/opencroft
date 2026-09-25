import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { installTestDom } from './test-dom'

// The mounted editor, not a headless one: these tests are about what the
// block views draw and what their controls write back, which only exists once
// React has rendered them.
let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ MarkdownEditor } = await import('./markdown-editor'))
  ;({ createRoot } = await import('react-dom/client'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

/**
 * Mount a fresh editor on `markdown` and collect what it reports. Fresh each
 * time: an editor kept between tests would carry its caret, and with it which
 * tab it shows, from one test into the next.
 */
async function mount(markdown: string): Promise<string[]> {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  await act(async () => {
    next.render(<MarkdownEditor value={markdown} onChange={(value) => changes.push(value)} />)
  })
  // The editor is created after the first render, and its node views after that.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return changes
}

/** Change an input the way a person typing does, so React's onChange fires. */
async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('the toolbar ends with the Blocks menu, after the buttons it already had', async () => {
  await mount('text')
  const buttons = [...container.querySelectorAll('button')]
  const titles = buttons.map((button) => button.getAttribute('title'))
  assert.ok(titles.includes('Insert table'), 'the existing table button stays')
  assert.ok(titles.includes('Horizontal rule'), 'the existing rule button stays')
  assert.equal(titles.at(-1), 'Insert a block')
  assert.match(buttons.at(-1)?.textContent ?? '', /Blocks/)
})

test('a callout draws as the kit callout, and its title field writes the title back', async () => {
  const changes = await mount(':::warning{title="Before"}\nBody.\n:::')
  const title = container.querySelector<HTMLInputElement>('input[aria-label="Callout title"]')
  assert.ok(title, 'the callout heading is an input')
  assert.equal(title.value, 'Before')
  assert.ok(container.querySelector('[role="note"]'))
  await typeInto(title, 'After')
  assert.equal(changes.at(-1), ':::warning{title="After"}\nBody.\n\n:::')
})

test('a spoiler is drawn open, with its summary as a field that writes back', async () => {
  const changes = await mount(':::details{summary="Log"}\nline\n:::')
  assert.equal(container.querySelector('details'), null, 'not a collapsible while being edited')
  const summary = container.querySelector<HTMLInputElement>('input[aria-label="Spoiler summary"]')
  assert.equal(summary?.value, 'Log')
  assert.match(container.textContent ?? '', /line/)
  if (summary) {
    await typeInto(summary, 'Full log')
  }
  assert.equal(changes.at(-1), ':::details{summary="Full log"}\nline\n\n:::')
})

test('tabs draw a strip of their labels, and + adds a tab', async () => {
  const changes = await mount('::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  assert.deepEqual(labels, ['npm', 'pnpm'])
  const add = container.querySelector<HTMLButtonElement>('button[aria-label="Add tab"]')
  assert.ok(add)
  await act(async () => {
    add.click()
  })
  assert.match(changes.at(-1) ?? '', /:::tab\{label="Tab 3"\}/)
})

test('a page opens on the first tab of its tabs, wherever loading left the caret', async () => {
  await mount('Intro.\n\n::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const selected = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('aria-selected'))
  assert.deepEqual(selected, ['true', 'false'])
})

test('the selected tab can be removed, and the one that takes its place is shown', async () => {
  const changes = await mount('::::tabs\n:::tab{label="npm"}\na\n:::\n:::tab{label="pnpm"}\nb\n:::\n::::')
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove tab npm"]')
  assert.ok(remove, 'the first tab is selected, and it carries the remove control')
  await act(async () => {
    remove.click()
  })
  assert.equal(changes.at(-1), '::::tabs\n:::tab{label="pnpm"}\nb\n\n:::\n\n::::')
  const labels = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
  assert.deepEqual(labels, ['pnpm'])
  assert.equal(container.querySelector('button[title="Remove tab"]'), null, 'no remove control on the last tab')
})
