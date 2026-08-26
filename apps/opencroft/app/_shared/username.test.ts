import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_USERNAME_PREFIX,
  checkUsername,
  isAgentUsername,
  usernameFromDisplayName,
  usernameRefusalMessage,
} from './username'

// ---------------------------------------------------------------------------
// The grammar. Lowercase letters, digits and dots -- and nothing else, which
// is what makes uniqueness a plain comparison everywhere downstream rather
// than a case-insensitive one somebody has to remember to fold.
// ---------------------------------------------------------------------------

test('a username may be lowercase letters, digits and dots', () => {
  for (const value of ['ivan', 'alice', 'agent.alice', 'a1.b2', '123', 'x']) {
    assert.equal(checkUsername(value, 'agent').ok, true, `${value} should be allowed`)
  }
})

test('uppercase is refused rather than folded', () => {
  // The whole reason comparison downstream is plain: if this were accepted
  // and lowercased, every store and every lookup would have to remember to
  // fold, and the one that forgot would be the bug.
  assert.deepEqual(checkUsername('Ivan', 'user'), { ok: false, refusal: 'bad-characters' })
})

test('everything outside the alphabet is refused', () => {
  for (const value of ['iv an', 'ivan!', 'iv-an', 'iv_an', 'ваня', 'a/b']) {
    assert.equal(checkUsername(value, 'user').refusal, 'bad-characters', `${value} should be refused`)
  }
})

test('an empty username is refused as empty, not as bad characters', () => {
  // Two different things to tell someone, so they stay two refusals.
  assert.deepEqual(checkUsername('', 'user'), { ok: false, refusal: 'empty' })
})

// ---------------------------------------------------------------------------
// The reserved namespace -- the whole reason the two identity spaces cannot
// collide by construction rather than by convention.
// ---------------------------------------------------------------------------

test('a person cannot take the agent namespace', () => {
  assert.deepEqual(checkUsername('agent.alice', 'user'), { ok: false, refusal: 'reserved-prefix' })
})

test('an agent may hold what a person may not', () => {
  // The same string, the same grammar, opposite answers -- which is why the
  // kind is a required argument and never defaulted.
  assert.equal(checkUsername('agent.alice', 'agent').ok, true)
})

test('a person may hold "agent" itself, because it is not the prefix', () => {
  // The prefix carries its own dot. Refusing a bare "agent" too would be a
  // rule nobody stated, and would take a legitimate handle for no gain.
  assert.equal(checkUsername('agent', 'user').ok, true)
  assert.equal(isAgentUsername('agent'), false)
  assert.equal(isAgentUsername('agent.alice'), true)
})

test('the prefix alone identifies no agent', () => {
  assert.deepEqual(checkUsername(AGENT_USERNAME_PREFIX, 'agent'), { ok: false, refusal: 'prefix-only' })
})

test('every refusal has something to say', () => {
  // Guards a refusal added to the union without a message, which would
  // otherwise surface to a person as undefined.
  for (const refusal of ['empty', 'bad-characters', 'reserved-prefix', 'prefix-only'] as const) {
    assert.ok(usernameRefusalMessage(refusal).length > 0, `${refusal} needs a message`)
  }
})

// ---------------------------------------------------------------------------
// Deriving a first username. Runs once, when an account first needs a handle
// -- never again on a rename, which is the property the whole identifier
// split exists to protect.
// ---------------------------------------------------------------------------

test('a display name becomes a usable handle', () => {
  assert.equal(usernameFromDisplayName('Ada Lovelace'), 'ada.lovelace')
  assert.equal(usernameFromDisplayName('  Ivan  '), 'ivan')
})

test('a run of unusable characters collapses to one dot, not to nothing', () => {
  // "Ada Lovelace" and "AdaLovelace" are different people's answers to what
  // they are called, and must not derive the same handle.
  assert.notEqual(usernameFromDisplayName('Ada Lovelace'), usernameFromDisplayName('AdaLovelace'))
  assert.equal(usernameFromDisplayName('AdaLovelace'), 'adalovelace')
  assert.equal(usernameFromDisplayName("Anne-Marie O'Brien"), 'anne.marie.o.brien')
})

test('a derived handle never begins or ends with a separator', () => {
  assert.equal(usernameFromDisplayName('!Ivan!'), 'ivan')
  assert.equal(usernameFromDisplayName('...a...'), 'a')
})

test('a display name with nothing usable derives nothing, rather than something invented', () => {
  // The caller has to ask. A generated handle would be worse than a question,
  // because it becomes durable the moment anything references it.
  assert.equal(usernameFromDisplayName('!!!'), '')
  assert.equal(usernameFromDisplayName('🙂'), '')
})

test('whatever derivation produces is itself a valid username, or empty', () => {
  // The two halves of this module have to agree: a derived candidate that the
  // checker would refuse is a backfill that cannot be stored.
  for (const name of ['Ada Lovelace', 'Ivan', "Anne-Marie O'Brien", 'X Æ A-12', '123']) {
    const derived = usernameFromDisplayName(name)
    if (derived !== '') {
      assert.equal(checkUsername(derived, 'user').ok, true, `${name} derived ${derived}, which is not valid`)
    }
  }
})
