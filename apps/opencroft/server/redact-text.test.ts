import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  createStreamRedactor,
  knownValues,
  REDACTED,
  redactText,
  redactValues,
  STREAM_HOLD_MAX_CHARS,
} from './redact-text'

// Fixture values are placeholders; no real credential is used here.
const SECRET = 'example-token-0123456789'
// Holds a `/` and a `$`, so its percent-encoded and compose-escaped forms do not contain it
// literally and only the decoders can find it.
const OTHER = 'another/secret$value'
const VALUES = knownValues([OTHER, SECRET], 6)

// One line per form redactText recognises, with both line-end styles a stream carries.
const SAMPLE = [
  'starting service\n',
  `API_TOKEN=${SECRET}\n`,
  `prefix only: ${SECRET.slice(0, 14)}…\r\n`,
  `basic auth: ${Buffer.from(`alice:${SECRET}`).toString('base64')}\n`,
  `url: postgres://alice:${encodeURIComponent(OTHER)}@db/app\n`,
  `json: {"token":"${SECRET.replace(/-/g, '\\u002d')}"}\n`,
  `compose: pw=${OTHER.replace('$', '$$$$')}\n`,
  'typed url: https://bob:typed-password@db.example.com/main\n',
  'progress 10%\rprogress 50%\rprogress 100%\n',
  'done, no newline at the end',
].join('')

function streamed(chunks: string[], values: string[] = VALUES): string {
  const redactor = createStreamRedactor(values)
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.flush()
}

function chunksOf(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size))
  }
  return out
}

describe('knownValues', () => {
  test('drops values under the floor and duplicates, longest first', () => {
    assert.deepEqual(knownValues(['short', 'a-longer-one', 'medium', 'a-longer-one'], 6), ['a-longer-one', 'medium'])
  })
})

describe('redactValues', () => {
  test('removes every form of the sample credential', () => {
    const out = redactValues(SAMPLE, VALUES)
    assert.ok(!out.includes(SECRET))
    assert.ok(!out.includes(OTHER))
    assert.ok(!out.includes(SECRET.slice(0, 14)))
    assert.ok(!out.includes(Buffer.from(`alice:${SECRET}`).toString('base64')))
    assert.ok(!out.includes(encodeURIComponent(OTHER)))
    assert.ok(!out.includes('another/secret$$value'))
    assert.ok(!out.includes('\\u002d'))
    assert.ok(out.includes('starting service'))
  })

  test('finds a value visible only through compose escaping', () => {
    // No run of it in the escaped form is long enough to count as a prefix, so only undoing the
    // doubled `$` can find it.
    const value = 'pw$example-9876'
    assert.equal(redactValues('password: pw$$example-9876\n', [value]), `password: ${REDACTED}\n`)
  })

  test('a longer value is hidden whole when a shorter one is inside it', () => {
    assert.equal(
      redactValues('key placeholder-long-value', knownValues(['placeholder-', 'placeholder-long-value'], 6)),
      `key ${REDACTED}`,
    )
  })

  test('returns the text unchanged when there are no values', () => {
    assert.equal(redactValues(SAMPLE, []), SAMPLE)
  })
})

describe('redactText', () => {
  test('hides the password of a URL anywhere in the text, and keeps the rest of it', () => {
    assert.equal(
      redactText('connect postgresql://app:placeholder-pw@db.example.com/main now', []),
      `connect postgresql://app:${REDACTED}@db.example.com/main now`,
    )
  })

  test('leaves a URL without a password, and a user without one, as they are', () => {
    const text = 'see http://example.com and ssh://git@example.com/repo'
    assert.equal(redactText(text, []), text)
  })

  test('hides the URL password and the known values together', () => {
    const out = redactText(SAMPLE, VALUES)
    assert.ok(!out.includes('typed-password'))
    assert.ok(out.includes(`https://bob:${REDACTED}@db.example.com/main`))
    assert.ok(!out.includes(SECRET))
  })
})

describe('createStreamRedactor', () => {
  test('matches whole-text redaction for every two-piece split of the sample', () => {
    const whole = redactText(SAMPLE, VALUES)
    for (let cut = 0; cut <= SAMPLE.length; cut++) {
      assert.equal(streamed([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]), whole, `split at ${cut}`)
    }
  })

  test('matches whole-text redaction for pieces of every size from 1 to 16', () => {
    const whole = redactText(SAMPLE, VALUES)
    for (let size = 1; size <= 16; size++) {
      assert.equal(streamed(chunksOf(SAMPLE, size)), whole, `pieces of ${size}`)
    }
  })

  test('holds an unterminated line back instead of releasing half a credential', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(`API_TOKEN=${SECRET.slice(0, 8)}`), '')
    assert.equal(redactor.push(`${SECRET.slice(8)}\nnext`), `API_TOKEN=${REDACTED}\n`)
    assert.equal(redactor.flush(), 'next')
  })

  test('releases a line on a carriage return', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push('progress 10%\rprogress'), 'progress 10%\r')
  })

  test('flushes what is held, redacted, when the stream ends', () => {
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(`last words ${SECRET}`), '')
    assert.equal(redactor.flush(), `last words ${REDACTED}`)
    assert.equal(redactor.flush(), '')
  })

  test('releases an over-long unterminated run at its last whitespace, keeping the tail whole', () => {
    const filler = 'word '.repeat(Math.ceil(STREAM_HOLD_MAX_CHARS / 5) + 10)
    const text = `${filler}${SECRET}`
    const redactor = createStreamRedactor(VALUES)
    const released = redactor.push(text)
    assert.equal(released, filler)
    assert.equal(redactor.flush(), REDACTED)
  })

  test('releases an over-long run with no whitespace at all rather than holding it forever', () => {
    const run = 'x'.repeat(STREAM_HOLD_MAX_CHARS + 1)
    const redactor = createStreamRedactor(VALUES)
    assert.equal(redactor.push(run), run)
    assert.equal(redactor.flush(), '')
  })

  test('with no values, still hides URL passwords line by line and passes the rest through', () => {
    assert.equal(streamed(chunksOf(SAMPLE, 3), []), redactText(SAMPLE, []))
    assert.ok(streamed(chunksOf(SAMPLE, 3), []).includes(SECRET))
  })
})
