import type { Day } from "./charts.ts";
import { shiftDate, startOfDayIso, today } from "./util.ts";

export const HORIZONS = ["7d", "14d", "30d", "week", "month", "all"];

export type Span = {
  from: string;
  first: string | null;
  previous: { from: string; to: string } | null;
  label: string;
};

const DAILY_MAX = 31;
const WEEKLY_MAX = 366;

function weekday(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function daysBetween(first: string, last: string): number {
  return Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1;
}

export function span(horizon: string, now: Date, timezone: string): Span {
  const day = today(now, timezone);
  const at = (d: string) => startOfDayIso(d, timezone);
  if (horizon === "all") return { from: "", first: null, previous: null, label: "all time" };
  if (horizon === "week") {
    const first = shiftDate(day, -weekday(day));
    const elapsed = weekday(day) + 1;
    const before = shiftDate(first, -7);
    return {
      from: at(first),
      first,
      previous: { from: at(before), to: at(shiftDate(before, elapsed)) },
      label: "this week",
    };
  }
  if (horizon === "month") {
    const first = `${day.slice(0, 8)}01`;
    const start = new Date(`${first}T00:00:00Z`);
    const before = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const elapsed = Math.min(Number(day.slice(8)), daysBetween(before, shiftDate(first, -1)));
    return {
      from: at(first),
      first,
      previous: { from: at(before), to: at(shiftDate(before, elapsed)) },
      label: "this month",
    };
  }
  const n = Number.parseInt(horizon, 10);
  const first = shiftDate(day, 1 - n);
  return {
    from: at(first),
    first,
    previous: { from: at(shiftDate(first, -n)), to: at(first) },
    label: `in the last ${n} days`,
  };
}

function bucketStarts(first: string, last: string): { starts: string[]; label: (d: string) => string } {
  const length = daysBetween(first, last);
  if (length <= DAILY_MAX) {
    return { starts: Array.from({ length }, (_, i) => shiftDate(first, i)), label: (d) => d.slice(5) };
  }
  if (length <= WEEKLY_MAX) {
    const monday = shiftDate(first, -weekday(first));
    const weeks = Math.ceil(daysBetween(monday, last) / 7);
    return {
      starts: Array.from({ length: weeks }, (_, i) => shiftDate(monday, i * 7)),
      label: (d) => `week of ${d.slice(5)}`,
    };
  }
  const starts: string[] = [];
  for (let d = `${first.slice(0, 8)}01`; d <= last; ) {
    starts.push(d);
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    d = next.toISOString().slice(0, 10);
  }
  return { starts, label: (d) => d.slice(0, 7) };
}

export function series(first: string, last: string, days: string[]): Day[] {
  const { starts, label } = bucketStarts(first, last);
  const counts = starts.map(() => 0);
  for (const day of days) {
    const i = starts.findLastIndex((s) => s <= day);
    if (i >= 0) counts[i] = (counts[i] ?? 0) + 1;
  }
  return starts.map((day, i) => ({ day, n: counts[i] ?? 0, label: label(day) }));
}
