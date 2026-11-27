import { afterDuration } from "./util.ts";

export const INTERVALS = {
  syncEvery: ["5m", "8h"],
  fetchEvery: ["1m", "60m"],
  awayAfter: ["1m", "60m"],
  awayEvery: ["5m", "4h"],
  watchFor: ["30m", "24h"],
  backupEvery: ["1h", "7d"],
} as const;

export type IntervalKey = keyof typeof INTERVALS;

export const KEEP_RANGE = [1, 100] as const;

const HOUR = 60;
const DAY = 24 * HOUR;

export function isInterval(key: string): key is IntervalKey {
  return Object.hasOwn(INTERVALS, key);
}

export function minutes(value: string, flag: string): number {
  return Date.parse(afterDuration(new Date(0), value, flag)) / 60_000;
}

export function durationOf(total: number): string {
  if (total % DAY === 0) return `${total / DAY}d`;
  if (total % HOUR === 0) return `${total / HOUR}h`;
  return `${total}m`;
}

export function intervalError(key: IntervalKey, value: unknown): string | undefined {
  const [low, high] = INTERVALS[key];
  const range = `${key} takes a duration from ${low} to ${high}, e.g. 45m or 3h`;
  try {
    const n = minutes(String(value), key);
    return n >= minutes(low, key) && n <= minutes(high, key) ? undefined : range;
  } catch {
    return range;
  }
}

function step(at: number): number {
  if (at < HOUR) return 5;
  if (at < 4 * HOUR) return 15;
  if (at < DAY) return HOUR;
  return DAY;
}

export function ladder(key: IntervalKey): string[] {
  const [low, high] = INTERVALS[key];
  const end = minutes(high, key);
  const out: string[] = [];
  for (let at = minutes(low, key); at <= end; at = at - (at % step(at)) + step(at)) out.push(durationOf(at));
  return out;
}

export function intervalText(value: string): string {
  const total = minutes(value, "interval");
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const mins = total % HOUR;
  const parts = [
    days === 0 ? "" : `${days} ${days === 1 ? "day" : "days"}`,
    hours === 0 ? "" : `${hours} ${hours === 1 ? "hour" : "hours"}`,
    mins === 0 ? "" : `${mins} min`,
  ];
  return parts.filter((p) => p !== "").join(" ");
}
