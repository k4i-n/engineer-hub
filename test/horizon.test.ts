import assert from "node:assert/strict";
import { test } from "node:test";
import { series, span } from "../src/horizon.ts";

const TZ = "Asia/Tokyo";
const now = new Date("2026-11-19T03:00:00Z");

test("a day count starts that many days back and compares with the same length before it", () => {
  assert.deepEqual(span("7d", now, TZ), {
    from: "2026-11-12T15:00:00.000Z",
    first: "2026-11-13",
    previous: { from: "2026-11-05T15:00:00.000Z", to: "2026-11-12T15:00:00.000Z" },
    label: "in the last 7 days",
  });
});

test("this week starts on Monday and compares with the same days of last week", () => {
  assert.deepEqual(span("week", now, TZ), {
    from: "2026-11-15T15:00:00.000Z",
    first: "2026-11-16",
    previous: { from: "2026-11-08T15:00:00.000Z", to: "2026-11-12T15:00:00.000Z" },
    label: "this week",
  });
});

test("this month compares with the same days of last month, capped at its length", () => {
  assert.deepEqual(span("month", now, TZ).previous, {
    from: "2026-09-30T15:00:00.000Z",
    to: "2026-10-19T15:00:00.000Z",
  });
  assert.deepEqual(span("month", new Date("2026-03-31T03:00:00Z"), TZ).previous, {
    from: "2026-01-31T15:00:00.000Z",
    to: "2026-02-28T15:00:00.000Z",
  });
});

test("all time covers everything and has nothing to compare with", () => {
  assert.deepEqual(span("all", now, TZ), { from: "", first: null, previous: null, label: "all time" });
});

test("the series counts per day up to a month, then per week, then per month", () => {
  assert.deepEqual(series("2026-11-17", "2026-11-19", ["2026-11-17", "2026-11-19", "2026-11-19"]), [
    { day: "2026-11-17", n: 1, label: "11-17" },
    { day: "2026-11-18", n: 0, label: "11-18" },
    { day: "2026-11-19", n: 2, label: "11-19" },
  ]);
  const weeks = series("2026-09-02", "2026-11-19", ["2026-09-02", "2026-09-06", "2026-11-19"]);
  assert.equal(weeks.length, 12);
  assert.deepEqual(weeks[0], { day: "2026-08-31", n: 2, label: "week of 08-31" });
  assert.deepEqual(weeks.at(-1), { day: "2026-11-16", n: 1, label: "week of 11-16" });
  assert.deepEqual(series("2025-01-15", "2026-11-19", ["2025-01-20", "2026-11-01"]).at(-1), {
    day: "2026-11-01",
    n: 1,
    label: "2026-11",
  });
});
