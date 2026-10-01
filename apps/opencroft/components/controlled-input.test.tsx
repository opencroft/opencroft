// A value typed into a controlled field and submitted at once is the value
// submitted.
//
// The fields report changes to their parent after a delay, so that a caller
// filtering on every change is not re-run per keystroke. A submit handler reads
// the parent's state, not the field, so without a hand-over a press inside that
// delay submits whatever the parent held before the typing -- for a setting
// that started empty, a save that clears it. Pressing a button moves focus off the field before the
// click fires, and the field hands over the pending value on that blur.
//
// jsdom does not move focus on a synthesized click the way a pointer press
// does, so each test performs the two steps a real press consists of: focus
// lands on the button, then the button is clicked.
//
// The clock is faked throughout: the delay never elapses unless a test ticks
// it, so every assertion here holds however slow the machine is.

import assert from 'node:assert/strict'
import test, { after, afterEach, beforeEach, mock } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The textarea asks whether the viewport is mobile; the harness has no media
// query implementation, so answer "desktop" for the duration.
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

const { act, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ControlledInput } = await import('ui/components/ui/input/controlled-input')
const { ControlledTextarea } = await import('ui/components/ui/input/controlled-textarea')

after(() => dom.cleanup())

const DELAY_MS = 500

type Field = 'input' | 'textarea'

interface FormProps {
  field: Field
  onChangeReported: (value: string) => void
  onSubmit: (value: string) => void
}

function Form({ field, onChangeReported, onSubmit }: FormProps): ReactNode {
  const [value, setValue] = useState('')
  const report = (next: string) => {
    onChangeReported(next)
    setValue(next)
  }
  return (
    <div>
      {field === 'input' ? (
        <ControlledInput value={value} onValueChanged={report} />
      ) : (
        <ControlledTextarea value={value} onValueChanged={report} />
      )}
      <button type='button' onClick={() => onSubmit(value)}>
        Save
      </button>
    </div>
  )
}

interface View {
  reported: string[]
  submitted: string[]
  type: (text: string) => Promise<void>
  press: () => Promise<void>
  blur: () => Promise<void>
  tick: (ms: number) => Promise<void>
  unmount: () => Promise<void>
}

async function mount(field: Field): Promise<View> {
  const reported: string[] = []
  const submitted: string[] = []
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<Form field={field} onChangeReported={(v) => reported.push(v)} onSubmit={(v) => submitted.push(v)} />)
  })

  const control = () => {
    const found = dom.container.querySelector(field)
    assert.ok(found, `the ${field} is on screen`)
    return found as HTMLInputElement | HTMLTextAreaElement
  }
  const button = () => {
    const found = dom.container.querySelector('button')
    assert.ok(found, 'the Save button is on screen')
    return found as HTMLButtonElement
  }

  return {
    reported,
    submitted,
    type: async (text: string) => {
      const el = control()
      // React tracks a controlled field's value through the prototype setter;
      // assigning `el.value` directly would be swallowed as "no change".
      const proto = field === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      assert.ok(setValue, 'the value setter exists')
      await act(async () => {
        el.focus()
        setValue.call(el, text)
        el.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    },
    press: async () => {
      await act(async () => button().focus())
      await act(async () => button().click())
    },
    blur: async () => {
      await act(async () => control().blur())
    },
    tick: async (ms: number) => {
      await act(async () => mock.timers.tick(ms))
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
})

afterEach(() => {
  mock.timers.reset()
})

for (const field of ['input', 'textarea'] as const) {
  test(`${field}: pressing Save right after typing submits the typed value`, async () => {
    const view = await mount(field)

    await view.type('/data/projects')
    assert.deepEqual(view.reported, [], 'the delay has not elapsed, so nothing is reported by typing alone')
    await view.press()

    assert.deepEqual(view.submitted, ['/data/projects'])
    await view.unmount()
  })

  test(`${field}: the change is reported once, not again when the delay elapses`, async () => {
    const view = await mount(field)

    await view.type('abc')
    await view.press()
    await view.tick(DELAY_MS)

    assert.deepEqual(view.reported, ['abc'])
    await view.unmount()
  })

  test(`${field}: while focus stays in the field, the change is reported only after the delay`, async () => {
    const view = await mount(field)

    await view.type('a')
    await view.type('ab')
    await view.tick(DELAY_MS - 1)
    assert.deepEqual(view.reported, [], 'still inside the delay')
    await view.tick(1)

    assert.deepEqual(view.reported, ['ab'], 'one report, carrying the last value')
    await view.unmount()
  })

  test(`${field}: leaving the field with nothing pending reports nothing`, async () => {
    const view = await mount(field)

    await view.type('abc')
    await view.tick(DELAY_MS)
    assert.deepEqual(view.reported, ['abc'], 'the delay reported the change')

    await view.blur()

    assert.deepEqual(view.reported, ['abc'], 'the blur added no second report')
    await view.unmount()
  })
}
