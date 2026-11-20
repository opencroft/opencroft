import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ToolOutputPart } from 'agent-chat/tool-views'
import { renderToStaticMarkup } from 'react-dom/server'

import { GenericToolView } from './run-views'
import { ToolViewHostProvider } from './tool-view-host'

const host = {
  readFile: async () => '',
  readSkill: async () => '',
  describeBackgroundRun: () => undefined,
}

// A call drawn the way the transcript draws any tool without a view of its own.
function drawn(content: ToolOutputPart[], text = 'placeholder text') {
  return renderToStaticMarkup(
    <ToolViewHostProvider host={host}>
      <GenericToolView tool='fetch_media' args={{}} result={{ text, content }} state='completed' />
    </ToolViewHostProvider>,
  )
}

test('a kept picture is drawn from its URL at the size it displays at, between the text around it', () => {
  const html = drawn([
    { type: 'text', text: 'before' },
    { type: 'image', mimeType: 'image/png', byteSize: 2048, src: '/media/one?key=k', width: 30, height: 20 },
    { type: 'text', text: 'after' },
  ])
  assert.match(html, /<img[^>]*src="\/media\/one\?key=k"[^>]*width="30"[^>]*height="20"/)
  assert.ok(html.indexOf('before') < html.indexOf('<img') && html.indexOf('<img') < html.indexOf('after'), html)
  assert.doesNotMatch(html, /placeholder text/, 'the parts stand in for the flattened text')
})

test('a kept sound is a player', () => {
  const html = drawn([{ type: 'audio', mimeType: 'audio/wav', byteSize: 4, src: '/media/two?key=k' }])
  assert.match(html, /<audio[^>]*controls[^>]*src="\/media\/two\?key=k"/)
})

test('media with no bytes to show is a line saying what it was, never an image', () => {
  const html = drawn([
    { type: 'image', mimeType: 'image/svg+xml', byteSize: 1536 },
    { type: 'audio', mimeType: 'audio/wav', byteSize: 3 * 1024 * 1024 },
  ])
  assert.doesNotMatch(html, /<img|<audio/)
  assert.ok(html.includes('image/svg+xml, 2 KB, not kept'), html)
  assert.ok(html.includes('audio/wav, 3.0 MB, not kept'), html)
})

test('a link opens only when it is a web address', () => {
  const html = drawn([
    { type: 'resource_link', uri: 'https://example.com/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
    { type: 'resource_link', uri: 'file:///srv/app/notes.md', name: 'notes.md' },
    { type: 'resource_link', uri: 'javascript:alert(1)', name: 'click me' },
  ])
  assert.match(html, /<a href="https:\/\/example.com\/report.pdf" target="_blank" rel="noreferrer noopener"/)
  assert.equal((html.match(/<a /g) ?? []).length, 1, html)
  assert.ok(html.includes('notes.md') && html.includes('click me'), html)
})

test('an embedded resource shows its text, and a blob of it is named with its size', () => {
  const html = drawn([
    { type: 'resource', uri: 'file:///srv/app/notes.md', mimeType: 'text/markdown', text: '# Notes' },
    { type: 'resource', uri: 'file:///srv/app/data.bin', mimeType: 'application/octet-stream', byteSize: 12 },
    { type: 'terminal', terminalId: 'term-1' },
  ])
  assert.ok(html.includes('# Notes'), html)
  assert.ok(html.includes('file:///srv/app/data.bin, application/octet-stream, 12 B, not kept'), html)
  assert.ok(html.includes('Ran in terminal term-1'), html)
})

test('a result with no kept parts is drawn from its text', () => {
  const html = renderToStaticMarkup(
    <ToolViewHostProvider host={host}>
      <GenericToolView tool='fetch_media' args={{}} result={{ text: 'just text' }} state='completed' />
    </ToolViewHostProvider>,
  )
  assert.ok(html.includes('just text'), html)
})
