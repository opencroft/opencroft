import assert from 'node:assert/strict'
import test from 'node:test'

import { isScriptLanguage, SCRIPT_LANGUAGES, scriptDataProblems } from './script-language'

test('every language a script node runs is valid', () => {
  for (const language of SCRIPT_LANGUAGES) {
    assert.ok(isScriptLanguage(language))
    assert.deepEqual(scriptDataProblems({ language }), [])
  }
})

test('data with no language is a problem at the language field', () => {
  for (const data of [{}, { language: undefined }, undefined]) {
    const problems = scriptDataProblems(data)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].path, 'language')
    assert.equal(problems[0].title, 'No language set')
  }
})

test('a language no script node runs is a problem that names the value', () => {
  for (const language of ['ruby', 'Bash', '', 42, null]) {
    const [problem] = scriptDataProblems({ language })
    assert.equal(problem?.path, 'language', `for ${JSON.stringify(language)}`)
    assert.equal(problem.title, 'Language no script node runs')
    assert.ok(problem.detail?.includes(JSON.stringify(language)))
  }
})

test('a name inherited from Object is not a language', () => {
  assert.equal(isScriptLanguage('toString'), false)
  assert.equal(isScriptLanguage('constructor'), false)
})
