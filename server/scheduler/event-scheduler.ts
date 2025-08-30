import { dispatchNodeAction } from '@/app/(extension-runtime)/_server/node-actions';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import { toastStore } from '@/lib/toast-store';

type ScheduleMode = 'manual' | 'interval' | 'daily';
type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

interface EventData {
  mode?: ScheduleMode;
  intervalValue?: number;
  intervalUnit?: IntervalUnit;
  dailyTime?: string;
  dailyDays?: number[];
  lastRunAt?: number;
}

interface GraphNode {
  id?: string;
  type?: string;
  data?: EventData;
}

const TICK_MS = 5000;
const UNIT_SECONDS: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

function computeNextDaily(time: string, days: number[], lastRunAt: number | null, now: number): number | null {
  if (days.length === 0) {
    return null;
  }
  const parts = time.split(':');
  const hh = parseInt(parts[0], 10) || 0;
  const mm = parseInt(parts[1], 10) || 0;
  const allowed = new Set(days);
  const baseline = Math.max(now, (lastRunAt ?? 0) + 60_000);
  const start = new Date(baseline);
  for (let offset = 0; offset < 8; offset++) {
    const d = new Date(start);
    d.setDate(d.getDate() + offset);
    d.setHours(hh, mm, 0, 0);
    if (!allowed.has(d.getDay())) {
      continue;
    }
    if (d.getTime() <= baseline) {
      continue;
    }
    return d.getTime();
  }
  return null;
}

function computeNextRun(data: EventData, now: number): number | null {
  if (data.mode === 'interval') {
    const value = Math.max(1, data.intervalValue ?? 1);
    const unit = data.intervalUnit ?? 'minutes';
    const ms = value * UNIT_SECONDS[unit] * 1000;
    if (!data.lastRunAt) {
      return now + ms;
    }
    return data.lastRunAt + ms;
  }
  if (data.mode === 'daily') {
    return computeNextDaily(data.dailyTime ?? '09:00', data.dailyDays ?? [], data.lastRunAt ?? null, now);
  }
  return null;
}

function collectEventNodes(): GraphNode[] {
  const r = getSpacesRegistry();
  const events: GraphNode[] = [];
  for (const summary of r.list()) {
    const space = r.getBySlug(summary.slug);
    if (!space) {
      continue;
    }
    for (const node of space.graph.nodes as unknown as GraphNode[]) {
      if (node.type === 'event') {
        events.push(node);
      }
    }
  }
  return events;
}

const inFlight = new Set<string>();

async function fireDue(node: GraphNode): Promise<void> {
  if (!node.id) {
    return;
  }
  if (inFlight.has(node.id)) {
    return;
  }
  inFlight.add(node.id);
  try {
    await dispatchNodeAction(node.id, 'run');
    toastStore.broadcast({ type: 'graph_updated' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[event-scheduler] ${node.id} failed: ${message}`);
  } finally {
    inFlight.delete(node.id);
  }
}

async function tick(): Promise<void> {
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  const now = Date.now();
  const events = collectEventNodes();
  for (const node of events) {
    const data = node.data ?? {};
    const next = computeNextRun(data, now);
    if (next === null) {
      continue;
    }
    if (next > now) {
      continue;
    }
    fireDue(node);
  }
}

interface SchedulerHandle {
  timer: NodeJS.Timeout;
}

const globalForScheduler = globalThis as unknown as { __EVENT_SCHEDULER__?: SchedulerHandle };

export function startEventScheduler(): void {
  if (globalForScheduler.__EVENT_SCHEDULER__) {
    return;
  }
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[event-scheduler] tick failed', err);
    });
  }, TICK_MS);
  globalForScheduler.__EVENT_SCHEDULER__ = { timer };
  console.log(`[event-scheduler] started (tick every ${TICK_MS}ms)`);
}
