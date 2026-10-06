import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { MessageView } from './messages'

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
  assert.match(markup, /<div class="my-2 w-fit max-w-full overflow-x-auto rounded-md border[^"]*"><table>/)
  assert.match(markup, /<td>first<br\/>\s*second<\/td>/)
})

test('an assistant reply keeps its links opening in a new tab', () => {
  const markup = assistant('See [the guide](https://example.com/guide).')
  assert.match(
    markup,
    /<a href="https:\/\/example.com\/guide" target="_blank" rel="noopener noreferrer">the guide<\/a>/,
  )
})
