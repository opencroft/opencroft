// What a person sees of a tool's JSON answer does not depend on how compactly
// the host sent it. Host tools send compact JSON because a model reads it; the
// transcript lays it out again for a person. Rendered through the kit's views
// the way the transcript picks them (a registered view, else the generic block),
// the compact answer and the indented one it replaced give the same markup.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { GenericToolView } from 'ui/tool-views/run-views'
import { type ToolViewHost, ToolViewHostProvider } from 'ui/tool-views/tool-view-host'
import { lookupToolView } from 'ui/tool-views/tool-views'

const host: ToolViewHost = {
  readFile: async () => '',
  readSkill: async () => '',
  describeBackgroundRun: () => undefined,
}

const ANSWER = {
  tasks: [{ key: 'T-1', summary: 'First task', labels: ['a', 'b'], assignee: null, childCount: 0 }],
  total: 1,
}

function transcript(tool: string, args: Record<string, unknown>, text: string): string {
  const View = lookupToolView(tool)?.body
  return renderToStaticMarkup(
    <ToolViewHostProvider host={host}>
      {View ? (
        <View tool={tool} args={args} requestId='request-1' mode='history' result={{ text }} />
      ) : (
        <GenericToolView tool={tool} args={args} result={{ text }} />
      )}
    </ToolViewHostProvider>,
  )
}

const CALLS: [string, Record<string, unknown>][] = [
  ['app_call', { app: 'my-space.my-app', action: 'task_list', params: { limit: 200 } }],
  ['group_chat_list', {}],
  ['call', { nodeId: 'node-1', action: 'status' }],
]

test('a compact JSON answer renders exactly as the indented answer did', () => {
  const compact = JSON.stringify(ANSWER)
  const indented = JSON.stringify(ANSWER, null, 2)
  for (const [tool, args] of CALLS) {
    const shown = transcript(tool, args, compact)
    assert.equal(shown, transcript(tool, args, indented), tool)
    assert.ok(shown.includes('{\n  &quot;tasks&quot;: [\n    {\n'), `${tool} shows the answer indented`)
  }
})

test('program output is shown as written, even when it is JSON', () => {
  const printed = JSON.stringify(ANSWER)
  const shown = transcript('remote_exec', { target: 'node-1/terminal', command: 'cat tasks.json' }, printed)
  assert.ok(shown.includes(printed.replaceAll('"', '&quot;')), 'the command output keeps its own layout')
})
