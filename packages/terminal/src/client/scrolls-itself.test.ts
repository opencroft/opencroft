// Drives a real xterm, unopened: its parser, buffers and modes run without a DOM.
import assert from 'node:assert/strict'
import test from 'node:test'

import xterm from '@xterm/xterm'

import { markScrollsItself, SCROLLS_ITSELF } from './scrolls-itself'

const ALT_BUFFER_ON = '\x1b[?1049h'
const ALT_BUFFER_OFF = '\x1b[?1049l'
const MOUSE_VT200_ON = '\x1b[?1000h'
const MOUSE_VT200_OFF = '\x1b[?1000l'
const MOUSE_X10_ON = '\x1b[?9h'

/** An element as far as the mark goes: its attributes. */
class FakeElement {
  readonly attributes = new Set<string>()
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.attributes.has(name)
    if (on) {
      this.attributes.add(name)
    } else {
      this.attributes.delete(name)
    }
    return on
  }
}

function marked() {
  const term = new xterm.Terminal({ allowProposedApi: true })
  const el = new FakeElement()
  markScrollsItself(term, el)
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve))
  const isMarked = () => el.attributes.has(SCROLLS_ITSELF)
  return { term, write, isMarked }
}

test('a shell in the normal buffer is not marked, and plain output leaves it so', async () => {
  const { term, write, isMarked } = marked()
  assert.equal(isMarked(), false)
  await write('line\r\n'.repeat(50))
  assert.equal(isMarked(), false)
  term.dispose()
})

test('the alternate buffer marks the terminal until the app leaves it', async () => {
  const { term, write, isMarked } = marked()
  await write(ALT_BUFFER_ON)
  assert.equal(isMarked(), true)
  await write('screen')
  assert.equal(isMarked(), true)
  await write(ALT_BUFFER_OFF)
  assert.equal(isMarked(), false)
  term.dispose()
})

test('mouse tracking that reports the wheel marks the terminal in the normal buffer', async () => {
  const { term, write, isMarked } = marked()
  await write(MOUSE_VT200_ON)
  assert.equal(isMarked(), true)
  await write(MOUSE_VT200_OFF)
  assert.equal(isMarked(), false)
  term.dispose()
})

test('X10 mouse tracking reports no wheel and leaves the terminal unmarked', async () => {
  const { term, write, isMarked } = marked()
  await write(MOUSE_X10_ON)
  assert.equal(term.modes.mouseTrackingMode, 'x10')
  assert.equal(isMarked(), false)
  term.dispose()
})
