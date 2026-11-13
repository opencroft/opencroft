import assert from 'node:assert/strict'
import test from 'node:test'

import {
  fileCollision,
  fileSaveSettings,
  formatFileName,
  formatFilePath,
  formatFolder,
  joinFilePath,
  nextSaveCount,
} from './file-name'

const AT = Date.UTC(2026, 9, 30, 14, 5, 9)
const VALUES = { date: AT, time: AT, counter: 7, name: 'Save Image', size: 52341, format: 'png' }

test('date and time written without a format fit in a file name', () => {
  assert.deepEqual(formatFileName('{date}_{time}.{format}', VALUES), { ok: true, text: '2026-10-30_14-05-09.png' })
})

test('the counter pads and the date formats as written', () => {
  assert.deepEqual(formatFileName('shot-{counter:04}-{date:YYYYMMDD}-{size}.{format}', VALUES), {
    ok: true,
    text: 'shot-0007-20261030-52341.png',
  })
})

test('a name that is not one file in the folder is refused', () => {
  assert.deepEqual(formatFileName('', VALUES), { ok: false, error: 'The file name is empty' })
  assert.deepEqual(formatFileName('..', VALUES), { ok: false, error: '".." is not a file name' })
  const slash = formatFileName('a/{format}', VALUES)
  assert.equal(slash.ok, false)
  assert.match(slash.ok ? '' : slash.error, /holds a "\/"/)
  const fromValue = formatFileName('{name}', { name: 'x/y' })
  assert.equal(fromValue.ok, false, 'a "/" that comes from a value is refused too')
  assert.deepEqual(formatFileName('{name}', { name: 'a\0b' }), {
    ok: false,
    error: 'The file name holds a NUL character',
  })
})

test('a placeholder with nothing behind it is the error, naming it', () => {
  assert.deepEqual(formatFileName('{seed}.png', VALUES), { ok: false, error: 'Nothing to put in {seed}' })
})

test('a folder may hold slashes and placeholders', () => {
  assert.deepEqual(formatFolder('/data/{date:YYYY}/{date:MM}', VALUES), { ok: true, text: '/data/2026/10' })
  assert.deepEqual(formatFolder('', VALUES), { ok: true, text: '' })
})

test('the path joins the folder and the name, and says which of the two is wrong', () => {
  assert.deepEqual(formatFilePath('/out', '{counter}.png', VALUES), { ok: true, text: '/out/7.png' })
  assert.deepEqual(formatFilePath('/out/', '{counter}.png', VALUES), { ok: true, text: '/out/7.png' })
  assert.deepEqual(formatFilePath('', '{counter}.png', VALUES), { ok: true, text: '7.png' })
  assert.deepEqual(formatFilePath('/{x', 'a.png', VALUES), { ok: false, error: 'Folder: Unclosed "{" at 2' })
  assert.deepEqual(formatFilePath('/out', '{y}', VALUES), { ok: false, error: 'Name: Nothing to put in {y}' })
})

test('joining keeps a root folder rooted', () => {
  assert.equal(joinFilePath('/', 'a.png'), '/a.png')
})

test('a save node reads its folder, name and rule from its data', () => {
  assert.deepEqual(fileSaveSettings({ folder: '/out', fileName: '{counter}.png', collision: 'fail' }), {
    folder: '/out',
    fileName: '{counter}.png',
    collision: 'fail',
  })
  assert.deepEqual(fileSaveSettings({}), { folder: '', fileName: '', collision: 'number' })
})

test('a node whose data holds only a path writes that one file, overwriting it', () => {
  const settings = fileSaveSettings({ path: '/srv/out/out {1}.webp' })
  assert.deepEqual(settings, { folder: '/srv/out', fileName: 'out {{1}}.webp', collision: 'overwrite' })
  assert.deepEqual(formatFilePath(settings.folder, settings.fileName, {}), { ok: true, text: '/srv/out/out {1}.webp' })
  assert.deepEqual(fileSaveSettings({ path: '/top.png' }), { folder: '/', fileName: 'top.png', collision: 'overwrite' })
  assert.deepEqual(fileSaveSettings({ path: 'here.png' }), { folder: '', fileName: 'here.png', collision: 'overwrite' })
  assert.equal(fileSaveSettings({ path: '/a.png', fileName: 'b.png' }).fileName, 'b.png', 'edited fields win')
})

test('the next save counts one past the saves made', () => {
  assert.equal(nextSaveCount({}), 1)
  assert.equal(nextSaveCount({ counter: 6 }), 7)
  assert.equal(nextSaveCount({ counter: 'x' }), 1)
  assert.equal(nextSaveCount({ counter: -3 }), 1)
})

test('an unknown collision rule reads as adding a number', () => {
  assert.equal(fileCollision('overwrite'), 'overwrite')
  assert.equal(fileCollision('fail'), 'fail')
  assert.equal(fileCollision(undefined), 'number')
  assert.equal(fileCollision('rename'), 'number')
})
