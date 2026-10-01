import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { Approvals, type ApprovalsSession } from './approvals'

function session(overrides: Partial<ApprovalsSession>): ApprovalsSession {
  return {
    permissions: [],
    asks: [],
    resolvePermission: () => {},
    respondPermissionText: () => {},
    resolveAsk: () => {},
    ...overrides,
  }
}

// A host tells that an ask or a permission request is waiting on the person
// by this slot on the panel's root, for instance to hold back its own
// dialogs until it is answered.
test('the panel root carries the approvals slot while a request is waiting', () => {
  const html = renderToStaticMarkup(
    <Approvals session={session({ asks: [{ requestId: 'ask-1', message: 'Which branch?' }] })} />,
  )
  assert.match(html, /^<div data-slot="approvals"/)
})

test('nothing renders, and so no slot, when nothing is waiting', () => {
  assert.equal(renderToStaticMarkup(<Approvals session={session({})} />), '')
})
