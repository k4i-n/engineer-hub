import type { DatabaseSync } from "node:sqlite";
import { type Config, DEFAULTS, loadConfig, setConfig } from "./config.ts";
import {
  all,
  checkLimit,
  type DayRow,
  type DraftRow,
  type EventRow,
  ftsQuery,
  getTicket,
  LIMITED_FIELDS,
  type NoteRow,
  one,
  SETTABLE_FIELDS,
  type Ticket,
} from "./db.ts";
import { splitResume } from "./parse.ts";
import { progress } from "./steps.ts";
import { cut, HubError, nowIso, nowTs, sinceDate, startOfDayIso, today } from "./util.ts";

export type Ctx = { db: DatabaseSync; config: Config; now: Date };
export type Result = { text: string; json: unknown; exitCode?: number };

const EVENT_KINDS = ["log", "reading", "decision", "tracker", "pr", "slack", "sync", "step", "import"];
const EVENT_SOURCES = ["agent", "human", "sync", "import"];
const NOTE_KINDS = ["ticket_body", "detail", "state_notes", "other"];
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const CLOSED_TRACKER_STATES = ["done", "canceled", "cancelled", "duplicate"];

function oneOf(name: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new HubError(`${name} must be one of ${allowed.join(", ")}, not ${value}`);
}

export function has(value: string | null): value is string {
  return value !== null && value.trim() !== "" && value.trim() !== "-";
}

function rank(priority: string | null): number {
  return PRIORITY_RANK[(priority ?? "").trim().toLowerCase()] ?? 4;
}

function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

export function byPriorityThenRecent(a: Ticket, b: Ticket): number {
  return rank(a.tracker_priority) - rank(b.tracker_priority) || (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
}

function touch(ctx: Ctx, id: string): void {
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(nowIso(ctx.now), id);
}

export function openTickets(ctx: Ctx): Ticket[] {
  const dirs = ctx.config.openDirs;
  const tickets = all<Ticket>(ctx.db, `SELECT * FROM ticket WHERE dir IN (${dirs.map(() => "?").join(", ")})`, ...dirs);
  return tickets.filter(
    (t) => !(t.dir === "unfiled" && CLOSED_TRACKER_STATES.includes((t.tracker_state ?? "").trim().toLowerCase())),
  );
}

function trackerDisagrees(t: Ticket): boolean {
  if (!has(t.tracker_state) || t.dir === "unfiled" || t.dir === null) return false;
  return letters(t.tracker_state) !== letters(t.dir);
}

function lastEvents(ctx: Ctx, id: string, limit: number): EventRow[] {
  return all<EventRow>(ctx.db, "SELECT * FROM event WHERE ticket_id = ? ORDER BY ts DESC, id DESC LIMIT ?", id, limit);
}

export function ticket(ctx: Ctx, id: string): Result {
  const t = getTicket(ctx.db, id);
  const v = (value: string | null) => value ?? "";
  const events = lastEvents(ctx, id, 3);
  const eventCount = one<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM event WHERE ticket_id = ?", id)?.n ?? 0;
  const drafts = all<DraftRow>(
    ctx.db,
    "SELECT * FROM draft WHERE ticket_id = ? AND status = 'draft' ORDER BY label",
    id,
  );
  const itemCounts = one<{ open: number; needsMe: number }>(
    ctx.db,
    "SELECT count(*) AS open, coalesce(sum(needs_me), 0) AS needsMe FROM item WHERE ticket_id = ? AND closed_at IS NULL",
    id,
  ) ?? { open: 0, needsMe: 0 };
  const steps = progress(ctx.db, id);
  const openWaits =
    one<{ n: number }>(ctx.db, "SELECT count(*) AS n FROM wait WHERE ticket_id = ? AND closed_at IS NULL", id)?.n ?? 0;
  const notes = all<{ title: string }>(ctx.db, "SELECT title FROM note WHERE ticket_id = ? ORDER BY position, id", id);
  const lines = [
    `${t.id} | ${v(t.dir)} | ${v(t.title)}`,
    `status: ${v(t.status)}`,
    `repo: ${v(t.repo)} | worktree: ${v(t.worktree)} | branch: ${v(t.branch)}`,
    `prs: ${v(t.prs)}`,
    `gate: ${v(t.gate)}`,
    `decide: ${v(t.decide)}`,
    `next: ${v(t.next)}`,
    `owner: ${v(t.owner)} | updated: ${v(t.updated)}`,
    `tracker: ${v(t.tracker_state)} | ${v(t.tracker_priority)} | ${v(t.tracker_url)}`,
    `path: ${v(t.path)}`,
    `steps: ${steps.done}/${steps.total}${steps.next ? ` | next step: ${steps.next.n} ${cut(steps.next.title, 100)}` : ""}`,
    `events: ${eventCount}, last:`,
    ...events.map((e) => `  ${e.ts} ${cut(e.text, 100)}`),
    `drafts: ${drafts.length} (${cut(drafts.map((d) => d.label).join(", "), 150)})`,
    `items: ${itemCounts.open} open, ${itemCounts.needsMe} need you | waits: ${openWaits} open`,
    `notes: ${cut(notes.map((n) => n.title).join("; "), 200)}`,
  ];
  return {
    text: lines.join("\n"),
    json: {
      ticket: t,
      events,
      eventCount,
      drafts,
      items: itemCounts,
      openWaits,
      steps,
      notes: notes.map((n) => n.title),
    },
  };
}

export function boardLine(t: Ticket): string {
  let line = `  [${t.tracker_priority || "-"}]`;
  if (trackerDisagrees(t)) line += ` [TRACKER: ${t.tracker_state}]`;
  line += ` ${t.id} | ${cut(t.status || "-", 90)}`;
  if (has(t.prs)) line += ` | PR ${cut(t.prs, 90)}`;
  if (has(t.gate)) line += ` | GATE: ${cut(t.gate, 90)}`;
  if (has(t.decide)) line += ` | DECIDE: ${cut(t.decide, 90)}`;
  return `${line} | next: ${cut(t.next || "-", 90)}`;
}

export function board(ctx: Ctx, pattern: string | undefined): Result {
  let filter: RegExp | null = null;
  try {
    filter = pattern ? new RegExp(pattern, "i") : null;
  } catch {
    throw new HubError(`board filter ${pattern} is not a valid regular expression`);
  }
  const tickets = openTickets(ctx).filter(
    (t) => !filter || filter.test(t.id) || filter.test(t.title ?? "") || filter.test(t.path ?? ""),
  );
  const lines: string[] = [];
  const groups: Record<string, Ticket[]> = {};
  for (const dir of ctx.config.openDirs) {
    const group = tickets.filter((t) => t.dir === dir).sort(byPriorityThenRecent);
    if (group.length === 0) continue;
    groups[dir] = group;
    lines.push(`== ${dir}`, ...group.map(boardLine));
  }
  return { text: lines.join("\n") || "no open tickets", json: groups };
}

export function next(ctx: Ctx): Result {
  const tickets = ctx.config.taskDirs
    .slice(0, 2)
    .flatMap((dir) => all<Ticket>(ctx.db, "SELECT * FROM ticket WHERE dir = ?", dir).sort(byPriorityThenRecent));
  const lines = tickets.map((t) => `${t.id} | next: ${t.next || "-"} | gate: ${t.gate || "-"}`);
  return {
    text: lines.join("\n") || "nothing in progress or to do",
    json: tickets.map((t) => ({ id: t.id, dir: t.dir, next: t.next, gate: t.gate, priority: t.tracker_priority })),
  };
}

export function gates(ctx: Ctx): Result {
  const tickets = openTickets(ctx)
    .filter((t) => has(t.gate) || has(t.decide))
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = tickets.map((t) => `${t.id} | GATE: ${t.gate || "-"} | DECIDE: ${t.decide || "-"}`);
  return {
    text: lines.join("\n") || "no gates",
    json: tickets.map((t) => ({ id: t.id, gate: t.gate, decide: t.decide })),
  };
}

export function changed(ctx: Ctx, since: string | undefined): Result {
  if (!since) throw new HubError("usage: hub changed --since <YYYY-MM-DD|yesterday|today>");
  const date = sinceDate(since, ctx.now, ctx.config.timezone);
  const from = startOfDayIso(date, ctx.config.timezone);
  const events = all<EventRow & { created_at: string }>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? ORDER BY ts DESC, id DESC",
    from,
  );
  const touched = all<{ id: string; updated_at: string }>(
    ctx.db,
    "SELECT id, updated_at FROM ticket WHERE updated_at >= ?",
    from,
  );
  const latest = new Map<string, string>();
  for (const t of touched) latest.set(t.id, t.updated_at);
  for (const e of events) if ((latest.get(e.ticket_id) ?? "") < e.created_at) latest.set(e.ticket_id, e.created_at);
  const ids = [...latest.keys()].sort((a, b) => (latest.get(b) ?? "").localeCompare(latest.get(a) ?? ""));
  const lines: string[] = [];
  const json: Record<string, EventRow[]> = {};
  for (const id of ids) {
    const own = events.filter((e) => e.ticket_id === id);
    json[id] = own;
    lines.push(`${id}: ${own.length} event(s)`, ...own.map((e) => `  ${e.ts} [${e.kind}] ${cut(e.text, 120)}`));
  }
  return { text: lines.join("\n") || `nothing changed since ${date}`, json };
}

type Hit = { tbl: string; ticket_id: string; label: string; snip: string; score: number };

export function search(ctx: Ctx, query: string | undefined, limit: number): Result {
  const match = ftsQuery(query ?? "");
  const snippet = (fts: string) => `snippet(${fts}, -1, '[', ']', '...', 10)`;
  const hits = all<Hit>(
    ctx.db,
    `SELECT 'ticket' AS tbl, id AS ticket_id, title AS label, ${snippet("ticket_fts")} AS snip, bm25(ticket_fts) AS score
       FROM ticket_fts WHERE ticket_fts MATCH ?1
     UNION ALL
     SELECT 'note', ticket_id, title, ${snippet("note_fts")}, bm25(note_fts) FROM note_fts WHERE note_fts MATCH ?1
     UNION ALL
     SELECT 'event', e.ticket_id, e.ts, ${snippet("event_fts")}, bm25(event_fts)
       FROM event_fts JOIN event e ON e.id = event_fts.rowid WHERE event_fts MATCH ?1
     UNION ALL
     SELECT 'draft', ticket_id, label, ${snippet("draft_fts")}, bm25(draft_fts) FROM draft_fts WHERE draft_fts MATCH ?1
     ORDER BY score LIMIT ?2`,
    match,
    limit,
  );
  const lines = hits.map((h) => `${h.tbl} ${h.ticket_id} ${h.label ?? ""}: ${cut(h.snip, 160)}`);
  return { text: lines.join("\n") || "no matches", json: hits };
}

export function events(ctx: Ctx, id: string, limit: number, full: boolean): Result {
  getTicket(ctx.db, id);
  const rows = lastEvents(ctx, id, limit);
  const lines = rows.map((e) => `${e.ts} [${e.kind}] ${full ? e.text : cut(e.text, 120)}`);
  return { text: lines.join("\n") || "no events", json: rows };
}

export function notes(ctx: Ctx, id: string): Result {
  getTicket(ctx.db, id);
  const rows = all<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? ORDER BY position, id", id);
  const lines = rows.map((n) => `${n.title} (${n.kind}, ${n.body.length} chars)`);
  return { text: lines.join("\n") || "no notes", json: rows.map(({ body, ...n }) => ({ ...n, size: body.length })) };
}

export function noteShow(ctx: Ctx, id: string, title: string): Result {
  const note = one<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? AND title = ?", id, title);
  if (!note) throw new HubError(`no note "${title}" on ${id} (hub notes ${id} lists them)`);
  return { text: note.body, json: note };
}

export function drafts(ctx: Ctx, id: string | undefined): Result {
  if (!id) {
    const rows = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE status = 'draft' ORDER BY ticket_id, label");
    const lines = rows.map((d) => `${d.ticket_id} | ${d.label} | ${cut(d.body.split("\n")[0] ?? "", 80)}`);
    return { text: lines.join("\n") || "no open drafts", json: rows };
  }
  getTicket(ctx.db, id);
  const rows = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? ORDER BY id", id);
  const lines = rows.map((d) => {
    const pending = d.status !== "draft" && d.sent_text === null ? "wording pending" : null;
    const proposed = d.match_ref === null ? null : "match proposed";
    return [d.label, d.status, d.channel, d.posted_at, pending, proposed]
      .filter((part) => part !== null && part !== "")
      .join(" | ");
  });
  return { text: lines.join("\n") || "no drafts", json: rows };
}

export function draftShow(ctx: Ctx, id: string, label: string): Result {
  const draft = one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? AND label = ?", id, label);
  if (!draft) throw new HubError(`no draft "${label}" on ${id} (hub drafts ${id} lists them)`);
  if (draft.sent_text === null) return { text: draft.body, json: draft };
  return {
    text: `${draft.body}\n\n--- sent${draft.sent_ref ? ` ${draft.sent_ref}` : ""}\n${draft.sent_text}`,
    json: draft,
  };
}

export function day(ctx: Ctx, date: string | undefined): Result {
  const row = date
    ? one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", date)
    : (one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", today(ctx.now, ctx.config.timezone)) ??
      one<DayRow>(ctx.db, "SELECT * FROM day ORDER BY date DESC LIMIT 1"));
  if (!row)
    throw new HubError(date ? `no day plan for ${date}` : "no day plan yet (hub day set <date> --file <plan.md>)");
  return { text: `${row.date}\n${row.resume ?? `(no ## ${ctx.config.resumeHeading} block)`}`, json: row };
}

export function lint(ctx: Ctx): Result {
  const findings: string[] = [];
  for (const t of openTickets(ctx).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const field of ["status", "next", "owner"] as const) {
      if (!t[field]?.trim()) findings.push(`${t.id}: missing ${field}`);
    }
    for (const field of LIMITED_FIELDS) {
      const value = t[field];
      const limit = ctx.config.limits[field];
      if (value && limit !== undefined && value.length > limit) {
        findings.push(`${t.id}: ${field} is ${value.length} chars (max ${limit})`);
      }
    }
  }
  return { text: findings.join("\n") || "ok", json: findings, exitCode: findings.length > 0 ? 1 : 0 };
}

export function set(ctx: Ctx, id: string, field: string, value: string): Result {
  oneOf("field", field, SETTABLE_FIELDS);
  checkLimit(field, value, ctx.config.limits);
  getTicket(ctx.db, id);
  const updated = today(ctx.now, ctx.config.timezone);
  ctx.db
    .prepare(`UPDATE ticket SET ${field} = ?, updated = ?, updated_at = ? WHERE id = ?`)
    .run(value, updated, nowIso(ctx.now), id);
  return { text: `${id} ${field} set`, json: { id, field, value, updated } };
}

export function match(ctx: Ctx, id: string, label: string, sentText: string, sentRef: string): Result {
  const existing = one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? AND label = ?", id, label);
  if (!existing) throw new HubError(`no draft "${label}" on ${id} (hub drafts ${id} lists them)`);
  if (existing.sent_text !== null) throw new HubError(`draft "${label}" on ${id} already has its sent wording`);
  ctx.db
    .prepare("UPDATE draft SET match_text = ?, match_ref = ?, updated_at = ? WHERE ticket_id = ? AND label = ?")
    .run(sentText, sentRef, nowIso(ctx.now), id, label);
  return {
    text: `${id} draft "${label}": match proposed, waiting for yes or no`,
    json: { ticket_id: id, label, match_ref: sentRef },
  };
}

export function resolveMatch(ctx: Ctx, id: string, label: string, answer: string): Result {
  oneOf("answer", answer, ["yes", "no"]);
  const existing = one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? AND label = ?", id, label);
  if (!existing?.match_text) throw new HubError(`no proposed match on draft "${label}" of ${id}`);
  const clear = () =>
    ctx.db
      .prepare("UPDATE draft SET match_text = NULL, match_ref = NULL, updated_at = ? WHERE ticket_id = ? AND label = ?")
      .run(nowIso(ctx.now), id, label);
  if (answer === "no") {
    clear();
    return { text: `${id} draft "${label}": match dropped`, json: { ticket_id: id, label, status: existing.status } };
  }
  const result = posted(ctx, id, label, {
    at: null,
    channel: null,
    answer: null,
    sentText: existing.match_text,
    sentRef: existing.match_ref,
  });
  clear();
  return result;
}

export function answerGate(ctx: Ctx, id: string, answer: string): Result {
  oneOf("answer", answer, ["yes", "no"]);
  const t = getTicket(ctx.db, id);
  if (!has(t.gate)) throw new HubError(`${id} has no gate`);
  const at = nowIso(ctx.now);
  ctx.db
    .prepare(
      "INSERT INTO event(ticket_id, ts, kind, text, source, created_at) VALUES (?, ?, 'decision', ?, 'human', ?)",
    )
    .run(id, nowTs(ctx.now, ctx.config.timezone), `${answer === "yes" ? "Yes" : "No"}: ${t.gate}`, at);
  ctx.db
    .prepare("UPDATE ticket SET gate = '-', updated = ?, updated_at = ? WHERE id = ?")
    .run(today(ctx.now, ctx.config.timezone), at, id);
  return { text: `${id} gate answered ${answer}`, json: { id, gate: t.gate, answer } };
}

export type LogOptions = { kind: string; source: string; ref: string | null };

export function log(ctx: Ctx, id: string, text: string, options: LogOptions): Result {
  oneOf("--kind", options.kind, EVENT_KINDS);
  oneOf("--source", options.source, EVENT_SOURCES);
  if (!text.trim()) throw new HubError("log text is empty");
  getTicket(ctx.db, id);
  const ts = nowTs(ctx.now, ctx.config.timezone);
  const result = ctx.db
    .prepare("INSERT INTO event(ticket_id, ts, kind, text, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, ts, options.kind, text, options.source, options.ref, nowIso(ctx.now));
  touch(ctx, id);
  return { text: `${id} logged ${ts}`, json: { id: Number(result.lastInsertRowid), ticket_id: id, ts } };
}

export function note(ctx: Ctx, id: string, title: string, body: string, kind: string): Result {
  oneOf("--kind", kind, NOTE_KINDS);
  if (!title.trim()) throw new HubError("note title is empty");
  getTicket(ctx.db, id);
  const position =
    one<{ p: number | null }>(ctx.db, "SELECT max(position) AS p FROM note WHERE ticket_id = ?", id)?.p ?? -1;
  ctx.db
    .prepare(
      `INSERT INTO note(ticket_id, title, body, kind, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticket_id, title) DO UPDATE SET body = excluded.body, kind = excluded.kind, updated_at = excluded.updated_at`,
    )
    .run(id, title, body, kind, position + 1, nowIso(ctx.now));
  touch(ctx, id);
  return { text: `${id} note "${title}" saved (${body.length} chars)`, json: { ticket_id: id, title, kind } };
}

export function draft(ctx: Ctx, id: string, label: string, body: string, channel: string | null): Result {
  if (!label.trim()) throw new HubError("draft label is empty");
  getTicket(ctx.db, id);
  const at = nowIso(ctx.now);
  ctx.db
    .prepare(
      `INSERT INTO draft(ticket_id, label, body, status, channel, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?)
       ON CONFLICT(ticket_id, label) DO UPDATE SET body = excluded.body, status = 'draft',
         channel = coalesce(excluded.channel, draft.channel), posted_at = NULL, sent_text = NULL, sent_ref = NULL,
         answer = NULL, match_text = NULL, match_ref = NULL, updated_at = excluded.updated_at`,
    )
    .run(id, label, body, channel, at, at);
  touch(ctx, id);
  return { text: `${id} draft "${label}" saved`, json: { ticket_id: id, label, status: "draft" } };
}

export type PostedOptions = {
  at: string | null;
  channel: string | null;
  answer: string | null;
  sentText: string | null;
  sentRef: string | null;
};

export function posted(ctx: Ctx, id: string, label: string, options: PostedOptions): Result {
  const existing = one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? AND label = ?", id, label);
  if (!existing) throw new HubError(`no draft "${label}" on ${id} (hub drafts ${id} lists them)`);
  const answer = options.answer ?? existing.answer;
  const status = answer === null ? "posted" : "answered";
  const at = options.at ?? existing.posted_at ?? nowTs(ctx.now, ctx.config.timezone);
  ctx.db
    .prepare(
      `UPDATE draft SET status = ?, posted_at = ?, channel = coalesce(?, channel), answer = ?,
         sent_text = coalesce(?, sent_text), sent_ref = coalesce(?, sent_ref), updated_at = ?
       WHERE ticket_id = ? AND label = ?`,
    )
    .run(status, at, options.channel, answer, options.sentText, options.sentRef, nowIso(ctx.now), id, label);
  touch(ctx, id);
  const pending = options.sentText === null && existing.sent_text === null ? ", wording pending" : "";
  return { text: `${id} draft "${label}" ${status}${pending}`, json: { ticket_id: id, label, status, posted_at: at } };
}

export function daySet(ctx: Ctx, date: string, body: string): Result {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HubError(`day date must be YYYY-MM-DD, not ${date}`);
  const resume = splitResume(body, ctx.config.resumeHeading);
  ctx.db
    .prepare(
      `INSERT INTO day(date, resume, body, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET resume = excluded.resume, body = excluded.body, updated_at = excluded.updated_at`,
    )
    .run(date, resume, body, nowIso(ctx.now));
  return {
    text: `day ${date} saved${resume ? "" : ` (no ## ${ctx.config.resumeHeading} block)`}`,
    json: { date, resume },
  };
}

function checkDir(ctx: Ctx, dir: string): void {
  oneOf("dir", dir, [...ctx.config.taskDirs, "unfiled"]);
}

export function ticketNew(ctx: Ctx, id: string, title: string, dir: string): Result {
  checkDir(ctx, dir);
  const tracker = new RegExp(`^(?:${ctx.config.ticketIdPattern})$`);
  if (!tracker.test(id) && !ctx.config.localIdPrefixes.some((p) => id.startsWith(p) && id.length > p.length)) {
    throw new HubError(
      `id ${id} matches neither ${ctx.config.ticketIdPattern} nor a local prefix (${ctx.config.localIdPrefixes.join(", ")})`,
    );
  }
  if (one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id)) throw new HubError(`ticket ${id} already exists`);
  const at = nowIso(ctx.now);
  ctx.db
    .prepare("INSERT INTO ticket(id, title, dir, updated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, title, dir, today(ctx.now, ctx.config.timezone), at, at);
  return { text: `${id} created in ${dir}`, json: { id, title, dir } };
}

export function move(ctx: Ctx, id: string, dir: string): Result {
  checkDir(ctx, dir);
  getTicket(ctx.db, id);
  ctx.db
    .prepare("UPDATE ticket SET dir = ?, updated = ?, updated_at = ? WHERE id = ?")
    .run(dir, today(ctx.now, ctx.config.timezone), nowIso(ctx.now), id);
  return { text: `${id} moved to ${dir}`, json: { id, dir } };
}

export function config(ctx: Ctx, key: string | undefined, value: string | undefined): Result {
  if (key !== undefined && value !== undefined) {
    setConfig(ctx.db, key, value, ctx.now);
    const updated = loadConfig(ctx.db);
    return { text: `${key} = ${JSON.stringify(updated[key as keyof Config])}`, json: updated };
  }
  const current = ctx.config;
  if (key === undefined) {
    const lines = Object.entries(current).map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
    return { text: lines.join("\n"), json: current };
  }
  if (!Object.hasOwn(DEFAULTS, key)) {
    throw new HubError(`unknown config key ${key} (${Object.keys(DEFAULTS).join(", ")})`);
  }
  const v = current[key as keyof Config];
  return { text: `${key} = ${JSON.stringify(v)}`, json: v };
}
