import assert from 'node:assert/strict'
import test from 'node:test'

import { type LinkClick, onPlainClick, opensElsewhere } from '@/app/_lib/opens-elsewhere'

type Keys = Partial<Omit<LinkClick, 'currentTarget'>>

function click(keys: Keys = {}, target: string | null = null) {
  let prevented = false
  return {
    event: {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: { getAttribute: (name: string) => (name === 'target' ? target : null) },
      preventDefault: () => {
        prevented = true
      },
      ...keys,
    },
    prevented: () => prevented,
  }
}

// Clicks the browser opens somewhere other than the current page.
const ELSEWHERE: [name: string, keys: Keys, target: string | null][] = [
  ['the middle button', { button: 1 }, null],
  ['Ctrl', { ctrlKey: true }, null],
  ['Cmd', { metaKey: true }, null],
  ['Shift', { shiftKey: true }, null],
  ['Alt', { altKey: true }, null],
  ['a link with target _blank', {}, '_blank'],
]

test('a plain click with the main button stays on the page', () => {
  assert.equal(opensElsewhere(click().event), false)
  assert.equal(opensElsewhere(click({}, '_self').event), false, 'target _self')
})

test('a click the browser opens somewhere else is told apart', () => {
  for (const [name, keys, target] of ELSEWHERE) {
    assert.equal(opensElsewhere(click(keys, target).event), true, name)
  }
})

test('onPlainClick runs the action in place of following the link on a plain click', () => {
  let ran = 0
  const { event, prevented } = click()
  onPlainClick(() => ran++)(event)
  assert.equal(ran, 1)
  assert.equal(prevented(), true, 'the link is not followed')
})

test('onPlainClick leaves a click for a new tab or window to the browser', () => {
  for (const [name, keys, target] of ELSEWHERE) {
    let ran = 0
    const { event, prevented } = click(keys, target)
    onPlainClick(() => ran++)(event)
    assert.equal(ran, 0, `${name}: no action`)
    assert.equal(prevented(), false, `${name}: the browser opens the link`)
  }
})
