import assert from 'node:assert/strict'
import test from 'node:test'

import { SharedTextSaver, type SharedWriteAnswer } from './shared-instructions-saver'

/** A stored row with compare-and-swap, as the host's shared text is; `calls` records each write. */
function store(text: string, version: number) {
  const row = { text, version }
  const calls: Array<{ text: string; expectedVersion: number }> = []
  const write = async (next: string, expectedVersion: number): Promise<SharedWriteAnswer> => {
    calls.push({ text: next, expectedVersion })
    if (expectedVersion !== row.version) {
      return { conflict: { text: row.text, version: row.version, updatedBy: 'Other' } }
    }
    row.text = next
    row.version += 1
    return { version: row.version }
  }
  return { row, calls, write }
}

test('a save writes the edited text at the version read, and the next at the version it returned', async () => {
  const { row, calls, write } = store('Rules.', 3)
  const saver = new SharedTextSaver({ text: 'Rules.', version: 3 }, write, () => {})
  saver.edit('Rules, v2.')
  await saver.save()
  saver.edit('Rules, v3.')
  await saver.save()
  assert.deepEqual(calls, [
    { text: 'Rules, v2.', expectedVersion: 3 },
    { text: 'Rules, v3.', expectedVersion: 4 },
  ])
  assert.deepEqual(row, { text: 'Rules, v3.', version: 5 })
})

test('an edit made while a save is out is saved after it, at the version it returned', async () => {
  const { calls, write } = store('A', 1)
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const saver = new SharedTextSaver(
    { text: 'A', version: 1 },
    async (text, expectedVersion) => {
      if (calls.length === 0) {
        const answer = write(text, expectedVersion)
        await held
        return answer
      }
      return write(text, expectedVersion)
    },
    () => {},
  )
  saver.edit('B')
  const first = saver.save()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(saver.current.saving, true, 'the first save is out')
  saver.edit('C')
  const second = saver.save()
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, [
    { text: 'B', expectedVersion: 1 },
    { text: 'C', expectedVersion: 2 },
  ])
  assert.equal(saver.current.conflict, null)
})

test('a save takes the text current when its turn comes, so saves queued together write once', async () => {
  const { calls, write } = store('A', 1)
  const saver = new SharedTextSaver({ text: 'A', version: 1 }, write, () => {})
  saver.edit('B')
  const first = saver.save()
  saver.edit('C')
  await Promise.all([first, saver.save()])
  assert.deepEqual(calls, [{ text: 'C', expectedVersion: 1 }])
})

test('an unchanged text is not saved', async () => {
  const { calls, write } = store('Same.', 1)
  const saver = new SharedTextSaver({ text: 'Same.', version: 1 }, write, () => {})
  saver.edit('Same.')
  await saver.save()
  assert.equal(calls.length, 0)
})

test('a save after someone else saved writes nothing and shows their text', async () => {
  const { row, write } = store('Theirs.', 2)
  const saver = new SharedTextSaver({ text: 'Old.', version: 1 }, write, () => {})
  saver.edit('Mine.')
  await saver.save()
  assert.deepEqual(saver.current.conflict, { text: 'Theirs.', version: 2, updatedBy: 'Other' })
  assert.equal(saver.current.value, 'Mine.', 'the editor keeps what the person typed')
  assert.deepEqual(row, { text: 'Theirs.', version: 2 }, 'nothing was written')
})

test('while a conflict waits, no save is made', async () => {
  const { calls, write } = store('Theirs.', 2)
  const saver = new SharedTextSaver({ text: 'Old.', version: 1 }, write, () => {})
  saver.edit('Mine.')
  await saver.save()
  saver.edit('Mine, more.')
  await saver.save()
  assert.equal(calls.length, 1)
})

test('taking their text puts it in the editor, and the next edit saves at their version', async () => {
  const { row, write } = store('Theirs.', 2)
  const saver = new SharedTextSaver({ text: 'Old.', version: 1 }, write, () => {})
  saver.edit('Mine.')
  await saver.save()
  saver.takeTheirs()
  assert.equal(saver.current.value, 'Theirs.')
  assert.equal(saver.current.conflict, null)
  assert.equal(saver.dirty, false)
  saver.edit('Theirs, edited.')
  await saver.save()
  assert.deepEqual(row, { text: 'Theirs, edited.', version: 3 })
})

test('keeping mine saves it over their text, at the version the conflict found', async () => {
  const { row, write } = store('Theirs.', 2)
  const saver = new SharedTextSaver({ text: 'Old.', version: 1 }, write, () => {})
  saver.edit('Mine.')
  await saver.save()
  await saver.keepMine()
  assert.deepEqual(row, { text: 'Mine.', version: 3 })
  assert.equal(saver.current.conflict, null)
})

test('a fresh read replaces the text only while nothing typed is unsaved', () => {
  const { write } = store('', 0)
  const saver = new SharedTextSaver({ text: 'Old.', version: 1 }, write, () => {})
  saver.adoptRead({ text: 'Read again.', version: 2 })
  assert.equal(saver.current.value, 'Read again.')
  saver.edit('Typing…')
  saver.adoptRead({ text: 'Read once more.', version: 3 })
  assert.equal(saver.current.value, 'Typing…')
})

test('a failed save is reported and the next save tries again', async () => {
  let fail = true
  const saver = new SharedTextSaver(
    { text: '', version: 0 },
    async () => {
      if (fail) {
        throw new Error('offline')
      }
      return { version: 1 }
    },
    () => {},
  )
  saver.edit('Text.')
  await saver.save()
  assert.equal(saver.current.error, 'offline')
  fail = false
  await saver.save()
  assert.equal(saver.current.error, '')
  assert.equal(saver.dirty, false)
})

test('every change is reported to the listener', async () => {
  const { write } = store('A', 1)
  const seen: string[] = []
  const saver = new SharedTextSaver({ text: 'A', version: 1 }, write, (state) =>
    seen.push(`${state.value}:${state.saving}`),
  )
  saver.edit('B')
  await saver.save()
  assert.deepEqual(seen, ['B:false', 'B:true', 'B:false'])
})
