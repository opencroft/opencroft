// Which part of the reader's selection a message's menu acts on.
//
// jsdom serialises a selection with its range's `toString()`, not with the
// line breaks a browser puts between blocks, so these tests pin WHICH text is
// taken -- the clamping and the fall-through to '' -- and not its line breaks.

import assert from 'node:assert/strict'
import { before, beforeEach, test } from 'node:test'

import { installTestDom } from '../test-dom'
import { selectedTextWithin } from './message-selection'

let first: HTMLElement
let second: HTMLElement

before(() => {
  installTestDom()
})

// Two messages side by side, as a transcript renders them.
beforeEach(() => {
  document.body.innerHTML =
    '<div id="first"><p>alpha beta</p><p>gamma delta</p></div><div id="second"><p>epsilon zeta</p></div>'
  first = document.getElementById('first') as HTMLElement
  second = document.getElementById('second') as HTMLElement
})

function textOf(element: Element, index = 0): Text {
  const paragraph = element.querySelectorAll('p')[index]
  return paragraph.firstChild as Text
}

function select(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number): Selection {
  const selection = document.getSelection() as Selection
  selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
  return selection
}

test('a selection inside the message is taken as it is', () => {
  const selection = select(textOf(first), 6, textOf(first), 10)
  assert.equal(selectedTextWithin(first, selection), 'beta')
})

test('a selection running out of the message is cut at its end', () => {
  // From "delta" in the first message to "epsilon" in the second.
  const selection = select(textOf(first, 1), 6, textOf(second), 7)
  assert.equal(selectedTextWithin(first, selection), 'delta')
  assert.equal(selectedTextWithin(second, selection), 'epsilon')
})

test('a selection running into the message from before it is cut at its start', () => {
  document.body.insertAdjacentHTML('afterbegin', '<p id="before">outside words</p>')
  const outside = (document.getElementById('before') as HTMLElement).firstChild as Text
  const selection = select(outside, 8, textOf(first), 5)
  assert.equal(selectedTextWithin(first, selection), 'alpha')
})

test('a selection spanning a whole message and more yields that message whole', () => {
  document.body.insertAdjacentHTML('afterbegin', '<p id="before">outside</p>')
  const outside = (document.getElementById('before') as HTMLElement).firstChild as Text
  const selection = select(outside, 0, textOf(second), 7)
  assert.equal(selectedTextWithin(first, selection), 'alpha betagamma delta')
})

test("the reader's selection is put back exactly, direction included, after a clamped read", () => {
  // Made backwards on purpose: a restore that re-added the range would lose
  // which end the reader was extending from.
  const selection = select(textOf(second), 7, textOf(first, 1), 6)
  selectedTextWithin(first, selection)
  assert.equal(selection.anchorNode, textOf(second))
  assert.equal(selection.anchorOffset, 7)
  assert.equal(selection.focusNode, textOf(first, 1))
  assert.equal(selection.focusOffset, 6)
})

test('a selection wholly in another message gives nothing, so the menu falls back to the whole message', () => {
  const selection = select(textOf(second), 0, textOf(second), 7)
  assert.equal(selectedTextWithin(first, selection), '')
})

test('no selection, or a collapsed one, gives nothing', () => {
  assert.equal(selectedTextWithin(first, null), '')
  const selection = document.getSelection() as Selection
  selection.removeAllRanges()
  assert.equal(selectedTextWithin(first, selection), '')
  select(textOf(first), 3, textOf(first), 3)
  assert.equal(selectedTextWithin(first, selection), '')
})

// A chip drawn for an identifier: what it shows is not what it stands for.
const CHIP =
  '<p>Before <span data-selection-text="ABC-1"><a href="#"><span>ABC-1</span><span>Fix the login</span></a></span> after</p>'

test('a selection across a stand-in reads it as its text, not as what it shows', () => {
  document.body.innerHTML = `<div id="chip">${CHIP}</div>`
  const message = document.getElementById('chip') as HTMLElement
  const paragraph = message.querySelector('p') as HTMLElement
  const selection = select(paragraph.firstChild as Text, 0, paragraph.lastChild as Text, 6)
  assert.equal(selectedTextWithin(message, selection), 'Before ABC-1 after')
})

test('a selection ending inside a stand-in takes the whole of it', () => {
  document.body.innerHTML = `<div id="chip">${CHIP}</div>`
  const message = document.getElementById('chip') as HTMLElement
  const paragraph = message.querySelector('p') as HTMLElement
  const summary = message.querySelectorAll('a span')[1].firstChild as Text
  const selection = select(paragraph.firstChild as Text, 0, summary, 3)
  assert.equal(selectedTextWithin(message, selection), 'Before ABC-1')
})

test("reading a stand-in puts the reader's selection back and leaves nothing behind", () => {
  document.body.innerHTML = `<div id="chip">${CHIP}</div>`
  const message = document.getElementById('chip') as HTMLElement
  const paragraph = message.querySelector('p') as HTMLElement
  const end = paragraph.lastChild as Text
  const selection = select(end, 6, paragraph.firstChild as Text, 0)
  const html = document.body.innerHTML
  selectedTextWithin(message, selection)
  assert.equal(document.body.innerHTML, html)
  assert.equal(selection.anchorNode, end)
  assert.equal(selection.anchorOffset, 6)
  assert.equal(selection.focusNode, paragraph.firstChild)
  assert.equal(selection.focusOffset, 0)
})

test('a selection covering only whitespace in the message gives nothing', () => {
  document.body.innerHTML = '<div id="spaced"><p>one</p> <p>two</p></div>'
  const spaced = document.getElementById('spaced') as HTMLElement
  const gap = spaced.childNodes[1] as Text
  const selection = select(gap, 0, gap, 1)
  assert.equal(selectedTextWithin(spaced, selection), '')
})
