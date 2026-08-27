// Whether the context-window field is IN the markup for a bridged harness, as
// opposed to whether the rule that decides to show it reads correctly.
//
// The field used to be gated to the in-process harness, on the premise that a
// bridged agent reports its own window over the protocol and is believed. That
// premise was reversed: `normalizeUsage` withholds a bridged `size`, because
// nothing in the protocol separates the bridge's seeded family default from the
// corrected value that later replaces it. So for a bridged session this field
// is the only source of a window there is, and the gate put the one available
// remedy out of reach of exactly the sessions that depend on it.
//
// `knownContextWindow` consults a configured window FIRST and never asks which
// adapter is in use. This asserts the form agrees with that. A later tidy-up
// that reintroduces a harness gate here would restore the defect in silence --
// nothing else in this suite renders this field, and the typechecker cannot see
// a condition change.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AgentPresetForm, EMPTY_SELECTION } from './preset-form'

function markupFor(adapterId: string): string {
  return renderToStaticMarkup(
    <AgentPresetForm
      name='probe'
      onNameChange={() => {}}
      selection={{ ...EMPTY_SELECTION, adapterId }}
      onSelectionChange={() => {}}
    />,
  )
}

// The label proves the field rendered; the placeholder proves it rendered as
// the right case. Asserting only the label would pass on a form that shows the
// field to everyone with the in-process wording, which is a different bug.
test('the context window field renders for a bridged harness', () => {
  const markup = markupFor('claude-subscription')
  assert.match(markup, /Max context/)
  assert.match(markup, /placeholder="Unknown"/)
})

test('and for the in-process harness, with the placeholder naming its own source', () => {
  const markup = markupFor('native')
  assert.match(markup, /Max context/)
  assert.match(markup, /placeholder="Ask the endpoint"/)
})
