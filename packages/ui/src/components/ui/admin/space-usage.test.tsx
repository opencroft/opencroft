// The usage page's markup, rendered to a string: where the choice of groups
// is drawn and what its button reads, that the series are named once (in the
// list of groups, not in a legend above the charts), how a series is
// coloured, and what the empty page says while a choice narrows it. Opening
// the choice and ticking in it are exercised in multi-select.test.tsx; how
// any of it looks is not visible here.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
}

const SERIES: SpaceUsageSeries[] = [{ key: 'all', label: 'All', points: [POINT] }]

const AGENTS = [
  { key: 'ada', label: 'Ada' },
  { key: 'brook', label: 'Brook' },
  { key: 'sage', label: 'Sage' },
]

function render(props: Partial<SpaceUsageProps>): string {
  return renderToStaticMarkup(
    <SpaceUsage
      series={SERIES}
      grouping='all'
      onGroupingChange={() => {}}
      period={{ kind: '7d' }}
      onPeriodChange={() => {}}
      {...props}
    />,
  )
}

/** The choice's button, by the accessible name it carries. */
function trigger(html: string): string | undefined {
  return html.match(/<button[^>]*role="combobox"[^>]*>.*?<\/button>/)?.[0]
}

test('the choice is drawn per agent, model and space for a host that takes it, and never under All', () => {
  const choosing = { options: AGENTS, onChosenChange: () => {} }
  assert.equal(trigger(render({ ...choosing, grouping: 'all' })), undefined)
  assert.equal(trigger(render({ options: AGENTS, grouping: 'agent' })), undefined, 'no callback, no choice')
  assert.match(render({ ...choosing, grouping: 'agent' }), /aria-label="Agents: All agents"/)
  assert.match(render({ ...choosing, grouping: 'model', options: [] }), /aria-label="Models: All models"/)
  assert.match(render({ ...choosing, grouping: 'space', options: [] }), /aria-label="Spaces: All spaces"/)
})

test('the button reads All with nothing chosen, the name with one, and a count with several', () => {
  const textOf = (chosen: string[]) =>
    trigger(render({ grouping: 'agent', options: AGENTS, chosen, onChosenChange: () => {} }))
      ?.replace(/<[^>]+>/g, '')
      .trim()
  assert.equal(textOf([]), 'All agents')
  assert.equal(textOf(['brook']), 'Brook')
  assert.equal(textOf(['ada', 'brook', 'sage']), '3 agents')
  assert.equal(textOf(['gone']), 'gone', 'a chosen group the period lacks is named by its key')
})

test('the button is the same element whatever is chosen, only its words differ', () => {
  // A static stand-in for "the row keeps its height": no chip or field is
  // added per choice. Whether it truly keeps one line is a browser check.
  const shapeOf = (chosen: string[]) =>
    trigger(render({ grouping: 'agent', options: AGENTS, chosen, onChosenChange: () => {} }))
      ?.replace(/aria-label="[^"]*"/, '')
      .replace(/>[^<]+</g, '><')
  assert.ok(shapeOf([]))
  assert.equal(shapeOf(['ada']), shapeOf([]))
  assert.equal(shapeOf(['ada', 'brook', 'sage']), shapeOf([]))
})

test('the series are named once, in the list of groups beneath the charts', () => {
  const two: SpaceUsageSeries[] = [
    { key: 'ada', label: 'Ada', points: [POINT], colorIndex: 0 },
    { key: 'brook', label: 'Brook', points: [POINT], colorIndex: 1 },
  ]
  const groups: SpaceUsageGroup[] = two.map(({ key, label, colorIndex }) => ({ key, label, colorIndex, ...POINT }))
  const html = render({ grouping: 'agent', series: two, groups })
  assert.equal(html.match(/>Ada</g)?.length, 1)
  assert.equal(html.match(/>Brook</g)?.length, 1)
  assert.ok(html.indexOf('>Ada<') > html.indexOf('Cache writes'), 'after the last chart, in the list')
})

/** The chart token a lone series in `slot` is stroked with. */
function slotToken(slot: number): string {
  const tokens = [
    ...render({ series: [{ ...SERIES[0], colorIndex: slot }] }).matchAll(/stroke="var\((--chart-\d+)\)"/g),
  ]
  assert.ok(tokens.length > 0, `slot ${slot} draws no chart token`)
  assert.equal(new Set(tokens.map((m) => m[1])).size, 1, `slot ${slot} draws in more than one token`)
  return tokens[0][1]
}

/** The hue of each chart token in the host stylesheet's light theme. */
function stylesheetHues(): Map<string, number> {
  const css = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8')
  const root = css.slice(css.indexOf('\n:root {'), css.indexOf('\n}', css.indexOf('\n:root {')))
  return new Map(
    [...root.matchAll(/(--chart-\d+): oklch\([\d.]+ [\d.]+ ([\d.]+)\);/g)].map((m) => [m[1], Number(m[2])]),
  )
}

test('a series is painted in its colour slot, or in its position when it has none', () => {
  assert.match(render({}), new RegExp(`stroke="var\\(${slotToken(0)}\\)"`))
  const slotted = render({ series: [{ ...SERIES[0], colorIndex: 2 }] })
  assert.match(slotted, new RegExp(`stroke="var\\(${slotToken(2)}\\)"`))
  assert.doesNotMatch(slotted, new RegExp(`stroke="var\\(${slotToken(0)}\\)"`))
})

test('the 17 slots are the 17 chart tokens, once each, and the 18th slot takes the first again', () => {
  const tokens = Array.from({ length: 17 }, (_, slot) => slotToken(slot))
  assert.deepEqual([...new Set(tokens)].sort(), [...stylesheetHues().keys()].sort())
  assert.equal(slotToken(17), tokens[0])
})

test('the slots start at blue and step two hues round the wheel each time', () => {
  const hues = stylesheetHues()
  // Tailwind's blue-500 hue.
  const blue = 259.815
  // Each token's place on the wheel, counted from blue in the direction of rising hue.
  const wheel = [...hues.keys()].sort(
    (a, b) => (((hues.get(a) ?? 0) - blue + 360) % 360) - (((hues.get(b) ?? 0) - blue + 360) % 360),
  )
  assert.equal(hues.get(wheel[0]), blue)
  const places = Array.from({ length: 17 }, (_, slot) => wheel.indexOf(slotToken(slot)))
  assert.deepEqual(
    places,
    Array.from({ length: 17 }, (_, slot) => (slot * 2) % 17),
  )
})

test('an empty page says whether the chosen groups or the whole record are empty', () => {
  assert.match(render({ series: [] }), /No usage recorded yet/)
  assert.match(
    render({ series: [], grouping: 'agent', chosen: ['ada'], onChosenChange: () => {} }),
    /No usage on the chosen agents/,
  )
  assert.match(
    render({ series: [], grouping: 'model', chosen: ['large'], onChosenChange: () => {} }),
    /No usage on the chosen models/,
  )
  assert.match(
    render({ series: [], grouping: 'all', chosen: ['ada'], onChosenChange: () => {} }),
    /No usage recorded yet/,
    'under All no choice narrows the page',
  )
})
