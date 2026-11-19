import { esc } from "./markdown.ts";

export type Slice = { label: string; value: number; tone: string; href?: string };
export type Day = { day: string; n: number; label?: string };

const GAP = 1.2;

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function percent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

export function ring(pct: number, size: number, stroke: number, complete: boolean): string {
  const c = size / 2;
  const r = round((size - stroke) / 2);
  const arc =
    pct === 0
      ? ""
      : `<circle class="arc" cx="${c}" cy="${c}" r="${r}" pathLength="100" stroke-dasharray="${pct} 100" transform="rotate(-90 ${c} ${c})"/>`;
  return `<svg class="ring${complete ? " complete" : ""}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" stroke-width="${stroke}" aria-hidden="true"><circle class="track" cx="${c}" cy="${c}" r="${r}"/>${arc}</svg>`;
}

export function half(pct: number, width: number, stroke: number, complete: boolean): string {
  const r = round((width - stroke) / 2);
  const y = round(width / 2);
  const h = round(width / 2 + stroke / 2);
  const d = `M ${stroke / 2} ${y} A ${r} ${r} 0 0 1 ${round(width - stroke / 2)} ${y}`;
  const arc = pct === 0 ? "" : `<path class="arc" d="${d}" pathLength="100" stroke-dasharray="${pct} 100"/>`;
  return `<svg class="half${complete ? " complete" : ""}" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" stroke-width="${stroke}" aria-hidden="true"><path class="track" d="${d}"/>${arc}</svg>`;
}

export function bar(pct: number): string {
  return `<span class="bar"><span style="width:${pct}%"></span></span>`;
}

export function arcs(slices: Slice[]): { start: number; length: number }[] {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const shown = slices.filter((s) => s.value > 0).length;
  const gap = shown > 1 ? GAP : 0;
  let start = 0;
  return slices.map((s) => {
    const share = total === 0 ? 0 : (s.value / total) * 100;
    const arc = { start: round(start), length: share === 0 ? 0 : round(Math.max(share - gap, 0.5)) };
    start += share;
    return arc;
  });
}

export function donut(slices: Slice[], size: number, stroke: number): string {
  const c = size / 2;
  const r = round((size - stroke) / 2);
  const parts = arcs(slices)
    .map((a, i) => {
      const s = slices[i];
      if (s === undefined || a.length === 0) return "";
      return `<circle class="arc tone-${s.tone}" cx="${c}" cy="${c}" r="${r}" pathLength="100" stroke-dasharray="${a.length} ${round(100 - a.length)}" stroke-dashoffset="${round(-a.start)}" transform="rotate(-90 ${c} ${c})"><title>${esc(`${s.label} ${s.value}`)}</title></circle>`;
    })
    .join("");
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" stroke-width="${stroke}"><circle class="track" cx="${c}" cy="${c}" r="${r}"/>${parts}</svg>`;
}

export function stack(slices: Slice[]): string {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const parts = slices
    .filter((s) => s.value > 0)
    .map(
      (s) =>
        `<span class="seg-part tone-${s.tone}" style="flex-grow:${s.value}" title="${esc(`${s.label} ${s.value}`)}"></span>`,
    )
    .join("");
  return `<div class="stack${total === 0 ? " is-empty" : ""}">${parts}</div>`;
}

export function legend(slices: Slice[]): string {
  const rows = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const body = `<i class="tone-${s.tone}"></i><span>${esc(s.label)}</span><b>${s.value}</b>`;
      return s.href === undefined ? `<li>${body}</li>` : `<li><a href="${esc(s.href)}">${body}</a></li>`;
    })
    .join("");
  return `<ul class="legend">${rows}</ul>`;
}

export function area(days: Day[], unit: string): string {
  const max = Math.max(1, ...days.map((d) => d.n));
  const step = days.length > 1 ? 100 / (days.length - 1) : 100;
  const height = (d: Day) => round(5 + (d.n / max) * 85);
  const only = days.length === 1 && days[0] !== undefined ? days[0] : null;
  const line =
    only === null
      ? days.map((d, i) => `${round(i * step)},${round(100 - height(d))}`).join(" ")
      : `0,${round(100 - height(only))} 100,${round(100 - height(only))}`;
  const pad = only === null ? round(-step / 2) : 0;
  const hits = days
    .map(
      (d) =>
        `<span data-tip="${esc(`${d.label ?? d.day.slice(5)} · ${d.n} ${unit}`)}"><i style="bottom:${height(d)}%"></i></span>`,
    )
    .join("");
  const first = days[0] === undefined ? "" : (days[0].label ?? days[0].day.slice(5));
  return `<div class="area"><div class="plot"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fill-top"/><stop offset="1" class="fill-bottom"/></linearGradient></defs><polygon class="fill" points="0,100 ${line} 100,100"/><polyline class="line" points="${line}" vector-effect="non-scaling-stroke"/></svg><div class="hits" style="left:${pad}%;right:${pad}%">${hits}</div></div><div class="axis"><span>${esc(first)}</span><span>today</span></div></div>`;
}
