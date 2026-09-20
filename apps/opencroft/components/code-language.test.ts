import assert from 'node:assert/strict'
import test from 'node:test'

import { languageFromPath } from './code-language'

// What a tool view hands this is a label, not a path, and the labels differ by
// tool: a file edit is shown under its path, a node's property under a property
// name. Both arrive here, so recognising one and quietly not recognising the
// other is the whole behaviour.

test('a file path is coloured as the file it is', () => {
  assert.equal(languageFromPath('packages/agent-chat/src/components/markdown.tsx'), 'typescript')
  assert.equal(languageFromPath('/app/config.yaml'), 'yaml')
  assert.equal(languageFromPath('scripts\\run-tests.mjs'), 'javascript')
  assert.equal(languageFromPath('README.md'), 'markdown')
})

test('extension case does not decide whether a diff has colour', () => {
  assert.equal(languageFromPath('Main.PY'), 'python')
  assert.equal(languageFromPath('Styles.CSS'), 'css')
})

test('a label that is not a file name is plain text rather than a guess', () => {
  // The node-property and skill-body views pass a name here. Reading `data` out
  // of `agent.data` as a language would be worse than not colouring at all.
  assert.equal(languageFromPath('agent instructions'), 'plaintext')
  assert.equal(languageFromPath(undefined), 'plaintext')
  assert.equal(languageFromPath(null), 'plaintext')
  assert.equal(languageFromPath(''), 'plaintext')
})

test('a dotfile has no extension to read', () => {
  // `.gitignore` is all extension and no name; treating the whole name as one
  // would ask Monaco for a `gitignore` grammar that is not there.
  assert.equal(languageFromPath('.gitignore'), 'plaintext')
  assert.equal(languageFromPath('/repo/.env'), 'plaintext')
})

test('an unknown extension is plain text, not an error', () => {
  assert.equal(languageFromPath('main.hcl'), 'plaintext')
  assert.equal(languageFromPath('flake.nix'), 'plaintext')
})
