import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildRollupScript, COLD_PRIME_THRESHOLD_TOKENS } from './rollup-script'
import type { RollupRow } from './types'

// Runs the EXACT script buildRollupScript produces, via a real `node -e`
// child process, against fixture transcript files — proving what actually
// ships into the agent-container, not a parallel reimplementation of it.

function assistantLine(opts: { timestamp: string; model?: string; usage?: Record<string, number> | null }): string {
  const message: Record<string, unknown> = { model: opts.model ?? 'claude-sonnet-5' }
  if (opts.usage !== null) {
    message.usage = opts.usage ?? {
      input_tokens: 2,
      output_tokens: 5,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 100,
    }
  }
  return JSON.stringify({ type: 'assistant', timestamp: opts.timestamp, message })
}

function writeFixture(root: string, relPath: string, lines: string[]): void {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `${lines.join('\n')}\n`)
}

function setMtime(root: string, relPath: string, mtime: Date): void {
  const full = path.join(root, relPath)
  fs.utimesSync(full, mtime, mtime)
}

function runScript(root: string, sinceDay: string): RollupRow[] {
  const script = buildRollupScript(sinceDay, root)
  const stdout = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  return JSON.parse(stdout) as RollupRow[]
}

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rollup-fixture-'))
}

test('aggregates requests per (day, agent, model) from a project directory name', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-bob/session1.jsonl', [
    assistantLine({ timestamp: '2026-08-14T10:00:00.000Z' }),
    assistantLine({ timestamp: '2026-08-14T11:00:00.000Z' }),
  ])
  const rows = runScript(root, '2026-08-14')
  assert.deepEqual(rows, [
    {
      day: '2026-08-14',
      agent: 'bob',
      model: 'claude-sonnet-5',
      requests: 2,
      rawInputTokens: 4,
      cacheWriteTokens: 20,
      cacheReadTokens: 200,
      outputTokens: 10,
      coldPrimeRequests: 0,
      coldPrimeTokens: 0,
    },
  ])
})

test('rolls up a subagent transcript into its owning agent, not a separate one', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-carol/abc/subagents/agent-xyz.jsonl', [
    assistantLine({ timestamp: '2026-08-14T09:00:00.000Z' }),
  ])
  const rows = runScript(root, '2026-08-14')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent, 'carol')
})

test('a project directory not under the -agents- convention is labeled by its own name', () => {
  const root = makeRoot()
  writeFixture(root, 'some-other-dir/session.jsonl', [assistantLine({ timestamp: '2026-08-14T09:00:00.000Z' })])
  const rows = runScript(root, '2026-08-14')
  assert.equal(rows[0].agent, 'some-other-dir')
})

test('skips lines with no usage field instead of counting them as zero', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-frank/session.jsonl', [
    assistantLine({ timestamp: '2026-08-14T09:00:00.000Z', usage: null }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-14T09:00:01.000Z', message: { model: 'claude-sonnet-5' } }),
    'not even json',
    JSON.stringify({ type: 'user', timestamp: '2026-08-14T09:00:02.000Z' }),
  ])
  const rows = runScript(root, '2026-08-14')
  assert.deepEqual(rows, [])
})

test('excludes days before sinceDay', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-erin/session.jsonl', [
    assistantLine({ timestamp: '2026-08-12T09:00:00.000Z' }),
    assistantLine({ timestamp: '2026-08-14T09:00:00.000Z' }),
  ])
  const rows = runScript(root, '2026-08-13')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].day, '2026-08-14')
})

test('flags a request as a cold re-prime only once its cache write crosses the threshold', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-dave/session.jsonl', [
    assistantLine({
      timestamp: '2026-08-14T09:00:00.000Z',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: COLD_PRIME_THRESHOLD_TOKENS,
        cache_read_input_tokens: 0,
      },
    }),
    assistantLine({
      timestamp: '2026-08-14T09:05:00.000Z',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: COLD_PRIME_THRESHOLD_TOKENS + 1,
        cache_read_input_tokens: 0,
      },
    }),
  ])
  const rows = runScript(root, '2026-08-14')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].coldPrimeRequests, 1)
  assert.equal(rows[0].coldPrimeTokens, COLD_PRIME_THRESHOLD_TOKENS + 1)
})

test('keeps a GLM model as its own (day, agent, model) row', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-alice/session.jsonl', [
    assistantLine({ timestamp: '2026-08-14T09:00:00.000Z', model: 'glm-5.2' }),
    assistantLine({ timestamp: '2026-08-14T09:01:00.000Z', model: 'claude-opus-5' }),
  ])
  const rows = runScript(root, '2026-08-14')
  const models = rows.map((r) => r.model).sort()
  assert.deepEqual(models, ['claude-opus-5', 'glm-5.2'])
})

test('an empty projects directory produces no rows, not an error', () => {
  const root = makeRoot()
  const rows = runScript(root, '2026-08-14')
  assert.deepEqual(rows, [])
})

test('skips a file whose mtime is older than sinceDay minus a day of slack, even if its content would match', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-judy/session.jsonl', [assistantLine({ timestamp: '2026-08-14T09:00:00.000Z' })])
  // sinceDay - 1 day slack is 2026-08-13T00:00:00Z; put mtime clearly before that.
  setMtime(root, '-agents-judy/session.jsonl', new Date('2026-08-10T00:00:00.000Z'))
  const rows = runScript(root, '2026-08-14')
  assert.deepEqual(rows, [])
})

test('reads a file whose mtime falls inside the slack window even if its own content is a day earlier than sinceDay', () => {
  const root = makeRoot()
  writeFixture(root, '-agents-judy/session.jsonl', [assistantLine({ timestamp: '2026-08-14T09:00:00.000Z' })])
  // sinceDay - 1 day slack is 2026-08-13T00:00:00Z; put mtime just inside that.
  setMtime(root, '-agents-judy/session.jsonl', new Date('2026-08-13T12:00:00.000Z'))
  const rows = runScript(root, '2026-08-14')
  assert.equal(rows.length, 1)
})
