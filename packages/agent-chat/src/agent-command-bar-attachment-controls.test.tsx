// The slot for a control that governs the attachments row: whether it survives
// to the markup, and where it lands.
//
// Both halves have a way of going wrong quietly. The cluster this slot joins is
// built only when it has something to show, and the test for that was written
// when the only somethings were the context ring and the boolean options -- so a
// composer holding nothing but the host's own control renders no cluster, drops
// what it was handed, and reports nothing. Nothing downstream can tell that from
// a host that passed nothing.
//
// And the position is a requirement rather than an arrangement: the control
// stands to the LEFT of the context ring. A slot appended instead of prepended
// is type-correct, green everywhere, and visible only to somebody looking at the
// screen.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCommandBarSession, UseAgentCommandBarOptions } from './agent-command-bar'
import { useAgentCommandBar } from './agent-command-bar'

// A literal rather than an element: what is being located is the slot's
// content, so the content itself should add no elements to search through.
const CONTROL = '[[attachment-control]]'

// The ring names itself in its accessible name, which is what this matches on.
// A class or a shape would be the styling; the name is the control.
const RING = 'Context usage:'

const SESSION: AgentCommandBarSession = {
  sessionKey: 'session-under-test',
  send: () => {},
  waiting: false,
  sending: false,
}

// The hook's required options and nothing else, so each test states only the
// one thing it is about.
const BASE: UseAgentCommandBarOptions = {
  session: SESSION,
  approvalTitles: { yolo: 'yolo', on: 'on', off: 'off' },
  autoApprove: false,
}

function Bar(options: UseAgentCommandBarOptions) {
  return useAgentCommandBar(options)
}

// The options are assembled as one typed value before they reach the element.
// Spreading a Partial straight into JSX widens every required prop to
// possibly-undefined, and the error that produces names whichever required prop
// the compiler reaches first -- which is never the one the test is about.
function render(extra: Partial<UseAgentCommandBarOptions>): string {
  const options: UseAgentCommandBarOptions = { ...BASE, ...extra }
  return renderToStaticMarkup(<Bar {...options} />)
}

test('the control reaches the markup when it is the only thing in its cluster', () => {
  // No usage, no config options: before the slot counted towards the cluster
  // being occupied, this was the case that silently dropped it.
  const markup = render({ attachmentControls: CONTROL })
  assert.ok(markup.includes(CONTROL), `the control was dropped from:\n${markup}`)
})

test('the cluster is still absent when nothing at all is given', () => {
  // The other side of the same guard, so the fix above cannot have been a
  // wrapper that now draws for every composer.
  const empty = render({})
  const filled = render({ attachmentControls: CONTROL })
  const at = filled.indexOf(CONTROL)
  assert.notEqual(at, -1, `the control was dropped from:\n${filled}`)

  // Deleting the cluster from the filled markup reproduces the empty markup
  // exactly -- so the empty case carries no element for it, not one that
  // happens to have nothing in it.
  const open = filled.lastIndexOf('<div', at)
  const close = filled.indexOf('</div>', at)
  assert.ok(open !== -1 && close !== -1, 'no element found around the slot content')
  assert.equal(filled.slice(0, open) + filled.slice(close + '</div>'.length), empty)
})

test('the control stands to the left of the context ring', () => {
  const markup = render({ attachmentControls: CONTROL, usage: { used: 1000, size: 100000 } })
  const control = markup.indexOf(CONTROL)
  const ring = markup.indexOf(RING)

  assert.notEqual(control, -1, `no control in:\n${markup}`)
  assert.notEqual(ring, -1, `no context ring in:\n${markup}`)
  assert.ok(control < ring, 'the control must come before the ring, which is the position it was given')
})

test('the control sits below the composer, in the action row', () => {
  // The other slot a host reaches for is the attachments row ABOVE the input,
  // and handing one to the other is the mistake this pins: the two look
  // interchangeable from the call site and are not.
  const markup = render({ attachmentControls: CONTROL })
  const control = markup.indexOf(CONTROL)
  const composer = markup.indexOf('<textarea')

  assert.notEqual(composer, -1, `no composer in:\n${markup}`)
  assert.ok(control > composer, 'the control belongs to the row under the input, not the row over it')
})
