/**
 * Which cascade layer an extension's utilities are emitted into.
 *
 * An extension's stylesheet and the host's both carry Tailwind utilities, and
 * before this both emitted them into the same `utilities` layer. Within one
 * layer the later sheet wins, so whichever of the two loaded last decided every
 * collision — and neither answer is correct. Tailwind ranks utilities in a
 * single global sort, where a variant (`@[560px]:block`) outranks a plain
 * utility (`hidden`); that ranking exists only inside one sheet. Concatenating
 * two separately sorted sheets replaces rank with "whichever sheet came last".
 *
 * Both orders are therefore wrong, in opposite directions:
 *   - host sheet last  — its plain `.hidden` beats an extension's own variant,
 *     which is what put a full-page editor in its narrow layout with an
 *     unreachable primary action;
 *   - extension sheet last — its plain `.hidden` beats a host variant such as
 *     `sm:flex-row`, reaching the extension through shared `@ext/ui`
 *     components, which is the failure the current load order was chosen to
 *     prevent (see `_client/loader.ts`).
 *
 * So the split is by rank, not by sheet: variant-carrying extension utilities
 * are emitted into their own layer ordered after `utilities`, and plain ones
 * are left where they already were. Both statements above then hold at once.
 *
 * The pairing has four cells — {host, extension} × {plain, variant} — and the
 * two failures above are both a plain utility beating a variant. The fourth,
 * **host variant against extension variant**, is decided here rather than left
 * to fall out: the extension's wins, because its utilities now sit in a later
 * layer. Previously the host's won, by being in the later sheet. This is a
 * deliberate reversal, on the ground that inside an extension's own surface
 * the extension is the more specific author — the same reasoning that makes an
 * extension's variant beating a host's plain utility the correct outcome. It is
 * worth knowing that it is decided by LAYER here and not by rank: two variants
 * of different weight no longer compare on weight, and the extension's wins
 * whichever it is. Nothing observed depends on that yet, and if a case turns up
 * where the host's variant should win, this is the line it argues with.
 *
 * The layer name only has to appear in one of the two sheets. A name absent
 * from the other's `@layer` statement is appended after the names they share,
 * so this layer sorts last whichever sheet the browser parses first — which is
 * what stops the fix from being another thing that quietly depends on load
 * order.
 */
export const EXTENSION_UTILITY_LAYER = 'extension-utilities'

/**
 * Whether a Tailwind candidate carries at least one variant.
 *
 * Variants are separated from the utility by a `:` that is not nested. Three
 * nesting contexts make a colon inert, and all three are needed:
 *
 *   - brackets, `supports-[display:grid]:flex` — one variant, not two;
 *   - parens, `bg-(color:--brand)` — none;
 *   - **quotes**, `content-[']:a']` — none, because the `]` inside the string
 *     does not close the arbitrary value. Tracking only the first two reads
 *     that as a variant.
 *
 * A wrong answer is silent in both directions: a variant read as plain drops
 * into the lower layer and loses to the host again for that one class, and a
 * plain utility read as a variant outranks host variants it should lose to.
 * Neither shows up as a failure anywhere, which is why the accompanying test
 * checks this against Tailwind's own parser instead of against expectations —
 * and why that test carries quoted cases explicitly rather than relying on its
 * sample of Tailwind's vocabulary, which contains no arbitrary values and so
 * cannot reach this disagreement at all.
 *
 * Tailwind's parser is not used here directly: it hangs off the design system,
 * which `compile()` does not expose, so reaching it means a second
 * `__unstable__loadDesignSystem` per extension build — a load we do not need
 * and a dependency on an API whose name says not to. It stays in the test,
 * where a version bump is a message rather than an outage.
 */
export function hasVariant(candidate: string): boolean {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (const char of candidate) {
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (quote !== null) {
      if (char === quote) {
        quote = null
      }
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '[' || char === '(') {
      depth += 1
    } else if (char === ']' || char === ')') {
      // Clamped rather than allowed to go negative: an unbalanced candidate is
      // not a valid utility and Tailwind will emit nothing for it either way,
      // but a negative depth would hide every colon after it.
      depth = Math.max(0, depth - 1)
    } else if (char === ':' && depth === 0) {
      return true
    }
  }
  return false
}
