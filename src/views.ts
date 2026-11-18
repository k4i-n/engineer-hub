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
import { progress } from "./steps.ts";
import { cut, nowIso, nowTs, sinceDate, startOfDayIso, today } from "./util.ts";

export type SyncState = {
  status: "idle" | "running" | "finished" | "failed";
  at: string | null;
  detail: string | null;
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const KIND_LABEL: Record<string, string> = { review_request: "review", message: "message" };
const MAX_CHANGED = 40;
const MAX_TIMELINE = 200;

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function link(url: string | null, text: string): string {
  if (url === null || !/^https?:\/\//.test(url)) return esc(text);
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)}</a>`;
}

function ticketLink(id: string | null): string {
  if (id === null) return "";
  return `<a class="tid" href="/t/${encodeURIComponent(id)}">${esc(id)}</a>`;
}

function when(ctx: Ctx, iso: string): string {
  const shown = nowTs(new Date(iso), ctx.config.timezone);
  return shown.startsWith(today(ctx.now, ctx.config.timezone)) ? shown.slice(11) : shown.slice(5);
}

function button(label: string, data: Record<string, string | number>, disabled = false): string {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join("");
  return `<button type="button"${attrs}${disabled ? " disabled" : ""}>${esc(label)}</button>`;
}

function section(title: string, count: number | null, body: string, cls = ""): string {
  const badge = count === null ? "" : `<span class="count">${count}</span>`;
  return `<section class="${cls}"><h2>${esc(title)}${badge}</h2>${body}</section>`;
}

function list(rows: string[]): string {
  if (rows.length === 0) return `<p class="empty">—</p>`;
  return `<ul class="rows">${rows.map((r) => `<li>${r}</li>`).join("")}</ul>`;
}

function kind(label: string, cls = ""): string {
  return `<span class="kind ${cls}">${esc(label)}</span>`;
}

function itemTitle(i: ItemRow): string {
  return link(i.url ?? (/^https?:/.test(i.ref) ? i.ref : null), i.title ?? i.ref);
}

function header(ctx: Ctx, sync: SyncState): string {
  const sources = all<SourceRow>(ctx.db, "SELECT * FROM source ORDER BY name");
  const chips = sources
    .map((s) => {
      const error = s.last_error === null ? "" : ` title="${esc(s.last_error)}"`;
      return `<span class="chip${s.last_error === null ? "" : " bad"}"${error}>${esc(s.name)} ${esc(when(ctx, s.last_sync))}</span>`;
    })
    .join("");
  const state =
    sync.status === "running"
      ? "Syncing…"
      : sync.status === "failed"
        ? "Sync failed"
        : sync.status === "finished" && sync.at !== null
          ? `Synced ${when(ctx, sync.at)}`
          : "";
  const detail = sync.status === "failed" && sync.detail ? ` title="${esc(sync.detail)}"` : "";
  return `<header>
  <a class="brand" href="/">hub</a>
  <span class="date">${esc(today(ctx.now, ctx.config.timezone))}</span>
  <div class="sources">${chips}</div>
  <div class="sync"><span class="sync-state${sync.status === "failed" ? " bad" : ""}"${detail}>${esc(state)}</span>${button("Sync", { act: "sync" }, sync.status === "running")}</div>
</header>`;
}

function needsYou(ctx: Ctx, tickets: Ticket[]): string {
  const at = nowIso(ctx.now);
  const items = all<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE needs_me = 1 AND closed_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?)
     ORDER BY changed_at DESC, id DESC`,
    at,
  );
  const waits = all<WaitRow>(
    ctx.db,
    "SELECT * FROM wait WHERE closed_at IS NULL AND ping_after <= ? ORDER BY ping_after, id",
    at,
  );
  const matches = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE match_ref IS NOT NULL ORDER BY ticket_id, label");
  const stops = tickets.flatMap((t) => [
    ...(has(t.decide) ? [{ id: t.id, label: "decide", text: t.decide }] : []),
    ...(has(t.gate) ? [{ id: t.id, label: "gate", text: t.gate }] : []),
  ]);
  const rows = [
    ...items.map(
      (i) =>
        `${kind(KIND_LABEL[i.kind] ?? i.kind, i.kind === "alert" ? "bad" : "")}<span class="main">${itemTitle(i)}</span>${ticketLink(i.ticket_id)}<span class="actions">${button("Done", { act: "item-done", id: i.id })}${button("Snooze", { act: "item-snooze", id: i.id })}</span>`,
    ),
    ...matches.map(
      (d) =>
        `${kind("sent?")}<span class="main">${esc(d.label)}: “${esc(cut(d.match_text ?? "", 160))}” ${link(d.match_ref, "↗")}</span>${ticketLink(d.ticket_id)}<span class="actions">${button("Yes", { act: "match", ticket: d.ticket_id, label: d.label, answer: "yes" })}${button("No", { act: "match", ticket: d.ticket_id, label: d.label, answer: "no" })}</span>`,
    ),
    ...waits.map(
      (w) =>
        `${kind("ping")}<span class="main">${esc(w.who)} ${link(w.url, "↗")} <span class="muted">since ${esc(when(ctx, w.asked_at))}</span></span>${ticketLink(w.ticket_id)}<span class="actions">${button("Close", { act: "wait-close", id: w.id })}</span>`,
    ),
    ...stops.map((g) => `${kind(g.label)}<span class="main">${esc(g.text)}</span>${ticketLink(g.id)}`),
  ];
  return section("Needs you", rows.length, list(rows), "needs");
}

function prLabel(i: ItemRow): string {
  const number = /\/pull\/(\d+)/.exec(i.url ?? i.ref)?.[1];
  return `${number ? `#${number}` : "PR"}${i.state ? ` ${i.state}` : ""}`;
}

function ticketRow(ctx: Ctx, t: Ticket): string {
  const p = progress(ctx.db, t.id);
  const items = all<ItemRow>(ctx.db, "SELECT * FROM item WHERE ticket_id = ? AND closed_at IS NULL ORDER BY id", t.id);
  const waits =
    one<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM wait WHERE ticket_id = ? AND closed_at IS NULL", t.id)?.n ??
    0;
  const prs = items.filter((i) => i.kind === "pr").map((i) => `<span class="chip">${link(i.url, prLabel(i))}</span>`);
  const threads = items.filter((i) => i.kind === "thread").length;
  const chips = [
    ...prs,
    threads > 0 ? `<span class="chip">Slack ${threads}</span>` : "",
    waits > 0 ? `<span class="chip">waiting ${waits}</span>` : "",
    has(t.gate) ? `<span class="chip bad">gate</span>` : "",
  ].join("");
  const pct = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100);
  const next = p.next ? `${p.next.n}. ${p.next.title}` : (t.next ?? "");
  return `<div class="t-head">${ticketLink(t.id)}<span class="t-title">${esc(t.title)}</span><span class="muted">${esc(t.dir)}${t.tracker_priority ? ` · ${esc(t.tracker_priority)}` : ""}</span></div>
<div class="t-progress"><span class="bar"><span style="width:${pct}%"></span></span><span class="frac">${p.total === 0 ? "–" : `${p.done}/${p.total}`}</span></div>
<div class="t-next">${esc(cut(next || "–", 160))}</div>
<div class="chips">${chips}</div>`;
}

function todaySection(ctx: Ctx): string {
  const day =
    one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", today(ctx.now, ctx.config.timezone)) ??
    one<DayRow>(ctx.db, "SELECT * FROM day ORDER BY date DESC LIMIT 1");
  const body =
    day === undefined
      ? `<p class="empty">—</p>`
      : `<div class="day-date muted">${esc(day.date)}</div><pre class="text">${esc(day.body)}</pre>`;
  return section("Today", null, body, "today");
}

function drafts(ctx: Ctx): string {
  const rows = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE status = 'draft' OR sent_text IS NULL ORDER BY status = 'draft' DESC, ticket_id, label",
  ).map((d) => {
    const sent = d.status !== "draft";
    return `<div class="d-head">${ticketLink(d.ticket_id)}<span class="main">${esc(d.label)}</span><span class="muted">${esc(d.channel ?? "")}</span><span class="actions">${button("Copy", { copy: d.body })}${button(sent ? "Sent ✓" : "Sent", { act: "sent", ticket: d.ticket_id, label: d.label }, sent)}</span></div><pre class="text clip">${esc(d.body)}</pre>`;
  });
  return section("Drafts", rows.length, list(rows), "drafts");
}

function changed(ctx: Ctx): string {
  const from = startOfDayIso(sinceDate("yesterday", ctx.now, ctx.config.timezone), ctx.config.timezone);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
    from,
    MAX_CHANGED,
  );
  const rows = events.map(
    (e) =>
      `<span class="ts">${esc(e.ts.slice(5))}</span>${ticketLink(e.ticket_id)}<span class="main">${esc(cut(e.text, 200))}</span>`,
  );
  return section("Changed", rows.length, list(rows), "changed");
}

export function indexBody(ctx: Ctx, sync: SyncState): string {
  const tickets = openTickets(ctx).sort(
    (a, b) =>
      ctx.config.openDirs.indexOf(a.dir ?? "") - ctx.config.openDirs.indexOf(b.dir ?? "") || byPriorityThenRecent(a, b),
  );
  const ticketRows = tickets.map((t) => ticketRow(ctx, t));
  return `${header(ctx, sync)}
<div class="grid">
  <div class="col">${needsYou(ctx, tickets)}${section("Tickets", tickets.length, list(ticketRows), "tickets")}</div>
  <div class="col">${todaySection(ctx)}${drafts(ctx)}${changed(ctx)}</div>
</div>`;
}

function field(label: string, value: string | null): string {
  return `<dt>${esc(label)}</dt><dd>${esc((value ?? "").trim() || "–")}</dd>`;
}

export function ticketBody(ctx: Ctx, id: string, sync: SyncState): string {
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
  const ticketDrafts = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? ORDER BY id", id);
  const events = all<EventRow>(
    ctx.db,
    "SELECT * FROM event WHERE ticket_id = ? ORDER BY ts DESC, id DESC LIMIT ?",
    id,
    MAX_TIMELINE,
  );
  const notes = all<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? ORDER BY position, id", id);
  const p = progress(ctx.db, id);

  const state = `<dl class="state">${field("status", t.status)}${field("next", t.next)}${field("gate", t.gate)}${field("decide", t.decide)}${field("repo", [t.repo, t.branch].filter(Boolean).join(" · "))}${field("PRs", t.prs)}${field("owner", t.owner)}</dl>
<div class="muted">${esc(t.dir)}${t.tracker_state ? ` · ${esc(t.tracker_state)}` : ""}${t.tracker_priority ? ` · ${esc(t.tracker_priority)}` : ""} ${link(t.tracker_url, "tracker ↗")}</div>`;
  const stepRows = steps.map(
    (s) =>
      `<span class="check${s.done_at === null ? "" : " done"}">${s.done_at === null ? "○" : "●"}</span><span class="main">${s.n}. ${esc(s.title)}</span>${s.evidence ? link(s.evidence, "↗") : ""}`,
  );
  const itemRows = items.map(
    (i) =>
      `${kind(KIND_LABEL[i.kind] ?? i.kind, i.kind === "alert" ? "bad" : "")}<span class="main">${itemTitle(i)}</span><span class="muted">${esc(i.state ?? "")}${i.closed_at ? " · closed" : ""}</span>`,
  );
  const waitRows = waits.map(
    (w) =>
      `${kind("wait")}<span class="main">${esc(w.who)} ${link(w.url, "↗")}</span><span class="muted">since ${esc(when(ctx, w.asked_at))}</span><span class="actions">${button("Close", { act: "wait-close", id: w.id })}</span>`,
  );
  const draftRows = ticketDrafts.map(
    (d) =>
      `<div class="d-head"><span class="main">${esc(d.label)}</span><span class="muted">${esc(d.status)}${d.channel ? ` · ${esc(d.channel)}` : ""}</span><span class="actions">${button("Copy", { copy: d.body })}</span></div><pre class="text clip">${esc(d.sent_text ?? d.body)}</pre>`,
  );
  const eventRows = events.map(
    (e) =>
      `<span class="ts">${esc(e.ts)}</span>${kind(e.kind)}<span class="main">${esc(e.text)}</span>${e.ref ? link(e.ref, "↗") : ""}`,
  );
  const noteRows = notes.map(
    (n) => `<details><summary>${esc(n.title)}</summary><pre class="text">${esc(n.body)}</pre></details>`,
  );
  return `${header(ctx, sync)}
<div class="t-page-head">${ticketLink(t.id)}<h1>${esc(t.title)}</h1></div>
<div class="grid">
  <div class="col">${section("State", null, state)}${section("Steps", p.total === 0 ? 0 : p.done, list(stepRows))}${section("Timeline", events.length, list(eventRows), "timeline")}</div>
  <div class="col">${section("Items", items.length, list(itemRows))}${section("Waiting on", waits.length, list(waitRows))}${section("Drafts", ticketDrafts.length, list(draftRows), "drafts")}${section("Notes", notes.length, notes.length === 0 ? `<p class="empty">—</p>` : noteRows.join(""))}</div>
</div>`;
}

const CSS = `
:root{--bg:#f6f6f4;--panel:#fff;--text:#1d1d1b;--muted:#77756f;--line:#e4e2dc;--accent:#2f6fde;--bad:#c2410c;--chip:#efeee9;--bar:#dcdad3}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--panel:#1b1b19;--text:#e8e6e1;--muted:#97948c;--line:#2c2b28;--accent:#7aa7ff;--bad:#fb923c;--chip:#262522;--bar:#33322e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:12px;padding:10px 20px;background:var(--panel);border-bottom:1px solid var(--line);min-height:52px}
.brand{font-weight:700;color:var(--text);font-size:16px}
.date{color:var(--muted)}
.sources{display:flex;gap:6px;flex-wrap:wrap;flex:1;min-width:0}
.sync{display:flex;align-items:center;gap:8px}
.sync-state{color:var(--muted);min-width:110px;text-align:right;font-size:13px}
.grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;padding:16px 20px;max-width:1440px;margin:0 auto}
@media (max-width:900px){.grid{grid-template-columns:minmax(0,1fr);padding:12px 16px}header{padding:10px 16px;flex-wrap:wrap}}
.col{display:flex;flex-direction:column;gap:16px;min-width:0}
section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
h1{font-size:18px;margin:0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;display:flex;align-items:center;gap:8px}
.count{background:var(--chip);color:var(--text);border-radius:9px;padding:0 7px;font-size:11px;letter-spacing:0}
.needs .count{background:var(--accent);color:#fff}
.rows{list-style:none;margin:0;padding:0}
.rows>li{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:7px 0;border-top:1px solid var(--line)}
.rows>li:first-child{border-top:0}
.tickets .rows>li,.drafts .rows>li{display:block}
.main{flex:1;min-width:0;overflow-wrap:anywhere}
.muted,.ts,.empty{color:var(--muted)}
.empty{margin:4px 0}
.ts{font-variant-numeric:tabular-nums;font-size:12px;min-width:76px}
.tid{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.kind{font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:var(--chip);border-radius:4px;padding:1px 6px;min-width:58px;text-align:center}
.kind.bad,.chip.bad,.bad{color:var(--bad)}
.actions{display:flex;gap:6px;margin-left:auto}
button{font:inherit;font-size:12px;min-width:64px;padding:3px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}
button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
button.err{border-color:var(--bad);color:var(--bad)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;min-height:20px}
.chip{background:var(--chip);border-radius:10px;padding:1px 8px;font-size:12px;white-space:nowrap}
.t-head,.d-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.t-title{flex:1;min-width:0;font-weight:500}
.t-progress{display:flex;align-items:center;gap:8px;margin-top:4px}
.bar{flex:1;height:6px;background:var(--bar);border-radius:3px;overflow:hidden}
.bar>span{display:block;height:100%;background:var(--accent)}
.frac{font-size:12px;color:var(--muted);min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
.t-next{color:var(--muted);margin-top:2px}
.text{white-space:pre-wrap;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:6px 0 0;overflow-wrap:anywhere}
.clip{max-height:9em;overflow:auto;background:var(--bg);border-radius:6px;padding:6px 8px}
.today .text{max-height:28em;overflow:auto}
.state{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 10px;margin:0 0 8px}
.state dt{color:var(--muted)}.state dd{margin:0;overflow-wrap:anywhere}
.t-page-head{display:flex;align-items:baseline;gap:12px;padding:16px 20px 0;max-width:1440px;margin:0 auto}
.check{color:var(--muted)}.check.done{color:var(--accent)}
details{border-top:1px solid var(--line);padding:6px 0}details:first-of-type{border-top:0}
summary{cursor:pointer}
.timeline .rows{max-height:60vh;overflow:auto}
`;

const SCRIPT = `
const token = document.querySelector('meta[name="hub-token"]').content;
const app = document.getElementById('app');
let busy = false, again = false;
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const r = await fetch(location.pathname + '?part=1', { cache: 'no-store' });
    if (r.ok) app.innerHTML = await r.text();
  } finally {
    busy = false;
    if (again) { again = false; refresh(); }
  }
}
const events = new EventSource('/events');
events.addEventListener('change', refresh);
events.addEventListener('open', refresh);
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.copy !== undefined) {
    await navigator.clipboard.writeText(b.dataset.copy);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    return;
  }
  const act = b.dataset.act;
  if (!act) return;
  b.disabled = true;
  b.classList.remove('err');
  const r = await fetch('/api/' + act, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-token': token },
    body: JSON.stringify(b.dataset),
  });
  if (!r.ok) { b.disabled = false; b.classList.add('err'); b.title = await r.text(); }
});
`;

export function page(title: string, body: string, token: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="hub-token" content="${esc(token)}">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app">${body}</div>
<script nonce="${esc(nonce)}">${SCRIPT}</script>
</body>
</html>`;
}
