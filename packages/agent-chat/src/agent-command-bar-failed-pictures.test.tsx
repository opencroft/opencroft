// A picture that could not be attached, from the moment it fails to the
// moment the message (or the edit) is sent.
//
// A failed picture has no stored id, so a send that went ahead would carry the
// others and drop it without a word: its reason lived on the chip, and the chip
// is cleared with the composer. These pin the opposite: the composer says which
// picture failed and why as soon as it fails, a send or commit is refused while
// it is there, the reader's words stay, and the notice goes with the picture.
// An edit is covered through both of its controls, Enter in the composer and
// the Commit button, since either one is how a reader saves it.
//
// Mounted, because the refusal is the hook's and the words are put back into
// the kit bar, which only a real commit shows.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { AgentCommandBarSession, UseAgentCommandBarOptions } from './agent-command-bar'
import { installTestDom } from './test-dom'
import { failedPicturesNotice } from './use-composer-pictures'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let useAgentCommandBar: typeof import('./agent-command-bar').useAgentCommandBar

before(async () => {
  container = installTestDom()
  // jsdom has no object URLs; the chip only needs a string to draw.
  let urls = 0
  URL.createObjectURL = () => {
    urls += 1
    return `blob:test-${urls}`
  }
  URL.revokeObjectURL = () => {}
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useAgentCommandBar } = await import('./agent-command-bar'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

function Bar(options: UseAgentCommandBarOptions) {
  return useAgentCommandBar(options)
}

const REFUSAL = 'that image is 4.2 MB, over the 4.0 MB limit'

type Upload = NonNullable<UseAgentCommandBarOptions['pictures']>['upload']

async function mount(upload: Upload, extra: Partial<AgentCommandBarSession> = {}) {
  await unmount()
  const sent: Array<{ text: string; attachments?: readonly string[] }> = []
  const session: AgentCommandBarSession = {
    sessionKey: 'session-under-test',
    send: (text, options) => sent.push({ text, ...(options?.attachments ? { attachments: options.attachments } : {}) }),
    waiting: false,
    sending: false,
    ...extra,
  }
  const options: UseAgentCommandBarOptions = {
    session,
    approvalTitles: { yolo: 'yolo', on: 'on', off: 'off' },
    autoApprove: false,
    pictures: { upload },
  }
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<Bar {...options} />))
  return sent
}

function file(name: string): File {
  return new File(['GIF89a'], name, { type: 'image/gif' })
}

async function attach(...files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement | null
  assert.ok(input, 'no file input rendered')
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

async function type(text: string) {
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, 'no composer rendered')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(textarea, text)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function press(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
  assert.ok(button, `no button labelled ${label}`)
  await act(async () => {
    button.click()
  })
  // The send waits for uploads in flight before it decides.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function pressEnter() {
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, 'no composer rendered')
  await act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function alertText(): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null
}

function composerText(): string {
  return container.querySelector('textarea')?.value ?? ''
}

test('a send with a picture that failed to attach is refused, keeps the words, and says which picture and why', async () => {
  const sent = await mount(async (picked) => {
    if (picked.name === 'big.gif') {
      throw new Error(REFUSAL)
    }
    return { id: `id-${picked.name}`, byteSize: 6 }
  })
  await attach(file('small.gif'), file('big.gif'))
  assert.equal(
    alertText(),
    `A picture could not be attached: big.gif (${REFUSAL}). Remove it to send the message without it.`,
    'the notice is up as soon as the picture fails, before any press',
  )
  await type('look at these')
  await press('Send')

  assert.deepEqual(sent, [], 'nothing went out')
  assert.equal(composerText(), 'look at these', 'the words are still in the composer')
  assert.equal(
    alertText(),
    `A picture could not be attached: big.gif (${REFUSAL}). Remove it to send the message without it.`,
  )

  await press('Remove big.gif')
  assert.equal(alertText(), null, 'the notice goes with the picture it was about')
  await press('Send')
  assert.deepEqual(sent, [{ text: 'look at these', attachments: ['id-small.gif'] }])
})

test('a picture that fails while the send waits for it refuses the send and gives the words back', async () => {
  let refuse: (error: Error) => void = () => {}
  const sent = await mount(
    (picked) =>
      new Promise((resolve, reject) => {
        if (picked.name === 'slow.gif') {
          refuse = reject
        } else {
          resolve({ id: `id-${picked.name}`, byteSize: 6 })
        }
      }),
  )
  await attach(file('small.gif'), file('slow.gif'))
  await type('one more')
  const button = container.querySelector('button[aria-label="Send"]') as HTMLButtonElement
  await act(async () => {
    button.click()
  })
  assert.equal(composerText(), '', 'the press cleared the composer while the upload was still running')
  await act(async () => {
    refuse(new Error(REFUSAL))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  assert.deepEqual(sent, [])
  assert.equal(composerText(), 'one more')
  assert.match(alertText() ?? '', /slow\.gif/)
})

test('a send with every picture attached goes as before, with no notice', async () => {
  const sent = await mount(async (picked) => ({ id: `id-${picked.name}`, byteSize: 6 }))
  await attach(file('a.gif'), file('b.gif'))
  await type('both')
  await press('Send')
  assert.deepEqual(sent, [{ text: 'both', attachments: ['id-a.gif', 'id-b.gif'] }])
  assert.equal(alertText(), null)
})

test('the notice names every failed picture, across slots, and says nothing when none failed', () => {
  const ok = { key: 'k1', name: 'ok.png', id: 'x', uploading: false }
  const bad = (name: string) => ({ key: name, name, uploading: false, error: 'too big' })
  assert.equal(failedPicturesNotice([[ok], undefined]), undefined)
  assert.equal(
    failedPicturesNotice([[ok, bad('a.gif')], [bad('b.gif')]]),
    '2 pictures could not be attached: a.gif (too big); b.gif (too big). Remove them to send the message without them.',
  )
})

test('a dismissed notice stays down until a send is refused over the same picture again', async () => {
  const sent = await mount(async (picked) => {
    if (picked.name === 'big.gif') {
      throw new Error(REFUSAL)
    }
    return { id: `id-${picked.name}`, byteSize: 6 }
  })
  await attach(file('big.gif'))
  await press('Dismiss error')
  assert.equal(alertText(), null)

  await type('try anyway')
  await press('Send')
  assert.deepEqual(sent, [])
  assert.match(alertText() ?? '', /big\.gif/, 'the refusal says why again')
})

const EDIT = { eventIndex: 7, parts: [{ index: 0, text: 'first words', pictures: [] }] }

async function mountEdit() {
  const commits: unknown[] = []
  await mount(
    async (picked) => {
      if (picked.name === 'big.gif') {
        throw new Error(REFUSAL)
      }
      return { id: `id-${picked.name}`, byteSize: 6 }
    },
    { edit: EDIT, commitEdit: (edits) => commits.push(edits), cancelEdit: () => {} },
  )
  assert.equal(composerText(), 'first words', 'the edit opened on its message')
  return commits
}

for (const [control, save] of [
  ['Enter in the composer', pressEnter],
  ['the Commit button', () => press('Commit edits')],
] as const) {
  test(`an edit with a picture that failed to attach is refused through ${control}, keeps its words, and says why`, async () => {
    const commits = await mountEdit()
    await attach(file('big.gif'))
    assert.match(alertText() ?? '', /big\.gif/, 'the notice is up before any press')

    await save()
    assert.deepEqual(commits, [], 'nothing was committed')
    assert.equal(composerText(), 'first words', 'the words are still in the composer')
    assert.equal(
      alertText(),
      `A picture could not be attached: big.gif (${REFUSAL}). Remove it to send the message without it.`,
    )

    await press('Remove big.gif')
    assert.equal(alertText(), null)
    await save()
    assert.equal(commits.length, 1, 'with the picture gone the edit commits')
  })
}
