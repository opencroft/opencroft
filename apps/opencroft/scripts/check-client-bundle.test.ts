// The empirical half: what the built output is scanned for. These tests fix
// the two things the scan had wrong — a package list that omitted the database
// stack, and an exact-name match that missed every subpath.

import assert from 'node:assert/strict'
import test from 'node:test'

import { bundledFingerprints, isForbidden, offendingSpecifiers } from './check-client-bundle.mjs'

// A pure-JS package is bundled inline, so no specifier survives and the scan
// above cannot see it. Verified against a real build: importing
// `drizzle-orm/pg-core` into a client component put the library's internals in
// an emitted chunk while the specifier scan called the bundle clean.
test('a bundled server-only package is caught by its fingerprint', () => {
  const emitted = 'var L=Symbol.for(`drizzle:entityKind`);function R(e,t){}'
  assert.deepEqual(bundledFingerprints(emitted), ['drizzle-orm (bundled)'])
})

// The reason the fingerprint is a namespaced symbol tag and not the package
// name: a CLEAN bundle already contains the string "drizzle", because that is
// part of a lucide icon name. Matching the bare name would fail every build.
test('the lucide icon named after drizzle does not trip the fingerprint', () => {
  const emitted = 'p_=U(`cloud-drizzle`,[[`path`,{d:`M4 14.899A7 7 0 1 1 15.71`}]])'
  assert.deepEqual(bundledFingerprints(emitted), [])
})

test('node builtins are forbidden in both spellings', () => {
  assert.equal(isForbidden('node:fs'), true)
  assert.equal(isForbidden('fs'), true)
  // The whole builtin set, not a hand-kept shortlist.
  assert.equal(isForbidden('perf_hooks'), true)
})

// The packages that were already listed, because they had already reached a
// browser this way.
test('known native packages are forbidden', () => {
  for (const name of ['esbuild', 'ssh2', '@tailwindcss/node', 'jiti', 'lightningcss']) {
    assert.equal(isForbidden(name), true, `${name} must be forbidden`)
  }
})

// The gap this work closes. A leak through the database stack would have
// passed the check unchanged, which is the opposite of what it is relied on for.
test('the database stack is forbidden', () => {
  for (const name of ['@electric-sql/pglite', 'drizzle-orm', 'pg', 'postgres']) {
    assert.equal(isForbidden(name), true, `${name} must be forbidden`)
  }
})

// Reaching into a package is the same leak as importing it bare, and matching
// the exact string only would have let every one of these through.
test('a subpath of a server-only package is forbidden', () => {
  assert.equal(isForbidden('drizzle-orm/pg-core'), true)
  assert.equal(isForbidden('ssh2/lib/client'), true)
  assert.equal(isForbidden('@electric-sql/pglite/vector'), true)
})

// The check must stay a signal rather than noise: ordinary client dependencies
// share prefixes and substrings with the forbidden names.
test('client packages that merely resemble a forbidden name are allowed', () => {
  assert.equal(isForbidden('react'), false)
  assert.equal(isForbidden('pglite-react'), false)
  assert.equal(isForbidden('postgres-formatter'), false)
  assert.equal(isForbidden('@xyflow/react'), false)
  // 'pg' is forbidden; a different package starting with those letters is not.
  assert.equal(isForbidden('pgvector'), false)
})

test('a forbidden specifier is found in emitted code, in each import form', () => {
  assert.deepEqual(offendingSpecifiers('import x from "node:fs"'), ['node:fs'])
  assert.deepEqual(offendingSpecifiers("const m = await import('drizzle-orm/pg-core')"), ['drizzle-orm/pg-core'])
  assert.deepEqual(offendingSpecifiers('export{a}from"ssh2"'), ['ssh2'])
})

test('clean emitted code yields nothing', () => {
  assert.deepEqual(offendingSpecifiers('import React from "react"; import "./chunk.js"'), [])
})
