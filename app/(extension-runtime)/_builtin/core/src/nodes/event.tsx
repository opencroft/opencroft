import {
  React,
  NodeFrame,
  OutputHandle,
  dispatch,
  icons,
  toast,
  useReactFlow,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ext/ui';

const { useCallback, useEffect, useState } = React;

export type ScheduleMode = 'manual' | 'interval' | 'daily';

export type IntervalUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface EventData {
  mode: ScheduleMode;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  dailyTime: string;
  dailyDays: number[];
  lastRunAt?: number;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const UNIT_SECONDS: Record<IntervalUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
};

function getIntervalSeconds(data: EventData): number {
  const value = Math.max(1, data.intervalValue ?? 1);
  return value * UNIT_SECONDS[data.intervalUnit ?? 'minutes'];
}

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

export function computeNextRun(data: EventData, now: number = Date.now()): number | null {
  if (data.mode === 'interval') {
    const ms = getIntervalSeconds(data) * 1000;
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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatAbsolute(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelative(ms: number, now: number): string {
  const diff = ms - now;
  if (diff <= 0) {
    return 'now';
  }
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return `in ${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `in ${min}m ${sec % 60}s`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `in ${hr}h ${min % 60}m`;
  }
  const day = Math.floor(hr / 24);
  return `in ${day}d ${hr % 24}h`;
}

function scheduleSummary(data: EventData): string {
  if (data.mode === 'interval') {
    return `Every ${data.intervalValue ?? 1} ${data.intervalUnit ?? 'minutes'}`;
  }
  if (data.mode === 'daily') {
    const days = data.dailyDays ?? [];
    const time = data.dailyTime ?? '09:00';
    if (days.length === 0) {
      return `Daily ${time} (no days)`;
    }
    if (days.length === 7) {
      return `Daily ${time}`;
    }
    return `${days.map((d) => DAY_LABELS[d]).join(' ')} ${time}`;
  }
  return 'Manual';
}

function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function EventNode({ id, data, selected }: { id: string; data: EventData; selected?: boolean }) {
  const [running, setRunning] = useState(false);
  const { setNodes } = useReactFlow();
  const now = useNow(1000);
  const next = computeNextRun(data, now);
  const summary = scheduleSummary(data);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      await dispatch(id, 'run');
      setNodes((nds: { id: string; data: Record<string, unknown> }[]) => nds.map((n) => (
        n.id === id ? { ...n, data: { ...n.data, lastRunAt: Date.now() } } : n
      )));
    } catch (err) {
      toast.error(`Event run failed: ${String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [id, setNodes]);

  return (
    <NodeFrame
      icon={icons.AlarmClock}
      title='Event'
      subtitle={summary}
      selected={selected ?? false}
      loading={running}
      output={<OutputHandle type='execution-context' id='exec-out' />}
      extra={
        <div className='flex items-center justify-end gap-1 text-[10px] text-muted-foreground'>
          {next ? <span>{formatRelative(next, now)}</span> : null}
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={run}
            disabled={running}
          >
            <icons.Play className='h-2.5 w-2.5 shrink-0' />
          </Button>
        </div>
      }
    />
  );
}

interface InspectorProps {
  nodeId: string;
  data: EventData;
  updateData: (p: Partial<EventData>) => void;
}

function IntervalFields({ data, updateData }: InspectorProps) {
  return (
    <div className='flex flex-col gap-1'>
      <Label className='text-xs'>Run every</Label>
      <div className='flex items-center gap-1'>
        <Input
          type='number'
          min={1}
          value={String(data.intervalValue ?? 1)}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ intervalValue: Math.max(1, parseInt(e.target.value, 10) || 1) })}
          className='h-8 text-xs w-20'
        />
        <Select
          value={data.intervalUnit ?? 'minutes'}
          onValueChange={(v: IntervalUnit) => updateData({ intervalUnit: v })}
        >
          <SelectTrigger className='h-8 text-xs flex-1'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='seconds'>Seconds</SelectItem>
            <SelectItem value='minutes'>Minutes</SelectItem>
            <SelectItem value='hours'>Hours</SelectItem>
            <SelectItem value='days'>Days</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function DailyFields({ data, updateData }: InspectorProps) {
  const days = data.dailyDays ?? [];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    updateData({ dailyDays: next.sort((a, b) => a - b) });
  };
  return (
    <>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Time</Label>
        <Input
          type='time'
          value={data.dailyTime ?? '09:00'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ dailyTime: e.target.value })}
          className='h-8 text-xs'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Days</Label>
        <div className='flex gap-1'>
          {DAY_LABELS.map((label, i) => {
            const active = days.includes(i);
            return (
              <button
                key={label}
                type='button'
                onClick={() => toggleDay(i)}
                className={
                  'flex-1 inline-flex items-center justify-center rounded h-7 text-[10px] font-medium transition-colors '
                  + (active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted-foreground/10')
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function NextRunCard({ data }: { data: EventData }) {
  const now = useNow(1000);
  const next = computeNextRun(data, now);
  return (
    <div className='flex flex-col gap-1 rounded border px-2 py-1.5 text-[11px]'>
      <span className='text-muted-foreground'>Next run</span>
      {next ? (
        <span className='font-mono'>
          {formatAbsolute(next)}
          <span className='text-muted-foreground'> ({formatRelative(next, now)})</span>
        </span>
      ) : (
        <span className='italic text-muted-foreground'>Not scheduled</span>
      )}
      {data.lastRunAt ? (
        <span className='text-muted-foreground mt-1'>
          Last run: <span className='font-mono'>{formatAbsolute(data.lastRunAt)}</span>
        </span>
      ) : null}
    </div>
  );
}

export function EventInspector(props: InspectorProps) {
  const { data, updateData } = props;
  const mode = data.mode ?? 'manual';
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Mode</Label>
        <Select value={mode} onValueChange={(v: ScheduleMode) => updateData({ mode: v })}>
          <SelectTrigger className='h-8 text-xs'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='manual'>Manual</SelectItem>
            <SelectItem value='interval'>Interval</SelectItem>
            <SelectItem value='daily'>Daily</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === 'interval' ? <IntervalFields {...props} /> : null}
      {mode === 'daily' ? <DailyFields {...props} /> : null}
      <NextRunCard data={data} />
    </div>
  );
}

export const EVENT_HANDLES = [
  { id: 'exec-out', contextType: 'execution-context', role: 'source' as const, label: 'Handler' },
];

export function eventExposeOutput(handleId: string, data: unknown): { mode: ScheduleMode } | undefined {
  if (handleId !== 'exec-out') {
    return undefined;
  }
  const d = data as EventData;
  return { mode: d.mode ?? 'manual' };
}
