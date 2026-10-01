/** OpenCroft's GitHub Sponsors page, opened from the thank-you prompt and the account menu. */
export const SPONSOR_URL = 'https://github.com/sponsors/opencroft'

/**
 * Whether the thank-you prompt is due: once per calendar month, in the
 * viewer's local time. Due when it has never been seen, or was last seen
 * before the current month began. A stored value that is not a readable date
 * counts as never seen, so a bad value cannot silence the prompt for good.
 */
export function isSponsorPromptDue(seenAt: Date | string | null | undefined, now: Date): boolean {
  if (seenAt == null) {
    return true
  }
  const seen = new Date(seenAt).getTime()
  if (Number.isNaN(seen)) {
    return true
  }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  return seen < monthStart
}
