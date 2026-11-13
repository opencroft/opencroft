import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { AskPrompt, MessageView, PermissionRequest } from './messages'
import { ToolCallBlock } from './tool-block'

function assistant(text: string): string {
  return renderToStaticMarkup(
    <MessageView
      message={{ id: '1', kind: 'assistant', text }}
      toolViews={{}}
      onRespondPermission={() => {}}
      onRespondAsk={() => {}}
    />,
  )
}

test('an assistant reply renders a table in the framed table, with its line breaks', () => {
  const markup = assistant('| Step | Notes |\n| --- | --- |\n| 1 | first<br>second |\n')
  assert.match(markup, /<div class="[^"]*w-fit max-w-full overflow-x-auto rounded-md border[^"]*"><table>/)
  assert.match(markup, /<td>first<br\/>\s*second<\/td>/)
})

test('an assistant reply keeps its links opening in a new tab', () => {
  const markup = assistant('See [the guide](https://example.com/guide).')
  assert.match(
    markup,
    /<a href="https:\/\/example.com\/guide" target="_blank" rel="noopener noreferrer">the guide<\/a>/,
  )
})

const header = (props: Parameters<typeof ToolCallBlock>[0]) => renderToStaticMarkup(<ToolCallBlock {...props} />)

test('a running call keeps its spinner while its output streams in', () => {
  const markup = header({ name: 'bash', state: 'running', result: { text: 'line 1\n' } })
  assert.match(markup, /animate-spin/)
  assert.doesNotMatch(markup, />(failed|stopped)</)
})

test('a settled call says how it ended: nothing when it completed, failed or stopped otherwise', () => {
  const completed = header({ name: 'bash', state: 'completed', result: { text: 'ok' } })
  assert.doesNotMatch(completed, /animate-spin|>(failed|stopped)</)
  const failed = header({ name: 'bash', state: 'failed', result: { text: 'Exit code 3', isError: true } })
  assert.match(failed, /class="text-destructive">failed</)
  const stopped = header({ name: 'bash', state: 'cancelled' })
  assert.match(stopped, /class="text-muted-foreground">stopped</)
  assert.doesNotMatch(stopped, /animate-spin/)
})

const ask = (outcome?: 'answered' | 'declined' | 'turn_ended' | 'withdrawn') =>
  renderToStaticMarkup(
    <AskPrompt
      message={{ id: '1', kind: 'ask', requestId: 'r1', message: 'Which way?', resolved: true, outcome }}
      onRespond={() => {}}
    />,
  )

test('a settled ask says how it was settled, and only an answered one reads Answered', () => {
  assert.match(ask('answered'), />Answered</)
  assert.match(ask('declined'), />Skipped</)
  assert.match(ask('turn_ended'), />Not answered: the turn ended</)
  assert.match(ask('withdrawn'), />Not answered: the question was withdrawn</)
  assert.match(ask(), />Closed</)
})

test('a settled permission request names the option picked, or that none was', () => {
  const options = [
    { id: 'opt-allow', label: 'Allow', kind: 'allow_once' },
    { id: 'opt-reject', label: 'Reject', kind: 'reject_once' },
  ]
  const permission = (resolvedOptionId?: string) =>
    renderToStaticMarkup(
      <PermissionRequest
        message={{ id: '1', kind: 'permission', requestId: 'p1', title: 'rm -rf tmp', options, resolved: true, resolvedOptionId }}
        onRespond={() => {}}
      />,
    )
  assert.match(permission('opt-allow'), />Answered: Allow</)
  assert.match(permission(), />Not answered</)
})
