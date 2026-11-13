// A code block names its fence's language in a strip of its own over the code,
// names nothing when the fence names nothing, copies and downloads only its
// code, and folds long lines when asked.

import assert from 'node:assert/strict'
import { afterEach, before, mock, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let CodeBlock: typeof import('./code-block').CodeBlock
let codeFileName: typeof import('./code-block').codeFileName
let Markdown: typeof import('./markdown').Markdown

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CodeBlock, codeFileName } = await import('./code-block'))
  ;({ Markdown } = await import('./markdown'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

async function mount(element: import('react').ReactElement): Promise<HTMLElement> {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(element))
  const frame = container.querySelector<HTMLElement>('[data-code-frame]')
  assert.ok(frame, 'the block is drawn in its frame')
  return frame
}

test('a block whose fence names a language shows it over the code, out of the selection', async () => {
  // `hcl` has no grammar, so the block stays the plain `pre` it first renders.
  const frame = await mount(<CodeBlock code={'bucket = "logs"'} language='hcl {1}' />)
  const label = frame.querySelector<HTMLElement>('[data-code-label]')
  assert.ok(label, 'the block has a label')
  assert.equal(label.textContent, 'hcl')
  assert.equal(label.getAttribute('contenteditable'), 'false')
  assert.ok(label.classList.contains('select-none'))
  // A strip of its own before the code, not a tag inside it.
  const pre = frame.querySelector('pre')
  assert.ok(pre && label.compareDocumentPosition(pre) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.equal(pre.contains(label), false)
  assert.equal(pre.textContent, 'bucket = "logs"')
})

test('a block whose fence names no language has no label', async () => {
  const frame = await mount(<CodeBlock code='plain text' />)
  assert.equal(frame.querySelector('[data-code-label]'), null)
  assert.equal(frame.querySelector('pre')?.textContent, 'plain text')
})

test('copy puts the code on the clipboard, without its label', async () => {
  const copied: string[] = []
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  try {
    const frame = await mount(<CodeBlock code={'line one\nline two'} language='hcl' />)
    const copy = frame.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')
    assert.ok(copy, 'the block offers a copy control')
    await act(async () => copy.click())
    assert.deepEqual(copied, ['line one\nline two'])
  } finally {
    if (clipboard) {
      Object.defineProperty(window.navigator, 'clipboard', clipboard)
    } else {
      delete (window.navigator as { clipboard?: unknown }).clipboard
    }
  }
})

function actionLabels(frame: HTMLElement): (string | null)[] {
  return [...frame.querySelectorAll('[data-code-actions] button')].map((button) => button.getAttribute('aria-label'))
}

test('the controls read Wrap, Download, Copy from left to right, with or without a label', async () => {
  let frame = await mount(<CodeBlock code='x' language='ts' />)
  assert.deepEqual(actionLabels(frame), ['Wrap lines', 'Download snippet.ts', 'Copy code'])
  await act(async () => root?.unmount())
  frame = await mount(<CodeBlock code='x' />)
  assert.equal(frame.querySelector('[data-code-label]'), null)
  assert.deepEqual(actionLabels(frame), ['Wrap lines', 'Download snippet.txt', 'Copy code'])
})

test('a block that is not copyable keeps the wrap toggle and offers no download', async () => {
  const frame = await mount(<CodeBlock code='x' language='ts' copyable={false} />)
  assert.deepEqual(actionLabels(frame), ['Wrap lines'])
})

test('the download name comes from the file the fence names, else from its language', () => {
  assert.equal(codeFileName('ts'), 'snippet.ts')
  assert.equal(codeFileName('py'), 'snippet.py')
  assert.equal(codeFileName('python'), 'snippet.py')
  assert.equal(codeFileName('sh'), 'snippet.sh')
  assert.equal(codeFileName('bash'), 'snippet.sh')
  assert.equal(codeFileName('console'), 'snippet.sh')
  assert.equal(codeFileName('shellsession'), 'snippet.sh')
  assert.equal(codeFileName('hcl {1}'), 'snippet.hcl')
  assert.equal(codeFileName(undefined), 'snippet.txt')
  assert.equal(codeFileName('objective-c'), 'snippet.txt')
  assert.equal(codeFileName('ts title="src/app.ts"'), 'app.ts')
  assert.equal(codeFileName("ts title='my app.ts'"), 'my app.ts')
  assert.equal(codeFileName('py filename=run.py'), 'run.py')
  assert.equal(codeFileName('ts title=""'), 'snippet.ts')
})

test('download saves exactly the code as a blob, under the block name, and frees the URL later', async () => {
  const saved: { blob: Blob; name: string; href: string }[] = []
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  const anchor = window.HTMLAnchorElement.prototype
  mock.method(URL, 'createObjectURL', (blob: Blob) => {
    const url = `blob:test/${blobs.size}`
    blobs.set(url, blob)
    return url
  })
  mock.method(URL, 'revokeObjectURL', (url: string) => void revoked.push(url))
  mock.method(anchor, 'click', function (this: HTMLAnchorElement) {
    const blob = blobs.get(this.href)
    assert.ok(blob, 'the link points at the blob that was made')
    saved.push({ blob, name: this.download, href: this.href })
  })
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const frame = await mount(<CodeBlock code={'line one\n  line two\n'} language='ts title="src/app.ts"' />)
    const download = frame.querySelector<HTMLButtonElement>('button[aria-label="Download app.ts"]')
    assert.ok(download, 'the block offers a download named after its file')
    download.click()
    assert.equal(saved.length, 1)
    assert.equal(saved[0].name, 'app.ts')
    assert.equal(await saved[0].blob.text(), 'line one\n  line two\n')
    assert.deepEqual(revoked, [], 'the URL lives while the browser reads it')
    mock.timers.tick(40_000)
    assert.deepEqual(revoked, [saved[0].href])
  } finally {
    mock.timers.reset()
    mock.restoreAll()
  }
})

test('wrap folds the block when pressed and unfolds it when pressed again', async () => {
  const frame = await mount(<CodeBlock code={'a very long line'} language='hcl' />)
  const wrap = frame.querySelector<HTMLButtonElement>('button[aria-label="Wrap lines"]')
  assert.ok(wrap)
  const folds = () => frame.className.split(' ').includes('[&_pre]:whitespace-pre-wrap')
  assert.equal(wrap.getAttribute('aria-pressed'), 'false')
  assert.equal(folds(), false, 'off by default')
  await act(async () => wrap.click())
  assert.equal(wrap.getAttribute('aria-pressed'), 'true')
  assert.equal(folds(), true)
  await act(async () => wrap.click())
  assert.equal(wrap.getAttribute('aria-pressed'), 'false')
  assert.equal(folds(), false)
})

test('markdown hands the block the file its fence names, and keeps the language as the label', async () => {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<Markdown text={'```ts title="src/app.ts"\nconst a = 1\n```'} />))
  const frame = container.querySelector<HTMLElement>('[data-code-frame]')
  assert.ok(frame)
  assert.equal(frame.querySelector('[data-code-label]')?.textContent, 'ts')
  assert.ok(frame.querySelector('button[aria-label="Download app.ts"]'))
  assert.equal(frame.querySelector('pre')?.textContent, 'const a = 1')
})
