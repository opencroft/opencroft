const UNITS = [
  { size: 1e3, suffix: 'k', decimalsBelow: 100 },
  { size: 1e6, suffix: 'M', decimalsBelow: 10 },
  { size: 1e9, suffix: 'B', decimalsBelow: 10 },
  { size: 1e12, suffix: 'T', decimalsBelow: 10 },
] as const

/**
 * A count, short: 950, 12.4k, 680k, 1.2M, 3B, 4T. Negative counts read as 0.
 *
 * k / M / B / T covers any total a day of cache reads can reach. One decimal
 * while the figure is small in its unit, dropped once it is noise, and a
 * trailing ".0" trimmed so a round million reads "1M" and not "1.0M".
 */
export function formatCompactNumber(n: number): string {
  const value = Math.max(0, n)
  if (Math.round(value) < 1000) {
    return String(Math.round(value))
  }
  // A figure that rounds to 1000 of its unit reads as 1 of the next one: 999,999 is 1M, not 1000k.
  let unit = 0
  let text = inUnit(value, unit)
  while (Number(text) >= 1000 && unit < UNITS.length - 1) {
    unit += 1
    text = inUnit(value, unit)
  }
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}${UNITS[unit].suffix}`
}

function inUnit(value: number, unit: number): string {
  const scaled = value / UNITS[unit].size
  return scaled.toFixed(scaled < UNITS[unit].decimalsBelow ? 1 : 0)
}
