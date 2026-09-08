import assert from 'node:assert/strict'
import test from 'node:test'

import { __unstable__loadDesignSystem } from '@tailwindcss/node'

import { hasVariant } from './css-cascade-layers'
import { projectRoot } from './paths'

// Tailwind's own parser, used as the oracle this splitter is checked against.
// It is reached through an API whose name says it is unstable, and that is why
// it lives here and not in the compiler: a version bump then breaks this test,
// which is a message, rather than breaking every extension build, which is an
// outage.
const designSystem = await __unstable__loadDesignSystem("@import 'tailwindcss';", { base: projectRoot() })

function tailwindSaysHasVariant(candidate: string): boolean {
  return [...designSystem.parseCandidate(candidate)].some((parsed) => parsed.variants.length > 0)
}

// The container-query variants that had to ship behind an `!` flag while this
// collision was unfixed, plus the shapes that make a naive split wrong. Every
// colon in the second group is inside brackets or parens and separates nothing.
const CARRIES_A_VARIANT = [
  '@[560px]:block',
  '@[560px]:block!',
  '@[560px]:grid-cols-[230px_minmax(0,1fr)]!',
  '@[520px]:inline-flex!',
  '@[720px]:flex!',
  '@[720px]:hidden!',
  'md:flex',
  'hover:bg-red-500',
  'dark:md:hover:underline',
  '[&:hover]:flex',
  'supports-[display:grid]:flex',
  'group-hover:[&>svg]:rotate-90',
  '@[560px]:bg-(color:--brand)',
]

const PLAIN = [
  'hidden',
  'flex',
  'inline-flex',
  'grid-cols-1',
  'bg-[url(a:b)]',
  'bg-(color:--brand)',
  '[mask-type:luminance]',
  'grid-cols-[230px_minmax(0,1fr)]',
  '-mt-4',
  'size-6',
  'shrink-0',
]

// Quoted arbitrary values, where a `]` inside the string does not close the
// arbitrary value. These are here as their own group because the sampled
// cross-check below CANNOT reach them: `getClassList` enumerates Tailwind's
// declared vocabulary, which contains no arbitrary values at all, so a sample
// drawn from it can never contain a quote. A predicate tracking only brackets
// and parens reads every one of these as carrying a variant, and would put a
// plain utility in the layer that outranks host variants — silently.
const QUOTED_PLAIN = [
  "content-[']:a']",
  'content-["]:a"]',
  "[content:']:x']",
  "content-['a\\']:b']",
  "bg-[url('a:b')]",
  "content-['hello']",
]

const QUOTED_WITH_VARIANT = ["before:content-[']:a']", 'hover:before:content-["]:x"]']

test('a candidate carrying a variant is recognised, including when the colon is not the separator', () => {
  for (const candidate of CARRIES_A_VARIANT) {
    assert.equal(hasVariant(candidate), true, `expected a variant in ${candidate}`)
  }
})

test('a plain candidate is not mistaken for one, when its colon is inside an arbitrary value', () => {
  for (const candidate of PLAIN) {
    assert.equal(hasVariant(candidate), false, `expected no variant in ${candidate}`)
  }
})

test("the split agrees with Tailwind, over Tailwind's own vocabulary rather than a list we thought of", () => {
  // The corpus above is ours and therefore only covers cases we imagined. This
  // one is built from the utilities and variants Tailwind itself declares, so
  // it exercises shapes nobody here wrote down — which is the half where a
  // silent misparse would otherwise live.
  const utilities = designSystem.getClassList().map(([name]) => name)
  // Variants that stand on their own: no value to supply and not arbitrary, so
  // `<variant>:<utility>` is a candidate Tailwind will actually parse.
  const variants = designSystem
    .getVariants()
    .filter((variant) => variant.values.length === 0 && !variant.isArbitrary)
    .map((variant) => variant.name)
    .slice(0, 6)

  assert.ok(utilities.length > 1000, `expected Tailwind to declare many utilities, got ${utilities.length}`)
  assert.equal(variants.length, 6, 'expected at least six standalone variants to sample')

  // Every 97th, so the sample crosses the whole alphabetised list rather than
  // sitting in whichever prefix sorts first, and the run stays quick.
  let checked = 0
  for (let i = 0; i < utilities.length; i += 97) {
    const utility = utilities[i]
    assert.equal(hasVariant(utility), tailwindSaysHasVariant(utility), `plain: ${utility}`)
    checked += 1
    for (const variant of variants) {
      for (const candidate of [`${variant}:${utility}`, `dark:${variant}:${utility}`, `${variant}:${utility}!`]) {
        assert.equal(hasVariant(candidate), tailwindSaysHasVariant(candidate), `varied: ${candidate}`)
        checked += 1
      }
    }
  }
  // A loop that silently ran zero times would pass every assertion above.
  assert.ok(checked > 1000, `expected a substantial sample, only compared ${checked} candidates`)
})

test('a quoted arbitrary value does not make a colon a separator', () => {
  // The case the sample cannot produce, so it is asserted directly.
  for (const candidate of QUOTED_PLAIN) {
    assert.equal(hasVariant(candidate), false, `expected no variant in ${candidate}`)
    assert.equal(tailwindSaysHasVariant(candidate), false, `Tailwind disagrees about ${candidate}`)
  }
  for (const candidate of QUOTED_WITH_VARIANT) {
    assert.equal(hasVariant(candidate), true, `expected a variant in ${candidate}`)
    assert.equal(tailwindSaysHasVariant(candidate), true, `Tailwind disagrees about ${candidate}`)
  }
})

test('the hand-written corpus itself agrees with Tailwind', () => {
  // Guards the corpus, not the splitter: an entry filed under the wrong heading
  // would make the tests above pass while asserting the wrong thing.
  for (const candidate of [...CARRIES_A_VARIANT, ...PLAIN, ...QUOTED_PLAIN, ...QUOTED_WITH_VARIANT]) {
    assert.equal(
      hasVariant(candidate),
      tailwindSaysHasVariant(candidate),
      `${candidate} is filed under the wrong heading in this test`,
    )
  }
})
