// The usage page's groupings switch and the list of each group's figures,
// rendered to a string: which groupings the switch offers, when the list is
// drawn and in what box, what a row says, and that "Other" and the groups
// folded into it are drawn in the theme's neutral, outside the palette.

import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { SpaceUsage, type SpaceUsageGroup, type SpaceUsageProps, type SpaceUsageSeries } from './space-usage'

const POINT = {
  date: '2026-03-01',
  totalTokens: 10,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 4,
  cost: 0.5,
}

const SERIES: SpaceUsageSeries[] = [{ key: 'north', label: 'North', colorIndex: 0, points: [POINT] }]

const GROUPS: SpaceUsageGroup[] = [
  {
    key: 'north',
    label: 'North',
    colorIndex: 0,
    totalTokens: 12_000,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    cost: 1.25,
  },
  {
    key: 'south',
    label: 'South',
    totalTokens: 7,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  {
    key: 'east',
    label: 'East',
    // A slot alongside the fold, which must not be read.
    colorIndex: 2,
    folded: true,
    totalTokens: 5,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
]

function render(props: Partial<SpaceUsageProps>): string {
  return renderToStaticMarkup(
    <SpaceUsage
      series={SERIES}
      grouping='space'
      onGroupingChange={() => {}}
      period={{ kind: '7d' }}
      onPeriodChange={() => {}}
      {...props}
    />,
  )
}

test('the switch offers All, Per agent and Per model unless the host names its groupings', () => {
  const plain = render({ grouping: 'all' })
  assert.match(plain, />Per model</)
  assert.doesNotMatch(plain, />Per space</)
  assert.match(render({ groupings: ['all', 'agent', 'model', 'space'] }), />Per space</)
})

test('the list is drawn only when the host passes groups and the window has buckets', () => {
  assert.doesNotMatch(render({}), /<table/)
  assert.doesNotMatch(render({ series: [], groups: GROUPS }), /<table/)
  assert.match(render({ groups: GROUPS }), /<table/)
})

test('the list sits in a bordered box, as the settings tables do', () => {
  assert.match(render({ groups: GROUPS }), /<div class="rounded-lg border"><div data-slot="table-container"/)
})

test('a row names the group and gives its figures; a group without a price shows a dash for cost', () => {
  const html = render({ groups: GROUPS })
  assert.match(html, />North</)
  assert.match(html, />\$1\.25</)
  assert.match(html, />12k</)
  assert.match(html, /South<\/span><\/td><td[^>]*>—</)
})

test("a group with its own line wears its colour in the list, a folded one Other's neutral, one with neither no colour", () => {
  const html = render({ groups: GROUPS })
  const rows = html.split('<tr').slice(2)
  assert.match(rows[0], /background-color:var\(--chart-9\)/)
  assert.doesNotMatch(rows[1], /background-color/)
  assert.match(rows[2], /background-color:var\(--muted-foreground\)/)
  assert.doesNotMatch(rows[2], /--chart-/)
})

test('the Other series is drawn in the neutral, whatever slot it is given', () => {
  const html = render({
    series: [...SERIES, { key: 'other', label: 'Other', colorIndex: 5, folded: true, points: [POINT] }],
  })
  assert.match(html, /stroke="var\(--muted-foreground\)"/)
  assert.doesNotMatch(html, /var\(--chart-13\)/)
  assert.match(html, /stroke="var\(--chart-9\)"/)
})
