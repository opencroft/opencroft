// The history settings (Settings → Agent → Sessions): how much of each
// session's chat history the recording keeps. Both are off by default, and
// off keeps everything: the whole history of every session, archived threads
// included, as the recording holds it.
//
// Stored in the settings table; the event store trims by whatever was last
// handed to it (setHistoryRetention), on its own writes for the limit and on
// the sweep below for both.

import {
  type HistoryRetention,
  setHistoryRetention,
  sweepHistory,
} from '@/app/_authed/(agent)/_server/session-event-store'
import { getSetting, upsertSetting } from '@/server/data'

const SETTING_ID = 'agent-transcript-retention'

/** Keep everything: the default, and what each setting left empty means. */
export const KEEP_ALL: HistoryRetention = { maxEntries: null, cleanupAfterDays: null }

// The bounds a setting is held to. A limit of one entry still keeps the
// newest turn whole, and a century is as long as "keep" needs to mean.
const MAX_ENTRIES_LIMIT = 10_000_000
const MAX_DAYS = 36_500

// How often the recording is swept by the settings: the age cut moves with
// the clock, and an hour late is nothing against a cut counted in days.
const SWEEP_EVERY_MS = 60 * 60 * 1000

const globalRef = globalThis as typeof globalThis & { __transcriptRetentionTimer?: ReturnType<typeof setInterval> }

// A setting's value: a whole number within its bounds, or null for off.
function bounded(value: unknown, max: number): number | null | undefined {
  if (value === null || value === undefined) {
    return null
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max ? value : undefined
}

/**
 * The settings in `value`, or null when they are not settings: each field a
 * whole number within its bounds, or null (or absent) for off.
 */
export function parseRetention(value: unknown): HistoryRetention | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const fields = value as { maxEntries?: unknown; cleanupAfterDays?: unknown }
  const maxEntries = bounded(fields.maxEntries, MAX_ENTRIES_LIMIT)
  const cleanupAfterDays = bounded(fields.cleanupAfterDays, MAX_DAYS)
  if (maxEntries === undefined || cleanupAfterDays === undefined) {
    return null
  }
  return { maxEntries, cleanupAfterDays }
}

/** The stored settings; keep-everything when nothing is stored, or what is stored is not settings. */
export async function readTranscriptRetention(): Promise<HistoryRetention> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return KEEP_ALL
  }
  try {
    return parseRetention(JSON.parse(row.data)) ?? KEEP_ALL
  } catch {
    return KEEP_ALL
  }
}

/**
 * Store new settings and apply them: to every write from now on, and to the
 * history already recorded by a sweep that starts now and is not waited for.
 * Refuses what is not settings.
 */
export async function writeTranscriptRetention(next: unknown): Promise<HistoryRetention> {
  const settings = parseRetention(next)
  if (!settings) {
    throw new Error(
      `A history setting is a whole number, at most ${MAX_ENTRIES_LIMIT} events or ${MAX_DAYS} days, or empty for none.`,
    )
  }
  await upsertSetting(SETTING_ID, JSON.stringify(settings))
  setHistoryRetention(settings)
  sweep()
  return settings
}

function sweep(): void {
  void sweepHistory().catch((error: unknown) => {
    console.error('[transcript-retention] sweeping the recorded history failed', error)
  })
}

/**
 * Load the stored settings into the event store and sweep by them now and
 * every hour. Once per process; a second call only reloads the settings.
 */
export async function startTranscriptRetention(): Promise<void> {
  setHistoryRetention(await readTranscriptRetention())
  if (globalRef.__transcriptRetentionTimer) {
    return
  }
  const timer = setInterval(sweep, SWEEP_EVERY_MS)
  // A sweep waiting to run is not a reason to hold the process open.
  timer.unref?.()
  globalRef.__transcriptRetentionTimer = timer
  sweep()
}
