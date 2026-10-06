import { availableParallelism } from 'node:os'

// How many test files may run at once: half the cores, leaving the rest to
// whatever else shares the machine. OPENCROFT_TEST_CONCURRENCY overrides it;
// `1` gives a serial run.
export function testConcurrency() {
  const requested = Number(process.env.OPENCROFT_TEST_CONCURRENCY)
  if (Number.isInteger(requested) && requested > 0) {
    return requested
  }
  return Math.max(1, Math.floor(availableParallelism() / 2))
}
