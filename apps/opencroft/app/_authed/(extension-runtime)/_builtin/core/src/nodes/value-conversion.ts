// How Convert turns a text, a number or a boolean into another of the three.
//
// Pure: no runtime imports.

import { BOOLEAN_TYPE, NUMBER_TYPE, type PrimitiveValue, valueAsText } from '@opencroft/core/values'

export type Converted = { ok: true; value: PrimitiveValue } | { ok: false; error: string }

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

/**
 * `value` as a value of `to` (qualified: text, number or boolean), or why it
 * has none:
 * - to text, as Format writes a placeholder without a format (`valueAsText`);
 * - to a number, a text that is a decimal number (`42`, `-0.5`, `1e3`), true
 *   as 1 and false as 0;
 * - to a boolean, `true` or `1` as true and `false` or `0` as false, from a
 *   text or a number.
 * A value already of `to` is itself.
 */
export function convertValue(value: PrimitiveValue, to: string): Converted {
  switch (to) {
    case NUMBER_TYPE: {
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { ok: true, value: Number(value) }
      }
      const text = value.trim()
      const n = NUMBER_TEXT.test(text) ? Number(text) : Number.NaN
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `"${value}" is not a number` }
    }
    case BOOLEAN_TYPE: {
      if (typeof value === 'boolean') {
        return { ok: true, value }
      }
      const text = valueAsText(value).trim()
      if (text === 'true' || text === '1') {
        return { ok: true, value: true }
      }
      if (text === 'false' || text === '0') {
        return { ok: true, value: false }
      }
      return { ok: false, error: `"${value}" is not true, false, 1 or 0` }
    }
    default:
      return { ok: true, value: valueAsText(value) }
  }
}
