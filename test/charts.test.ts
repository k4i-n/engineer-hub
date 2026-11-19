import assert from "node:assert/strict";
import { test } from "node:test";
import { arcs, area, half, percent, ring } from "../src/charts.ts";

test("donut arcs start where the previous one ended and leave a gap only between shown slices", () => {
  const slices = [
    { label: "a", value: 3, tone: "blue" },
    { label: "b", value: 0, tone: "grey" },
    { label: "c", value: 1, tone: "amber" },
  ];
  assert.deepEqual(arcs(slices), [
    { start: 0, length: 73.8 },
    { start: 75, length: 0 },
    { start: 75, length: 23.8 },
  ]);
  assert.deepEqual(arcs([{ label: "a", value: 2, tone: "blue" }]), [{ start: 0, length: 100 }]);
  assert.deepEqual(arcs([{ label: "a", value: 0, tone: "blue" }]), [{ start: 0, length: 0 }]);
});

test("progress shapes draw no arc at zero and turn complete at 100", () => {
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(2, 3), 67);
  assert.doesNotMatch(ring(0, 20, 3, false), /class="arc"/);
  assert.match(ring(40, 20, 3, false), /stroke-dasharray="40 100"/);
  assert.match(half(100, 30, 4, true), /class="half complete"/);
});

test("the area chart has one hover target per day, labelled with the day and count", () => {
  const html = area(
    [
      { day: "2026-11-18", n: 0 },
      { day: "2026-11-19", n: 4 },
    ],
    "steps",
  );
  assert.match(html, /points="0,95 100,10"/);
  assert.deepEqual(
    [...html.matchAll(/data-tip="([^"]+)"/g)].map((m) => m[1]),
    ["11-18 · 0 steps", "11-19 · 4 steps"],
  );
});
