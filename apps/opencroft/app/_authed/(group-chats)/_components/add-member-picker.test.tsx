// Adding someone from the member picker the chat settings render: once a
// match is chosen, the field is empty and focused again, and the rows are the
// member list with the new member in it -- not a search that, now that they
// are a member, matches no one.
//
// Rendered with react-dom against a DOM; the text is typed and the match
// pressed through DOM events, the way a person does it.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// cmdk observes its list's size with ResizeObserver, which jsdom lacks, and
// scrolls the active row into view; stubs are enough to mount and select.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const scope of [globalThis, globalThis.window] as unknown as Record<string, unknown>[]) {
  scope.ResizeObserver = FakeResizeObserver
}
window.Element.prototype.scrollIntoView ??= () => {}

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { AddMemberPicker } = await import('ui/group-chat/add-member-picker')

after(() => dom.cleanup())

type Principal = { kind: 'user' | 'agent'; id: string }

const CANDIDATES = [
  { kind: 'user' as const, id: 'u1', name: 'Alice', avatarUrl: null },
  { kind: 'agent' as const, id: 'a1', name: 'Bob', avatarUrl: null },
]

/** Sets an input's value the way typing does, so React's onChange sees it. */
function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set
  assert.ok(setValue, 'an input has a value setter')
  setValue.call(input, text)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function rowNamed(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((row) => row.textContent?.includes(name))
}

test('choosing a match empties the field, keeps focus in it, and shows the member list', async () => {
  const root = createRoot(dom.container)
  const added: Principal[] = []
  const render = (members: Principal[]) =>
    root.render(
      createElement(AddMemberPicker, {
        candidates: CANDIDATES,
        members,
        onAdd: (principal: Principal) => added.push(principal),
      }),
    )
  try {
    await act(async () => render([{ kind: 'user', id: 'u1' }]))
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
    assert.ok(input, 'the picker has its search field')

    await act(async () => type(input, 'Bo'))
    const match = rowNamed('Bob')
    assert.ok(match, 'typing offers the match')
    assert.equal(rowNamed('Alice'), undefined, 'a member is not offered for adding')

    await act(async () => match.click())
    assert.deepEqual(added, [{ kind: 'agent', id: 'a1' }])
    assert.equal(input.value, '')
    // A boolean, not the two elements: a failing comparison of DOM nodes
    // has the assertion print their whole object graphs.
    assert.ok(document.activeElement === input, 'the search field keeps focus')

    // The host has the new member in.
    await act(async () =>
      render([
        { kind: 'user', id: 'u1' },
        { kind: 'agent', id: 'a1' },
      ]),
    )
    assert.doesNotMatch(dom.container.textContent ?? '', /No one matches that/)
    assert.match(dom.container.textContent ?? '', /2 members/)
    assert.ok(rowNamed('Bob'), 'the new member is in the list')
    assert.ok(rowNamed('Alice'), 'the earlier member is still in the list')
  } finally {
    await act(async () => root.unmount())
  }
})

// jsdom has no layout, so this pins the class that lifts the menu's height
// cap, not the height itself; the settings section relies on it to show every
// member under its own scroll.
test('the member list keeps its height cap unless the host scrolls it instead', async () => {
  const root = createRoot(dom.container)
  const listClasses = async (scrollsInside?: boolean) => {
    await act(async () =>
      root.render(
        createElement(AddMemberPicker, {
          candidates: CANDIDATES,
          members: [{ kind: 'user', id: 'u1' }],
          onAdd: () => {},
          scrollsInside,
        }),
      ),
    )
    const list = document.querySelector('[cmdk-list]')
    assert.ok(list, 'the picker has its list')
    return list.className.split(/\s+/)
  }
  try {
    const capped = await listClasses()
    assert.ok(capped.includes('max-h-72'), 'a menu caps its rows')
    assert.ok(!capped.includes('max-h-none'))

    const uncapped = await listClasses(false)
    assert.ok(uncapped.includes('max-h-none'), 'a scrolling host lifts the cap')
    assert.ok(!uncapped.includes('max-h-72'))
  } finally {
    await act(async () => root.unmount())
  }
})
