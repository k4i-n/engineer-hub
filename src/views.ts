import { readFileSync } from "node:fs";
import type { AwayState } from "./away.ts";
import type { Backup, BackupState } from "./backup.ts";
import { area, bar, donut, half, legend, percent, ring, type Slice, stack } from "./charts.ts";
import { asks, byOrder, type Ctx, has, letters, listedToday, openTickets, recentlyDone } from "./commands.ts";
import {
  BLOCKS,
  type Config,
  DEFAULT_LAYOUT,
  DEFAULTS,
  type GithubQueryKey,
  type Layout,
  REPO,
  repoTerms,
  type SlackChannel,
  type SlackChannelKey,
  sectionId,
  slackSources,
} from "./config.ts";
import {
  all,
  type CommentRow,
  type DayRow,
  type DraftRow,
  draftOwner,
  type EventRow,
  getTicket,
  type ItemRow,
  itemFinished,
  type NoteRow,
  one,
  type SourceRow,
  type StepRow,
  type Ticket,
  type WaitRow,
} from "./db.ts";
import { type FileEntry, fileHref, insideFolder, listFiles, show, sizeText, ticketFolder } from "./files.ts";
import { series, span } from "./horizon.ts";
import { type IntervalKey, intervalText, KEEP_RANGE, ladder, minutes } from "./intervals.ts";
import { folds, KIND_NAME } from "./items.ts";
import { esc, renderLine, renderMarkdown } from "./markdown.ts";
import { pins } from "./pins.ts";
import * as plan from "./plan.ts";
import { sections } from "./scripts.ts";
import { teamOf, workspaceOf, workspacesByTeam } from "./slackteam.ts";
import { isDoing, progress } from "./steps.ts";
import { githubRef, isDate, nowIso, nowTs, sinceDate, startOfDayIso, today } from "./util.ts";

export const BRAND = "EngineerHub";

export type SyncState = {
  status: "idle" | "running" | "finished" | "failed";
  at: string | null;
  detail: string | null;
};
export type Live = {
  sync: SyncState;
  agent: SyncState;
  agentNext: string | null;
  agentBusy: boolean;
  sources: { name: string; running: boolean }[];
};
export type DbInfo = { path: string; size: number; schema: string; backupFolder: string; backups: Backup[] };

type Tone = "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "grey";
type Data = Record<string, string | number>;
type Later = { act: "item-snooze" | "wait-pinged" | "draft-later"; data: Data };
type Need = {
  key: string;
  rank: number;
  since: string;
  verb: string;
  tone: Tone;
  title: string;
  fold?: true;
  sub: string;
  oneLine?: string;
  body?: string;
  drafts?: string;
  ask: string;
  ticket: string | null;
  href: string | null;
  dim: string | null;
  ok: { label: string; data: Data } | null;
  undo: Data | null;
  later: Later | null;
  ignore?: number;
  detach?: { id: number; ticket: string };
  id?: { shown: string | null; token: string };
  fyi?: boolean;
  today?: boolean;
  section?: string;
  panel?: string;
  ws?: string;
};

const NO_TEXT = "(no text)";
const MAX_ACTIVITY = 40;
const ACTIVITY_SHOWN = 5;
const MAX_TIMELINE = 200;
const MAX_PR_CHIPS = 3;
const STALE_MS = 6 * 3_600_000;
const DIR_LABEL: Record<string, string> = {
  inprogress: "In progress",
  todo: "To do",
  triage: "Triage",
  backlog: "Backlog",
  done: "Done",
  unfiled: "Unfiled",
};
const DIR_TONE: Record<string, Tone> = {
  inprogress: "blue",
  todo: "grey",
  triage: "amber",
  backlog: "grey",
  done: "green",
};
const PRIORITY_TONE: Record<string, Tone> = { urgent: "red", high: "orange", medium: "amber", low: "grey" };
const PRIORITY_BARS: Record<string, number> = { low: 1, medium: 2, high: 3 };
const EVENT_TONE: Record<string, Tone> = {
  step: "green",
  decision: "amber",
  sync: "blue",
  slack: "teal",
  pr: "violet",
  tracker: "violet",
  reading: "grey",
  log: "grey",
};

function startOfToday(ctx: Ctx): string {
  return startOfDayIso(today(ctx.now, ctx.config.timezone), ctx.config.timezone);
}

function when(ctx: Ctx, iso: string): string {
  const shown = nowTs(new Date(iso), ctx.config.timezone);
  const day = shown.slice(0, 10);
  const todayDate = today(ctx.now, ctx.config.timezone);
  const offset = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${todayDate}T00:00:00Z`)) / 86_400_000;
  if (offset === 0) return shown.slice(11);
  if (offset === 1) return `tomorrow ${shown.slice(11)}`;
  if (offset === -1) return `yesterday ${shown.slice(11)}`;
  return shown.slice(5);
}

function ago(ctx: Ctx, iso: string): string {
  const minutes = Math.max(0, Math.round((ctx.now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function appHref(ctx: Ctx, url: string): { href: string; app: boolean } {
  if (ctx.config.openLinearIn === "app" && url.startsWith("https://linear.app/")) {
    return { href: `linear://${url.slice("https://linear.app/".length)}`, app: true };
  }
  const slack =
    ctx.config.openSlackIn === "app" ? /^https:\/\/([^/]+\.slack\.com)\/archives\/([A-Z0-9]+)\/?$/.exec(url) : null;
  const team = slack === null ? null : teamOf(ctx.db, slack[1] ?? "");
  if (slack !== null && team !== null) return { href: `slack://channel?team=${team}&id=${slack[2]}`, app: true };
  return { href: url, app: false };
}

function linker(ctx: Ctx) {
  return (url: string | null, text: string, cls = "", title = ""): string => {
    const label = title ? ` title="${esc(title)}" aria-label="${esc(title)}"` : "";
    if (url === null || !/^https?:\/\//.test(url)) return `<span class="${cls}"${label}>${esc(text)}</span>`;
    const { href, app } = appHref(ctx, url);
    const target = app ? "" : ` target="_blank" rel="noreferrer"`;
    return `<a class="${cls}" href="${esc(href)}"${target}${label}>${esc(text)}</a>`;
  };
}

function ticketLink(id: string | null): string {
  if (id === null) return "";
  return `<a class="tid" href="/t/${encodeURIComponent(id)}" title="${esc(id)}">${esc(id)}</a>`;
}

function line(ctx: Ctx, text: string, max = Number.POSITIVE_INFINITY): string {
  const link = linker(ctx);
  return renderLine(text, (url, label) => link(url, label), max);
}

function markdown(ctx: Ctx, text: string): string {
  const link = linker(ctx);
  return renderMarkdown(text, (url, label) => link(url, label));
}

function codeBlock(text: string): string {
  return `<div class="md code-block"><pre><code>${esc(text)}</code></pre></div>`;
}

function replaceFold(key: string, commands: string[]): string {
  if (commands.length === 0) return "";
  return `<details class="replace-fold" data-key="replace-${esc(key)}"><summary class="chip-btn">Replace</summary>${commands.map(codeBlock).join("")}</details>`;
}

function button(
  label: string,
  data: Record<string, string | number>,
  opts: { cls?: string; disabled?: boolean } = {},
): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join("");
  return `<button type="button" class="${opts.cls ?? ""}"${attrs}${opts.disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

const ICON: Record<string, string> = {
  ok: '<path d="M20 6 9 17l-5-5"/>',
  later: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l3 3.2v2H6v-2z"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
  grip: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  ignore:
    '<path d="m3 3 18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-3 4.2"/><path d="M6.6 6.6A13 13 0 0 0 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/>',
  merge:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path d="M8 5c5 0 8 2.5 8 7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  logo: '<path d="M12 9.4V6.8M14.24 13.31l2.71 1.58M9.76 13.31l-2.71 1.58"/><circle cx="12" cy="12" r="2.6" class="core"/><circle cx="12" cy="5" r="1.8"/><circle cx="18.5" cy="15.8" r="1.8"/><circle cx="5.5" cy="15.8" r="1.8"/>',
  gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.8l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};

const LATER_TEXT: Record<Later["act"], Record<string, string>> = {
  "item-snooze": { "1h": "Snooze 1 hour", "4h": "Snooze 4 hours", tomorrow: "Snooze until tomorrow" },
  "wait-pinged": {
    "1h": "Pinged, remind in 1 hour",
    "4h": "Pinged, remind in 4 hours",
    tomorrow: "Pinged, remind tomorrow",
  },
  "draft-later": { "1h": "Send in 1 hour", "4h": "Send in 4 hours", tomorrow: "Send tomorrow" },
};

function svg(name: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] ?? ""}</svg>`;
}

function dataAttrs(data: Data): string {
  return Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join("");
}

function iconButton(name: string, label: string, key: string, data: Data | null): string {
  if (data === null)
    return `<button type="button" class="ic ic-${name}" aria-label="${esc(label)}" disabled>${svg(name)}</button>`;
  return `<button type="button" class="ic ic-${name}" title="${esc(label)} · ${key}" aria-label="${esc(label)}"${dataAttrs({ ...data, hotkey: key })}>${svg(name)}</button>`;
}

function menuItem(icon: string, label: string, data: Data, key = ""): string {
  return `<button type="button"${dataAttrs(data)}>${svg(icon)}<span>${esc(label)}</span>${key ? `<span class="key">${esc(key)}</span>` : ""}</button>`;
}

function copyId(token: string): string {
  return menuItem("copy", `Copy id (${token})`, { copy: token, hotkey: "c" }, "c");
}

function moreMenu(key: string, items: string[]): string {
  return `<details class="menu" data-key="${esc(key)}"><summary class="ic ic-more" title="More" aria-label="More">${svg("more")}</summary><div class="menu-pop">${items.join("")}</div></details>`;
}

function rail(n: Need, pinned: boolean, target: string | null): string {
  const first =
    n.undo === null
      ? iconButton("ok", n.ok?.label ?? "Done", "e", n.ok?.data ?? null)
      : iconButton("undo", "Undo", "u", n.undo);
  const later = n.later;
  const clock = iconButton(
    "later",
    later === null ? "Later" : (LATER_TEXT[later.act].tomorrow ?? ""),
    "s",
    later === null ? null : { act: later.act, ...later.data, for: "tomorrow" },
  );
  const items = [
    menuItem(
      "pin",
      pinned ? "Unpin" : "Pin to top",
      { act: "pin", row: n.key, on: pinned ? "0" : "1", hotkey: "p" },
      "p",
    ),
    ...(later === null
      ? []
      : ["1h", "4h", "tomorrow"].map((f) =>
          menuItem("later", LATER_TEXT[later.act][f] ?? f, { act: later.act, ...later.data, for: f }),
        )),
    ...(target === null ? [] : [menuItem("open", "Open", { open: target }, "↵")]),
    ...(n.href !== null && /^https?:/.test(n.href)
      ? [menuItem("link", "Copy link", { copy: n.href, hotkey: "C" }, "C")]
      : []),
    ...(n.id === undefined ? [] : [copyId(n.id.token)]),
    ...(n.ignore === undefined ? [] : [menuItem("ignore", "Ignore this PR", { act: "item-ignore", id: n.ignore })]),
    ...(n.detach === undefined ? [] : [menuItem("ignore", "Detach", { act: "item-detach", ...n.detach })]),
  ];
  return `<span class="rail">${first}${clock}<details class="menu" data-key="menu-${esc(n.key)}"><summary class="ic ic-more" title="More" aria-label="More">${svg("more")}</summary><div class="menu-pop">${items.join("")}</div></details></span>`;
}

function askChips(prompt: string, chips: string[]): string {
  return `<span class="ask">${prompt === "" ? "" : `<span>${prompt}</span>`}${chips.join("")}</span>`;
}

function answerChip(label: string, data: Data, key: string): string {
  return `<button type="button" class="chip-btn ans-${label.toLowerCase()}" title="${esc(label)} · ${key}"${dataAttrs({ ...data, hotkey: key })}>${esc(label)}</button>`;
}

function pill(text: string, tone: Tone): string {
  return `<span class="pill tone-${tone}">${esc(text)}</span>`;
}

function priorityMark(priority: string | null): string {
  const name = (priority ?? "").trim();
  const key = name.toLowerCase();
  const label = name === "" ? ' aria-hidden="true"' : ` title="${esc(name)}" aria-label="${esc(name)} priority"`;
  const cls = `prio tone-${PRIORITY_TONE[key] ?? "grey"}`;
  if (key === "urgent")
    return `<span class="${cls} prio-urgent"${label}><svg viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3.5"/><path d="M8 4.5v4.2M8 11.4v.1"/></svg></span>`;
  const bars = PRIORITY_BARS[key] ?? 0;
  const bar = (n: number, x: number, y: number) =>
    `<rect${n <= bars ? ' class="on"' : ""} x="${x}" y="${y}" width="3" height="${14 - y}" rx="1"/>`;
  return `<span class="${cls}"${label}><svg viewBox="0 0 16 16">${bar(1, 1.5, 9)}${bar(2, 6.5, 5.5)}${bar(3, 11.5, 2)}</svg></span>`;
}

function heading(title: string, label = title): string {
  return `<h2><button type="button" class="fold" data-fold="${esc(title)}" aria-expanded="true">${esc(label)}</button></h2>`;
}

function section(title: string, count: number | null, body: string, cls: string, extra = "", label = title): string {
  const badge = count === null ? "" : `<span class="count">${count}</span>`;
  return `<section class="${cls}"><div class="sec-head">${heading(title, label)}${badge}${extra}</div>${body}</section>`;
}

function empty(): string {
  return `<p class="empty">—</p>`;
}

function prTone(state: string | null): { verb: string; tone: Tone } {
  if (state === null) return { verb: "Linked", tone: "grey" };
  const s = state.toLowerCase();
  if (s.includes("change") || s.includes("fail")) return { verb: "Fix PR", tone: "orange" };
  if (s.includes("approved")) return { verb: "Approved", tone: "green" };
  if (s.includes("comment")) return { verb: "Comments", tone: "teal" };
  if (s.includes("draft")) return { verb: "Draft", tone: "grey" };
  if (s.includes("merged")) return { verb: "Merged", tone: "violet" };
  if (s.includes("closed")) return { verb: "Closed", tone: "grey" };
  return { verb: "In review", tone: "blue" };
}

function itemVerb(i: ItemRow): { verb: string; tone: Tone; rank: number } {
  if (i.kind === "alert") return { verb: "Alert", tone: "red", rank: 0 };
  if (i.kind === "review_request") return { verb: "Review", tone: "violet", rank: 1 };
  if (i.kind === "message" || i.kind === "thread" || i.kind === "mail") return { verb: "Reply", tone: "teal", rank: 2 };
  if (i.kind === "pr") return { ...prTone(i.state), rank: 4 };
  if (i.kind === "issue") return { verb: "Triage", tone: "blue", rank: 5 };
  return { verb: KIND_NAME[i.kind] ?? i.kind, tone: "grey", rank: 9 };
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function moreText(i: ItemRow): { body?: string; fold?: true } {
  if (i.body !== null && !flat(i.title ?? "").includes(flat(i.body))) return { body: i.body };
  return i.detail === null ? {} : { fold: true };
}

const TRACKER_NAME: [RegExp, string][] = [
  [/(^|\.)linear\.app$/, "Linear"],
  [/(^|\.)atlassian\.net$/, "Jira"],
  [/(^|\.)github\.com$/, "GitHub"],
];

function trackerName(url: string | null): string {
  const host = URL.parse(url ?? "")?.hostname ?? "";
  return TRACKER_NAME.find(([pattern]) => pattern.test(host))?.[1] ?? "Tracker";
}

function trackerPill(t: Ticket): string {
  const state = t.tracker_state?.trim() ?? "";
  if (state === "" || letters(state) === letters(t.dir ?? "")) return "";
  return pill(`${trackerName(t.tracker_url)}: ${state}`, "violet");
}

function itemTitle(i: ItemRow): string {
  const title = i.title?.trim() ?? "";
  if (title.endsWith(":")) return `${title} ${flat(i.body ?? "").slice(0, 200) || NO_TEXT}`;
  if (title !== "") return title;
  if (!/^https?:/.test(i.ref)) return i.ref;
  return githubRef(i.ref) ?? [NO_TEXT, i.author].filter(Boolean).join(" · ");
}

function withoutTicket(title: string, ticket: string | null): string {
  if (ticket === null || !title.startsWith(ticket)) return title;
  const rest = title.slice(ticket.length).replace(/^[\s:–-]+/, "");
  return rest === "" ? title : rest;
}

function avatar(url: string | null): string {
  if (url === null) return "";
  return `<img class="avatar" src="${esc(url)}" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer">`;
}

function workspace(ctx: Ctx, url: string | null): string | null {
  return ctx.config.slackWorkspaces.length < 2 ? null : workspaceOf(url);
}

type Part = string | { html: string; text: string } | null;

function sourceLine(parts: Part[]): string {
  return parts
    .filter((p) => p !== null && p !== "")
    .map((p) => (typeof p === "string" ? esc(p) : (p as { html: string }).html))
    .join(" · ");
}

function sourceText(parts: Part[]): string {
  return parts
    .map((p) => (p === null || typeof p === "string" ? p : p.text))
    .filter((p) => p !== null && p !== "")
    .join(" · ");
}

function wsFilter(name: string | null): Part {
  if (name === null) return null;
  return {
    html: `<button type="button" class="ws-filter" data-ws-filter="${esc(name)}" title="Show only ${esc(name)} in Slack rows">${esc(name)}</button>`,
    text: name,
  };
}

function needs(ctx: Ctx, tickets: Ticket[]): Need[] {
  const now = nowIso(ctx.now);
  const dayStart = startOfToday(ctx);
  const { from } = span(ctx.config.horizon, ctx.now, ctx.config.timezone);
  const items = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE (needs_me = 1 OR (kind = 'pr' AND (coalesce(state, '') NOT IN ('merged', 'closed') OR (state = 'merged' AND changed_at >= ?))))
       AND ignored IS NULL AND (closed_at IS NULL OR closed_at >= ?)
       OR ignored = 'item' AND coalesce(state, '') NOT IN ('merged', 'closed', 'done')`,
    from,
    dayStart,
  );
  const waits = all<WaitRow>(
    ctx.db,
    `SELECT * FROM wait WHERE (closed_at IS NULL AND (ping_after <= ? OR pinged_at >= ?)) OR closed_at >= ?`,
    now,
    dayStart,
    dayStart,
  );
  const matches = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE match_ref IS NOT NULL");
  const unsent = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE status = 'draft' AND match_ref IS NULL AND internal = 0 ORDER BY id",
  );
  const answered = all<EventRow & { created_at: string }>(
    ctx.db,
    "SELECT * FROM event WHERE kind = 'decision' AND source = 'human' AND created_at >= ?",
    dayStart,
  );
  const cards = sections(ctx);
  const list: Need[] = [];
  const rowKeys = new Set(items.filter((i) => itemOpen(ctx, i)).flatMap((i) => [i.ref, i.url ?? i.ref]));
  for (const i of items) {
    const section = cards.get(i.source);
    list.push({ ...itemNeed(ctx, i), ...(section === undefined ? {} : { section: sectionId(section) }) });
  }
  for (const d of matches) list.push(matchNeed(ctx, d));
  for (const d of unsent) {
    if (d.item === null || !rowKeys.has(d.item)) list.push(sendNeed(ctx, d));
  }
  for (const w of waits) list.push(waitNeed(ctx, w));
  for (const t of tickets) {
    const page = `/t/${encodeURIComponent(t.id)}`;
    if (asks(t.gate)) {
      list.push({
        key: `gate-${t.id}`,
        rank: 7,
        since: t.updated_at ?? now,
        verb: "Approve?",
        tone: "amber",
        title: `<span class="need-title">${line(ctx, t.gate ?? "")}</span>`,
        fold: true,
        sub: line(ctx, t.title ?? "", 80),
        ask: askChips("", [
          answerChip("Yes", { act: "gate", ticket: t.id, answer: "yes" }, "y"),
          answerChip("No", { act: "gate", ticket: t.id, answer: "no" }, "n"),
        ]),
        ticket: t.id,
        id: { shown: null, token: `gate ${t.id}` },
        href: page,
        dim: null,
        ok: null,
        undo: null,
        later: null,
      });
    }
  }
  for (const e of answered) {
    list.push({
      key: `answered-${e.id}`,
      rank: 7,
      since: e.created_at,
      verb: "Approve?",
      tone: "amber",
      title: `<span class="need-title">${line(ctx, e.text.replace(/^(Yes|No): /, ""))}</span>`,
      sub: "",
      ask: "",
      ticket: e.ticket_id,
      href: e.ticket_id === null ? null : `/t/${encodeURIComponent(e.ticket_id)}`,
      dim: e.text.startsWith("Yes") ? "yes" : "no",
      ok: null,
      undo: e.ticket_id === null ? null : { act: "gate-reopen", ticket: e.ticket_id },
      later: null,
    });
  }
  const planned = plannedKeys(ctx);
  for (const n of list) if (planned.has(n.key)) n.today = true;
  const pinned = pins(ctx.db);
  const byPin = (a: Need, b: Need) => {
    const pa = pinned.get(a.key);
    const pb = pinned.get(b.key);
    if (pa === pb) return 0;
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    return pa < pb ? -1 : 1;
  };
  return list.sort(
    (a, b) => byPin(a, b) || a.rank - b.rank || a.since.localeCompare(b.since) || a.key.localeCompare(b.key),
  );
}

function draftUrl(ctx: Ctx, d: DraftRow): string | null {
  if (d.item === null) return null;
  const item = one<ItemRow>(ctx.db, "SELECT * FROM item WHERE ref = ? OR url = ? ORDER BY id LIMIT 1", d.item, d.item);
  const url = item?.url ?? d.item;
  return /^https?:/.test(url) ? url : null;
}

function sendNeed(ctx: Ctx, d: DraftRow): Need {
  const now = nowIso(ctx.now);
  const later = d.send_at !== null && d.send_at > now;
  const url = draftUrl(ctx, d);
  const noLink =
    url === null ? `<span class="chip tone-grey" title="this draft names no thread or PR">no link</span>` : "";
  const source = [d.channel, d.ticket_id === null ? itemName(d.item) : null];
  const sub = sourceLine(source);
  const more = draftMore(ctx, [d], false);
  const oneLine = d.verdict === null && more.drafts === undefined;
  const title =
    url === null ? `<span class="need-title">${line(ctx, d.label)}</span>` : linker(ctx)(url, d.label, "need-title");
  return {
    key: `send-${draftOwner(d)}-${d.label}`,
    id: { shown: null, token: `${draftOwner(d)}/${d.label}` },
    rank: 2,
    since: d.send_at ?? d.created_at ?? now,
    verb: "Send",
    tone: "teal",
    title: oneLine ? title + noLink : title,
    sub,
    ...(oneLine ? { oneLine: sourceText(source) } : {}),
    body: d.body,
    ...more,
    ask: askChips("", [verdictPill(d), draftButtons(ctx, d, "chip-btn", url), oneLine ? "" : noLink]),
    ticket: d.ticket_id,
    href: url,
    dim: later ? `send ${when(ctx, d.send_at ?? now)}` : null,
    ok: { label: "Sent", data: { act: "sent", ticket: draftOwner(d), label: d.label } },
    undo: null,
    later: { act: "draft-later", data: { ticket: draftOwner(d), label: d.label } },
  };
}

const REVIEW_URL = /#pullrequestreview-\d+$/;

function matchNeed(ctx: Ctx, d: DraftRow): Need {
  const text = line(ctx, d.match_text ?? "");
  const pr = REVIEW_URL.test(d.match_ref ?? "") ? githubRef(d.item) : null;
  const where = d.channel ? ` in ${d.channel}` : "";
  const proposal = {
    act: "match",
    ticket: draftOwner(d),
    label: d.label,
    text: d.match_text ?? "",
    ref: d.match_ref ?? "",
  };
  return {
    key: `match-${draftOwner(d)}-${d.label}`,
    id: { shown: null, token: `${draftOwner(d)}/${d.label}` },
    rank: 3,
    since: d.posted_at ?? nowIso(ctx.now),
    verb: pr === null ? "Sent?" : "Reviewed?",
    tone: pr === null ? "blue" : "violet",
    title: pr === null ? `<span class="need-title">“${text}”</span>` : linker(ctx)(d.match_ref, pr, "need-title"),
    fold: true,
    sub: pr === null ? "" : `“${text}”`,
    ...(pr === null ? { oneLine: "" } : {}),
    ask: askChips(`Your draft ${line(ctx, d.label)}${esc(where)}?${verdictClash(d)}`, [
      answerChip("Yes", { ...proposal, answer: "yes" }, "y"),
      answerChip("No", { ...proposal, answer: "no" }, "n"),
    ]),
    ticket: d.ticket_id,
    href: d.match_ref,
    dim: null,
    ok: null,
    undo: null,
    later: null,
  };
}

function itemOpen(ctx: Ctx, i: ItemRow): boolean {
  return i.ignored === null && i.closed_at === null && (i.snoozed_until === null || i.snoozed_until <= nowIso(ctx.now));
}

function itemUndo(i: ItemRow): string {
  if (i.ignored !== null) return "item-unignore";
  return i.closed_at !== null && i.closed_at === i.ask_at ? "item-unanswer" : "item-reopen";
}

function queued(i: ItemRow): boolean {
  return i.ask_answer === "yes" && i.ask_at !== null && i.changed_at <= i.ask_at;
}

function itemNeed(ctx: Ctx, i: ItemRow): Need {
  const now = nowIso(ctx.now);
  const v = itemVerb(i);
  const snoozed = i.snoozed_until !== null && i.snoozed_until > now;
  const dim =
    i.ignored !== null
      ? "ignored"
      : i.closed_at !== null
        ? "done"
        : snoozed
          ? `until ${when(ctx, i.snoozed_until ?? now)}`
          : queued(i)
            ? "Yes · queued"
            : null;
  const folded = i.kind === "alert" ? folds(ctx.db, i) : null;
  const url = folded?.url ?? i.url ?? (/^https?:/.test(i.ref) ? i.ref : null);
  const drafts = itemDrafts(ctx, i, dim === null);
  const ws = i.source === "slack" ? workspace(ctx, url) : null;
  const source = [
    githubRef(url) ?? i.source,
    folded === null ? null : `×${folded.count}, last ${when(ctx, folded.last)}`,
    wsFilter(ws),
    i.author,
    i.state,
    i.detail,
  ];
  const plain = drafts.every((d) => d.verdict === null && draftComments(ctx, d).length === 0);
  const oneLine = plain && (i.ask === null ? 0 : 1) + drafts.length === 1;
  return {
    key: `item-${i.id}`,
    id: { shown: `#${i.id}`, token: `item ${i.id}` },
    rank: v.rank,
    since: i.first_seen,
    verb: v.verb,
    tone: v.tone,
    title: (oneLine ? avatar(i.avatar) : "") + linker(ctx)(url, withoutTicket(itemTitle(i), i.ticket_id), "need-title"),
    sub: avatar(i.avatar) + sourceLine(source),
    ...(oneLine ? { oneLine: sourceText([...source, ...drafts.map((d) => `draft ${d.label}`)]) } : {}),
    ...moreText(i),
    ...draftMore(ctx, drafts, true),
    ask: itemAsk(ctx, i) + draftChips(ctx, drafts, url, !oneLine),
    ticket: i.ticket_id,
    href: url,
    dim,
    ok: { label: "Done", data: { act: "item-done", id: i.id } },
    undo: dim === null ? null : { act: itemUndo(i), id: i.id },
    later: dim === null ? { act: "item-snooze", data: { id: i.id } } : null,
    ...((i.kind === "review_request" || i.kind === "pr") && i.ignored === null ? { ignore: i.id } : {}),
    ...(i.needs_me === 0 ? { fyi: true } : {}),
    ...(ws === null ? {} : { ws }),
  };
}

function waitNeed(ctx: Ctx, w: WaitRow): Need {
  const now = nowIso(ctx.now);
  const closed = w.closed_at !== null;
  const pinged = !closed && w.ping_after !== null && w.ping_after > now;
  const ws = workspace(ctx, w.url);
  return {
    key: `wait-${w.id}`,
    id: { shown: `wait ${w.id}`, token: `wait ${w.id}` },
    rank: 6,
    since: w.asked_at,
    verb: "Ping",
    tone: "orange",
    title: linker(ctx)(w.url, w.who, "need-title"),
    sub: sourceLine([wsFilter(ws), pinged ? `next ${when(ctx, w.ping_after ?? now)}` : "no reply yet"]),
    ask: "",
    ticket: w.ticket_id,
    href: w.url,
    dim: closed ? "answered" : pinged ? "pinged" : null,
    ok: { label: "Answered", data: { act: "wait-close", id: w.id } },
    undo: closed ? { act: "wait-reopen", id: w.id } : null,
    later: closed ? null : { act: "wait-pinged", data: { id: w.id } },
    ...(ws === null ? {} : { ws }),
  };
}

function needRow(ctx: Ctx, n: Need, pinned: boolean, showVerb: boolean | "inline" = true): string {
  const target = n.href === null ? null : appHref(ctx, n.href).href;
  const href = target === null ? "" : ` data-href="${esc(target)}"`;
  const oneLine = n.oneLine !== undefined;
  const dimLabel = n.dim === null ? "" : `<span class="dim-label">${esc(n.dim)}</span>`;
  const finished = n.dim !== null && ["done", "answered", "yes", "no"].includes(n.dim);
  const pin = pinned ? `<span class="pinmark" title="Pinned">${svg("pin")}</span>` : "";
  const cls = `need tone-${n.tone}${oneLine ? " one-line" : ""}${n.dim === null ? "" : " is-dim"}${finished ? " is-done" : ""}${pinned ? " pinned" : ""}`;
  const panel =
    n.panel === undefined ? "" : ` data-tab-panel="${n.panel}"${n.panel.split(" ").includes("open") ? "" : " hidden"}`;
  const folds = n.fold === true || n.body !== undefined || n.drafts !== undefined;
  const fold = folds ? ` data-fold-key="nfold-${esc(n.key)}"` : "";
  const caret = folds
    ? `<button type="button" class="n-caret" data-fold-toggle aria-expanded="false" title="Show more · space" aria-label="Show more">${svg("down")}</button>`
    : `<span class="n-caret"></span>`;
  const mark = n.today === true ? `<span class="pill tone-blue plan-mark" title="In today's plan">today</span>` : "";
  const verb = showVerb === "inline" ? `<span class="verb verb-inline">${esc(n.verb)}</span>` : "";
  const hover = n.oneLine ? ` title="${esc(n.oneLine)}"` : "";
  const subText = `${dimLabel}${n.sub === "" || dimLabel === "" ? "" : " · "}${n.sub}`;
  const subBody = n.id?.shown
    ? `<span class="sub-text">${subText}</span><span class="row-id">${esc(n.id.shown)}</span>`
    : subText;
  const sub = oneLine ? "" : `<span class="need-sub">${subBody}</span>`;
  const main = `<span class="need-main"${hover}><span class="need-line">${pin}${verb}${n.title}${mark}${oneLine ? dimLabel : ""}</span>${sub}</span>`;
  const ask = n.ask === "" ? "" : `<div class="n-ask">${n.ask}</div>`;
  const body = n.body === undefined ? "" : `<div class="n-body md">${markdown(ctx, n.body)}</div>`;
  const more = folds && body + (n.drafts ?? "") !== "" ? `<div class="n-more">${body}${n.drafts ?? ""}</div>` : "";
  const ws = n.ws === undefined ? "" : ` data-ws="${esc(n.ws)}"`;
  return `<li class="${cls}" data-key="${esc(n.key)}"${href}${panel}${fold}${ws}>
${caret}
${showVerb === true ? `<span class="verb">${esc(n.verb)}</span>` : ""}
${main}
<span class="need-ticket">${ticketLink(n.ticket)}</span>
<span class="need-age">${esc(ago(ctx, n.since))}</span>
${rail(n, pinned, target)}
${ask}${more}
</li>`;
}

type Group = { key: string; label: string; tone: Tone; verbs: string[] };

const GROUPS: Group[] = [
  { key: "fix", label: "Fix now", tone: "red", verbs: ["Alert"] },
  { key: "review", label: "Review", tone: "violet", verbs: ["Review", "Reviewed?"] },
  { key: "reply", label: "Reply", tone: "teal", verbs: ["Reply", "Send", "Sent?"] },
  {
    key: "prs",
    label: "My PRs",
    tone: "orange",
    verbs: ["Fix PR", "Approved", "Comments", "In review", "Draft", "Merged", "Closed", "Linked"],
  },
  { key: "triage", label: "Triage", tone: "blue", verbs: ["Triage"] },
  { key: "waiting", label: "Waiting on", tone: "orange", verbs: ["Ping"] },
  { key: "decide", label: "Decide", tone: "amber", verbs: ["Approve?"] },
];
const PINNED_GROUP: Group = { key: "pinned", label: "Pinned", tone: "violet", verbs: [] };
const OTHER_GROUP: Group = { key: "other", label: "Other", tone: "grey", verbs: [] };

const PR_TABS: Record<string, string> = { Draft: "draft", "In review": "review", Merged: "", Linked: "" };

function needPanel(n: Need, prs: boolean): string | undefined {
  if (n.dim !== null) return undefined;
  const tab = PR_TABS[n.verb];
  if (tab === "") return "all";
  if (tab !== undefined) return `${tab} all`;
  return prs ? "open all" : undefined;
}

function needTabs(g: Group, rows: Need[]): Tab[] {
  const active = rows.filter((n) => n.dim === null);
  const tabs = [{ name: "open", label: "Open", count: active.filter((n) => PR_TABS[n.verb] === undefined).length }];
  if (g.key === "prs")
    for (const [verb, name] of Object.entries(PR_TABS).filter(([, tab]) => tab !== ""))
      tabs.push({ name, label: verb, count: active.filter((n) => n.verb === verb).length });
  return [...tabs, { name: "all", label: "All", count: rows.length }];
}

const ACK_ALL_GROUPS = ["fix", "review", "reply"];

function ackAll(g: Group, rows: Need[]): string {
  if (!ACK_ALL_GROUPS.includes(g.key)) return "";
  const ids = rows.filter((n) => n.dim === null && n.ok?.data.act === "item-done").map((n) => String(n.ok?.data.id));
  const [first, ...more] = ids;
  const data =
    first === undefined
      ? null
      : { act: "item-done", id: first, ...(more.length === 0 ? {} : { more: more.join(",") }) };
  const label = `Ack all ${esc(g.label)}`;
  const attrs = data === null ? " disabled" : dataAttrs(data);
  return `<button type="button" class="ic ic-ok ack-all" title="${label}" aria-label="${label}"${attrs}>${svg("ok")}</button>`;
}

function needsCard(ctx: Ctx, g: Group, rows: Need[], pinned: Set<string>): string {
  const tabs = needTabs(g, rows);
  const prs = g.key === "prs";
  const list = rows
    .map((n) => {
      const panel = needPanel(n, prs);
      return needRow(
        ctx,
        { ...n, ...(panel === undefined ? {} : { panel }) },
        pinned.has(n.key),
        prs ? "inline" : false,
      );
    })
    .join("");
  return `<section class="ncard tone-${g.tone}"><details class="ngroup" data-key="group-${g.key}" data-group="${g.key}" open><summary><span class="g-label">${esc(g.label)}</span>${tabBar(`needs-${g.key}`, tabs)}${ackAll(g, rows)}</summary><ul class="rows needs-list">${list}</ul></details></section>`;
}

function needsYou(n: Need): boolean {
  return n.dim === null && n.fyi !== true;
}

function sectionGroups(ctx: Ctx): Group[] {
  const byId = new Map<string, Group>();
  for (const title of sections(ctx).values()) {
    const key = sectionId(title);
    if (!byId.has(key)) byId.set(key, { key, label: title, tone: "grey", verbs: [] });
  }
  return [...byId.values()];
}

function groupFor(n: Need, extra: Group[]): Group {
  if (n.section !== undefined) {
    const own = extra.find((g) => g.key === n.section);
    if (own !== undefined) return own;
  }
  return GROUPS.find((g) => g.verbs.includes(n.verb)) ?? OTHER_GROUP;
}

function needsCards(ctx: Ctx, list: Need[], extra: Group[]): Record<string, string> {
  const pinned = new Set(pins(ctx.db).keys());
  const groupOf = (n: Need) => (pinned.has(n.key) ? PINNED_GROUP : groupFor(n, extra));
  const cards: Record<string, string> = {};
  for (const g of [PINNED_GROUP, ...GROUPS, ...extra, OTHER_GROUP]) {
    const rows = list.filter((n) => groupOf(n) === g);
    cards[g.key] = rows.length === 0 ? "" : needsCard(ctx, g, rows, pinned);
  }
  return cards;
}

function needCounts(list: Need[]): Map<string, Need[]> {
  const byTicket = new Map<string, Need[]>();
  for (const n of list) {
    if (!needsYou(n) || n.ticket === null) continue;
    byTicket.set(n.ticket, [...(byTicket.get(n.ticket) ?? []), n]);
  }
  return byTicket;
}

const BLOCK_NAME: Record<string, string> = {
  overview: "Overview",
  pinned: "Pinned",
  fix: "Fix now",
  review: "Review",
  reply: "Reply",
  prs: "My PRs",
  triage: "Triage",
  waiting: "Waiting on",
  decide: "Decide",
  other: "Other",
  tickets: "Tickets",
  today: "Today",
  activity: "Activity",
};

type Col = keyof Layout;

const COL_MOVE: Record<Col, string> = {
  top: "Move to top row",
  left: "Move to left column",
  right: "Move to right column",
};

function block(id: string, name: string, html: string, col: Col, hidden: string[]): string {
  if (html === "" || hidden.includes(id)) return `<div class="block" data-block="${id}" id="b-${id}" hidden></div>`;
  const move = (dir: string, label: string) => `<button type="button" data-move="${dir}">${esc(label)}</button>`;
  const others = (Object.keys(COL_MOVE) as Col[]).filter((c) => c !== col).map((c) => move(c, COL_MOVE[c]));
  const hide = `<button type="button" data-config="hiddenBlocks" data-value="${esc(JSON.stringify([...hidden, id]))}">Hide</button>`;
  const grip = `<details class="menu grip-menu" data-key="grip-${id}"><summary class="grip" draggable="true" title="Drag to move" aria-label="Move ${esc(name)}">${svg("grip")}</summary><div class="menu-pop">${move("up", "Move up")}${move("down", "Move down")}${others.join("")}${hide}</div></details>`;
  return `<div class="block" data-block="${id}" id="b-${id}">${grip}${html}</div>`;
}

function columns(layout: Layout, extra: string[]): Record<Col, string[]> {
  const known = [...BLOCKS, ...extra];
  const placed = new Set<string>();
  const take = (ids: string[] | undefined) =>
    (ids ?? []).filter((id) => {
      if (!known.includes(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
  const cols: Record<Col, string[]> = { top: take(layout.top), left: take(layout.left), right: take(layout.right) };
  for (const id of known) {
    if (placed.has(id)) continue;
    const home =
      (Object.keys(cols) as Col[]).find((c) => DEFAULT_LAYOUT[c].includes(id)) ??
      (extra.includes(id) ? "right" : "left");
    cols[home].push(id);
  }
  return cols;
}

function progressView(style: string, done: number, total: number, big: boolean): string {
  const pct = percent(done, total);
  const complete = total > 0 && done === total;
  const graphic =
    style === "bar"
      ? bar(pct)
      : style === "half"
        ? big
          ? half(pct, 112, 10, complete)
          : half(pct, 30, 4, complete)
        : big
          ? ring(pct, 56, 6, complete)
          : ring(pct, 20, 3.5, complete);
  const text =
    total === 0
      ? `<span class="frac">–</span>`
      : `<span class="pct">${pct}%</span><span class="frac">${done}/${total}</span>`;
  return `<span class="t-progress style-${esc(style)}${big ? " big" : ""}${complete ? " complete" : ""}">${graphic}<span class="p-text">${text}</span></span>`;
}

const DIR_SLICE_TONE: Record<string, string> = {
  inprogress: "blue",
  todo: "violet",
  triage: "amber",
  backlog: "grey",
  unfiled: "teal",
};

function stepsDone(ctx: Ctx, from: string, to: string | null): string[] {
  const rows = all<{ done_at: string }>(
    ctx.db,
    to === null
      ? "SELECT done_at FROM step WHERE done_at >= ?"
      : "SELECT done_at FROM step WHERE done_at >= ? AND done_at < ?",
    ...(to === null ? [from] : [from, to]),
  );
  return rows.map((r) => today(new Date(r.done_at), ctx.config.timezone));
}

function delta(now: number, before: number): string {
  if (before === 0 || now === before) return "";
  const change = Math.round(((now - before) / before) * 100);
  const up = change > 0;
  return `<span class="delta ${up ? "up" : "down"}" title="vs previous ${before}">${up ? "↑" : "↓"} ${Math.abs(change)}%</span>`;
}

function rangeControl(c: Config): string {
  return segmented(
    "horizon",
    c.horizon,
    [
      ["7d", "7d"],
      ["14d", "14d"],
      ["30d", "30d"],
      ["week", "Week"],
      ["month", "Month"],
      ["all", "All"],
    ],
    "compact",
  );
}

function overviewSection(ctx: Ctx, tickets: Ticket[], list: Need[], extra: Group[]): string {
  const c = ctx.config;
  const active = list.filter(needsYou);
  const dayStart = startOfToday(ctx);
  const fresh = active.filter((n) => n.since >= dayStart).length;
  const needSlices: Slice[] = [...GROUPS, ...extra, OTHER_GROUP].map((g) => ({
    label: g.label,
    value: active.filter((n) => groupFor(n, extra) === g).length,
    tone: g.tone,
    href: `#b-${g.key}`,
  }));
  const needsTile = `<div class="tile"><div class="tile-head"><span class="tile-title">Needs you</span>${fresh > 0 ? `<span class="delta new">+${fresh} today</span>` : ""}</div><div class="hero">${active.length}</div>${stack(needSlices)}${legend(needSlices)}</div>`;

  const sums = tickets.map((t) => progress(ctx.db, t.id));
  const done = sums.reduce((n, p) => n + p.done, 0);
  const total = sums.reduce((n, p) => n + p.total, 0);
  const pct = percent(done, total);
  const progressTile = `<div class="tile"><div class="tile-head"><span class="tile-title">Progress</span></div><div class="gauge">${half(pct, 150, 14, total > 0 && done === total)}<span class="gauge-value"><b>${total === 0 ? "–" : `${pct}%`}</b><small>${done} of ${total} steps</small></span></div></div>`;

  const dirSlices: Slice[] = c.openDirs.map((d) => ({
    label: DIR_LABEL[d] ?? d,
    value: tickets.filter((t) => t.dir === d).length,
    tone: DIR_SLICE_TONE[d] ?? "grey",
  }));
  const period = span(c.horizon, ctx.now, c.timezone);
  const finished = recentlyDone(ctx).length;
  const ticketsTile = `<div class="tile"><div class="tile-head"><span class="tile-title">Tickets</span>${finished > 0 ? `<span class="delta up" title="done ${esc(period.label)}">${finished} done</span>` : ""}</div><div class="donut-row"><span class="donut-wrap">${donut(dirSlices, 92, 12)}<b>${tickets.length}</b></span>${legend(dirSlices)}</div></div>`;

  const todayDate = today(ctx.now, c.timezone);
  const recent = stepsDone(ctx, period.from, null);
  const before = period.previous === null ? 0 : stepsDone(ctx, period.previous.from, period.previous.to).length;
  const first = period.first ?? recent.toSorted()[0] ?? todayDate;
  const days = series(first, todayDate, recent);
  const doneTile = `<div class="tile"><div class="tile-head"><span class="tile-title">Steps done</span>${delta(recent.length, before)}</div><div class="hero">${recent.length}</div>${area(days, recent.length === 1 ? "step" : "steps")}</div>`;

  return `<section class="overview"><div class="sec-head">${heading("Overview")}${rangeControl(c)}</div><div class="tiles">${needsTile}${progressTile}${ticketsTile}${doneTile}</div></section>`;
}

function prChip(ctx: Ctx, i: ItemRow): string {
  const ref = githubRef(i.url);
  const label = ref ? `#${ref.split("#")[1]}` : "PR";
  return linker(ctx)(i.url, label, `chip tone-${prTone(i.state).tone}`, i.state ? `${label} ${i.state}` : "");
}

function prChips(ctx: Ctx, ticketId: string, prs: ItemRow[]): string {
  const shown = prs
    .slice(0, MAX_PR_CHIPS)
    .map((i) => prChip(ctx, i))
    .join("");
  const rest = prs.slice(MAX_PR_CHIPS);
  if (rest.length === 0) return shown;
  return `${shown}<details class="menu chip-more" data-key="prs-${esc(ticketId)}"><summary class="chip" title="${rest.length} more PRs">+${rest.length}</summary><div class="menu-pop chip-pop">${rest.map((i) => prChip(ctx, i)).join("")}</div></details>`;
}

function doneDay(ctx: Ctx, iso: string): string {
  const day = today(new Date(iso), ctx.config.timezone);
  const now = today(ctx.now, ctx.config.timezone);
  if (day === now) return "today";
  if (day === sinceDate("yesterday", ctx.now, ctx.config.timezone)) return "yesterday";
  return day.slice(5);
}

function needPill(list: Need[]): string {
  if (list.length === 0) return "";
  const kinds = [...new Set(list.map((n) => n.verb))].join(", ");
  return `<span class="pill tone-red need-pill" title="${esc(kinds)}">${list.length} need${list.length === 1 ? "s" : ""} you</span>`;
}

function ticketRow(ctx: Ctx, t: Ticket, done = false, needing: Need[] = []): string {
  const p = progress(ctx.db, t.id);
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE ticket_id = ? AND closed_at IS NULL ORDER BY id", t.id);
  const waiting =
    one<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM wait WHERE ticket_id = ? AND closed_at IS NULL", t.id)?.n ??
    0;
  const threads = items.filter((i) => i.kind === "thread" && !itemFinished(i)).length;
  const chips = [
    prChips(
      ctx,
      t.id,
      items.filter((i) => i.kind === "pr"),
    ),
    threads > 0 ? `<span class="chip tone-teal">Slack ${threads}</span>` : "",
    waiting > 0 ? `<span class="chip tone-orange">waiting ${waiting}</span>` : "",
    asks(t.gate) ? `<span class="chip tone-amber">approve?</span>` : "",
  ].join("");
  const next = done
    ? `done ${doneDay(ctx, t.updated_at ?? nowIso(ctx.now))}`
    : p.doing.length > 0
      ? `${p.doing.map((s) => s.n).join(", ")}: ${p.doing[0]?.title ?? ""}`
      : (t.next ?? "");
  const drag = done ? "" : ` draggable="true" data-dir="${esc(t.dir ?? "")}"`;
  return `<li class="ticket${done ? " is-closed" : ""}" data-key="t-${esc(t.id)}" data-id="${esc(t.id)}" data-href="/t/${encodeURIComponent(t.id)}"${drag}>
<div class="t-top">${priorityMark(t.tracker_priority)}${ticketLink(t.id)}<span class="t-title">${line(ctx, t.title ?? "")}</span>${needPill(needing)}${pill(DIR_LABEL[t.dir ?? ""] ?? t.dir ?? "", DIR_TONE[t.dir ?? ""] ?? "grey")}</div>
<div class="t-meta">${progressView(ctx.config.progressStyle, p.done, p.total, false)}<span class="t-next">${line(ctx, next || "–", 160)}</span><span class="chips">${chips}</span></div>
</li>`;
}

type Tab = { name: string; label: string; count: number };

function tabBar(group: string, tabs: Tab[]): string {
  const buttons = tabs.map((t, i) => {
    const on = i === 0;
    return `<button type="button" role="tab" class="tab${on ? " on" : ""}" data-tab="${esc(t.name)}" aria-selected="${on}">${esc(t.label)} <b>${t.count}</b></button>`;
  });
  return `<span class="tabs" role="tablist" data-tabs="${group}">${buttons.join("")}</span>`;
}

function openDrafts(drafts: DraftRow[]): number {
  return drafts.filter((d) => d.status === "draft").length;
}

function openTabs(group: string, open: number, total: number): string {
  return tabBar(group, [
    { name: "open", label: "Open", count: open },
    { name: "all", label: "All", count: total },
  ]);
}

function openRows(open: number): string {
  return open === 0 ? `<li class="empty" data-tab-panel="open">—</li>` : "";
}

function draftTabs(drafts: DraftRow[]): string {
  return openTabs("drafts", openDrafts(drafts), drafts.length);
}

function draftButtons(ctx: Ctx, d: DraftRow, cls = "", open: string | null = null): string {
  const which = { ticket: draftOwner(d), label: d.label };
  const mark =
    d.status === "draft"
      ? button("Sent", { act: "sent", ...which }, { cls: `${cls} primary`.trim(), disabled: d.match_ref !== null })
      : button("Not sent", { act: "draft-unsent", ...which }, { cls });
  const copyOpen =
    open === null || d.status !== "draft"
      ? ""
      : button("Copy & open", { copy: d.body, open: appHref(ctx, open).href }, { cls });
  return `${button("Copy", { copy: d.sent_text ?? d.body }, { cls })}${copyOpen}${mark}`;
}

const VERDICT: Record<string, { word: string; tone: Tone }> = {
  approve: { word: "approve", tone: "green" },
  request_changes: { word: "request changes", tone: "orange" },
  comment: { word: "comment", tone: "blue" },
};

function verdictClash(d: DraftRow): string {
  if (d.verdict === null || d.match_verdict === null || d.verdict === d.match_verdict) return "";
  return ` ${esc(`Draft says ${verdictWord(d.verdict)}, GitHub says ${verdictWord(d.match_verdict)}`)}`;
}

function verdictWord(verdict: string | null): string {
  return verdict === null ? "" : (VERDICT[verdict]?.word ?? verdict);
}

function verdictPill(d: DraftRow): string {
  const v = d.verdict === null ? undefined : VERDICT[d.verdict];
  return v === undefined ? "" : pill(v.word, v.tone);
}

function draftComments(ctx: Ctx, d: DraftRow): CommentRow[] {
  return all<CommentRow>(ctx.db, "SELECT * FROM draft_comment WHERE draft_id = ? ORDER BY pos", d.id);
}

function commentList(ctx: Ctx, comments: CommentRow[]): string {
  if (comments.length === 0) return "";
  const rows = comments.map(
    (c) =>
      `<li><code class="d-path" title="${esc(c.path)}:${c.line}"><bdi dir="ltr">${esc(c.path)}:${c.line}</bdi></code><div class="d-cbody md">${markdown(ctx, c.body)}</div>${button("Copy", { copy: c.body }, { cls: "chip-btn" })}</li>`,
  );
  return `<ul class="d-comments">${rows.join("")}</ul>`;
}

function ticketDraftKey(d: DraftRow): string {
  return d.ticket_id === null ? `${d.item}-${d.label}` : d.label;
}

function itemName(item: string | null): string | null {
  return githubRef(item) ?? item;
}

function itemLink(ctx: Ctx, item: string | null): string {
  if (item === null) return "";
  const name = itemName(item) ?? item;
  return /^https?:/.test(item) ? linker(ctx)(item, name, "d-item") : `<span class="d-item">${esc(name)}</span>`;
}

function itemDrafts(ctx: Ctx, i: ItemRow, open: boolean): DraftRow[] {
  return all<DraftRow>(
    ctx.db,
    `SELECT * FROM draft WHERE item IN (?, ?) AND internal = 0 AND sent_text IS NULL AND (status != 'draft' OR ?) ORDER BY id`,
    i.ref,
    i.url ?? i.ref,
    open ? 1 : 0,
  );
}

function itemAsk(ctx: Ctx, i: ItemRow): string {
  if (i.ask === null) return "";
  if (i.ask_answer !== null) return askChips(`${line(ctx, i.ask)} ${i.ask_answer === "yes" ? "Yes" : "No"}`, []);
  return askChips(line(ctx, i.ask), [
    answerChip("Yes", { act: "item-answer", id: i.id, answer: "yes" }, "y"),
    answerChip("No", { act: "item-answer", id: i.id, answer: "no" }, "n"),
  ]);
}

function draftMore(ctx: Ctx, drafts: DraftRow[], withBody: boolean): { drafts?: string } {
  const html = drafts
    .map(
      (d) =>
        `${withBody ? `<div class="n-body n-draft md">${markdown(ctx, d.sent_text ?? d.body)}</div>` : ""}${commentList(ctx, draftComments(ctx, d))}`,
    )
    .join("");
  return html === "" ? {} : { drafts: html };
}

function draftChips(ctx: Ctx, drafts: DraftRow[], open: string | null, labels: boolean): string {
  if (drafts.length === 0) return "";
  return drafts
    .map((d) =>
      askChips("", [
        labels
          ? `<span class="chip tone-${d.status === "draft" ? "teal" : "grey"}" title="draft">${line(ctx, d.label, 40)}</span>`
          : "",
        verdictPill(d),
        draftButtons(ctx, d, "chip-btn", open),
      ]),
    )
    .join("");
}

function draftPanel(d: DraftRow): string {
  return d.status === "draft" ? ` data-tab-panel="open all"` : ` data-tab-panel="all" hidden`;
}

function rowList(rows: string[], open: number): string {
  return rows.length === 0 ? empty() : `<ul class="rows">${rows.join("")}${openRows(open)}</ul>`;
}

function draftList(drafts: DraftRow[], rows: string[]): string {
  return rowList(rows, openDrafts(drafts));
}

type TicketGroup = { name: string; label: string; tickets: Ticket[] };

function ticketList(ctx: Ctx, group: TicketGroup, on: boolean, needing: Map<string, Need[]>): string {
  const done = group.name === "done";
  const rows = group.tickets.map((t) => ticketRow(ctx, t, done, needing.get(t.id) ?? [])).join("");
  return `<ul class="rows ticket-list" data-tab-panel="${esc(group.name)}"${on ? "" : " hidden"}>${rows === "" ? `<li class="empty">—</li>` : rows}</ul>`;
}

function ticketsSection(ctx: Ctx, tickets: Ticket[], needing: Map<string, Need[]>): string {
  const groups: TicketGroup[] = [
    ...ctx.config.openDirs.map((dir) => ({
      name: dir,
      label: DIR_LABEL[dir] ?? dir,
      tickets: tickets.filter((t) => t.dir === dir),
    })),
    { name: "done", label: "Done", tickets: recentlyDone(ctx) },
  ];
  const tabs = tabBar(
    "tickets",
    groups.map((g) => ({ name: g.name, label: g.label, count: g.tickets.length })),
  );
  const lists = groups.map((g, i) => ticketList(ctx, g, i === 0, needing)).join("");
  return `<section class="tickets"><div class="sec-head">${heading("Tickets")}${tabs}</div>${lists}</section>`;
}

function dayLabel(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${date}`;
}

function dayStep(icon: string, label: string, date: string | undefined, now: string): string {
  const target = date === undefined ? " disabled" : ` data-day="${date === now ? "" : esc(date)}"`;
  return `<button type="button" class="ic" title="${label}" aria-label="${label}"${target}>${svg(icon)}</button>`;
}

function dayNav(ctx: Ctx, shown: string, now: string): string {
  const prev = one<{ date: string }>(ctx.db, "SELECT date FROM day WHERE date < ? ORDER BY date DESC LIMIT 1", shown);
  const next = one<{ date: string }>(
    ctx.db,
    "SELECT date FROM day WHERE date > ? AND date <= ? ORDER BY date LIMIT 1",
    shown,
    now,
  );
  const pick = `<input type="date" data-day-pick value="${esc(shown)}" max="${esc(now)}" aria-label="Open a day">`;
  return `<span class="day-nav">${dayStep("left", "Previous plan", prev?.date, now)}${pick}${dayStep("right", "Next plan", next?.date, now)}</span>`;
}

function plannedKeys(ctx: Ctx): Set<string> {
  const keys = new Set<string>();
  for (const s of plan.lines(ctx, today(ctx.now, ctx.config.timezone))) {
    if (s.dropped || s.doneAt !== null) continue;
    for (const r of s.refs) {
      const act = r.act ?? {};
      if (r.ref.kind === "item") keys.add(`item-${r.ref.id}`);
      if (r.ref.kind === "wait") keys.add(`wait-${r.ref.id}`);
      if (r.ref.kind === "gate") keys.add(`gate-${r.ref.id}`);
      if (r.ref.kind === "draft") {
        keys.add(`send-${act.ticket}-${act.label}`);
        keys.add(`match-${act.ticket}-${act.label}`);
      }
    }
  }
  return keys;
}

const PLAIN_STATES = new Set([
  "open",
  "not sent",
  "todo",
  "inprogress",
  "done",
  "merged",
  "closed",
  "sent",
  "answered",
  "yes",
]);

function itemHref(ctx: Ctx, i: ItemRow): string | null {
  if (listedToday(ctx, i)) return `/#item-${i.id}`;
  if (i.ticket_id !== null) return `/t/${encodeURIComponent(i.ticket_id)}`;
  return i.url ?? (/^https?:/.test(i.ref) ? i.ref : null);
}

function refChip(ctx: Ctx, r: plan.RefState): string {
  const item = r.ref.kind === "item" ? one<ItemRow>(ctx.db, "SELECT * FROM item WHERE id = ?", r.ref.id) : undefined;
  const open = r.doneAt === null;
  const state = (open && item !== undefined ? itemVerb(item).verb : r.state).toLowerCase();
  const tone: Tone = !open ? "green" : r.state === "gone" ? "grey" : r.state === "sent?" ? "blue" : "amber";
  const name =
    item === undefined
      ? r.name
      : (githubRef(item.url ?? item.ref) ?? item.author ?? KIND_NAME[item.kind] ?? item.source);
  const about = item === undefined ? "" : `: ${item.title ?? item.ref} (item ${item.id})`;
  const text = PLAIN_STATES.has(state) ? name : `${name} · ${state}`;
  const title = `${name} · ${state}${about}`;
  const href = item === undefined ? r.href : itemHref(ctx, item);
  const cls = `chip tone-${tone}`;
  if (href?.startsWith("/"))
    return `<a class="${cls}" href="${esc(href)}" title="${esc(title)}" aria-label="${esc(title)}">${esc(text)}</a>`;
  return linker(ctx)(href, text, cls, title);
}

function planBox(s: plan.LineState, date: string, readOnly: boolean): string {
  const mark = s.dropped ? "–" : s.doneAt === null ? "" : "✓";
  const still = `<span class="pbox">${mark}</span>`;
  if (readOnly || s.dropped) return still;
  const only = s.refs.length === 1 ? s.refs[0] : undefined;
  const data =
    s.refs.length === 0
      ? { act: s.doneAt === null ? "plan-done" : "plan-undo", line: s.n, date }
      : s.doneAt === null
        ? (only?.act ?? null)
        : null;
  if (data === null) return still;
  const label = s.refs.length === 0 && s.doneAt !== null ? "Not done" : "Done";
  return `<button type="button" class="pbox" title="${label}" aria-label="${label}"${dataAttrs(data)}>${mark}</button>`;
}

function planRow(ctx: Ctx, s: plan.LineState, date: string, readOnly: boolean): string {
  const open = !s.dropped && s.doneAt === null;
  const cls = `pline${s.doneAt === null ? "" : " is-done"}${s.dropped ? " dropped" : ""}`;
  const time = s.line.time === null ? "" : `<span class="pl-time">${esc(s.line.time)}</span>`;
  const why = s.dropped ? `<span class="pl-why">${line(ctx, s.line.why ?? "")}</span>` : "";
  const carried =
    s.line.carried_from === null ? "" : `<span class="pl-why">from ${esc(s.line.carried_from.slice(5))}</span>`;
  const chips = s.refs.map((r) => refChip(ctx, r)).join("");
  return `<li class="${cls}" data-key="pl-${s.line.id}" data-tab-panel="${open ? "open all" : "all"}"${open ? "" : " hidden"}>${planBox(s, date, readOnly)}<span class="pl-text">${time}${line(ctx, s.line.text)}${why}${carried}</span><span class="pl-refs">${chips}</span></li>`;
}

const HUB_TONE: Record<plan.HubLine["kind"], Tone> = { pr: "blue", wait: "orange", draft: "teal", gate: "amber" };

function hubBlock(ctx: Ctx): string {
  const list = plan.fromHub(ctx);
  if (list.length === 0) return "";
  const link = linker(ctx);
  const rows = list.map((l) => {
    const name = l.href?.startsWith("/") ? `<a href="${esc(l.href)}">${esc(l.name)}</a>` : link(l.href, l.name);
    return `<li><span class="pill tone-${HUB_TONE[l.kind]}">${l.kind}</span>${name}<span class="pl-why">${line(ctx, l.text)}</span></li>`;
  });
  return `<div class="from-hub"><h4>${plan.FROM_HUB}</h4><ul>${rows.join("")}</ul></div>`;
}

function todaySection(ctx: Ctx, asked: string | null): string {
  const now = today(ctx.now, ctx.config.timezone);
  const picked = asked !== null && isDate(asked) && asked < now ? asked : null;
  const day =
    picked === null
      ? (one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", now) ??
        one<DayRow>(ctx.db, "SELECT * FROM day ORDER BY date DESC LIMIT 1"))
      : one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", picked);
  const shown = picked ?? (plan.hasLines(ctx, now) ? now : (day?.date ?? now));
  const body = day?.date === shown ? day.body : "";
  const past = shown !== now;
  const lines = plan.lines(ctx, shown);
  const link = linker(ctx);
  const missing = picked === null ? empty() : `<p class="empty">No plan for ${esc(picked)}</p>`;
  const rows =
    lines.length === 0
      ? ""
      : `<ul class="rows plines">${lines.map((s) => planRow(ctx, s, shown, past)).join("")}${openRows(lines.filter((s) => !s.dropped && s.doneAt === null).length)}</ul>`;
  const md =
    body.trim() === ""
      ? ""
      : `<div class="md">${renderMarkdown(body, (url, text) => link(url, text), ctx.config.resumeHeading)}</div>`;
  const hub = past ? "" : hubBlock(ctx);
  const content = rows + hub + md === "" ? missing : `<div data-keep-scroll data-key="today">${rows}${hub}${md}</div>`;
  const readOnly = past ? pill("read only", "grey") : "";
  const back = picked === null ? "" : `<a class="day-back" href="/" data-day="">Back to today</a>`;
  const open = lines.filter((s) => !s.dropped && s.doneAt === null).length;
  const head = readOnly + back + openTabs("today", open, lines.length) + dayNav(ctx, shown, now);
  return section("Today", null, content, "today", head, past ? dayLabel(shown) : "Today");
}

function eventRow(ctx: Ctx, e: EventRow, showTicket: boolean): string {
  const link = linker(ctx);
  const tone = EVENT_TONE[e.kind] ?? "grey";
  return `<li class="event"><span class="dot tone-${tone}"></span><span class="ts">${esc(e.ts.length > 10 && e.ts.startsWith(today(ctx.now, ctx.config.timezone)) ? e.ts.slice(11) : e.ts.slice(5))}</span>${showTicket ? ticketLink(e.ticket_id) : ""}<span class="e-text">${line(ctx, e.text)}</span>${e.ref ? link(e.ref, "↗", "e-ref") : ""}</li>`;
}

const WORK_EVENTS = new Set(["step", "decision", "pr", "tracker", "slack", "action"]);

function eventTabs(group: string, events: EventRow[]): { tabs: string; work: EventRow[] } {
  const work = events.filter((e) => WORK_EVENTS.has(e.kind));
  const tabs = tabBar(group, [
    { name: "work", label: "Work", count: work.length },
    { name: "all", label: "All", count: events.length },
  ]);
  return { tabs, work };
}

function activityPanel(ctx: Ctx, events: EventRow[], name: string, on: boolean): string {
  const rows = events.map((e) => eventRow(ctx, e, true));
  const first = `<ul class="rows events">${rows.slice(0, ACTIVITY_SHOWN).join("")}</ul>`;
  const rest =
    rows.length <= ACTIVITY_SHOWN
      ? ""
      : `<details class="more-fold" data-key="activity-more-${name}"><summary><span class="when-closed">Show all ${rows.length}</span><span class="when-open">Show less</span></summary><ul class="rows events">${rows.slice(ACTIVITY_SHOWN).join("")}</ul></details>`;
  return `<div data-tab-panel="${name}"${on ? "" : " hidden"}>${rows.length === 0 ? empty() : first + rest}</div>`;
}

function activitySection(ctx: Ctx): string {
  const { from } = span(ctx.config.horizon, ctx.now, ctx.config.timezone);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? AND source != 'import' ORDER BY created_at DESC, id DESC LIMIT ?",
    from,
    MAX_ACTIVITY,
  );
  const { tabs, work } = eventTabs("activity", events);
  const body = activityPanel(ctx, work, "work", true) + activityPanel(ctx, events, "all", false);
  return section("Activity", null, body, "activity", tabs);
}

type ChipState = "ok" | "warn" | "bad" | "busy" | "idle";

const AGENT_STATE: Record<SyncState["status"], ChipState> = {
  idle: "idle",
  running: "busy",
  finished: "ok",
  failed: "bad",
};

function sourceState(ctx: Ctx, s: SourceRow | undefined, running: boolean): ChipState {
  if (running) return "busy";
  if (s === undefined) return "idle";
  if (s.last_error !== null) return "bad";
  if (ctx.now.getTime() - new Date(s.last_sync).getTime() > STALE_MS || s.warning !== null) return "warn";
  return "ok";
}

function agoText(ctx: Ctx, iso: string): string {
  const age = ago(ctx, iso);
  return age === "now" ? "just now" : `${age} ago`;
}

function backupState(ctx: Ctx): BackupState | null {
  const value = one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = 'backup'")?.value;
  return value === undefined ? null : (JSON.parse(value) as BackupState);
}

function backupProblem(ctx: Ctx): string {
  const state = backupState(ctx);
  if (state?.error == null) return "";
  return `<a class="src src-bad" href="/settings" title="${esc(state.error)}"><i></i>Backup</a>`;
}

function chip(name: string, state: ChipState, title: string): string {
  return `<span class="src src-${state}" title="${esc(title)}"><i></i>${esc(name)}</span>`;
}

function sourceChip(ctx: Ctx, name: string, running: boolean): string {
  const s = one<SourceRow>(ctx.db, "SELECT * FROM source WHERE name = ?", name);
  const title = [
    running ? "syncing" : null,
    s === undefined ? "not synced yet" : `last sync ${when(ctx, s.last_sync)}`,
    s?.last_error,
    s?.warning,
  ]
    .filter(Boolean)
    .join("\n");
  return chip(sourceLabel(name), sourceState(ctx, s, running), title);
}

function agentChip(ctx: Ctx, live: Live): string {
  const a = live.agent;
  const title = [
    a.at === null ? "not run yet" : `${a.status === "running" ? "started" : "last run"} ${when(ctx, a.at)}`,
    ctx.config.autoSync ? `auto sync every ${ctx.config.syncEvery}` : "auto sync off",
    live.agentNext === null ? null : `next ${when(ctx, live.agentNext)}`,
    a.status === "failed" ? a.detail : null,
  ]
    .filter(Boolean)
    .join("\n");
  return chip("Agent", live.agentBusy ? "busy" : AGENT_STATE[a.status], title);
}

function statusChips(ctx: Ctx, live: Live): string {
  return `${live.sources.map((s) => sourceChip(ctx, s.name, s.running)).join("")}${agentChip(ctx, live)}${backupProblem(ctx)}`;
}

function syncControl(sync: SyncState): string {
  const running = sync.status === "running";
  const failed = sync.status === "failed";
  const last = failed ? `Failed: ${sync.detail ?? ""}` : sync.status === "finished" ? sync.detail : null;
  const title = running ? "Syncing" : ["Sync sources", last].filter(Boolean).join("\n");
  const started = running && sync.at ? ` data-started="${esc(sync.at)}"` : "";
  const off = running ? " disabled" : "";
  const item = (what: string, label: string) =>
    `<button type="button" data-act="sync" data-what="${what}"${off}><span>${label}</span></button>`;
  return `<div class="sync"${started}><button type="button" class="ic ic-sync sync-btn${failed ? " bad" : ""}" data-act="sync" data-what="sources" title="${esc(title)}" aria-label="${running ? "Syncing" : "Sync sources"}"${off}>${svg("sync")}</button><details class="menu sync-menu" data-key="sync-menu"><summary class="ic sync-more" title="Sync" aria-label="Sync options">${svg("down")}</summary><div class="menu-pop">${item("sources", "Sources")}${item("agent", "Agent")}${item("all", "All")}</div></details></div>`;
}

function header(ctx: Ctx, live: Live, active: "home" | "settings" | "ticket", needCount = 0): string {
  return `<header class="top">
<a class="brand" href="/"><span class="logo">${svg("logo")}</span>${BRAND}${needCount > 0 ? `<span class="count hot" title="needs you">${needCount}</span>` : ""}</a>
<div class="sources">${statusChips(ctx, live)}</div>
<div class="search" role="search"><input type="search" data-search-box placeholder="Search" aria-label="Search everything" autocomplete="off" spellcheck="false"><div class="search-pop" role="listbox" hidden></div></div>
${syncControl(live.sync)}
<a class="gear${active === "settings" ? " on" : ""}" href="${active === "settings" ? "/" : "/settings"}" title="Settings" aria-label="Settings">${svg("gear")}</a>
</header>`;
}

export function indexBody(ctx: Ctx, live: Live, day: string | null): string {
  const order = ctx.config.openDirs;
  const tickets = openTickets(ctx).sort(
    (a, b) => order.indexOf(a.dir ?? "") - order.indexOf(b.dir ?? "") || byOrder(a, b),
  );
  const list = needs(ctx, tickets);
  const active = list.filter(needsYou).length;
  const extra = sectionGroups(ctx);
  const names = blockNames(extra);
  const blocks: Record<string, string> = {
    overview: overviewSection(ctx, tickets, list, extra),
    ...needsCards(ctx, list, extra),
    tickets: ticketsSection(ctx, tickets, needCounts(list)),
    today: todaySection(ctx, day),
    activity: activitySection(ctx),
  };
  const cols = columns(
    ctx.config.layout,
    extra.map((g) => g.key),
  );
  const col = (name: Col) =>
    `<div class="col" data-col="${name}">${cols[name].map((id) => block(id, names[id] ?? id, blocks[id] ?? "", name, ctx.config.hiddenBlocks)).join("")}</div>`;
  return `${header(ctx, live, "home", active)}
<main class="grid" data-needs-count="${active}">
${col("top")}
${col("left")}
${col("right")}
</main>`;
}

function field(ctx: Ctx, label: string, value: string | null, tone: Tone | null = null): string {
  const v = (value ?? "").trim();
  if (v === "" || v === "-") return "";
  return `<dt>${esc(label)}</dt><dd class="md${tone ? ` tone-text-${tone}` : ""}">${markdown(ctx, v)}</dd>`;
}

const MAX_ISSUE_URL = 8000;

function issueItem(ctx: Ctx, t: Ticket, n: NoteRow): string[] {
  const own = (t.repo ?? "").trim();
  const repo = REPO.test(own) ? own : ctx.config.issueRepo;
  if (repo === "") return [];
  const base = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(`${t.id}: ${n.title}`)}`;
  const full = `${base}&body=${encodeURIComponent(n.body)}`;
  if (full.length <= MAX_ISSUE_URL) return [menuItem("issue", "Open as GitHub issue", { open: full })];
  return [menuItem("issue", "Open as GitHub issue (body copied, too long for a link)", { copy: n.body, open: base })];
}

function stepMenu(ticket: string, s: StepRow): string {
  const step = { ticket, n: s.n };
  const state =
    s.done_at !== null
      ? menuItem("undo", "Not done", { act: "step-undo", ...step })
      : isDoing(s)
        ? menuItem("undo", "Not started", { act: "step-unstart", ...step })
        : menuItem("right", "Start", { act: "step-start", ...step });
  return moreMenu(`menu-step-${s.n}`, [
    copyId(`${ticket}#${s.n}`),
    menuItem("edit", "Edit", { act: "step-edit", ...step, ask: "Step", "ask-value": s.title }),
    state,
    menuItem("trash", "Remove", { act: "step-remove", ...step, confirm: `Remove step ${s.n}?` }),
  ]);
}

function stepRow(ctx: Ctx, ticket: string, s: StepRow): string {
  const cls = s.done_at !== null ? "done" : isDoing(s) ? "doing" : "";
  const hidden = s.done_at === null ? "" : ' data-tab-panel="all" hidden';
  const doing = isDoing(s) ? pill("doing", "blue") : "";
  const evidence = s.evidence ? linker(ctx)(s.evidence, "↗", "e-ref") : "";
  return `<li class="${cls}" data-key="s-${s.n}"${hidden}><span class="check" data-n="${s.n}"></span><span class="s-title">${line(ctx, s.title)}</span>${doing}${evidence}${stepMenu(ticket, s)}</li>`;
}

type Folder = { name: string; path: string; files: FileEntry[]; folders: Folder[] };

function fileTree(files: FileEntry[]): Folder {
  const root: Folder = { name: "", path: "", files: [], folders: [] };
  for (const f of files) {
    let at = root;
    for (const name of f.path.split("/").slice(0, -1)) {
      let next = at.folders.find((d) => d.name === name);
      if (next === undefined) {
        next = { name, path: at.path === "" ? name : `${at.path}/${name}`, files: [], folders: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.files.push(f);
  }
  return root;
}

function filesIn(d: Folder): FileEntry[] {
  return [...d.files, ...d.folders.flatMap(filesIn)];
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function readmeFirst(a: FileEntry, b: FileEntry): number {
  const readme = (f: FileEntry) => Number(/^readme(\.|$)/i.test(baseName(f.path)));
  return readme(b) - readme(a) || a.path.localeCompare(b.path);
}

function fileRow(ctx: Ctx, id: string, f: FileEntry): string {
  const raw = show(f.path) === "raw";
  const href = fileHref(id, f.path, raw);
  const target = raw ? ` target="_blank" rel="noreferrer"` : "";
  return `<li class="file"><a class="f-path" href="${esc(href)}"${target}>${esc(baseName(f.path))}</a><span class="f-size">${sizeText(f.size)}</span><span class="ts" title="${esc(f.modified)}">${ago(ctx, f.modified)}</span></li>`;
}

function folderRow(ctx: Ctx, id: string, d: Folder): string {
  const inside = filesIn(d);
  const size = inside.reduce((n, f) => n + f.size, 0);
  const latest =
    inside
      .map((f) => f.modified)
      .sort()
      .at(-1) ?? "";
  const count = `${inside.length} file${inside.length === 1 ? "" : "s"}`;
  return `<li class="folder"><details data-key="folder-${esc(id)}/${esc(d.path)}"><summary class="file"><span class="f-path">${esc(d.name)}/</span><span class="f-count">${count}</span><span class="f-size">${sizeText(size)}</span><span class="ts" title="${esc(latest)}">${ago(ctx, latest)}</span></summary>${fileList(ctx, id, d)}</details></li>`;
}

function fileList(ctx: Ctx, id: string, d: Folder): string {
  const rows = [
    ...d.files.sort(readmeFirst).map((f) => fileRow(ctx, id, f)),
    ...d.folders.sort((a, b) => a.name.localeCompare(b.name)).map((x) => folderRow(ctx, id, x)),
  ];
  return `<ul class="rows files">${rows.join("")}</ul>`;
}

function filesSection(ctx: Ctx, id: string, files: FileEntry[]): string {
  const menu = moreMenu("menu-files", [menuItem("copy", "Copy folder path", { copy: ticketFolder(ctx.files, id) })]);
  return section("Files", files.length, fileList(ctx, id, fileTree(files)), "files-sec", menu);
}

export function fileBody(ctx: Ctx, id: string, path: string, live: Live): string {
  const t = getTicket(ctx.db, id);
  const full = insideFolder(ctx.files, id, path);
  const raw = fileHref(t.id, path, true);
  const kind = show(path);
  let content = `<a href="${esc(raw)}">${esc(path)}</a>`;
  if (kind === "markdown")
    content = `<section class="file-doc md">${markdown(ctx, readFileSync(full, "utf8"))}</section>`;
  if (kind === "html") {
    content = `<iframe class="file-frame" sandbox="allow-scripts" src="${esc(raw)}" title="${esc(path)}"></iframe>`;
  }
  if (kind === "image") content = `<img class="file-img" src="${esc(raw)}" alt="${esc(path)}">`;
  const head = `<div class="page-head">${ticketLink(t.id)}<h1>${esc(path)}</h1><a class="head-link" href="${esc(raw)}" target="_blank" rel="noreferrer">raw ↗</a></div>`;
  return `${header(ctx, live, "ticket")}
${head}
<main class="file-view" data-still>${content}</main>`;
}

export function ticketBody(ctx: Ctx, id: string, live: Live): string {
  const link = linker(ctx);
  const t = getTicket(ctx.db, id);
  const steps = all<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE ticket_id = ? ORDER BY needs_me DESC, id DESC", id).sort(
    (a, b) => Number(itemFinished(a)) - Number(itemFinished(b)),
  );
  const waits = all<WaitRow>(
    ctx.db,
    "SELECT * FROM wait WHERE ticket_id = ? ORDER BY closed_at IS NOT NULL, asked_at",
    id,
  );
  const drafts = all<DraftRow>(
    ctx.db,
    `SELECT * FROM draft WHERE ticket_id = ?1 OR (ticket_id IS NULL AND item IN
       (SELECT ref FROM item WHERE ticket_id = ?1 UNION SELECT url FROM item WHERE ticket_id = ?1)) ORDER BY id`,
    id,
  );
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE ticket_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
    id,
    MAX_TIMELINE,
  );
  const notes = all<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? ORDER BY position, id", id);
  const files = listFiles(ctx.files, id);
  const p = progress(ctx.db, id);

  const ticketMenu = moreMenu("menu-ticket", [
    menuItem("edit", "Edit title", { act: "ticket-title", ticket: t.id, ask: "Title", "ask-value": t.title ?? "" }),
    menuItem("edit", "Change id", {
      act: "ticket-rename",
      ticket: t.id,
      ask: "New id",
      "ask-value": t.id,
      go: "/t/{value}",
    }),
    menuItem("merge", "Merge into…", { act: "ticket-merge", ticket: t.id, ask: "Merge into", go: "/t/{value}" }),
    menuItem("trash", "Delete", { act: "ticket-delete", ticket: t.id, confirm: `Delete ${t.id}?`, go: "/" }),
  ]);
  const head = `<div class="page-head">${priorityMark(t.tracker_priority)}${ticketLink(t.id)}<h1>${line(ctx, t.title ?? "")}</h1>${ticketMenu}${pill(DIR_LABEL[t.dir ?? ""] ?? t.dir ?? "", DIR_TONE[t.dir ?? ""] ?? "grey")}${trackerPill(t)}${t.tracker_url === null ? "" : link(t.tracker_url, "tracker ↗", "head-link")}</div>`;
  const fields = `${field(ctx, "Status", t.status)}${field(ctx, "Next", t.next, "blue")}${asks(t.gate) ? field(ctx, "Approve?", t.gate, "amber") : field(ctx, "Rule", t.gate)}${field(ctx, "Repo", [t.repo, t.branch].filter(Boolean).join(" · "))}${field(ctx, "Owner", t.owner)}`;
  const state = fields === "" ? empty() : `<dl class="state">${fields}</dl>`;
  const openSteps = steps.filter((s) => s.done_at === null).length;
  const openItems = items.filter((i) => !itemFinished(i)).length;
  const openWaits = waits.filter((w) => w.closed_at === null).length;
  const { tabs: timelineTabs, work } = eventTabs("timeline", events);
  const timelinePanel = (list: EventRow[], name: string, on: boolean) =>
    `<ul class="rows events" data-keep-scroll data-key="timeline-${name}" data-tab-panel="${name}"${on ? "" : " hidden"}>${list.length === 0 ? `<li class="empty">—</li>` : list.map((e) => eventRow(ctx, e, false)).join("")}</ul>`;
  const timeline =
    events.length === 0 ? empty() : timelinePanel(work, "work", true) + timelinePanel(events, "all", false);
  const stepList =
    steps.length === 0
      ? empty()
      : `${progressView(ctx.config.progressStyle, p.done, p.total, true)}<ol class="steps">${steps
          .map((s) => stepRow(ctx, t.id, s))
          .join("")}${openRows(openSteps)}</ol>`;
  const pinned = pins(ctx.db);
  const itemRows = items.map((i) => {
    const n = itemNeed(ctx, i);
    const panel = itemFinished(i) ? { panel: "all" } : {};
    return needRow(ctx, { ...n, ticket: null, detach: { id: i.id, ticket: t.id }, ...panel }, pinned.has(n.key));
  });
  const waitRows = waits.map((w) => {
    const n = waitNeed(ctx, w);
    return needRow(ctx, { ...n, ticket: null, ...(w.closed_at === null ? {} : { panel: "all" }) }, pinned.has(n.key));
  });
  const draftRows = drafts.map(
    (d) =>
      `<li class="draft" data-key="td-${esc(ticketDraftKey(d))}"${draftPanel(d)}><div class="d-head">${itemLink(ctx, d.item)}<span class="d-label">${line(ctx, d.label)}</span>${verdictPill(d)}${pill(d.status, d.status === "draft" ? "blue" : "green")}${d.channel ? pill(d.channel, "teal") : ""}<span class="d-actions">${draftButtons(ctx, d, "", draftUrl(ctx, d))}${moreMenu(
        `menu-td-${ticketDraftKey(d)}`,
        [
          copyId(`${draftOwner(d)}/${d.label}`),
          menuItem("edit", "Rename", {
            act: "draft-rename",
            ticket: draftOwner(d),
            label: d.label,
            ask: "Label",
            "ask-value": d.label,
          }),
          ...(d.status === "draft"
            ? [
                menuItem("trash", "Remove", {
                  act: "draft-remove",
                  ticket: draftOwner(d),
                  label: d.label,
                  confirm: `Remove draft "${d.label}"?`,
                }),
              ]
            : []),
        ],
      )}</span></div><div class="d-body md">${markdown(ctx, d.sent_text ?? d.body)}</div>${commentList(ctx, draftComments(ctx, d))}</li>`,
  );
  const own = needs(ctx, [t]).filter(
    (n) => n.ticket === t.id && needsYou(n) && !n.key.startsWith("wait-") && !n.key.startsWith("item-"),
  );
  const ticketNeeds =
    own.length === 0
      ? ""
      : section(
          "Needs you",
          own.length,
          `<ul class="rows needs-list">${own.map((n) => needRow(ctx, { ...n, ticket: null }, pinned.has(n.key))).join("")}</ul>`,
          "needs",
        );
  const noteRows = notes.map(
    (n) =>
      `<details data-key="note-${esc(n.title)}"${notes.length === 1 ? " open" : ""}><summary>${line(ctx, n.title)}</summary><div class="note-actions">${moreMenu(
        `menu-note-${n.title}`,
        [
          menuItem("copy", "Copy markdown", { copy: n.body }),
          ...issueItem(ctx, t, n),
          menuItem("edit", "Rename", {
            act: "note-rename",
            ticket: t.id,
            title: n.title,
            ask: "Title",
            "ask-value": n.title,
          }),
          menuItem("trash", "Remove", {
            act: "note-remove",
            ticket: t.id,
            title: n.title,
            confirm: `Remove "${n.title}"?`,
          }),
        ],
      )}</div><div class="md">${markdown(ctx, n.body)}</div></details>`,
  );
  const parts = [
    {
      name: "steps",
      html: section("Steps", null, stepList, "steps-sec", openTabs("steps", openSteps, steps.length)),
      n: steps.length,
    },
    {
      name: "items",
      html: section(
        "Items",
        null,
        rowList(itemRows, openItems),
        "items-sec",
        openTabs("items", openItems, items.length),
      ),
      n: items.length,
    },
    {
      name: "waits",
      html: section(
        "Waiting on",
        null,
        rowList(waitRows, openWaits),
        "waits-sec",
        openTabs("waits", openWaits, waits.length),
      ),
      n: waits.length,
    },
    {
      name: "drafts",
      html: section("Drafts", null, draftList(drafts, draftRows), "drafts", draftTabs(drafts)),
      n: drafts.length,
    },
    { name: "files", html: filesSection(ctx, t.id, files), n: files.length },
  ];
  const shown = (names: string[]) =>
    parts
      .filter((s) => names.includes(s.name) && s.n > 0)
      .map((s) => s.html)
      .join("");
  const none = parts.filter((s) => s.n === 0).map((s) => s.name);
  const noneLine =
    none.length === 0
      ? ""
      : `<p class="none-line">No ${none.length === 1 ? none[0] : `${none.slice(0, -1).join(", ")} or ${none.at(-1)}`}</p>`;
  return `${header(ctx, live, "ticket")}
${head}
<main class="grid">
<div class="col">${ticketNeeds}${section("State", null, state, "state-sec")}${shown(["steps"])}${section("Timeline", null, timeline, "timeline", timelineTabs)}</div>
<div class="col">${shown(["items", "waits", "drafts"])}${section("Notes", notes.length, noteRows.length === 0 ? empty() : noteRows.join(""), "notes")}${shown(["files"])}${noneLine}</div>
</main>`;
}

type Option = [string | number, string, string?];

function segmented(key: string, value: string | number, options: Option[], cls = ""): string {
  return `<div class="seg${cls ? ` ${cls}` : ""}" role="radiogroup">${options
    .map(
      ([v, label, icon]) =>
        `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? "on" : ""}${icon ? " has-icon" : ""}" data-config="${esc(key)}" data-value="${esc(JSON.stringify(v))}">${icon ?? ""}${esc(label)}</button>`,
    )
    .join("")}</div>`;
}

function slider<T extends string | number>(key: string, value: T, steps: T[], text: (v: T) => string): string {
  const near = (v: T) => (typeof v === "number" ? v : minutes(v, key));
  const at = near(value);
  const index = steps.reduce(
    (best, v, i) => (Math.abs(near(v) - at) < Math.abs(near(steps[best] as T) - at) ? i : best),
    0,
  );
  return `<input type="range" class="slider" min="0" max="${steps.length - 1}" value="${index}" data-config-slider="${esc(key)}" data-steps="${esc(JSON.stringify(steps))}" data-texts="${esc(JSON.stringify(steps.map(text)))}" aria-label="${esc(key)}"><span class="slider-text">${esc(text(value))}</span>`;
}

function intervalSlider(key: IntervalKey, value: string): string {
  return slider(key, value, ladder(key), intervalText);
}

function range(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, i) => low + i);
}

function blockNames(extra: Group[]): Record<string, string> {
  return { ...BLOCK_NAME, ...Object.fromEntries(extra.map((g) => [g.key, g.label])) };
}

function blockChips(hidden: string[], extra: Group[]): string {
  const names = blockNames(extra);
  return `<div class="block-chips">${[...BLOCKS, ...extra.map((g) => g.key)]
    .map((id) => {
      const on = !hidden.includes(id);
      const next = on ? [...hidden, id] : hidden.filter((h) => h !== id);
      return `<button type="button" class="chip-toggle${on ? " on" : ""}" aria-pressed="${on}" data-config="hiddenBlocks" data-value="${esc(JSON.stringify(next))}">${esc(names[id] ?? id)}</button>`;
    })
    .join("")}</div>`;
}

function toggle(key: string, on: boolean): string {
  return `<button type="button" role="switch" aria-checked="${on}" class="switch${on ? " on" : ""}" data-config="${esc(key)}" data-value="${esc(JSON.stringify(!on))}"><span class="knob"></span></button>`;
}

function channelInput(key: SlackChannelKey, list: SlackChannel[], teams: Map<string, string> | null): string {
  const shared = (c: SlackChannel) => list.filter((o) => o.name === c.name).length > 1;
  const whereOf = (c: SlackChannel) => (teams === null || c.team === undefined ? null : (teams.get(c.team) ?? null));
  const typed = (c: SlackChannel) => {
    if (c.name === "") return c.id;
    if (!shared(c)) return `#${c.name}`;
    const where = whereOf(c);
    return where === null ? c.id : `${where}:#${c.name}`;
  };
  const value = list.map(typed).join(", ");
  const chips = list
    .map((c) => {
      const where = whereOf(c);
      const text = sourceLine([c.name === "" ? "?" : `#${c.name}`, c.id === "" ? "?" : c.id, where]);
      if (teams === null || where !== null) return `<span class="chip tone-grey">${text}</span>`;
      const why =
        c.team === undefined
          ? "Not read: not tied to a workspace. Save the list again, or write workspace:#name."
          : "Not read: its workspace is not one hub reads.";
      return `<span class="chip tone-red" title="${esc(why)}">${text}</span>`;
    })
    .join("");
  return `<input class="text" data-config-input="${key}" data-list value="${esc(value)}" spellcheck="false"><div class="set-chips">${chips}</div>`;
}

function customQueryRow(c: Config, label: string, key: GithubQueryKey): string {
  if (c[key] === DEFAULTS[key]) return "";
  const move =
    repoTerms(c[key]).length === 0
      ? ""
      : button("Move -repo: to Skip repos", { act: "skip-from-query", key }, { cls: "chip-btn" });
  return row(
    label,
    `<span class="src-state">custom search</span><code class="src-script">${esc(c[key])}</code>${move}`,
    c.fetch.github !== true,
  );
}

function row(label: string, control: string, off = false): string {
  return `<div class="set-row${off ? " off" : ""}"${off ? " inert" : ""}><span class="set-label">${esc(label)}</span><div class="set-control">${control}</div></div>`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export type Fetching = {
  name: string;
  on: boolean;
  script: string | null;
  every: string | null;
  section: string | null;
  how: string | null;
  ok: boolean | null;
  fixes: string[];
  last: string | null;
  error: string | null;
  warning: string | null;
};

const SOURCE_NAME: Record<string, string> = { github: "GitHub", linear: "Linear" };

function sourceLabel(name: string): string {
  return SOURCE_NAME[name] ?? (name.startsWith("slack-") ? `Slack ${name.slice("slack-".length)}` : name);
}

function fetchStatus(ctx: Ctx, f: Fetching): string {
  const status = (tone: string, text: string) =>
    `<span class="src-status tone-${tone}"><span class="dot"></span>${esc(text)}</span>`;
  if (f.error !== null) return status("red", f.error);
  if (f.last !== null) {
    const stale = ctx.now.getTime() - new Date(f.last).getTime() > STALE_MS;
    return status(stale || f.warning !== null ? "amber" : "green", `Synced ${agoText(ctx, f.last)}`);
  }
  return status("grey", f.on ? "Not synced yet" : "Off");
}

function scriptControls(f: Fetching): string {
  const off = f.on ? "" : " disabled";
  return `<input class="text src-every" data-source="${esc(f.name)}" data-field="every" value="${esc(f.every ?? "")}" aria-label="Every" spellcheck="false"${off}><input class="text src-section" data-source="${esc(f.name)}" data-field="section" value="${esc(f.section ?? "")}" placeholder="Section" aria-label="Section" spellcheck="false"${off}>${button("Fetch now", { act: "source-fetch", name: f.name }, { disabled: !f.on })}${button("Remove", { act: "source-remove", name: f.name, confirm: `Remove ${f.name}?` })}`;
}

function sourceRows(ctx: Ctx, list: Fetching[]): string {
  const next = (name: string, on: boolean) => JSON.stringify({ ...ctx.config.fetch, [name]: on });
  return list
    .map((f) => {
      const swtch =
        f.script !== null
          ? `<button type="button" role="switch" aria-checked="${f.on}" class="switch${f.on ? " on" : ""}" data-act="source-set" data-name="${esc(f.name)}" data-on="${f.on ? "0" : "1"}"><span class="knob"></span></button>`
          : `<button type="button" role="switch" aria-checked="${f.on}" class="switch${f.on ? " on" : ""}" data-config="fetch" data-value="${esc(next(f.name, !f.on))}"><span class="knob"></span></button>`;
      const script = f.script === null ? "" : `<code class="src-script">${esc(f.script)}</code>`;
      const how = f.how === null || f.script !== null ? "" : `<span class="src-how">${esc(f.how)}</span>`;
      const warning = f.warning === null ? "" : `<span class="src-how tone-text-amber">${esc(f.warning)}</span>`;
      const fixes =
        f.script === null && f.ok === true && f.error === null && f.warning === null
          ? replaceFold(`key-${f.name}`, f.fixes)
          : f.fixes.map(codeBlock).join("");
      const controls =
        f.script !== null
          ? scriptControls(f)
          : f.name.startsWith("slack-")
            ? button("Remove", { act: "source-remove", name: f.name, confirm: `Remove ${sourceLabel(f.name)}?` })
            : "";
      return row(
        sourceLabel(f.name),
        `${swtch}<div class="src-info">${fetchStatus(ctx, f)}${script}${how}${warning}</div>${controls}${fixes}`,
      );
    })
    .join("");
}

function addSourceRow(): string {
  return row(
    "Add",
    button("Slack workspace", { act: "slack-add", ask: "Slack workspace name, e.g. acme" }) +
      codeBlock("hub source add <name> --every 5m -- <program>"),
  );
}

function lastBackup(ctx: Ctx, newest: Backup | undefined): string {
  const state = backupState(ctx);
  if (state?.error != null) return `<span class="src-state tone-red">${esc(state.error)}</span>`;
  if (newest === undefined) return `<span class="src-state">none yet</span>`;
  return `<span class="src-state" title="${esc(newest.path)}">${esc(newest.name)} · ${esc(agoText(ctx, newest.at))}</span>`;
}

export type AwayView = AwayState & { hasUrl: boolean | null; command: string };

function awayRows(ctx: Ctx, away: AwayView): string {
  const c = ctx.config;
  const stored = away.hasUrl === null ? "–" : away.hasUrl ? "stored" : "not stored";
  const last =
    away.error !== null
      ? `<span class="src-state tone-red">${esc(away.error)}</span>`
      : away.lastPing === null
        ? `<span class="src-state">none yet</span>`
        : `<span class="src-state" title="${esc(away.lastText ?? "")}">${esc(agoText(ctx, away.lastPing))}</span>`;
  const judged =
    away.judgeError !== null
      ? `<span class="src-state tone-red">${esc(away.judgeError)}</span>`
      : away.lastJudge === null
        ? ""
        : `<span class="src-state">${esc(agoText(ctx, away.lastJudge))}</span>`;
  return (
    row("Ping when away", toggle("awayPing", c.awayPing)) +
    row("Away after", intervalSlider("awayAfter", c.awayAfter), !c.awayPing) +
    row("At most every", intervalSlider("awayEvery", c.awayEvery), !c.awayPing) +
    row(
      "Webhook",
      `<span class="src-state">${esc(stored)}</span>${button("Test", { act: "away-test" })}${
        away.hasUrl === true
          ? `${button("Remove", { act: "away-remove", confirm: "Remove the webhook URL?" })}${replaceFold("webhook", [away.command])}`
          : codeBlock(away.command)
      }`,
    ) +
    row("Last ping", last, !c.awayPing) +
    row("Judge", `${codeBlock(JSON.stringify(c.judgeCommand))}${judged}`, !c.awayPing) +
    row(
      "Judge rules",
      `<textarea class="text" data-config-input="judgePrompt" rows="4" spellcheck="false">${esc(c.judgePrompt)}</textarea>`,
      !c.awayPing || c.judgeCommand.length === 0,
    ) +
    row("Merged PRs", intervalSlider("watchFor", c.watchFor), !c.awayPing || c.judgeCommand.length === 0)
  );
}

const NO_AWAY: AwayView = {
  lastPing: null,
  lastText: null,
  error: null,
  lastJudge: null,
  judgeError: null,
  hasUrl: null,
  command: "",
};

export function settingsBody(
  ctx: Ctx,
  live: Live,
  db: DbInfo,
  fetching: Fetching[] = [],
  away: AwayView = NO_AWAY,
): string {
  const c = ctx.config;
  const slackOn = slackSources(c).some((name) => c.fetch[name] === true);
  const teams = c.slackWorkspaces.length < 2 ? null : workspacesByTeam(ctx.db);
  const shortcuts: [string, string][] = [
    ["j / k", "next / previous row"],
    ["Enter", "open"],
    ["e", "done, answered"],
    ["s", "later: snooze or remind tomorrow"],
    ["y / n", "yes / no"],
    ["p", "pin to top"],
    ["c / C", "copy id / link"],
    ["u", "undo"],
    ["/", "search"],
    [",", "settings"],
    ["Esc", "back"],
  ];
  return `${header(ctx, live, "settings")}
<div class="page-head set-head"><h1>Settings</h1></div>
<main class="grid settings">
<div class="col">
${section(
  "Sources",
  null,
  sourceRows(ctx, fetching) +
    addSourceRow() +
    row(
      "Skip repos",
      `<input class="text" data-config-input="skipRepos" data-list value="${esc(c.skipRepos.join(", "))}" placeholder="owner/repo" spellcheck="false">`,
      c.fetch.github !== true,
    ) +
    customQueryRow(c, "Review requests", "githubReviewQuery") +
    customQueryRow(c, "My PRs", "githubPrQuery") +
    row("Alert channels", channelInput("slackAlertChannels", c.slackAlertChannels, teams), !slackOn) +
    row("Ignore channels", channelInput("slackIgnoreChannels", c.slackIgnoreChannels, teams), !slackOn) +
    row("Group channels", channelInput("slackGroupChannels", c.slackGroupChannels, teams), !slackOn) +
    row("Watch channels", channelInput("slackWatchChannels", c.slackWatchChannels, teams), !slackOn) +
    row("Every", intervalSlider("fetchEvery", c.fetchEvery), !fetching.some((f) => f.script === null && f.on)),
  "set-sec",
)}
${section(
  "Agent",
  null,
  row("Auto sync", toggle("autoSync", c.autoSync)) +
    row("Every", intervalSlider("syncEvery", c.syncEvery), !c.autoSync) +
    row("Command", codeBlock(JSON.stringify(c.syncCommand))),
  "set-sec",
)}
${section("Away", null, awayRows(ctx, away), "set-sec")}
${section(
  "Database",
  null,
  row("Path", `<code class="path">${esc(db.path)}</code>${button("Copy", { copy: db.path })}`) +
    row("Size", esc(size(db.size))) +
    row("Schema", `v${esc(db.schema)}`) +
    row("Backup", toggle("autoBackup", c.autoBackup)) +
    row("Every", intervalSlider("backupEvery", c.backupEvery), !c.autoBackup) +
    row(
      "Keep",
      slider("backupKeep", c.backupKeep, range(KEEP_RANGE[0], KEEP_RANGE[1]), (n) => `${n} backups`),
      !c.autoBackup,
    ) +
    row(
      "Folder",
      `<input class="text" data-config-input="backupDir" value="${esc(c.backupDir)}" placeholder="${esc(db.backupFolder)}" spellcheck="false">`,
    ) +
    row("Last", `${lastBackup(ctx, db.backups[0])}${button("Back up now", { act: "backup" })}`),
  "set-sec",
)}
${section(
  "Behavior",
  null,
  row("Notifications", toggle("notifyNew", c.notifyNew)) +
    row("Sound", toggle("notifySound", c.notifySound)) +
    row(
      "Slack",
      segmented("openSlackIn", c.openSlackIn, [
        ["browser", "Browser"],
        ["app", "Slack app"],
      ]),
    ) +
    row(
      "Linear",
      segmented("openLinearIn", c.openLinearIn, [
        ["browser", "Browser"],
        ["app", "Linear app"],
      ]),
    ),
  "set-sec",
)}
${section(
  "Dashboard",
  null,
  row(
    "Theme",
    segmented("theme", c.theme, [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]),
  ) +
    row(
      "Time zone",
      `<input class="text" data-config-input="timezone" value="${esc(c.timezone)}" spellcheck="false">`,
    ) +
    row(
      "Progress",
      segmented("progressStyle", c.progressStyle, [
        ["ring", "Ring", ring(65, 16, 3, false)],
        ["half", "Half", half(65, 22, 3.5, false)],
        ["bar", "Bar", bar(65)],
      ]),
    ) +
    row("Period", rangeControl(c)) +
    row(
      "Later until",
      segmented(
        "laterHour",
        c.laterHour,
        [7, 8, 9, 10].map((h) => [h, `${h}:00`]),
      ),
    ) +
    row("Blocks", blockChips(c.hiddenBlocks, sectionGroups(ctx))) +
    row(
      "Layout",
      button("Reset", { config: "layout", value: JSON.stringify(DEFAULT_LAYOUT) }) +
        button("Show all", { config: "hiddenBlocks", value: "[]" }, { disabled: c.hiddenBlocks.length === 0 }),
    ),
  "set-sec",
)}
${section("Keyboard", null, `<dl class="keys">${shortcuts.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join("")}</dl>`, "set-sec")}
</div>
</main>`;
}

export function page(ctx: Ctx, title: string, body: string, token: string): string {
  const theme = ctx.config.theme === "system" ? "" : ` data-theme="${esc(ctx.config.theme)}"`;
  return `<!doctype html>
<html lang="en"${theme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="hub-token" content="${esc(token)}">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body data-notify="${ctx.config.notifyNew}" data-sound="${ctx.config.notifySound}">
<div id="app">${body}</div>
<div class="news" aria-live="polite" hidden></div>
<div class="toasts" aria-live="polite"></div>
</body>
</html>`;
}
