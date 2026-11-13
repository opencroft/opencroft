import assert from 'node:assert/strict'
import test from 'node:test'

import {
  equalMarkdownGridLayout,
  fittingMarkdownGridLayout,
  isMarkdownGridLayout,
  MARKDOWN_GRID_LAYOUTS,
  type MarkdownGridLayout,
  markdownGridBlockCount,
  markdownGridLayoutLabel,
  markdownGridPlacements,
} from './markdown-grid-layouts'

/** Each block as `narrow/medium/wide`: the columns of 12 it spans at each breakpoint. */
function placed(layout: MarkdownGridLayout): string {
  return markdownGridPlacements(layout)
    .map(({ narrow, medium, wide }) => `${narrow}/${medium}/${wide}`)
    .join(' ')
}

test('the layouts are the eleven rows of one to four blocks, and nothing else is one', () => {
  assert.deepEqual(
    [...MARKDOWN_GRID_LAYOUTS],
    [
      'full',
      '1/2+1/2',
      '1/3+2/3',
      '2/3+1/3',
      '1/4+3/4',
      '3/4+1/4',
      '1/3+1/3+1/3',
      '1/2+1/4+1/4',
      '1/4+1/2+1/4',
      '1/4+1/4+1/2',
      '1/4+1/4+1/4+1/4',
    ],
  )
  for (const value of ['1/2', '1/2 + 1/2', '2/3+2/3', '1/4+1/4+1/4', 'Full', '', undefined]) {
    assert.equal(isMarkdownGridLayout(value), false, String(value))
  }
})

test('wide, each block takes its share; below it, adjacent quarters pair as halves, 1/2 + 1/2 too on medium, and the rest take the row', () => {
  const expected: Record<MarkdownGridLayout, string> = {
    full: '12/12/12',
    '1/2+1/2': '12/6/6 12/6/6',
    '1/3+2/3': '12/12/4 12/12/8',
    '2/3+1/3': '12/12/8 12/12/4',
    '1/4+3/4': '12/12/3 12/12/9',
    '3/4+1/4': '12/12/9 12/12/3',
    '1/3+1/3+1/3': '12/12/4 12/12/4 12/12/4',
    '1/2+1/4+1/4': '12/12/6 6/6/3 6/6/3',
    '1/4+1/2+1/4': '12/12/3 12/12/6 12/12/3',
    '1/4+1/4+1/2': '6/6/3 6/6/3 12/12/6',
    '1/4+1/4+1/4+1/4': '6/6/3 6/6/3 6/6/3 6/6/3',
  }
  for (const layout of MARKDOWN_GRID_LAYOUTS) {
    assert.equal(placed(layout), expected[layout], layout)
  }
})

test('every layout fills whole rows of 12 at every breakpoint, in source order', () => {
  for (const layout of MARKDOWN_GRID_LAYOUTS) {
    const placements = markdownGridPlacements(layout)
    assert.equal(placements.length, markdownGridBlockCount(layout), layout)
    assert.equal(
      placements.reduce((sum, { wide }) => sum + wide, 0),
      12,
      layout,
    )
    for (const step of ['narrow', 'medium', 'wide'] as const) {
      // Placed in order, as the grid's auto-placement does: no row is left part-filled.
      let row = 0
      for (const placement of placements) {
        if (row + placement[step] > 12) {
          assert.equal(row, 12, `${layout} ${step}`)
          row = 0
        }
        row += placement[step]
      }
      assert.equal(row, 12, `${layout} ${step}`)
    }
  }
})

test('the equal layout for a count of blocks, and none past four', () => {
  assert.deepEqual([1, 2, 3, 4].map(equalMarkdownGridLayout), ['full', '1/2+1/2', '1/3+1/3+1/3', '1/4+1/4+1/4+1/4'])
  assert.equal(equalMarkdownGridLayout(0), undefined)
  assert.equal(equalMarkdownGridLayout(5), undefined)
})

test('a grid keeps its layout while its blocks fit it, and takes the equal one when they do not', () => {
  assert.equal(fittingMarkdownGridLayout('1/3+2/3', 2), '1/3+2/3')
  assert.equal(fittingMarkdownGridLayout('1/3+2/3', 3), '1/3+1/3+1/3')
  assert.equal(fittingMarkdownGridLayout('1/2+1/4+1/4', 1), 'full')
  assert.equal(fittingMarkdownGridLayout('', 4), '1/4+1/4+1/4+1/4')
  assert.equal(fittingMarkdownGridLayout('full', 5), undefined)
})

test('a layout is named by its shares, and the one-block layout as full width', () => {
  assert.equal(markdownGridLayoutLabel('full'), 'Full width')
  assert.equal(markdownGridLayoutLabel('1/3+2/3'), '1/3 + 2/3')
  assert.equal(markdownGridLayoutLabel('1/4+1/4+1/4+1/4'), '1/4 + 1/4 + 1/4 + 1/4')
})
