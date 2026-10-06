// The kit's collaborator caret in the forms the shared editor draws it: the
// element placed in the text, the component, and the tag alone for a block.
// Each tag is laid out against its own caret by anchor name, so two carets
// sharing a name would draw both tags at one of them.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { CollaboratorCaret, collaboratorCaretElement, collaboratorTagElement } = await import(
  'ui/components/ui/editing/collaborator-caret'
)

after(() => dom.cleanup())

const DASHED_IDENT = /^--[\w-]+$/

/** Each caret's anchor name, with the anchor its tag is laid out against. */
function tethers(carets: HTMLElement[]): { anchor: string; tag: string }[] {
  return carets.map((caret) => ({
    anchor: caret.style.getPropertyValue('anchor-name'),
    tag: (caret.firstElementChild as HTMLElement).style.getPropertyValue('position-anchor'),
  }))
}

test('each caret element’s tag is tethered to that caret and to no other', () => {
  const carets = [collaboratorCaretElement('alice', 'sky'), collaboratorCaretElement('bob', 'rose')]
  const pairs = tethers(carets)
  for (const { anchor, tag } of pairs) {
    assert.match(anchor, DASHED_IDENT, 'a dashed identifier, which is all anchor-name accepts')
    assert.equal(tag, anchor)
  }
  assert.equal(new Set(pairs.map(({ anchor }) => anchor)).size, carets.length)
})

test('a tag alone is tethered to the anchor it is given, and is drawn like a caret’s', () => {
  const tag = collaboratorTagElement('carol', 'amber', '--block-a')
  const caretTag = collaboratorCaretElement('carol', 'amber').firstElementChild as HTMLElement
  assert.equal(tag.style.getPropertyValue('position-anchor'), '--block-a')
  assert.equal(tag.textContent, 'carol')
  assert.ok(tag.classList.contains('text-amber-500'), 'filled with the collaborator’s colour')
  for (const name of caretTag.classList) {
    if (!name.includes('position-try-fallbacks')) {
      assert.ok(tag.classList.contains(name), `the caret's tag class ${name}`)
    }
  }
})

test('with no room above its block, a tag alone stands inside the block’s top edge', () => {
  const tag = collaboratorTagElement('carol', 'amber', '--block-a')
  const fallbacks = [...tag.classList].filter((name) => name.includes('position-try-fallbacks'))
  assert.deepEqual(fallbacks, ['supports-[anchor-name:--a]:[position-try-fallbacks:--collaborator-tag-inside]'])
  const rules = [...document.querySelectorAll('style')].map((style) => style.textContent ?? '')
  assert.ok(
    rules.some((rule) => /@position-try --collaborator-tag-inside \{ top: anchor\(top\);/.test(rule)),
    'the fallback it names is declared on the page',
  )
})

test('each caret component’s tag is tethered to that caret and to no other', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    createElement(
      'p',
      null,
      createElement(CollaboratorCaret, { name: 'alice', hue: 'sky' }),
      createElement(CollaboratorCaret, { name: 'bob', hue: 'rose' }),
    ),
  )
  const pairs = tethers([...(host.querySelector('p')?.children ?? [])] as HTMLElement[])
  assert.equal(pairs.length, 2)
  for (const { anchor, tag } of pairs) {
    assert.match(anchor, DASHED_IDENT)
    assert.equal(tag, anchor)
  }
  assert.notEqual(pairs[0].anchor, pairs[1].anchor)
})
