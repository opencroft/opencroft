// The rules the core repository holds its test files to (test-rules/*.grit,
// wired in by the root biome.json): no fixed time outside test-support, no
// skip or todo without a reason, no tracker key in a test name.
//
// Each row plants one file in a scratch tree that carries the repository's
// own biome.json, shared config and rule files, copied as they are, and runs
// the real biome over all of them once. What is pinned is which rule each
// planted file trips, and that a suppression with a reason is the one way
// past a rule, which itself fails once nothing is left to suppress.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runBiome } from './biome.mjs'
import { readRun } from './lint.mjs'

const CORE = path.resolve(import.meta.dirname, '..', '..', '..')
const RULES_DIR = 'packages/dev-tools/test-rules'
const CONFIG_FILES = ['biome.json', 'packages/dev-tools/biome.shared.json']

// Each rule is told apart by its category, and a plugin's by the opening of
// its message: biome reports every plugin finding under the one category.
const RULE_OF = [
  { rule: 'fixed-time', category: 'plugin', opening: 'A test does not wait on a fixed time' },
  { rule: 'timers-import', category: 'lint/style/noRestrictedImports', opening: 'A test does not sleep' },
  { rule: 'bare-skip', category: 'plugin', opening: 'A skipped or todo test carries its reason' },
  { rule: 'tracker-key', category: 'plugin', opening: 'A test name carries no tracker key' },
  { rule: 'unused-suppression', category: 'suppressions/unused', opening: '' },
]

type Row = { name: string; file: string; source: string; rules: string[] }

const IMPORTS = "import test, { describe, it, suite } from 'node:test'\n"

const ROWS: Row[] = [
  // No fixed time.
  {
    name: 'a global setTimeout in a test',
    file: 'a/sleep.test.ts',
    source: 'export const nap = () => new Promise((resolve) => setTimeout(resolve, 10))\n',
    rules: ['fixed-time'],
  },
  {
    name: 'a global setInterval in a test',
    file: 'a/interval.test.ts',
    source: 'export const timer = setInterval(() => {}, 10)\n',
    rules: ['fixed-time'],
  },
  {
    name: "window's and globalThis's timers in a test",
    file: 'a/hosted.test.ts',
    source: 'window.setTimeout(() => {}, 10)\nglobalThis.setInterval(() => {}, 10)\n',
    rules: ['fixed-time', 'fixed-time'],
  },
  {
    name: 'a sleep imported from node:timers/promises',
    file: 'a/timers-import.test.ts',
    source: "import { setTimeout as sleep } from 'node:timers/promises'\n\nexport const nap = () => sleep(10)\n",
    rules: ['timers-import'],
  },
  {
    name: 'a timer in a .test.tsx file',
    file: 'a/view.test.tsx',
    source: 'export const nap = () => new Promise((resolve) => setTimeout(resolve, 10))\n',
    rules: ['fixed-time'],
  },
  {
    name: 'a timer in test-support, where the waiting helpers live',
    file: 'a/test-support/wait.test.ts',
    source: 'export const nap = () => new Promise((resolve) => setTimeout(resolve, 10))\n',
    rules: [],
  },
  {
    name: 'a timer in a file that is not a test',
    file: 'a/poller.ts',
    source: 'export const timer = setInterval(() => {}, 10)\n',
    rules: [],
  },
  {
    name: 'a timer type and a child script held in a string',
    file: 'a/types.test.ts',
    source:
      "export let handle: ReturnType<typeof setTimeout> | undefined\nexport const script = 'setTimeout(() => {}, 10)'\n",
    rules: [],
  },
  {
    name: 'a fixed time behind a suppression with its reason',
    file: 'a/suppressed.test.ts',
    source:
      '// biome-ignore lint/plugin/noTestFixedTime: a deadline that only bounds failure\nexport const bound = setTimeout(() => {}, 10)\n',
    rules: [],
  },
  {
    name: 'a suppression with nothing left to suppress',
    file: 'a/stale.test.ts',
    source:
      '// biome-ignore lint/plugin/noTestFixedTime: a deadline that only bounds failure\nexport const bound = 10\n',
    rules: ['unused-suppression'],
  },

  // No skip or todo without a reason.
  {
    name: 'the skip and todo forms that carry no reason',
    file: 'b/bare.test.ts',
    source: `${IMPORTS}
it.skip('a', () => {})
describe.todo('b')
suite.skip('c', () => {})
test.todo('d')
test('e', { skip: true }, () => {})
test('f', { todo: true }, () => {})
test('g', (t) => {
  t.skip()
  t.todo()
})
`,
    rules: Array(8).fill('bare-skip'),
  },
  {
    name: 'a skip and a todo that give their reason',
    file: 'b/reasoned.test.ts',
    source: `${IMPORTS}
const noGit = { skip: process.env.PATH ? false : 'git is not installed' }
test('a', noGit, () => {})
test('b', { skip: 'the fixture needs a symlink this filesystem cannot make' }, () => {})
test('c', (t) => {
  t.skip('the fixture needs a symlink this filesystem cannot make')
  t.todo('the parser does not read this form yet')
})
`,
    rules: [],
  },
  {
    name: 'a bare skip in test-support',
    file: 'b/test-support/bare.test.ts',
    source: `${IMPORTS}\ntest('a', { skip: true }, () => {})\n`,
    rules: ['bare-skip'],
  },

  // No tracker key in a test name.
  {
    name: 'a key in the name of each kind of test',
    file: 'c/keys.test.ts',
    source: `${IMPORTS}
test('PROJ-12 keeps the order', () => {})
test('keeps the order PROJ-12', { skip: 'x' }, () => {})
it(\`keeps the PROJ-12 order\`, () => {})
describe('order (PROJ-12)', () => {})
suite('order PROJ-1', () => {})
test.only('order PROJ-3', () => {})
test('outer', async (t) => {
  await t.test('inner PROJ-4', () => {})
})
`,
    rules: Array(7).fill('tracker-key'),
  },
  {
    name: 'names with no key',
    file: 'c/plain.test.ts',
    source: `${IMPORTS}\ntest('keeps the order of a re-sorted list', () => {})\ndescribe('a list', () => {})\n`,
    rules: [],
  },
  {
    name: 'a key in a test-support test name',
    file: 'c/test-support/keys.test.ts',
    source: `${IMPORTS}\ntest('PROJ-12 keeps the order', () => {})\n`,
    rules: ['tracker-key'],
  },
  {
    name: 'a key-shaped string that is not a test name',
    file: 'c/elsewhere.test.ts',
    source: "export const label = (name: string) => name\nlabel('PROJ-12')\n",
    rules: [],
  },
]

/** Copies the repository's own config and rule files into `dir`, at the same relative paths. */
function stageConfig(dir: string) {
  for (const file of CONFIG_FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    cpSync(path.join(CORE, file), path.join(dir, file))
  }
  const rules = readdirSync(path.join(CORE, RULES_DIR)).filter((file) => file.endsWith('.grit'))
  assert.ok(rules.includes('noTestFixedTime.grit'), `the rule files are where biome.json points: ${rules.join(', ')}`)
  cpSync(path.join(CORE, RULES_DIR), path.join(dir, RULES_DIR), { recursive: true })
}

function ruleOf(category: string, message: string) {
  const hit = RULE_OF.find((r) => r.category === category && message.startsWith(r.opening))
  return hit ? hit.rule : `unexpected ${category}: ${message}`
}

test('each planted file trips exactly the test-file rules its row names', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-tools-test-rules-'))
  try {
    stageConfig(dir)
    for (const row of ROWS) {
      mkdirSync(path.dirname(path.join(dir, row.file)), { recursive: true })
      writeFileSync(path.join(dir, row.file), row.source)
    }
    // The scratch tree is no git checkout, so the config's ignore-file lookup
    // is switched off; formatting is another command's concern.
    const run = runBiome(
      dir,
      ROWS.map((row) => row.file),
      ['--vcs-enabled=false', '--formatter-enabled=false', '--assist-enabled=false', '--reporter=json'],
    )
    const verdict = readRun(JSON.parse(run.stdout))
    assert.ok(verdict.ok, `biome's report can be read: ${verdict.ok || verdict.reason}`)
    assert.equal(verdict.scanned, ROWS.length, 'biome looked at every planted file')

    // The rest of the recommended set (an import a row leaves unused) is not
    // what these rows plant, so only the categories above are counted.
    const counted = new Set(RULE_OF.map((r) => r.category))
    const found = new Map<string, string[]>()
    for (const finding of verdict.findings.filter((f) => counted.has(f.rule))) {
      const rules = found.get(finding.file) ?? []
      rules.push(ruleOf(finding.rule, finding.message))
      found.set(finding.file, rules)
    }
    for (const row of ROWS) {
      assert.deepEqual(found.get(row.file) ?? [], row.rules, row.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
