// The kit's agent-edit label in the forms the shared editor and the kit draw
// it: the element placed in a line or between blocks, and the component. Like
// a collaborator's name tag, each label is laid out against its own anchor by
// anchor name, so it is neither cut off nor scrolled by a box the text sits in.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { AgentEdit, agentEditLabelElement } = await import('ui/components/ui/editing/agent-edit')
const { collaboratorCaretElement } = await import('ui/components/ui/editing/collaborator-caret')

after(() => dom.cleanup())

const DASHED_IDENT = /^--[\w-]+$/
const ANCHORED = 'supports-[anchor-name:--a]:'

/** Each label anchor's name, with the anchor its label is laid out against. */
function tethers(anchors: HTMLElement[]): { anchor: string; label: string }[] {
  return anchors.map((anchor) => ({
    anchor: anchor.style.getPropertyValue('anchor-name'),
    label: (anchor.firstElementChild as HTMLElement).style.getPropertyValue('position-anchor'),
  }))
}

test('each label element is tethered to its own anchor, in a line and between blocks', () => {
  const anchors = [
    agentEditLabelElement('agent-a', 'violet'),
    agentEditLabelElement('agent-b', 'sky'),
    agentEditLabelElement('agent-a', 'violet', { blocks: true }),
  ]
  const pairs = tethers(anchors)
  for (const { anchor, label } of pairs) {
    assert.match(anchor, DASHED_IDENT, 'a dashed identifier, which is all anchor-name accepts')
    assert.equal(label, anchor)
  }
  assert.equal(new Set(pairs.map(({ anchor }) => anchor)).size, anchors.length)
})

test('a label is laid out against its anchor the way a collaborator’s tag is', () => {
  const caretTag = collaboratorCaretElement('alice', 'sky').firstElementChild as HTMLElement
  const anchored = (element: Element) => [...element.classList].filter((name) => name.startsWith(ANCHORED)).sort()
  const expected = anchored(caretTag)
  assert.ok(expected.length > 0, 'the caret’s tag is laid out by anchor')
  for (const blocks of [false, true]) {
    const label = agentEditLabelElement('agent-a', 'violet', { blocks }).firstElementChild as HTMLElement
    assert.deepEqual(anchored(label), expected)
    assert.equal(label.textContent, 'agent-a')
    assert.match(label.getAttribute('style') ?? '', /agent-edit-label/, 'it still rises into place')
  }
})

test('each component’s label is tethered to that component’s anchor and to no other', () => {
  const host = document.createElement('div')
  const edit = (name: string) =>
    createElement(AgentEdit, {
      name,
      hue: 'violet',
      before: 'The release goes ',
      replaced: 'later',
      inserted: 'sooner',
    })
  host.innerHTML = renderToStaticMarkup(createElement('div', null, edit('agent-a'), edit('agent-b')))
  const anchors = [...host.querySelectorAll<HTMLElement>('p > span')].filter((span) =>
    span.style.getPropertyValue('anchor-name'),
  )
  const pairs = tethers(anchors)
  assert.equal(pairs.length, 2)
  for (const { anchor, label } of pairs) {
    assert.match(anchor, DASHED_IDENT)
    assert.equal(label, anchor)
  }
  assert.notEqual(pairs[0].anchor, pairs[1].anchor)
})
