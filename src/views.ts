import type { Backup, BackupState } from "./backup.ts";
import { area, bar, donut, half, legend, percent, ring, type Slice, stack } from "./charts.ts";
import { byOrder, type Ctx, has, openTickets, recentlyDone } from "./commands.ts";
import { BLOCKS, type Config, DEFAULT_LAYOUT, type Layout } from "./config.ts";
import {
  all,
  type DayRow,
  type DraftRow,
  type EventRow,
  getTicket,
  type ItemRow,
  type NoteRow,
  one,
  type SourceRow,
  type StepRow,
  type Ticket,
  type WaitRow,
} from "./db.ts";
import { series, span } from "./horizon.ts";
import { KIND_NAME, repoOf } from "./items.ts";
import { esc, renderLine, renderMarkdown } from "./markdown.ts";
import { pins } from "./pins.ts";
import { progress } from "./steps.ts";
import { cut, nowIso, nowTs, sinceDate, startOfDayIso, today } from "./util.ts";

export type SyncState = {
  status: "idle" | "running" | "finished" | "failed";
  at: string | null;
  detail: string | null;
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
  sub: string;
  ask: string;
  ticket: string | null;
  href: string | null;
  dim: string | null;
  ok: { label: string; data: Data } | null;
  undo: Data | null;
  later: Later | null;
  ignore?: { id: number; kind: string; repo: string | null };
  fyi?: boolean;
};

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
  const slack = /^https:\/\/[^/]+\.slack\.com\/archives\/([A-Z0-9]+)\/?$/.exec(url);
  if (ctx.config.openSlackIn === "app" && ctx.config.slackTeamId !== "" && slack) {
    return { href: `slack://channel?team=${ctx.config.slackTeamId}&id=${slack[1]}`, app: true };
  }
  return { href: url, app: false };
}

function linker(ctx: Ctx) {
  return (url: string | null, text: string, cls = ""): string => {
    if (url === null || !/^https?:\/\//.test(url)) return `<span class="${cls}">${esc(text)}</span>`;
    const { href, app } = appHref(ctx, url);
    const target = app ? "" : ` target="_blank" rel="noreferrer"`;
    return `<a class="${cls}" href="${esc(href)}"${target}>${esc(text)}</a>`;
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
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
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
    ...(n.href !== null && /^https?:/.test(n.href) ? [menuItem("link", "Copy link", { copy: n.href })] : []),
    ...ignoreItems(n.ignore),
  ];
  return `<span class="rail">${first}${clock}<details class="menu" data-key="menu-${esc(n.key)}"><summary class="ic ic-more" title="More" aria-label="More">${svg("more")}</summary><div class="menu-pop">${items.join("")}</div></details></span>`;
}

const IGNORE_REPO_TEXT: Record<string, string> = {
  review_request: "Ignore review requests from",
  pr: "Ignore my PRs from",
};

function ignoreItems(ignore: Need["ignore"]): string[] {
  if (ignore === undefined) return [];
  const one = menuItem("ignore", "Ignore this PR", { act: "item-ignore", id: ignore.id });
  if (ignore.repo === null) return [one];
  const label = `${IGNORE_REPO_TEXT[ignore.kind] ?? "Ignore"} ${ignore.repo}`;
  return [one, menuItem("ignore", label, { act: "item-ignore", id: ignore.id, repo: "1" })];
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

function section(title: string, count: number | null, body: string, cls: string, extra = ""): string {
  const badge = count === null ? "" : `<span class="count">${count}</span>`;
  return `<section class="${cls}"><div class="sec-head"><h2>${esc(title)}</h2>${badge}${extra}</div>${body}</section>`;
}

function empty(): string {
  return `<p class="empty">—</p>`;
}

function githubRef(url: string | null): string | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url ?? "");
  return m ? `${m[1]}#${m[2]}` : null;
}

function prTone(state: string | null): { verb: string; tone: Tone } {
  const s = (state ?? "").toLowerCase();
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

function withoutTicket(title: string, ticket: string | null): string {
  if (ticket === null || !title.startsWith(ticket)) return title;
  const rest = title.slice(ticket.length).replace(/^[\s:–-]+/, "");
  return rest === "" ? title : rest;
}

function sourceLine(parts: (string | null)[]): string {
  return parts
    .filter((p): p is string => p !== null && p !== "")
    .map(esc)
    .join(" · ");
}

function needs(ctx: Ctx, tickets: Ticket[]): Need[] {
  const link = linker(ctx);
  const now = nowIso(ctx.now);
  const dayStart = startOfToday(ctx);
  const items = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE (needs_me = 1 OR (kind = 'pr' AND coalesce(state, '') NOT IN ('merged', 'closed'))) AND ignored IS NULL AND (closed_at IS NULL OR closed_at >= ?)",
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
  const sends = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE status = 'draft' AND match_ref IS NULL AND send_at IS NOT NULL AND send_at <= ? ORDER BY send_at",
    now,
  );
  const answered = all<EventRow & { created_at: string }>(
    ctx.db,
    "SELECT * FROM event WHERE kind = 'decision' AND source = 'human' AND created_at >= ?",
    dayStart,
  );
  const list: Need[] = [];
  for (const i of items) {
    const v = itemVerb(i);
    const snoozed = i.snoozed_until !== null && i.snoozed_until > now;
    const dim = i.closed_at !== null ? "done" : snoozed ? `until ${when(ctx, i.snoozed_until ?? now)}` : null;
    const url = i.url ?? (/^https?:/.test(i.ref) ? i.ref : null);
    list.push({
      key: `item-${i.id}`,
      rank: v.rank,
      since: i.first_seen,
      verb: v.verb,
      tone: v.tone,
      title: link(url, withoutTicket(i.title ?? i.ref, i.ticket_id), "need-title"),
      sub: sourceLine([githubRef(url) ?? i.source, i.author, i.state]),
      ask: "",
      ticket: i.ticket_id,
      href: url,
      dim,
      ok: { label: "Done", data: { act: "item-done", id: i.id } },
      undo: dim === null ? null : { act: "item-reopen", id: i.id },
      later: dim === null ? { act: "item-snooze", data: { id: i.id } } : null,
      ...(i.kind === "review_request" || i.kind === "pr"
        ? { ignore: { id: i.id, kind: i.kind, repo: repoOf(i) } }
        : {}),
      ...(i.needs_me === 0 ? { fyi: true } : {}),
    });
  }
  for (const d of matches) {
    const where = d.channel ? ` in ${d.channel}` : "";
    list.push({
      key: `match-${d.ticket_id}-${d.label}`,
      rank: 3,
      since: d.posted_at ?? now,
      verb: "Sent?",
      tone: "blue",
      title: `<span class="need-title">“${line(ctx, d.match_text ?? "", 180)}”</span>`,
      sub: "",
      ask: askChips(`Your draft ${line(ctx, d.label)}${esc(where)}?`, [
        answerChip("Yes", { act: "match", ticket: d.ticket_id, label: d.label, answer: "yes" }, "y"),
        answerChip("No", { act: "match", ticket: d.ticket_id, label: d.label, answer: "no" }, "n"),
      ]),
      ticket: d.ticket_id,
      href: d.match_ref,
      dim: null,
      ok: null,
      undo: null,
      later: null,
    });
  }
  for (const d of sends) {
    list.push({
      key: `send-${d.ticket_id}-${d.label}`,
      rank: 2,
      since: d.send_at ?? now,
      verb: "Send",
      tone: "teal",
      title: `<span class="need-title">${line(ctx, d.label)}</span>`,
      sub: line(ctx, [d.channel, d.body].filter(Boolean).join(" · "), 160),
      ask: askChips("", [button("Copy", { copy: d.body }, { cls: "chip-btn" })]),
      ticket: d.ticket_id,
      href: null,
      dim: null,
      ok: { label: "Sent", data: { act: "sent", ticket: d.ticket_id, label: d.label } },
      undo: null,
      later: { act: "draft-later", data: { ticket: d.ticket_id, label: d.label } },
    });
  }
  for (const w of waits) list.push(waitNeed(ctx, w));
  for (const t of tickets) {
    const page = `/t/${encodeURIComponent(t.id)}`;
    if (has(t.gate)) {
      list.push({
        key: `gate-${t.id}`,
        rank: 7,
        since: t.updated_at ?? now,
        verb: "Approve?",
        tone: "amber",
        title: `<span class="need-title">${line(ctx, t.gate ?? "")}</span>`,
        sub: line(ctx, t.title ?? "", 80),
        ask: askChips("", [
          answerChip("Yes", { act: "gate", ticket: t.id, answer: "yes" }, "y"),
          answerChip("No", { act: "gate", ticket: t.id, answer: "no" }, "n"),
        ]),
        ticket: t.id,
        href: page,
        dim: null,
        ok: null,
        undo: null,
        later: null,
      });
    }
    if (has(t.decide)) {
      list.push({
        key: `decide-${t.id}`,
        rank: 8,
        since: t.updated_at ?? now,
        verb: "Decide",
        tone: "amber",
        title: `<span class="need-title">${line(ctx, t.decide ?? "")}</span>`,
        sub: line(ctx, t.title ?? "", 80),
        ask: askChips("", [`<a class="chip-btn" href="${esc(page)}">Open ticket</a>`]),
        ticket: t.id,
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
      undo: null,
      later: null,
    });
  }
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

function waitNeed(ctx: Ctx, w: WaitRow): Need {
  const now = nowIso(ctx.now);
  const closed = w.closed_at !== null;
  const pinged = !closed && w.ping_after !== null && w.ping_after > now;
  return {
    key: `wait-${w.id}`,
    rank: 6,
    since: w.asked_at,
    verb: "Ping",
    tone: "orange",
    title: linker(ctx)(w.url, w.who, "need-title"),
    sub: pinged ? `next ${esc(when(ctx, w.ping_after ?? now))}` : "no reply yet",
    ask: "",
    ticket: w.ticket_id,
    href: w.url,
    dim: closed ? "answered" : pinged ? "pinged" : null,
    ok: { label: "Answered", data: { act: "wait-close", id: w.id } },
    undo: closed ? { act: "wait-reopen", id: w.id } : null,
    later: closed ? null : { act: "wait-pinged", data: { id: w.id } },
  };
}

function needRow(ctx: Ctx, n: Need, pinned: boolean, showVerb: boolean | "inline" = true): string {
  const target = n.href === null ? null : appHref(ctx, n.href).href;
  const href = target === null ? "" : ` data-href="${esc(target)}"`;
  const dim = n.dim === null ? "" : `<span class="dim-label">${esc(n.dim)}</span>${n.sub === "" ? "" : " · "}`;
  const finished = n.dim !== null && ["done", "answered", "yes", "no"].includes(n.dim);
  const pin = pinned ? `<span class="pinmark" title="Pinned">${svg("pin")}</span>` : "";
  const cls = `need tone-${n.tone}${n.dim === null ? "" : " is-dim"}${finished ? " is-done" : ""}${pinned ? " pinned" : ""}`;
  return `<li class="${cls}" data-key="${esc(n.key)}"${href}>
${showVerb === true ? `<span class="verb">${esc(n.verb)}</span>` : ""}
<span class="need-main"><span class="need-line">${pin}${showVerb === "inline" ? `<span class="verb verb-inline">${esc(n.verb)}</span>` : ""}${n.title}</span><span class="need-sub">${dim}${n.sub}</span>${n.ask}</span>
<span class="need-ticket">${ticketLink(n.ticket)}</span>
<span class="need-age">${esc(ago(ctx, n.since))}</span>
${rail(n, pinned, target)}
</li>`;
}

type Group = { key: string; label: string; tone: Tone; verbs: string[] };

const GROUPS: Group[] = [
  { key: "fix", label: "Fix now", tone: "red", verbs: ["Alert"] },
  { key: "review", label: "Review", tone: "violet", verbs: ["Review"] },
  { key: "reply", label: "Reply", tone: "teal", verbs: ["Reply", "Send", "Sent?"] },
  {
    key: "prs",
    label: "My PRs",
    tone: "orange",
    verbs: ["Fix PR", "Approved", "Comments", "In review", "Draft", "Merged", "Closed"],
  },
  { key: "triage", label: "Triage", tone: "blue", verbs: ["Triage"] },
  { key: "waiting", label: "Waiting on", tone: "orange", verbs: ["Ping"] },
  { key: "decide", label: "Decide", tone: "amber", verbs: ["Approve?", "Decide"] },
];
const PINNED_GROUP: Group = { key: "pinned", label: "Pinned", tone: "violet", verbs: [] };
const OTHER_GROUP: Group = { key: "other", label: "Other", tone: "grey", verbs: [] };

function needsCard(ctx: Ctx, g: Group, rows: Need[], pinned: Set<string>): string {
  const active = rows.filter((n) => n.dim === null).length;
  const list = rows.map((n) => needRow(ctx, n, pinned.has(n.key), g.key === "prs" ? "inline" : false)).join("");
  return `<section class="ncard tone-${g.tone}"><details class="ngroup" data-key="group-${g.key}" data-group="${g.key}" open><summary><span class="g-label">${esc(g.label)}</span><span class="g-count">${active}</span></summary><ul class="rows needs-list">${list}</ul></details></section>`;
}

function needsYou(n: Need): boolean {
  return n.dim === null && n.fyi !== true;
}

function groupFor(n: Need): Group {
  return GROUPS.find((g) => g.verbs.includes(n.verb)) ?? OTHER_GROUP;
}

function needsCards(ctx: Ctx, list: Need[]): Record<string, string> {
  const pinned = new Set(pins(ctx.db).keys());
  const groupOf = (n: Need) => (pinned.has(n.key) ? PINNED_GROUP : groupFor(n));
  const cards: Record<string, string> = {};
  for (const g of [PINNED_GROUP, ...GROUPS, OTHER_GROUP]) {
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
  drafts: "Drafts",
  activity: "Activity",
};

type Col = keyof Layout;

const COL_MOVE: Record<Col, string> = {
  top: "Move to top row",
  left: "Move to left column",
  right: "Move to right column",
};

function block(id: string, html: string, col: Col, hidden: string[]): string {
  if (html === "" || hidden.includes(id)) return `<div class="block" data-block="${id}" id="b-${id}" hidden></div>`;
  const move = (dir: string, label: string) => `<button type="button" data-move="${dir}">${esc(label)}</button>`;
  const others = (Object.keys(COL_MOVE) as Col[]).filter((c) => c !== col).map((c) => move(c, COL_MOVE[c]));
  const hide = `<button type="button" data-config="hiddenBlocks" data-value="${esc(JSON.stringify([...hidden, id]))}">Hide</button>`;
  const grip = `<details class="menu grip-menu" data-key="grip-${id}"><summary class="grip" draggable="true" title="Drag to move" aria-label="Move ${esc(BLOCK_NAME[id] ?? id)}">${svg("grip")}</summary><div class="menu-pop">${move("up", "Move up")}${move("down", "Move down")}${others.join("")}${hide}</div></details>`;
  return `<div class="block" data-block="${id}" id="b-${id}">${grip}${html}</div>`;
}

function columns(layout: Layout): Record<Col, string[]> {
  const placed = new Set<string>();
  const take = (ids: string[] | undefined) =>
    (ids ?? []).filter((id) => {
      if (!BLOCKS.includes(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
  const cols: Record<Col, string[]> = { top: take(layout.top), left: take(layout.left), right: take(layout.right) };
  for (const id of BLOCKS) {
    if (placed.has(id)) continue;
    const home = (Object.keys(cols) as Col[]).find((c) => DEFAULT_LAYOUT[c].includes(id)) ?? "left";
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

function overviewSection(ctx: Ctx, tickets: Ticket[], list: Need[]): string {
  const c = ctx.config;
  const active = list.filter(needsYou);
  const dayStart = startOfToday(ctx);
  const fresh = active.filter((n) => n.since >= dayStart).length;
  const needSlices: Slice[] = [...GROUPS, OTHER_GROUP].map((g) => ({
    label: g.label,
    value: active.filter((n) => groupFor(n) === g).length,
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

  return `<section class="overview"><div class="sec-head"><h2>Overview</h2>${rangeControl(c)}</div><div class="tiles">${needsTile}${progressTile}${ticketsTile}${doneTile}</div></section>`;
}

function prChip(ctx: Ctx, i: ItemRow): string {
  const ref = githubRef(i.url);
  const label = `${ref ? `#${ref.split("#")[1]}` : "PR"}${i.state ? ` ${i.state}` : ""}`;
  return linker(ctx)(i.url, label, `chip tone-${prTone(i.state).tone}`);
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
  const threads = items.filter((i) => i.kind === "thread").length;
  const chips = [
    prChips(
      ctx,
      t.id,
      items.filter((i) => i.kind === "pr"),
    ),
    threads > 0 ? `<span class="chip tone-teal">Slack ${threads}</span>` : "",
    waiting > 0 ? `<span class="chip tone-orange">waiting ${waiting}</span>` : "",
    has(t.gate) ? `<span class="chip tone-amber">approve?</span>` : "",
    has(t.decide) ? `<span class="chip tone-amber">decide</span>` : "",
  ].join("");
  const next = done
    ? `done ${doneDay(ctx, t.updated_at ?? nowIso(ctx.now))}`
    : p.next
      ? `${p.next.n}. ${p.next.title}`
      : (t.next ?? "");
  const drag = done ? "" : ` draggable="true" data-id="${esc(t.id)}" data-dir="${esc(t.dir ?? "")}"`;
  return `<li class="ticket${done ? " is-closed" : ""}" data-key="t-${esc(t.id)}" data-href="/t/${encodeURIComponent(t.id)}"${drag}>
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

function draftTabs(drafts: DraftRow[]): string {
  return tabBar("drafts", [
    { name: "open", label: "Open", count: openDrafts(drafts) },
    { name: "all", label: "All", count: drafts.length },
  ]);
}

function draftPanel(d: DraftRow): string {
  return d.status === "draft" ? ` data-tab-panel="open all"` : ` data-tab-panel="all" hidden`;
}

function draftList(drafts: DraftRow[], rows: string[]): string {
  if (rows.length === 0) return empty();
  const none = openDrafts(drafts) === 0 ? `<li class="empty" data-tab-panel="open">—</li>` : "";
  return `<ul class="rows">${rows.join("")}${none}</ul>`;
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
  return `<section class="tickets"><div class="sec-head"><h2>Tickets</h2>${tabs}</div>${lists}</section>`;
}

function todaySection(ctx: Ctx): string {
  const day =
    one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", today(ctx.now, ctx.config.timezone)) ??
    one<DayRow>(ctx.db, "SELECT * FROM day ORDER BY date DESC LIMIT 1");
  const link = linker(ctx);
  const body =
    day === undefined
      ? empty()
      : `<div class="md" data-keep-scroll data-key="today">${renderMarkdown(day.body, (url, text) => link(url, text), ctx.config.resumeHeading)}</div>`;
  const date =
    day === undefined || day.date === today(ctx.now, ctx.config.timezone)
      ? ""
      : `<span class="muted">${esc(day.date)}</span>`;
  return section("Today", null, body, "today", date);
}

function draftsSection(ctx: Ctx): string {
  const drafts = all<DraftRow>(
    ctx.db,
    `SELECT * FROM draft WHERE (status = 'draft' OR sent_text IS NULL) AND match_ref IS NULL
       AND NOT (status = 'draft' AND send_at IS NOT NULL AND send_at <= ?)
     ORDER BY status != 'draft', send_at IS NOT NULL, send_at, ticket_id, label`,
    nowIso(ctx.now),
  );
  const rows = drafts.map((d) => {
    const later = d.status === "draft" && d.send_at !== null;
    const sent = d.status !== "draft";
    const state =
      d.match_ref !== null
        ? pill("sent?", "blue")
        : sent
          ? pill("wording pending", "grey")
          : later
            ? pill(`send ${when(ctx, d.send_at ?? "")}`, "grey")
            : "";
    return `<li class="draft${sent || later ? " is-dim" : ""}" data-key="d-${esc(d.ticket_id)}-${esc(d.label)}"${draftPanel(d)}>
<div class="d-head">${ticketLink(d.ticket_id)}<span class="d-label">${line(ctx, d.label)}</span>${d.channel ? pill(d.channel, "teal") : ""}${state}<span class="d-actions">${button("Copy", { copy: d.body })}${button(sent ? "Sent" : "Sent", { act: "sent", ticket: d.ticket_id, label: d.label }, { cls: sent ? "" : "primary", disabled: sent || d.match_ref !== null })}</span></div>
<details class="d-fold" data-key="dfold-${esc(d.ticket_id)}-${esc(d.label)}"><summary><span class="d-line">${line(ctx, d.body)}</span><div class="d-body md">${markdown(ctx, d.body)}</div></summary></details>
</li>`;
  });
  return section("Drafts", null, draftList(drafts, rows), "drafts", draftTabs(drafts));
}

function eventRow(ctx: Ctx, e: EventRow, showTicket: boolean): string {
  const link = linker(ctx);
  const tone = EVENT_TONE[e.kind] ?? "grey";
  return `<li class="event"><span class="dot tone-${tone}"></span><span class="ts">${esc(e.ts.length > 10 && e.ts.startsWith(today(ctx.now, ctx.config.timezone)) ? e.ts.slice(11) : e.ts.slice(5))}</span>${showTicket ? ticketLink(e.ticket_id) : ""}<span class="e-text">${line(ctx, e.text)}</span>${e.ref ? link(e.ref, "↗", "e-ref") : ""}</li>`;
}

function activitySection(ctx: Ctx): string {
  const { from } = span(ctx.config.horizon, ctx.now, ctx.config.timezone);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? AND source != 'import' ORDER BY created_at DESC, id DESC LIMIT ?",
    from,
    MAX_ACTIVITY,
  );
  const rows = events.map((e) => eventRow(ctx, e, true));
  const first = `<ul class="rows events">${rows.slice(0, ACTIVITY_SHOWN).join("")}</ul>`;
  const rest =
    rows.length <= ACTIVITY_SHOWN
      ? ""
      : `<details class="more-fold" data-key="activity-more"><summary><span class="when-closed">Show all ${rows.length}</span><span class="when-open">Show less</span></summary><ul class="rows events">${rows.slice(ACTIVITY_SHOWN).join("")}</ul></details>`;
  return section("Activity", events.length, events.length === 0 ? empty() : first + rest, "activity");
}

function sourceState(ctx: Ctx, s: SourceRow): "ok" | "stale" | "bad" | "warn" {
  if (s.last_error !== null) return "bad";
  if (ctx.now.getTime() - new Date(s.last_sync).getTime() > STALE_MS) return "stale";
  return s.warning === null ? "ok" : "warn";
}

function sourceProblems(ctx: Ctx, sources: SourceRow[]): string {
  return sources
    .filter((s) => sourceState(ctx, s) !== "ok")
    .map((s) => sourceChip(ctx, s))
    .join("");
}

function agoText(ctx: Ctx, iso: string): string {
  const age = ago(ctx, iso);
  return age === "now" ? "just now" : `${age} ago`;
}

function syncTitle(ctx: Ctx, sources: SourceRow[]): string {
  const latest = sources
    .map((s) => s.last_sync)
    .sort()
    .at(-1);
  return [
    "Sync",
    latest === undefined ? null : `synced ${agoText(ctx, latest)}`,
    ctx.config.claudeSync && ctx.config.autoSync ? `Claude every ${ctx.config.syncEvery}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function backupState(ctx: Ctx): BackupState | null {
  const value = one<{ value: string }>(ctx.db, "SELECT value FROM meta WHERE key = 'backup'")?.value;
  return value === undefined ? null : (JSON.parse(value) as BackupState);
}

function backupProblem(ctx: Ctx): string {
  const state = backupState(ctx);
  if (state?.error == null) return "";
  return `<a class="src src-bad" href="/settings" title="${esc(state.error)}"><i></i>backup<small>failed</small></a>`;
}

function sourceChip(ctx: Ctx, s: SourceRow): string {
  const state = sourceState(ctx, s);
  const title = [`last sync ${when(ctx, s.last_sync)}`, s.cursor ? `cursor ${s.cursor}` : null, s.last_error, s.warning]
    .filter(Boolean)
    .join("\n");
  return `<span class="src src-${state}" title="${esc(title)}"><i></i>${esc(s.name)}<small>${esc(when(ctx, s.last_sync))}</small></span>`;
}

function header(ctx: Ctx, sync: SyncState, active: "home" | "settings" | "ticket", needCount = 0): string {
  const sources = all<SourceRow>(ctx.db, "SELECT * FROM source ORDER BY name");
  const running = sync.status === "running";
  const failed = sync.status === "failed";
  const last = failed ? `Failed: ${sync.detail ?? ""}` : sync.status === "finished" ? sync.detail : null;
  const title = running ? "Syncing" : [syncTitle(ctx, sources), last].filter(Boolean).join("\n");
  const started = running && sync.at ? ` data-started="${esc(sync.at)}"` : "";
  return `<header class="top${running ? " syncing" : ""}">
<a class="brand" href="/"><span class="logo"></span>hub${needCount > 0 ? `<span class="count hot" title="needs you">${needCount}</span>` : ""}</a>
<div class="sources">${sourceProblems(ctx, sources)}${backupProblem(ctx)}</div>
<div class="search" role="search"><input type="search" data-search-box placeholder="Search" aria-label="Search everything" autocomplete="off" spellcheck="false"><div class="search-pop" role="listbox" hidden></div></div>
<div class="sync"${started}><button type="button" class="ic ic-sync sync-btn${failed ? " bad" : ""}" data-act="sync" title="${esc(title)}" aria-label="${running ? "Syncing" : "Sync"}"${running ? " disabled" : ""}>${svg("sync")}</button></div>
<a class="gear${active === "settings" ? " on" : ""}" href="${active === "settings" ? "/" : "/settings"}" title="Settings" aria-label="Settings">${svg("gear")}</a>
<div class="strip"></div>
</header>`;
}

export function indexBody(ctx: Ctx, sync: SyncState): string {
  const order = ctx.config.openDirs;
  const tickets = openTickets(ctx).sort(
    (a, b) => order.indexOf(a.dir ?? "") - order.indexOf(b.dir ?? "") || byOrder(a, b),
  );
  const list = needs(ctx, tickets);
  const active = list.filter(needsYou).length;
  const blocks: Record<string, string> = {
    overview: overviewSection(ctx, tickets, list),
    ...needsCards(ctx, list),
    tickets: ticketsSection(ctx, tickets, needCounts(list)),
    today: todaySection(ctx),
    drafts: draftsSection(ctx),
    activity: activitySection(ctx),
  };
  const cols = columns(ctx.config.layout);
  const col = (name: Col) =>
    `<div class="col" data-col="${name}">${cols[name].map((id) => block(id, blocks[id] ?? "", name, ctx.config.hiddenBlocks)).join("")}</div>`;
  return `${header(ctx, sync, "home", active)}
<main class="grid" data-needs-count="${active}">
${col("top")}
${col("left")}
${col("right")}
</main>`;
}

function field(ctx: Ctx, label: string, value: string | null, tone: Tone | null = null): string {
  const v = (value ?? "").trim();
  if (v === "" || v === "-") return `<dt>${esc(label)}</dt><dd><span class="muted">–</span></dd>`;
  return `<dt>${esc(label)}</dt><dd class="md${tone ? ` tone-text-${tone}` : ""}">${markdown(ctx, v)}</dd>`;
}

export function ticketBody(ctx: Ctx, id: string, sync: SyncState): string {
  const link = linker(ctx);
  const t = getTicket(ctx.db, id);
  const steps = all<StepRow>(ctx.db, "SELECT * FROM step WHERE ticket_id = ? ORDER BY n", id);
  const items = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE ticket_id = ? ORDER BY closed_at IS NOT NULL, id DESC",
    id,
  );
  const waits = all<WaitRow>(
    ctx.db,
    "SELECT * FROM wait WHERE ticket_id = ? AND closed_at IS NULL ORDER BY asked_at",
    id,
  );
  const drafts = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? ORDER BY id", id);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE ticket_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
    id,
    MAX_TIMELINE,
  );
  const notes = all<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? ORDER BY position, id", id);
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
  const head = `<div class="page-head">${priorityMark(t.tracker_priority)}${ticketLink(t.id)}<h1>${line(ctx, t.title ?? "")}</h1>${ticketMenu}${pill(DIR_LABEL[t.dir ?? ""] ?? t.dir ?? "", DIR_TONE[t.dir ?? ""] ?? "grey")}${t.tracker_state ? pill(t.tracker_state, "violet") : ""}${link(t.tracker_url, "tracker ↗", "head-link")}</div>`;
  const state = `<dl class="state">${field(ctx, "Status", t.status)}${field(ctx, "Next", t.next, "blue")}${field(ctx, "Approve?", t.gate, "amber")}${field(ctx, "Decide", t.decide, "amber")}${field(ctx, "Repo", [t.repo, t.branch].filter(Boolean).join(" · "))}${field(ctx, "PRs", t.prs)}${field(ctx, "Owner", t.owner)}</dl>`;
  const stepList =
    steps.length === 0
      ? empty()
      : `${progressView(ctx.config.progressStyle, p.done, p.total, true)}<ol class="steps">${steps
          .map(
            (s) =>
              `<li class="${s.done_at === null ? (p.next?.n === s.n ? "next" : "") : "done"}"><span class="check"></span><span class="s-title">${line(ctx, s.title)}</span>${s.evidence ? link(s.evidence, "↗", "e-ref") : ""}${moreMenu(
                `menu-step-${s.n}`,
                [
                  menuItem("edit", "Edit", {
                    act: "step-edit",
                    ticket: t.id,
                    n: s.n,
                    ask: "Step",
                    "ask-value": s.title,
                  }),
                  ...(s.done_at === null
                    ? []
                    : [menuItem("undo", "Not done", { act: "step-undo", ticket: t.id, n: s.n })]),
                  menuItem("trash", "Remove", {
                    act: "step-remove",
                    ticket: t.id,
                    n: s.n,
                    confirm: `Remove step ${s.n}?`,
                  }),
                ],
              )}</li>`,
          )
          .join("")}</ol>`;
  const itemRows = items.map((i) => {
    const v = itemVerb(i);
    return `<li class="need tone-${v.tone}${i.closed_at ? " is-dim" : ""}" data-key="ti-${i.id}"><span class="verb">${esc(v.verb)}</span><span class="need-main">${link(i.url ?? (/^https?:/.test(i.ref) ? i.ref : null), i.title ?? i.ref, "need-title")}<span class="need-sub">${sourceLine([githubRef(i.url) ?? i.source, i.state, i.ignored ? "ignored" : i.closed_at ? "closed" : null])}</span></span>${moreMenu(`menu-ti-${i.id}`, [menuItem("ignore", "Detach", { act: "item-detach", id: i.id })])}</li>`;
  });
  const pinned = pins(ctx.db);
  const waitRows = waits.map((w) => {
    const n = waitNeed(ctx, w);
    return needRow(ctx, { ...n, ticket: null }, pinned.has(n.key));
  });
  const draftRows = drafts.map(
    (d) =>
      `<li class="draft" data-key="td-${esc(d.label)}"${draftPanel(d)}><div class="d-head"><span class="d-label">${line(ctx, d.label)}</span>${pill(d.status, d.status === "draft" ? "blue" : "green")}${d.channel ? pill(d.channel, "teal") : ""}<span class="d-actions">${button("Copy", { copy: d.sent_text ?? d.body })}${moreMenu(
        `menu-td-${d.label}`,
        [
          menuItem("edit", "Rename", {
            act: "draft-rename",
            ticket: t.id,
            label: d.label,
            ask: "Label",
            "ask-value": d.label,
          }),
          ...(d.status === "draft"
            ? [
                menuItem("trash", "Remove", {
                  act: "draft-remove",
                  ticket: t.id,
                  label: d.label,
                  confirm: `Remove draft "${d.label}"?`,
                }),
              ]
            : []),
        ],
      )}</span></div><div class="d-body md">${markdown(ctx, d.sent_text ?? d.body)}</div></li>`,
  );
  const own = needs(ctx, [t]).filter((n) => n.ticket === t.id && needsYou(n) && !n.key.startsWith("wait-"));
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
      `<details data-key="note-${esc(n.title)}"><summary>${line(ctx, n.title)}</summary><div class="note-actions">${moreMenu(
        `menu-note-${n.title}`,
        [
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
  return `${header(ctx, sync, "ticket")}
${head}
<main class="grid">
<div class="col">${ticketNeeds}${section("State", null, state, "state-sec")}${section("Steps", steps.length, stepList, "steps-sec")}${section("Timeline", events.length, events.length === 0 ? empty() : `<ul class="rows events" data-keep-scroll data-key="timeline">${events.map((e) => eventRow(ctx, e, false)).join("")}</ul>`, "timeline")}</div>
<div class="col">${section("Items", items.length, itemRows.length === 0 ? empty() : `<ul class="rows">${itemRows.join("")}</ul>`, "items-sec")}${section("Waiting on", waits.length, waitRows.length === 0 ? empty() : `<ul class="rows">${waitRows.join("")}</ul>`, "waits-sec")}${section("Drafts", null, draftList(drafts, draftRows), "drafts", draftTabs(drafts))}${section("Notes", notes.length, noteRows.length === 0 ? empty() : noteRows.join(""), "notes")}</div>
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

function blockChips(hidden: string[]): string {
  return `<div class="block-chips">${BLOCKS.map((id) => {
    const on = !hidden.includes(id);
    const next = on ? [...hidden, id] : hidden.filter((h) => h !== id);
    return `<button type="button" class="chip-toggle${on ? " on" : ""}" aria-pressed="${on}" data-config="hiddenBlocks" data-value="${esc(JSON.stringify(next))}">${esc(BLOCK_NAME[id] ?? id)}</button>`;
  }).join("")}</div>`;
}

function toggle(key: string, on: boolean): string {
  return `<button type="button" role="switch" aria-checked="${on}" class="switch${on ? " on" : ""}" data-config="${esc(key)}" data-value="${esc(JSON.stringify(!on))}"><span class="knob"></span></button>`;
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
  how: string | null;
  ok: boolean | null;
  fixes: string[];
  last: string | null;
  error: string | null;
  warning: string | null;
};

const SOURCE_NAME: Record<string, string> = { github: "GitHub", linear: "Linear", slack: "Slack" };

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
  return `<input class="text src-every" data-source-every="${esc(f.name)}" value="${esc(f.every ?? "")}" aria-label="Every" spellcheck="false">${button("Fetch now", { act: "source-fetch", name: f.name })}${button("Remove", { act: "source-remove", name: f.name, confirm: `Remove ${f.name}?` })}`;
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
          ? ""
          : f.fixes.map(codeBlock).join("");
      const controls = f.script === null ? "" : scriptControls(f);
      return row(
        SOURCE_NAME[f.name] ?? f.name,
        `${swtch}<div class="src-info">${fetchStatus(ctx, f)}${script}${how}${warning}</div>${controls}${fixes}`,
      );
    })
    .join("");
}

function addSourceRow(): string {
  const line = "hub source add <name> --every 5m -- <program>";
  return row(
    "Add",
    `<div class="src-add" data-source-form><input class="text" data-keep="src-name" name="name" placeholder="name" aria-label="Name" spellcheck="false"><input class="text src-every" data-keep="src-every" name="every" placeholder="5m" aria-label="Every" spellcheck="false"><input class="text src-cmd" data-keep="src-cmd" name="command" placeholder="program args" aria-label="Command" spellcheck="false"></div><div class="md code-block"><pre><code data-source-line>${esc(line)}</code></pre></div>${button("Copy", { copy: line }, { disabled: true })}`,
  );
}

const IGNORED_KIND: Record<string, string> = { review_request: "Review requests", pr: "My PRs" };

function ignoredRows(ctx: Ctx): string {
  const repos = Object.entries(ctx.config.ignoreRepos).flatMap(([kind, list]) =>
    list.map(
      (repo) =>
        `<li><span class="ign-name">${esc(IGNORED_KIND[kind] ?? kind)} · ${esc(repo)}</span>${button("Undo", { act: "repo-unignore", kind, repo })}</li>`,
    ),
  );
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE ignored = 'item' ORDER BY id").map(
    (i) =>
      `<li><span class="ign-name">${esc(githubRef(i.url) ?? i.source)} · ${esc(cut(i.title ?? i.ref, 80))}</span>${button("Undo", { act: "item-unignore", id: i.id })}</li>`,
  );
  const list = [...repos, ...items];
  return row(
    "Ignored",
    list.length === 0 ? `<span class="muted">–</span>` : `<ul class="ignored">${list.join("")}</ul>`,
  );
}

function lastBackup(ctx: Ctx, newest: Backup | undefined): string {
  const state = backupState(ctx);
  if (state?.error != null) return `<span class="src-state tone-red">${esc(state.error)}</span>`;
  if (newest === undefined) return `<span class="src-state">none yet</span>`;
  return `<span class="src-state" title="${esc(newest.path)}">${esc(newest.name)} · ${esc(agoText(ctx, newest.at))}</span>`;
}

export function settingsBody(ctx: Ctx, sync: SyncState, db: DbInfo, fetching: Fetching[] = []): string {
  const c = ctx.config;
  const shortcuts: [string, string][] = [
    ["j / k", "next / previous row"],
    ["Enter", "open"],
    ["e", "done, answered"],
    ["s", "later: snooze or remind tomorrow"],
    ["y / n", "yes / no"],
    ["p", "pin to top"],
    ["u", "undo"],
    ["/", "search"],
    [",", "settings"],
    ["Esc", "back"],
  ];
  return `${header(ctx, sync, "settings")}
<div class="page-head"><h1>Settings</h1></div>
<main class="grid settings">
<div class="col">
${section(
  "Dashboard",
  null,
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
    row("Blocks", blockChips(c.hiddenBlocks)) +
    row(
      "Layout",
      button("Reset", { config: "layout", value: JSON.stringify(DEFAULT_LAYOUT) }) +
        button("Show all", { config: "hiddenBlocks", value: "[]" }, { disabled: c.hiddenBlocks.length === 0 }),
    ),
  "set-sec",
)}
${section(
  "Open links",
  null,
  row(
    "Slack",
    segmented("openSlackIn", c.openSlackIn, [
      ["browser", "Browser"],
      ["app", "Slack app"],
    ]),
  ) +
    row(
      "Slack team ID",
      `<input class="text" data-config-input="slackTeamId" value="${esc(c.slackTeamId)}" placeholder="T01ABCDEF" spellcheck="false">`,
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
${section("Notifications", null, row("New items", toggle("notifyNew", c.notifyNew)) + row("Sound", toggle("notifySound", c.notifySound)), "set-sec")}
${section(
  "Appearance",
  null,
  row(
    "Theme",
    segmented("theme", c.theme, [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
    ]),
  ) +
    row("Time zone", `<input class="text" data-config-input="timezone" value="${esc(c.timezone)}" spellcheck="false">`),
  "set-sec",
)}
${section("Keyboard", null, `<dl class="keys">${shortcuts.map(([k, v]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd>`).join("")}</dl>`, "set-sec")}
</div>
<div class="col">
${section(
  "Sync",
  null,
  row("Run Claude", toggle("claudeSync", c.claudeSync)) +
    row("Auto sync", toggle("autoSync", c.autoSync), !c.claudeSync) +
    row(
      "Every",
      segmented("syncEvery", c.syncEvery, [
        ["15m", "15 min"],
        ["30m", "30 min"],
        ["1h", "1 hour"],
        ["2h", "2 hours"],
        ["4h", "4 hours"],
      ]),
      !c.claudeSync,
    ) +
    row("Command", codeBlock(JSON.stringify(c.syncCommand)), !c.claudeSync),
  "set-sec",
)}
${section(
  "Sources",
  null,
  sourceRows(ctx, fetching) +
    addSourceRow() +
    row(
      "Review requests",
      `<input class="text" data-config-input="githubReviewQuery" value="${esc(c.githubReviewQuery)}" spellcheck="false">`,
    ) +
    ignoredRows(ctx) +
    row(
      "Every",
      segmented("fetchEvery", c.fetchEvery, [
        ["1m", "1 min"],
        ["5m", "5 min"],
        ["15m", "15 min"],
        ["30m", "30 min"],
      ]),
    ),
  "set-sec",
)}
${section(
  "Database",
  null,
  row("Path", `<code class="path">${esc(db.path)}</code>${button("Copy", { copy: db.path })}`) +
    row("Size", esc(size(db.size))) +
    row("Schema", `v${esc(db.schema)}`) +
    row("Backup", toggle("autoBackup", c.autoBackup)) +
    row(
      "Every",
      segmented("backupEvery", c.backupEvery, [
        ["1h", "1 hour"],
        ["6h", "6 hours"],
        ["12h", "12 hours"],
        ["1d", "1 day"],
        ["7d", "7 days"],
      ]),
    ) +
    row(
      "Keep",
      segmented(
        "backupKeep",
        c.backupKeep,
        [7, 14, 30].map((n) => [n, String(n)]),
      ),
    ) +
    row(
      "Folder",
      `<input class="text" data-config-input="backupDir" value="${esc(c.backupDir)}" placeholder="${esc(db.backupFolder)}" spellcheck="false">`,
    ) +
    row("Last", `${lastBackup(ctx, db.backups[0])}${button("Back up now", { act: "backup" })}`),
  "set-sec",
)}
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
<div class="toasts" aria-live="polite"></div>
</body>
</html>`;
}
