import { byPriorityThenRecent, type Ctx, has, openTickets } from "./commands.ts";
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
import { KIND_NAME } from "./items.ts";
import { esc, renderMarkdown } from "./markdown.ts";
import { progress } from "./steps.ts";
import { cut, nowIso, nowTs, sinceDate, startOfDayIso, today } from "./util.ts";

export type SyncState = {
  status: "idle" | "running" | "finished" | "failed";
  at: string | null;
  detail: string | null;
};
export type DbInfo = { path: string; size: number; schema: string };

type Tone = "red" | "orange" | "amber" | "green" | "teal" | "blue" | "violet" | "grey";
type Need = {
  key: string;
  rank: number;
  since: string;
  verb: string;
  tone: Tone;
  title: string;
  sub: string;
  ticket: string | null;
  actions: string;
  href: string | null;
  dim: string | null;
};

const MAX_ACTIVITY = 40;
const MAX_TIMELINE = 200;
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
  const slack = /^https:\/\/[^/]+\.slack\.com\/archives\/([A-Z0-9]+)/.exec(url);
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
  return `<a class="tid" href="/t/${encodeURIComponent(id)}">${esc(id)}</a>`;
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

function menu(key: string, buttons: string): string {
  return `<details class="menu" data-key="menu-${esc(key)}"><summary aria-label="More">⋯</summary><div class="menu-pop">${buttons}</div></details>`;
}

function pill(text: string, tone: Tone): string {
  return `<span class="pill tone-${tone}">${esc(text)}</span>`;
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
  if (s.includes("change")) return { verb: "Fix PR", tone: "orange" };
  if (s.includes("approved")) return { verb: "Merge?", tone: "green" };
  if (s.includes("merged")) return { verb: "Merged", tone: "violet" };
  if (s.includes("closed")) return { verb: "Closed", tone: "grey" };
  return { verb: "PR", tone: "blue" };
}

function itemVerb(i: ItemRow): { verb: string; tone: Tone; rank: number } {
  if (i.kind === "alert") return { verb: "Alert", tone: "red", rank: 0 };
  if (i.kind === "review_request") return { verb: "Review", tone: "violet", rank: 1 };
  if (i.kind === "message" || i.kind === "thread" || i.kind === "mail") return { verb: "Reply", tone: "teal", rank: 2 };
  if (i.kind === "pr") return { ...prTone(i.state), rank: 4 };
  if (i.kind === "issue") return { verb: "Triage", tone: "blue", rank: 5 };
  return { verb: KIND_NAME[i.kind] ?? i.kind, tone: "grey", rank: 9 };
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
    "SELECT * FROM item WHERE needs_me = 1 AND (closed_at IS NULL OR closed_at >= ?)",
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
      title: link(url, i.title ?? i.ref, "need-title"),
      sub: sourceLine([
        githubRef(url) ?? i.source,
        i.author,
        i.state && i.kind !== "pr" ? i.state : null,
        ago(ctx, i.first_seen),
      ]),
      ticket: i.ticket_id,
      href: url,
      dim,
      actions:
        dim !== null
          ? button("Undo", { act: "item-reopen", id: i.id, hotkey: "u" })
          : button("Done", { act: "item-done", id: i.id, hotkey: "e" }, { cls: "primary" }) +
            menu(
              `item-${i.id}`,
              button("Snooze 1 hour", { act: "item-snooze", id: i.id, for: "1h" }) +
                button("Snooze 4 hours", { act: "item-snooze", id: i.id, for: "4h" }) +
                button("Snooze 1 day", { act: "item-snooze", id: i.id, for: "1d", hotkey: "s" }),
            ),
    });
  }
  for (const d of matches) {
    list.push({
      key: `match-${d.ticket_id}-${d.label}`,
      rank: 3,
      since: d.posted_at ?? now,
      verb: "Sent?",
      tone: "blue",
      title: `<span class="need-title">“${esc(cut(d.match_text ?? "", 180))}”</span>`,
      sub: sourceLine([`draft ${d.label}`, d.channel]) + (d.match_ref ? ` · ${link(d.match_ref, "open")}` : ""),
      ticket: d.ticket_id,
      href: d.match_ref,
      dim: null,
      actions:
        button(
          "Yes",
          { act: "match", ticket: d.ticket_id, label: d.label, answer: "yes", hotkey: "e" },
          { cls: "primary" },
        ) + button("No", { act: "match", ticket: d.ticket_id, label: d.label, answer: "no", hotkey: "s" }),
    });
  }
  for (const w of waits) {
    const closed = w.closed_at !== null;
    const pinged = !closed && w.ping_after !== null && w.ping_after > now;
    list.push({
      key: `wait-${w.id}`,
      rank: 6,
      since: w.asked_at,
      verb: "Ping",
      tone: "orange",
      title: link(w.url, w.who, "need-title"),
      sub: sourceLine([
        ago(ctx, w.asked_at) === "now" ? "asked just now" : `asked ${ago(ctx, w.asked_at)} ago`,
        pinged ? `next ${when(ctx, w.ping_after ?? now)}` : null,
      ]),
      ticket: w.ticket_id,
      href: w.url,
      dim: closed ? "answered" : pinged ? "pinged" : null,
      actions: closed
        ? button("Undo", { act: "wait-reopen", id: w.id, hotkey: "u" })
        : pinged
          ? ""
          : button("Pinged", { act: "wait-pinged", id: w.id, hotkey: "e" }, { cls: "primary" }) +
            menu(`wait-${w.id}`, button("Answered", { act: "wait-close", id: w.id, hotkey: "s" })),
    });
  }
  for (const t of tickets) {
    if (has(t.gate)) {
      list.push({
        key: `gate-${t.id}`,
        rank: 7,
        since: t.updated_at ?? now,
        verb: "Approve?",
        tone: "amber",
        title: `<span class="need-title">${esc(t.gate)}</span>`,
        sub: esc(cut(t.title ?? "", 80)),
        ticket: t.id,
        href: `/t/${encodeURIComponent(t.id)}`,
        dim: null,
        actions:
          button("Yes", { act: "gate", ticket: t.id, answer: "yes", hotkey: "e" }, { cls: "primary" }) +
          button("No", { act: "gate", ticket: t.id, answer: "no", hotkey: "s" }),
      });
    }
    if (has(t.decide)) {
      list.push({
        key: `decide-${t.id}`,
        rank: 8,
        since: t.updated_at ?? now,
        verb: "Decide",
        tone: "amber",
        title: `<span class="need-title">${esc(t.decide)}</span>`,
        sub: esc(cut(t.title ?? "", 80)),
        ticket: t.id,
        href: `/t/${encodeURIComponent(t.id)}`,
        dim: null,
        actions: "",
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
      title: `<span class="need-title">${esc(e.text.replace(/^(Yes|No): /, ""))}</span>`,
      sub: "",
      ticket: e.ticket_id,
      href: null,
      dim: e.text.startsWith("Yes") ? "yes" : "no",
      actions: "",
    });
  }
  return list.sort((a, b) => a.rank - b.rank || a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
}

function needRow(n: Need): string {
  const href = n.href === null ? "" : ` data-href="${esc(n.href)}"`;
  const dim = n.dim === null ? "" : `<span class="dim-label">${esc(n.dim)}</span>`;
  const finished = n.dim !== null && ["done", "answered", "yes", "no"].includes(n.dim);
  return `<li class="need tone-${n.tone}${n.dim === null ? "" : " is-dim"}${finished ? " is-done" : ""}" data-key="${esc(n.key)}"${href}>
<span class="verb">${esc(n.verb)}</span>
<span class="need-main">${n.title}<span class="need-sub">${n.sub}</span></span>
<span class="need-ticket">${ticketLink(n.ticket)}</span>
<span class="need-actions">${dim}${n.actions}</span>
</li>`;
}

function needsSection(ctx: Ctx, tickets: Ticket[]): string {
  const list = needs(ctx, tickets);
  const active = list.filter((n) => n.dim === null);
  const counts = new Map<string, { tone: Tone; n: number }>();
  for (const n of active) {
    const c = counts.get(n.verb) ?? { tone: n.tone, n: 0 };
    counts.set(n.verb, { tone: c.tone, n: c.n + 1 });
  }
  const summary = [...counts.entries()]
    .map(([verb, c]) => `<span class="stat tone-${c.tone}"><b>${c.n}</b> ${esc(verb)}</span>`)
    .join("");
  const body = list.length === 0 ? empty() : `<ul class="rows needs-list">${list.map(needRow).join("")}</ul>`;
  return `<section class="needs" data-needs-count="${active.length}"><div class="sec-head"><h2>Needs you</h2><span class="count${active.length > 0 ? " hot" : ""}">${active.length}</span><span class="stats">${summary}</span></div>${body}</section>`;
}

function prChip(ctx: Ctx, i: ItemRow): string {
  const ref = githubRef(i.url);
  const label = `${ref ? `#${ref.split("#")[1]}` : "PR"}${i.state ? ` ${i.state}` : ""}`;
  return linker(ctx)(i.url, label, `chip tone-${prTone(i.state).tone}`);
}

function ticketRow(ctx: Ctx, t: Ticket): string {
  const p = progress(ctx.db, t.id);
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE ticket_id = ? AND closed_at IS NULL ORDER BY id", t.id);
  const waiting =
    one<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM wait WHERE ticket_id = ? AND closed_at IS NULL", t.id)?.n ??
    0;
  const threads = items.filter((i) => i.kind === "thread").length;
  const chips = [
    ...items.filter((i) => i.kind === "pr").map((i) => prChip(ctx, i)),
    threads > 0 ? `<span class="chip tone-teal">Slack ${threads}</span>` : "",
    waiting > 0 ? `<span class="chip tone-orange">waiting ${waiting}</span>` : "",
    has(t.gate) ? `<span class="chip tone-amber">approve?</span>` : "",
    has(t.decide) ? `<span class="chip tone-amber">decide</span>` : "",
  ].join("");
  const pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
  const next = p.next ? `${p.next.n}. ${p.next.title}` : (t.next ?? "");
  const priority = (t.tracker_priority ?? "").trim();
  const search = [t.id, t.title, t.status, t.next, p.next?.title].join(" ").toLowerCase();
  return `<li class="ticket" data-key="t-${esc(t.id)}" data-href="/t/${encodeURIComponent(t.id)}" data-search="${esc(search)}">
<div class="t-top">${ticketLink(t.id)}<span class="t-title">${esc(t.title)}</span>${priority ? pill(priority, PRIORITY_TONE[priority.toLowerCase()] ?? "grey") : ""}${pill(DIR_LABEL[t.dir ?? ""] ?? t.dir ?? "", DIR_TONE[t.dir ?? ""] ?? "grey")}</div>
<div class="t-progress${p.total > 0 && p.done === p.total ? " complete" : ""}"><span class="bar"><span style="width:${pct}%"></span></span><span class="frac">${p.total === 0 ? "–" : `${p.done}/${p.total}`}</span></div>
<div class="t-next">${esc(cut(next || "–", 160))}</div>
<div class="chips">${chips}</div>
</li>`;
}

function ticketsSection(ctx: Ctx, tickets: Ticket[]): string {
  const filter = `<input class="filter" type="search" data-filter placeholder="/" aria-label="Filter tickets">`;
  const body =
    tickets.length === 0
      ? empty()
      : `<ul class="rows ticket-list">${tickets.map((t) => ticketRow(ctx, t)).join("")}</ul>`;
  return section("Tickets", tickets.length, body, "tickets", filter);
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
  const rows = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE status = 'draft' OR sent_text IS NULL ORDER BY status != 'draft', ticket_id, label",
  ).map((d) => {
    const sent = d.status !== "draft";
    const state = d.match_ref !== null ? pill("sent?", "blue") : sent ? pill("wording pending", "grey") : "";
    return `<li class="draft${sent ? " is-dim" : ""}" data-key="d-${esc(d.ticket_id)}-${esc(d.label)}">
<div class="d-head">${ticketLink(d.ticket_id)}<span class="d-label">${esc(d.label)}</span>${d.channel ? pill(d.channel, "teal") : ""}${state}<span class="d-actions">${button("Copy", { copy: d.body })}${button(sent ? "Sent" : "Sent", { act: "sent", ticket: d.ticket_id, label: d.label }, { cls: sent ? "" : "primary", disabled: sent || d.match_ref !== null })}</span></div>
<pre class="d-body">${esc(d.body)}</pre>
</li>`;
  });
  return section(
    "Drafts",
    rows.length,
    rows.length === 0 ? empty() : `<ul class="rows">${rows.join("")}</ul>`,
    "drafts",
  );
}

function eventRow(ctx: Ctx, e: EventRow, showTicket: boolean): string {
  const link = linker(ctx);
  const tone = EVENT_TONE[e.kind] ?? "grey";
  return `<li class="event"><span class="dot tone-${tone}"></span><span class="ts">${esc(e.ts.length > 10 && e.ts.startsWith(today(ctx.now, ctx.config.timezone)) ? e.ts.slice(11) : e.ts.slice(5))}</span>${showTicket ? ticketLink(e.ticket_id) : ""}<span class="e-text">${esc(e.text)}</span>${e.ref ? link(e.ref, "↗", "e-ref") : ""}</li>`;
}

function activitySection(ctx: Ctx): string {
  const from = startOfDayIso(sinceDate("yesterday", ctx.now, ctx.config.timezone), ctx.config.timezone);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? AND source != 'import' ORDER BY created_at DESC, id DESC LIMIT ?",
    from,
    MAX_ACTIVITY,
  );
  const body =
    events.length === 0
      ? empty()
      : `<ul class="rows events" data-keep-scroll data-key="activity">${events.map((e) => eventRow(ctx, e, true)).join("")}</ul>`;
  return section("Activity", events.length, body, "activity");
}

function sourceChip(ctx: Ctx, s: SourceRow): string {
  const stale = ctx.now.getTime() - new Date(s.last_sync).getTime() > STALE_MS;
  const state = s.last_error !== null ? "bad" : stale ? "stale" : "ok";
  const title = [`last sync ${when(ctx, s.last_sync)}`, s.cursor ? `cursor ${s.cursor}` : null, s.last_error]
    .filter(Boolean)
    .join("\n");
  return `<span class="src src-${state}" title="${esc(title)}"><i></i>${esc(s.name)}<small>${esc(when(ctx, s.last_sync))}</small></span>`;
}

function header(ctx: Ctx, sync: SyncState, active: "home" | "settings" | "ticket"): string {
  const sources = all<SourceRow>(ctx.db, "SELECT * FROM source ORDER BY name");
  const running = sync.status === "running";
  const result =
    sync.status === "failed"
      ? `<span class="sync-result bad" title="${esc(sync.detail ?? "")}">${esc(cut(sync.detail ?? "Sync failed", 90))}</span>`
      : sync.status === "finished"
        ? `<span class="sync-result" title="${esc(sync.detail ?? "")}">${esc(cut(sync.detail || `Synced ${when(ctx, sync.at ?? nowIso(ctx.now))}`, 90))}</span>`
        : "";
  const started = running && sync.at ? ` data-started="${esc(sync.at)}"` : "";
  return `<header class="top${running ? " syncing" : ""}">
<a class="brand" href="/"><span class="logo"></span>hub</a>
<span class="date">${esc(today(ctx.now, ctx.config.timezone))}</span>
<div class="sources">${sources.map((s) => sourceChip(ctx, s)).join("")}</div>
<div class="sync"${started}>${result}<span class="live" title="live"></span>${button(running ? "Syncing" : "Sync", { act: "sync" }, { cls: "primary sync-btn", disabled: running })}</div>
<a class="gear${active === "settings" ? " on" : ""}" href="/settings" title="Settings" aria-label="Settings">⚙</a>
<div class="strip"></div>
</header>`;
}

export function indexBody(ctx: Ctx, sync: SyncState): string {
  const order = ctx.config.openDirs;
  const tickets = openTickets(ctx).sort(
    (a, b) => order.indexOf(a.dir ?? "") - order.indexOf(b.dir ?? "") || byPriorityThenRecent(a, b),
  );
  return `${header(ctx, sync, "home")}
<main class="grid">
<div class="col">${needsSection(ctx, tickets)}${ticketsSection(ctx, tickets)}</div>
<div class="col">${todaySection(ctx)}${draftsSection(ctx)}${activitySection(ctx)}</div>
</main>`;
}

function field(label: string, value: string | null, tone: Tone | null = null): string {
  const v = (value ?? "").trim();
  const shown = v === "" || v === "-" ? `<span class="muted">–</span>` : esc(v);
  return `<dt>${esc(label)}</dt><dd${tone && v && v !== "-" ? ` class="tone-text-${tone}"` : ""}>${shown}</dd>`;
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
  const priority = (t.tracker_priority ?? "").trim();
  const pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);

  const head = `<div class="page-head">${ticketLink(t.id)}<h1>${esc(t.title)}</h1>${priority ? pill(priority, PRIORITY_TONE[priority.toLowerCase()] ?? "grey") : ""}${pill(DIR_LABEL[t.dir ?? ""] ?? t.dir ?? "", DIR_TONE[t.dir ?? ""] ?? "grey")}${t.tracker_state ? pill(t.tracker_state, "violet") : ""}${link(t.tracker_url, "tracker ↗", "head-link")}</div>`;
  const state = `<dl class="state">${field("Status", t.status)}${field("Next", t.next, "blue")}${field("Approve?", t.gate, "amber")}${field("Decide", t.decide, "amber")}${field("Repo", [t.repo, t.branch].filter(Boolean).join(" · "))}${field("PRs", t.prs)}${field("Owner", t.owner)}</dl>`;
  const stepList =
    steps.length === 0
      ? empty()
      : `<div class="t-progress${p.done === p.total ? " complete" : ""}"><span class="bar"><span style="width:${pct}%"></span></span><span class="frac">${p.done}/${p.total}</span></div><ol class="steps">${steps
          .map(
            (s) =>
              `<li class="${s.done_at === null ? (p.next?.n === s.n ? "next" : "") : "done"}"><span class="check"></span><span class="s-title">${esc(s.title)}</span>${s.evidence ? link(s.evidence, "↗", "e-ref") : ""}</li>`,
          )
          .join("")}</ol>`;
  const itemRows = items.map((i) => {
    const v = itemVerb(i);
    return `<li class="need tone-${v.tone}${i.closed_at ? " is-dim" : ""}" data-key="ti-${i.id}"><span class="verb">${esc(v.verb)}</span><span class="need-main">${link(i.url ?? (/^https?:/.test(i.ref) ? i.ref : null), i.title ?? i.ref, "need-title")}<span class="need-sub">${sourceLine([githubRef(i.url) ?? i.source, i.state, i.closed_at ? "closed" : null])}</span></span></li>`;
  });
  const waitRows = waits.map(
    (w) =>
      `<li class="need tone-orange" data-key="tw-${w.id}"><span class="verb">Wait</span><span class="need-main">${link(w.url, w.who, "need-title")}<span class="need-sub">asked ${esc(ago(ctx, w.asked_at))} ago${w.ping_after ? ` · ping ${esc(when(ctx, w.ping_after))}` : ""}</span></span><span class="need-ticket"></span><span class="need-actions">${button("Pinged", { act: "wait-pinged", id: w.id })}${button("Answered", { act: "wait-close", id: w.id })}</span></li>`,
  );
  const draftRows = drafts.map(
    (d) =>
      `<li class="draft" data-key="td-${esc(d.label)}"><div class="d-head"><span class="d-label">${esc(d.label)}</span>${pill(d.status, d.status === "draft" ? "blue" : "green")}${d.channel ? pill(d.channel, "teal") : ""}<span class="d-actions">${button("Copy", { copy: d.sent_text ?? d.body })}</span></div><pre class="d-body">${esc(d.sent_text ?? d.body)}</pre></li>`,
  );
  const noteRows = notes.map(
    (n) =>
      `<details data-key="note-${esc(n.title)}"><summary>${esc(n.title)}</summary><div class="md">${renderMarkdown(n.body, (url, text) => link(url, text))}</div></details>`,
  );
  return `${header(ctx, sync, "ticket")}
${head}
<main class="grid">
<div class="col">${section("State", null, state, "state-sec")}${section("Steps", steps.length, stepList, "steps-sec")}${section("Timeline", events.length, events.length === 0 ? empty() : `<ul class="rows events" data-keep-scroll data-key="timeline">${events.map((e) => eventRow(ctx, e, false)).join("")}</ul>`, "timeline")}</div>
<div class="col">${section("Items", items.length, itemRows.length === 0 ? empty() : `<ul class="rows">${itemRows.join("")}</ul>`, "items-sec")}${section("Waiting on", waits.length, waitRows.length === 0 ? empty() : `<ul class="rows">${waitRows.join("")}</ul>`, "waits-sec")}${section("Drafts", drafts.length, draftRows.length === 0 ? empty() : `<ul class="rows">${draftRows.join("")}</ul>`, "drafts")}${section("Notes", notes.length, noteRows.length === 0 ? empty() : noteRows.join(""), "notes")}</div>
</main>`;
}

function segmented(key: string, value: string, options: [string, string][]): string {
  return `<div class="seg" role="radiogroup">${options
    .map(
      ([v, label]) =>
        `<button type="button" role="radio" aria-checked="${v === value}" class="${v === value ? "on" : ""}" data-config="${esc(key)}" data-value="${esc(JSON.stringify(v))}">${esc(label)}</button>`,
    )
    .join("")}</div>`;
}

function toggle(key: string, on: boolean): string {
  return `<button type="button" role="switch" aria-checked="${on}" class="switch${on ? " on" : ""}" data-config="${esc(key)}" data-value="${esc(JSON.stringify(!on))}"><span class="knob"></span></button>`;
}

function row(label: string, control: string): string {
  return `<div class="set-row"><span class="set-label">${esc(label)}</span><div class="set-control">${control}</div></div>`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function settingsBody(ctx: Ctx, sync: SyncState, db: DbInfo): string {
  const c = ctx.config;
  const shortcuts: [string, string][] = [
    ["j / k", "next / previous row"],
    ["Enter", "open"],
    ["e", "done, yes, pinged"],
    ["s", "snooze, no, answered"],
    ["u", "undo"],
    ["/", "filter tickets"],
    [",", "settings"],
    ["Esc", "back"],
  ];
  return `${header(ctx, sync, "settings")}
<div class="page-head"><h1>Settings</h1></div>
<main class="grid settings">
<div class="col">
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
</div>
<div class="col">
${section("Sync", null, `<pre class="text code">${esc(JSON.stringify(c.syncCommand))}</pre>`, "set-sec")}
${section(
  "Database",
  null,
  row("Path", `<code class="path">${esc(db.path)}</code>${button("Copy", { copy: db.path })}`) +
    row("Size", esc(size(db.size))) +
    row("Schema", `v${esc(db.schema)}`),
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
<div class="toasts" aria-live="polite"></div>
</body>
</html>`;
}
