import type { DatabaseSync } from "node:sqlite";
import { type Config, DEFAULTS, loadConfig, setConfig } from "./config.ts";
import {
  all,
  type CommentRow,
  checkLimit,
  type DayRow,
  type DraftRow,
  draftOwner,
  type EventRow,
  ftsQuery,
  getTicket,
  type ItemRow,
  LIMITED_FIELDS,
  type NoteRow,
  one,
  SETTABLE_FIELDS,
  type StepRow,
  type Ticket,
  transaction,
} from "./db.ts";
import { span } from "./horizon.ts";
import { splitResume } from "./parse.ts";
import { progress } from "./steps.ts";
import { cut, HubError, nowIso, nowTs, sendTime, sinceDate, startOfDayIso, today } from "./util.ts";

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

export function asks(value: string | null): value is string {
  return has(value) && /[?？]$/.test(value.trim());
}

function rank(priority: string | null): number {
  return PRIORITY_RANK[(priority ?? "").trim().toLowerCase()] ?? 4;
}

export function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function place(t: Ticket): number {
  return t.position ?? Number.MAX_SAFE_INTEGER;
}

export function byOrder(a: Ticket, b: Ticket): number {
  return (
    place(a) - place(b) ||
    rank(a.tracker_priority) - rank(b.tracker_priority) ||
    (b.updated_at ?? "").localeCompare(a.updated_at ?? "")
  );
}

function touch(ctx: Ctx, id: string | null): void {
  ctx.db.prepare("UPDATE ticket SET updated_at = ? WHERE id = ?").run(nowIso(ctx.now), id);
}

const URL_START = /^https?:\/\//;

export function itemKey(input: string): string {
  if (!URL_START.test(input)) return input;
  return input.replace(/#.*$/, "").replace(/\/+$/, "");
}

type Owner = { ticket: string; item: null } | { ticket: null; item: string };

function draftOwnerOf(ctx: Ctx, id: string): Owner {
  if (one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id)) return { ticket: id, item: null };
  const key = itemKey(id);
  const known =
    URL_START.test(key) ||
    one(ctx.db, "SELECT 1 FROM item WHERE ref = ?", key) !== undefined ||
    one(ctx.db, "SELECT 1 FROM draft WHERE item = ?", key) !== undefined;
  if (known) return { ticket: null, item: key };
  return { ticket: getTicket(ctx.db, id).id, item: null };
}

function findDraft(ctx: Ctx, owner: Owner, label: string): DraftRow | undefined {
  if (owner.ticket !== null) {
    return one<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? AND label = ?", owner.ticket, label);
  }
  const rows = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE item = ? AND label = ?", owner.item, label);
  if (rows.length > 1) {
    throw new HubError(
      `${rows.length} drafts "${label}" on ${owner.item}: name the ticket (${rows.map(draftOwner).join(", ")})`,
    );
  }
  return rows[0];
}

function getDraft(ctx: Ctx, id: string, label: string): DraftRow {
  const draft = findDraft(ctx, draftOwnerOf(ctx, id), label);
  if (!draft) throw new HubError(`no draft "${label}" on ${id} (hub drafts ${id} lists them)`);
  return draft;
}

export function draftTicket(ctx: Ctx, id: string, label: string): { ticket: string | null; on: string } {
  const draft = getDraft(ctx, id, label);
  return { ticket: draft.ticket_id, on: draft.ticket_id === null ? ` on ${draft.item}` : "" };
}

export function openTickets(ctx: Ctx): Ticket[] {
  const dirs = ctx.config.openDirs;
  const tickets = all<Ticket>(ctx.db, `SELECT * FROM ticket WHERE dir IN (${dirs.map(() => "?").join(", ")})`, ...dirs);
  return tickets.filter(
    (t) => !(t.dir === "unfiled" && CLOSED_TRACKER_STATES.includes((t.tracker_state ?? "").trim().toLowerCase())),
  );
}

export function recentlyDone(ctx: Ctx): Ticket[] {
  const open = new Set(openTickets(ctx).map((t) => t.id));
  const { from } = span(ctx.config.horizon, ctx.now, ctx.config.timezone);
  return all<Ticket>(ctx.db, "SELECT * FROM ticket WHERE updated_at >= ? ORDER BY updated_at DESC, id", from).filter(
    (t) => !open.has(t.id),
  );
}

function trackerDisagrees(t: Ticket): boolean {
  if (!has(t.tracker_state) || t.dir === "unfiled" || t.dir === null) return false;
  return letters(t.tracker_state) !== letters(t.dir);
}

export function pullItems(ctx: Ctx, id: string): ItemRow[] {
  return all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE ticket_id = ? AND kind = 'pr' AND closed_at IS NULL ORDER BY id",
    id,
  );
}

export function pullLabel(i: ItemRow): string {
  const number = /\/pull\/(\d+)/.exec(i.url ?? "")?.[1];
  return `${number ? `#${number}` : "PR"}${i.state ? ` ${i.state}` : ""}`;
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
  const pulls = pullItems(ctx, id);
  const lines = [
    `${t.id} | ${v(t.dir)} | ${v(t.title)}`,
    `status: ${v(t.status)}`,
    `repo: ${v(t.repo)} | worktree: ${v(t.worktree)} | branch: ${v(t.branch)}`,
    `prs: ${v(t.prs)}${pulls.length > 0 ? ` | ${cut(pulls.map(pullLabel).join(", "), 150)}` : ""}`,
    `gate: ${v(t.gate)}`,
    `decide: ${v(t.decide)}`,
    `next: ${v(t.next)}`,
    `owner: ${v(t.owner)} | updated: ${v(t.updated)} | order: ${t.position ?? "-"}`,
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
      pulls,
    },
  };
}

function boardLine(t: Ticket, pulls: ItemRow[]): string {
  let line = `  [${t.tracker_priority || "-"}]`;
  if (trackerDisagrees(t)) line += ` [TRACKER: ${t.tracker_state}]`;
  if (t.position !== null) line += ` #${t.position}`;
  line += ` ${t.id} | ${cut(t.status || "-", 90)}`;
  if (pulls.length > 0) line += ` | PR ${cut(pulls.map(pullLabel).join(", "), 90)}`;
  else if (has(t.prs)) line += ` | PR ${cut(t.prs, 90)}`;
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
  const groups: Record<string, (Ticket & { pulls: ItemRow[] })[]> = {};
  for (const dir of ctx.config.openDirs) {
    const group = tickets
      .filter((t) => t.dir === dir)
      .sort(byOrder)
      .map((t) => ({ ...t, pulls: pullItems(ctx, t.id) }));
    if (group.length === 0) continue;
    groups[dir] = group;
    lines.push(`== ${dir}`, ...group.map((t) => boardLine(t, t.pulls)));
  }
  return { text: lines.join("\n") || "no open tickets", json: groups };
}

export function next(ctx: Ctx): Result {
  const tickets = ctx.config.taskDirs
    .slice(0, 2)
    .flatMap((dir) => all<Ticket>(ctx.db, "SELECT * FROM ticket WHERE dir = ?", dir).sort(byOrder));
  const lines = tickets.map((t) => `${t.id} | next: ${t.next || "-"} | gate: ${t.gate || "-"}`);
  return {
    text: lines.join("\n") || "nothing in progress or to do",
    json: tickets.map((t) => ({
      id: t.id,
      dir: t.dir,
      next: t.next,
      gate: t.gate,
      priority: t.tracker_priority,
      order: t.position,
    })),
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
  const events = all<EventRow & { ticket_id: string; created_at: string }>(
    ctx.db,
    "SELECT * FROM event WHERE created_at >= ? AND ticket_id IS NOT NULL ORDER BY ts DESC, id DESC",
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

export type Found = {
  kind: string;
  title: string;
  sub: string;
  href: string | null;
  out: string | null;
  ticket: string | null;
};

const FOUND_KIND: Record<string, string> = { ticket: "Ticket", note: "Note", event: "Log", draft: "Draft" };

export function searchAll(ctx: Ctx, query: string, limit: number): Found[] {
  if (query.trim() === "") return [];
  const snip = (fts: string) => `snippet(${fts}, -1, char(57344), char(57345), '…', 12)`;
  const words = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const hits =
    words.length === 0
      ? []
      : all<Hit>(
          ctx.db,
          `SELECT 'ticket' AS tbl, id AS ticket_id, title AS label, ${snip("ticket_fts")} AS snip, bm25(ticket_fts) AS score
       FROM ticket_fts WHERE ticket_fts MATCH ?1
     UNION ALL
     SELECT 'note', ticket_id, title, ${snip("note_fts")}, bm25(note_fts) FROM note_fts WHERE note_fts MATCH ?1
     UNION ALL
     SELECT 'event', e.ticket_id, e.ts, ${snip("event_fts")}, bm25(event_fts)
       FROM event_fts JOIN event e ON e.id = event_fts.rowid WHERE event_fts MATCH ?1
     UNION ALL
     SELECT 'draft', ticket_id, label, ${snip("draft_fts")}, bm25(draft_fts) FROM draft_fts WHERE draft_fts MATCH ?1
     ORDER BY score LIMIT ?2`,
          ftsQuery(words.join(" ")),
          limit,
        );
  const like = `%${query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const items = all<ItemRow>(
    ctx.db,
    "SELECT * FROM item WHERE title LIKE ?1 ESCAPE '\\' OR ref LIKE ?1 ESCAPE '\\' OR author LIKE ?1 ESCAPE '\\' ORDER BY closed_at IS NOT NULL, changed_at DESC LIMIT ?2",
    like,
    limit,
  );
  const steps = all<StepRow>(
    ctx.db,
    "SELECT * FROM step WHERE title LIKE ?1 ESCAPE '\\' ORDER BY done_at IS NOT NULL, ticket_id, n LIMIT ?2",
    like,
    limit,
  );
  const page = (id: string | null) => (id === null ? null : `/t/${encodeURIComponent(id)}`);
  const dayStart = startOfDayIso(today(ctx.now, ctx.config.timezone), ctx.config.timezone);
  const listed = (i: ItemRow) => i.needs_me === 1 && i.ignored === null && (i.closed_at ?? dayStart) >= dayStart;
  const itemHref = (i: ItemRow) => page(i.ticket_id) ?? (listed(i) ? `/#item-${i.id}` : null);
  const found: Found[] = [
    ...hits
      .filter((h) => h.tbl === "ticket")
      .map((h) => ({
        kind: "Ticket",
        title: `${h.ticket_id} ${h.label ?? ""}`,
        sub: h.snip.replace(/[\uE000\uE001]/g, "") === h.label ? "" : h.snip,
        href: page(h.ticket_id),
        out: null,
        ticket: h.ticket_id,
      })),
    ...items.map((i) => ({
      kind: i.closed_at === null ? "Item" : "Closed item",
      title: i.title ?? i.ref,
      sub: [i.source, i.author, i.state].filter(Boolean).join(" · "),
      href: itemHref(i),
      out: i.url ?? (/^https?:/.test(i.ref) ? i.ref : null),
      ticket: i.ticket_id,
    })),
    ...steps.map((s) => ({
      kind: s.done_at === null ? "Step" : "Step done",
      title: `${s.n}. ${s.title}`,
      sub: "",
      href: page(s.ticket_id),
      out: null,
      ticket: s.ticket_id,
    })),
    ...hits
      .filter((h) => h.tbl !== "ticket")
      .map((h) => ({
        kind: FOUND_KIND[h.tbl] ?? h.tbl,
        title: h.label ?? "",
        sub: h.snip,
        href: page(h.ticket_id),
        out: null,
        ticket: h.ticket_id,
      })),
  ];
  return found.slice(0, limit);
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
    const rows = all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE status = 'draft' ORDER BY ticket_id, item, label");
    const lines = rows.map((d) =>
      [draftOwner(d), d.label, d.ticket_id === null ? null : d.item, cut(d.body.split("\n")[0] ?? "", 80)]
        .filter((part) => part !== null)
        .join(" | "),
    );
    return { text: lines.join("\n") || "no open drafts", json: rows };
  }
  const owner = draftOwnerOf(ctx, id);
  const rows =
    owner.ticket === null
      ? all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE item = ? ORDER BY id", owner.item)
      : all<DraftRow>(ctx.db, "SELECT * FROM draft WHERE ticket_id = ? ORDER BY id", owner.ticket);
  const lines = rows.map((d) => {
    const pending = d.status !== "draft" && d.sent_text === null ? "wording pending" : null;
    const proposed = d.match_ref === null ? null : "match proposed";
    const comments = draftComments(ctx.db, d.id).length;
    const review =
      comments === 0 ? d.verdict : `${d.verdict ?? "review"}, ${comments} comment${comments === 1 ? "" : "s"}`;
    return [
      d.label,
      d.status,
      d.channel,
      owner.ticket === null ? d.ticket_id : d.item,
      review,
      d.posted_at,
      pending,
      proposed,
    ]
      .filter((part) => part !== null && part !== "")
      .join(" | ");
  });
  return { text: lines.join("\n") || "no drafts", json: rows };
}

export function draftShow(ctx: Ctx, id: string, label: string): Result {
  const draft = getDraft(ctx, id, label);
  const comments = draftComments(ctx.db, draft.id);
  const review = [
    ...(draft.verdict === null ? [] : [`verdict: ${draft.verdict}`]),
    ...comments.map((c) => `${c.path}:${c.line} ${c.body}`),
  ];
  const sent =
    draft.sent_text === null ? [] : [`--- sent${draft.sent_ref ? ` ${draft.sent_ref}` : ""}\n${draft.sent_text}`];
  return {
    text: [draft.body, ...(review.length === 0 ? [] : [review.join("\n")]), ...sent].join("\n\n"),
    json: { ...draft, comments },
  };
}

function rev(row: DayRow): string {
  return row.updated_at ?? "none";
}

export function day(ctx: Ctx, date: string | undefined, full: boolean): Result {
  const row = date
    ? one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", date)
    : (one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", today(ctx.now, ctx.config.timezone)) ??
      one<DayRow>(ctx.db, "SELECT * FROM day ORDER BY date DESC LIMIT 1"));
  if (!row)
    throw new HubError(date ? `no day plan for ${date}` : "no day plan yet (hub day set <date> --file <plan.md>)");
  const shown = full ? row.body : (row.resume ?? `(no ## ${ctx.config.resumeHeading} block)`);
  return { text: `${row.date}\nrev: ${rev(row)}\n${shown}`, json: { ...row, rev: rev(row) } };
}

export function lint(ctx: Ctx): Result {
  const findings: string[] = [];
  for (const t of openTickets(ctx).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const field of ["status", "next", "owner"] as const) {
      if (!t[field]?.trim()) findings.push(`${t.id}: missing ${field}`);
    }
    for (const field of ["gate", "decide"] as const) {
      if (has(t[field]) && !asks(t[field])) {
        findings.push(`${t.id}: ${field} is not a question (no ?), so it shows as a rule and asks nothing`);
      }
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
  if (field === "title" && !value.trim()) throw new HubError("title is empty");
  checkLimit(field, value, ctx.config.limits);
  getTicket(ctx.db, id);
  const updated = today(ctx.now, ctx.config.timezone);
  ctx.db
    .prepare(`UPDATE ticket SET ${field} = ?, updated = ?, updated_at = ? WHERE id = ?`)
    .run(value, updated, nowIso(ctx.now), id);
  return { text: `${id} ${field} set`, json: { id, field, value, updated } };
}

function judged(ctx: Ctx, ref: string): void {
  ctx.db
    .prepare("UPDATE item SET closed_at = ? WHERE state = 'sent' AND closed_at IS NULL AND (ref = ? OR url = ?)")
    .run(nowIso(ctx.now), ref, ref);
}

export function match(ctx: Ctx, id: string, label: string, sentText: string, sentRef: string): Result {
  const existing = getDraft(ctx, id, label);
  if (existing.sent_text !== null) throw new HubError(`draft "${label}" on ${id} already has its sent wording`);
  ctx.db
    .prepare("UPDATE draft SET match_text = ?, match_ref = ?, updated_at = ? WHERE id = ?")
    .run(sentText, sentRef, nowIso(ctx.now), existing.id);
  judged(ctx, sentRef);
  return {
    text: `${id} draft "${label}": match proposed, waiting for yes or no`,
    json: { ticket_id: id, label, match_ref: sentRef },
  };
}

export function resolveMatch(ctx: Ctx, id: string, label: string, answer: string): Result {
  oneOf("answer", answer, ["yes", "no"]);
  const existing = getDraft(ctx, id, label);
  if (!existing.match_text) throw new HubError(`no proposed match on draft "${label}" of ${id}`);
  const clear = () =>
    ctx.db
      .prepare(
        "UPDATE draft SET match_text = NULL, match_ref = NULL, match_verdict = NULL, updated_at = ? WHERE id = ?",
      )
      .run(nowIso(ctx.now), existing.id);
  if (answer === "no") {
    ctx.db.prepare("UPDATE draft SET match_no = match_ref WHERE id = ?").run(existing.id);
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

export function reopenGate(ctx: Ctx, id: string): Result {
  const t = getTicket(ctx.db, id);
  if (has(t.gate)) throw new HubError(`${id} has an open gate`);
  const answer = one<EventRow>(
    ctx.db,
    `SELECT * FROM event WHERE ticket_id = ? AND kind = 'decision' AND source = 'human'
       AND (text LIKE 'Yes: %' OR text LIKE 'No: %') ORDER BY id DESC LIMIT 1`,
    id,
  );
  if (answer === undefined) throw new HubError(`${id} has no answered gate`);
  const gate = answer.text.replace(/^(Yes|No): /, "");
  const at = nowIso(ctx.now);
  transaction(ctx.db, () => {
    ctx.db.prepare("DELETE FROM event WHERE id = ?").run(answer.id);
    ctx.db
      .prepare("UPDATE ticket SET gate = ?, updated = ?, updated_at = ? WHERE id = ?")
      .run(gate, today(ctx.now, ctx.config.timezone), at, id);
  });
  return { text: `${id} gate open again`, json: { id, gate } };
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
  if (options.ref !== null) judged(ctx, options.ref);
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

function getNote(ctx: Ctx, id: string, title: string): NoteRow {
  getTicket(ctx.db, id);
  const note = one<NoteRow>(ctx.db, "SELECT * FROM note WHERE ticket_id = ? AND title = ?", id, title);
  if (!note) throw new HubError(`no note "${title}" on ${id} (hub notes ${id} lists them)`);
  return note;
}

export function noteRemove(ctx: Ctx, id: string, title: string): Result {
  getNote(ctx, id, title);
  ctx.db.prepare("DELETE FROM note WHERE ticket_id = ? AND title = ?").run(id, title);
  touch(ctx, id);
  return { text: `${id} note "${title}" removed`, json: { ticket_id: id, title } };
}

export function noteRename(ctx: Ctx, id: string, title: string, to: string): Result {
  if (!to.trim()) throw new HubError("note title is empty");
  getNote(ctx, id, title);
  if (one(ctx.db, "SELECT 1 FROM note WHERE ticket_id = ? AND title = ?", id, to)) {
    throw new HubError(`${id} already has a note "${to}"`);
  }
  ctx.db
    .prepare("UPDATE note SET title = ?, updated_at = ? WHERE ticket_id = ? AND title = ?")
    .run(to, nowIso(ctx.now), id, title);
  touch(ctx, id);
  return { text: `${id} note "${title}" is now "${to}"`, json: { ticket_id: id, title: to, from: title } };
}

export function draftRemove(ctx: Ctx, id: string, label: string): Result {
  const draft = getDraft(ctx, id, label);
  if (draft.status !== "draft") throw new HubError(`draft "${label}" on ${id} was sent; it stays as the record`);
  transaction(ctx.db, () => {
    ctx.db.prepare("DELETE FROM draft_comment WHERE draft_id = ?").run(draft.id);
    ctx.db.prepare("DELETE FROM draft WHERE id = ?").run(draft.id);
    ctx.db.prepare("DELETE FROM pin WHERE key = ?").run(`match-${draftOwner(draft)}-${label}`);
    touch(ctx, draft.ticket_id);
  });
  return { text: `${id} draft "${label}" removed`, json: { ticket_id: id, label } };
}

export function unposted(ctx: Ctx, id: string, label: string): Result {
  const draft = getDraft(ctx, id, label);
  if (draft.status === "draft") throw new HubError(`draft "${label}" on ${id} is not sent`);
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE draft SET status = 'draft', posted_at = NULL, answer = NULL, sent_text = NULL, sent_ref = NULL,
           closed_item = NULL, match_no = coalesce(sent_ref, match_no), updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(ctx.now), draft.id);
    if (draft.closed_item !== null) {
      ctx.db.prepare("UPDATE item SET closed_at = NULL WHERE id = ?").run(draft.closed_item);
    }
    touch(ctx, draft.ticket_id);
  });
  return { text: `${id} draft "${label}" not sent`, json: { ticket_id: id, label, status: "draft" } };
}

export function draftRename(ctx: Ctx, id: string, label: string, to: string): Result {
  if (!to.trim()) throw new HubError("draft label is empty");
  const draft = getDraft(ctx, id, label);
  const owner = draftOwner(draft);
  const clash =
    draft.ticket_id === null
      ? one(ctx.db, "SELECT 1 FROM draft WHERE ticket_id IS NULL AND item = ? AND label = ?", draft.item, to)
      : one(ctx.db, "SELECT 1 FROM draft WHERE ticket_id = ? AND label = ?", draft.ticket_id, to);
  if (clash) throw new HubError(`${owner} already has a draft "${to}"`);
  transaction(ctx.db, () => {
    ctx.db.prepare("UPDATE draft SET label = ?, updated_at = ? WHERE id = ?").run(to, nowIso(ctx.now), draft.id);
    ctx.db.prepare("UPDATE pin SET key = ? WHERE key = ?").run(`match-${owner}-${to}`, `match-${owner}-${label}`);
    touch(ctx, draft.ticket_id);
  });
  return { text: `${id} draft "${label}" is now "${to}"`, json: { ticket_id: id, label: to, from: label } };
}

export type DraftExtra = {
  item?: string | null;
  verdict?: string | null;
  comments?: unknown;
  internal?: boolean | null;
};

const VERDICTS = ["approve", "request_changes", "comment"];
const MAX_COMMENTS = 50;
const MAX_COMMENT = 8000;
const MAX_PATH = 500;

type CommentInput = { path: string; line: number; body: string };

function parseComments(raw: unknown): CommentInput[] {
  if (!Array.isArray(raw)) throw new HubError("comments must be a list of {path, line, body}");
  if (raw.length > MAX_COMMENTS) throw new HubError(`at most ${MAX_COMMENTS} comments on one draft`);
  return raw.map((c: { path?: unknown; line?: unknown; body?: unknown }, n) => {
    const where = `comment ${n + 1}`;
    if (typeof c?.path !== "string" || c.path.trim() === "" || c.path.length > MAX_PATH)
      throw new HubError(`${where}: path is a file path of at most ${MAX_PATH} chars`);
    if (!Number.isInteger(c.line) || (c.line as number) < 1) throw new HubError(`${where}: line is a positive integer`);
    if (typeof c.body !== "string" || c.body.trim() === "" || c.body.length > MAX_COMMENT)
      throw new HubError(`${where}: body is text of at most ${MAX_COMMENT} chars`);
    return { path: c.path.trim(), line: c.line as number, body: c.body };
  });
}

export function draftComments(db: DatabaseSync, draftId: number): CommentRow[] {
  return all<CommentRow>(db, "SELECT * FROM draft_comment WHERE draft_id = ? ORDER BY pos", draftId);
}

export function draft(
  ctx: Ctx,
  id: string,
  label: string,
  body: string,
  channel: string | null,
  sendAt: string | null,
  extra: DraftExtra = {},
): Result {
  if (!label.trim()) throw new HubError("draft label is empty");
  const owner = draftOwnerOf(ctx, id);
  const existing = findDraft(ctx, owner, label);
  const given = extra.item == null ? null : itemKey(extra.item.trim());
  const link = owner.item ?? (given === null ? (existing?.item ?? null) : given || null);
  if (existing?.ticket_id === null && given === "")
    throw new HubError(`draft "${label}" has no ticket, so it keeps its item`);
  if (extra.verdict != null && extra.verdict !== "") oneOf("verdict", extra.verdict, VERDICTS);
  const verdict = extra.verdict == null ? (existing?.verdict ?? null) : extra.verdict || null;
  const comments = extra.comments == null ? null : parseComments(extra.comments);
  const internal = extra.internal == null ? (existing?.internal ?? 0) : Number(extra.internal);
  const at = nowIso(ctx.now);
  const send = sendAt === null ? null : sendTime(ctx.now, sendAt, ctx.config.timezone, ctx.config.laterHour, "send_at");
  transaction(ctx.db, () => {
    let draftId = existing?.id;
    if (existing === undefined) {
      draftId = Number(
        ctx.db
          .prepare(
            `INSERT INTO draft(ticket_id, item, label, body, status, channel, send_at, verdict, internal, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
          )
          .run(owner.ticket, link, label, body, channel, send, verdict, internal, at, at).lastInsertRowid,
      );
    } else {
      ctx.db
        .prepare(
          `UPDATE draft SET body = ?, status = 'draft', item = ?, channel = coalesce(?, channel), send_at = ?, verdict = ?,
             internal = ?, posted_at = NULL, sent_text = NULL, sent_ref = NULL, answer = NULL, match_text = NULL, match_ref = NULL,
             match_verdict = NULL, closed_item = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          body,
          existing.ticket_id === null ? existing.item : link,
          channel,
          send,
          verdict,
          internal,
          at,
          existing.id,
        );
    }
    if (comments !== null) {
      ctx.db.prepare("DELETE FROM draft_comment WHERE draft_id = ?").run(draftId ?? null);
      const insert = ctx.db.prepare(
        "INSERT INTO draft_comment(draft_id, pos, path, line, body) VALUES (?, ?, ?, ?, ?)",
      );
      for (const [pos, c] of comments.entries()) insert.run(draftId ?? null, pos + 1, c.path, c.line, c.body);
    }
    touch(ctx, owner.ticket ?? existing?.ticket_id ?? null);
  });
  const ticket = existing === undefined ? owner.ticket : existing.ticket_id;
  const name = ticket ?? owner.item ?? id;
  const when = send === null ? "" : `, send at ${nowTs(new Date(send), ctx.config.timezone)}`;
  return {
    text: `${name} draft "${label}" saved${when}`,
    json: {
      ticket_id: ticket,
      item: existing?.ticket_id === null ? existing.item : link,
      label,
      status: "draft",
      send_at: send,
      verdict,
      internal: internal === 1,
    },
  };
}

export function draftLater(ctx: Ctx, id: string, label: string, duration: string): Result {
  const d = getDraft(ctx, id, label);
  if (d.status !== "draft") throw new HubError(`draft "${label}" on ${id} is already ${d.status}`);
  const send = sendTime(ctx.now, duration, ctx.config.timezone, ctx.config.laterHour, "for");
  ctx.db.prepare("UPDATE draft SET send_at = ?, updated_at = ? WHERE id = ?").run(send, nowIso(ctx.now), d.id);
  return {
    text: `${id} draft "${label}" send at ${nowTs(new Date(send), ctx.config.timezone)}`,
    json: { ticket_id: id, label, send_at: send, before: { send_at: d.send_at } },
  };
}

export function draftSendAt(ctx: Ctx, id: string, label: string, sendAt: string | null): Result {
  const d = getDraft(ctx, id, label);
  if (d.status !== "draft") throw new HubError(`draft "${label}" on ${id} is already ${d.status}`);
  if (sendAt !== null && Number.isNaN(Date.parse(sendAt))) throw new HubError(`not a time: ${sendAt}`);
  ctx.db.prepare("UPDATE draft SET send_at = ?, updated_at = ? WHERE id = ?").run(sendAt, nowIso(ctx.now), d.id);
  return { text: `${id} draft "${label}" send time set back`, json: { ticket_id: id, label, send_at: sendAt } };
}

export type PostedOptions = {
  at: string | null;
  channel: string | null;
  answer: string | null;
  sentText: string | null;
  sentRef: string | null;
};

export type Review = { item: string; url: string; body: string; state: string; at: string };

const REVIEW_VERDICT: Record<string, string> = {
  APPROVED: "approve",
  CHANGES_REQUESTED: "request_changes",
  COMMENTED: "comment",
};

const REVIEW_STATE: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

export function proposeReview(ctx: Ctx, review: Review): number {
  const text = review.body.trim() || REVIEW_STATE[review.state] || review.state.toLowerCase();
  const { changes } = ctx.db
    .prepare(
      `UPDATE draft SET match_text = ?, match_ref = ?, match_verdict = ?, updated_at = ?
       WHERE item = ? AND status = 'draft' AND match_ref IS NULL AND coalesce(match_no, '') != ? AND coalesce(created_at, '') <= ?`,
    )
    .run(text, review.url, REVIEW_VERDICT[review.state] ?? null, nowIso(ctx.now), review.item, review.url, review.at);
  return Number(changes);
}

function openReviewRequest(ctx: Ctx, item: string | null): ItemRow | undefined {
  if (item === null) return undefined;
  return one<ItemRow>(
    ctx.db,
    `SELECT * FROM item WHERE kind = 'review_request' AND closed_at IS NULL AND ignored IS NULL AND (ref = ?1 OR url = ?1)`,
    item,
  );
}

export function posted(ctx: Ctx, id: string, label: string, options: PostedOptions): Result {
  const existing = getDraft(ctx, id, label);
  const answer = options.answer ?? existing.answer;
  const status = answer === null ? "posted" : "answered";
  const at = options.at ?? existing.posted_at ?? nowTs(ctx.now, ctx.config.timezone);
  const request = openReviewRequest(ctx, existing.item);
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE draft SET status = ?, posted_at = ?, channel = coalesce(?, channel), answer = ?,
           sent_text = coalesce(?, sent_text), sent_ref = coalesce(?, sent_ref), closed_item = coalesce(?, closed_item),
           updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        at,
        options.channel,
        answer,
        options.sentText,
        options.sentRef,
        request?.id ?? null,
        nowIso(ctx.now),
        existing.id,
      );
    if (request !== undefined)
      ctx.db.prepare("UPDATE item SET closed_at = ? WHERE id = ?").run(nowIso(ctx.now), request.id);
    if (options.sentRef !== null) judged(ctx, options.sentRef);
    touch(ctx, existing.ticket_id);
  });
  const pending = options.sentText === null && existing.sent_text === null ? ", wording pending" : "";
  return {
    text: `${id} draft "${label}" ${status}${pending}`,
    json: { ticket_id: existing.ticket_id, item: existing.item, label, status, posted_at: at },
  };
}

export function daySet(ctx: Ctx, date: string, body: string, expected: string | null): Result {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HubError(`day date must be YYYY-MM-DD, not ${date}`);
  const resume = splitResume(body, ctx.config.resumeHeading);
  const at = nowIso(ctx.now);
  const { changes } = ctx.db
    .prepare(
      `INSERT INTO day(date, resume, body, updated_at) VALUES (:date, :resume, :body, :at)
       ON CONFLICT(date) DO UPDATE SET resume = excluded.resume, body = excluded.body, updated_at = excluded.updated_at
       WHERE coalesce(day.updated_at, 'none') = :rev`,
    )
    .run({ date, resume, body, at, rev: expected ?? "" });
  if (changes === 0) {
    const current = rev(one<DayRow>(ctx.db, "SELECT * FROM day WHERE date = ?", date) as DayRow);
    const merge = `read it with day ${date} (full), merge`;
    if (expected === null) {
      throw new HubError(
        `plan for ${date} already exists (rev ${current}); ${merge}, then day_set with rev ${current}`,
      );
    }
    throw new HubError(
      `plan for ${date} changed since you read it (rev ${current}, yours ${expected}); ${merge}, then retry with rev ${current}`,
    );
  }
  return {
    text: `day ${date} saved, rev: ${at}${resume ? "" : ` (no ## ${ctx.config.resumeHeading} block)`}`,
    json: { date, resume, rev: at },
  };
}

function checkDir(ctx: Ctx, dir: string): void {
  oneOf("dir", dir, [...ctx.config.taskDirs, "unfiled"]);
}

function checkNewId(ctx: Ctx, id: string): void {
  const tracker = new RegExp(`^(?:${ctx.config.ticketIdPattern})$`);
  if (!tracker.test(id) && !ctx.config.localIdPrefixes.some((p) => id.startsWith(p) && id.length > p.length)) {
    throw new HubError(
      `id ${id} matches neither ${ctx.config.ticketIdPattern} nor a local prefix (${ctx.config.localIdPrefixes.join(", ")})`,
    );
  }
  if (one(ctx.db, "SELECT 1 FROM ticket WHERE id = ?", id)) throw new HubError(`ticket ${id} already exists`);
}

export function ticketNew(ctx: Ctx, id: string, title: string, dir: string): Result {
  checkDir(ctx, dir);
  checkNewId(ctx, id);
  const at = nowIso(ctx.now);
  ctx.db
    .prepare("INSERT INTO ticket(id, title, dir, updated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, title, dir, today(ctx.now, ctx.config.timezone), at, at);
  return { text: `${id} created in ${dir}`, json: { id, title, dir } };
}

const TICKET_ROWS = ["event", "note", "draft", "item", "wait", "step"];

function exec(ctx: Ctx, sql: string, ...params: (string | number)[]): void {
  ctx.db.prepare(sql).run(...params);
}

function pointIdAt(ctx: Ctx, id: string, to: string): void {
  exec(ctx, "UPDATE meta SET value = ? WHERE key LIKE 'moved-id:%' AND value = ?", to, id);
  exec(ctx, "DELETE FROM meta WHERE key = ?", `moved-id:${to}`);
  exec(
    ctx,
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    `moved-id:${id}`,
    to,
  );
}

function dropPins(ctx: Ctx, id: string): void {
  const match = `match-${id}-`;
  exec(
    ctx,
    "DELETE FROM pin WHERE key IN (?, ?) OR substr(key, 1, ?) = ?",
    `gate-${id}`,
    `decide-${id}`,
    match.length,
    match,
  );
}

function event(ctx: Ctx, id: string, text: string): void {
  exec(
    ctx,
    "INSERT INTO event(ticket_id, ts, kind, text, source, created_at) VALUES (?, ?, 'log', ?, 'agent', ?)",
    id,
    nowTs(ctx.now, ctx.config.timezone),
    text,
    nowIso(ctx.now),
  );
}

export function rename(ctx: Ctx, id: string, to: string): Result {
  getTicket(ctx.db, id);
  checkNewId(ctx, to);
  exec(ctx, "UPDATE ticket SET id = ?, updated_at = ? WHERE id = ?", to, nowIso(ctx.now), id);
  for (const table of TICKET_ROWS) exec(ctx, `UPDATE ${table} SET ticket_id = ? WHERE ticket_id = ?`, to, id);
  for (const kind of ["gate", "decide"]) {
    exec(ctx, "UPDATE pin SET key = ? WHERE key = ?", `${kind}-${to}`, `${kind}-${id}`);
  }
  const match = `match-${id}-`;
  exec(
    ctx,
    "UPDATE pin SET key = ? || substr(key, ?) WHERE substr(key, 1, ?) = ?",
    `match-${to}-`,
    match.length + 1,
    match.length,
    match,
  );
  pointIdAt(ctx, id, to);
  event(ctx, to, `renamed from ${id}`);
  return { text: `${id} is now ${to}`, json: { id: to, from: id } };
}

export function deleteTicket(ctx: Ctx, id: string): Result {
  getTicket(ctx.db, id);
  exec(ctx, "DELETE FROM draft_comment WHERE draft_id IN (SELECT id FROM draft WHERE ticket_id = ?)", id);
  for (const table of TICKET_ROWS.filter((t) => t !== "item")) {
    exec(ctx, `DELETE FROM ${table} WHERE ticket_id = ?`, id);
  }
  exec(ctx, "UPDATE item SET ticket_id = NULL WHERE ticket_id = ?", id);
  dropPins(ctx, id);
  exec(ctx, "DELETE FROM meta WHERE key LIKE 'moved-id:%' AND value = ?", id);
  exec(ctx, "DELETE FROM ticket WHERE id = ?", id);
  return { text: `${id} deleted`, json: { id } };
}

export function checkMerge(ctx: Ctx, id: string, into: string): Ticket {
  if (id === into) throw new HubError("a ticket cannot merge into itself");
  getTicket(ctx.db, into);
  return getTicket(ctx.db, id);
}

export function mergeTicket(ctx: Ctx, id: string, into: string): Result {
  const from = checkMerge(ctx, id, into);
  const suffix = ` (from ${id})`;
  const offset = (table: string, column: string) =>
    one<{ m: number }>(ctx.db, `SELECT coalesce(max(${column}), 0) AS m FROM ${table} WHERE ticket_id = ?`, into)?.m ??
    0;
  exec(
    ctx,
    `UPDATE note SET ticket_id = ?1, position = position + ?2,
       title = CASE WHEN title IN (SELECT title FROM note WHERE ticket_id = ?1) THEN title || ?3 ELSE title END
     WHERE ticket_id = ?4`,
    into,
    offset("note", "position") + 1,
    suffix,
    id,
  );
  exec(
    ctx,
    `UPDATE draft SET ticket_id = ?1,
       label = CASE WHEN label IN (SELECT label FROM draft WHERE ticket_id = ?1) THEN label || ?2 ELSE label END
     WHERE ticket_id = ?3`,
    into,
    suffix,
    id,
  );
  exec(ctx, "UPDATE step SET ticket_id = ?, n = n + ? WHERE ticket_id = ?", into, offset("step", "n"), id);
  for (const table of ["event", "item", "wait"]) {
    exec(ctx, `UPDATE ${table} SET ticket_id = ? WHERE ticket_id = ?`, into, id);
  }
  dropPins(ctx, id);
  pointIdAt(ctx, id, into);
  exec(ctx, "DELETE FROM ticket WHERE id = ?", id);
  exec(ctx, "UPDATE ticket SET updated_at = ? WHERE id = ?", nowIso(ctx.now), into);
  event(ctx, into, `merged ${id}${from.title ? `: ${from.title}` : ""}`);
  return { text: `${id} merged into ${into}`, json: { id: into, from: id } };
}

export type TrackerFields = {
  id: string;
  state: string | null;
  priority: string | null;
  assignee: string | null;
  url: string | null;
  updated: string | null;
};

export function setTracker(ctx: Ctx, t: TrackerFields): boolean {
  const result = ctx.db
    .prepare(
      `UPDATE ticket SET tracker_state = ?1, tracker_priority = ?2, tracker_assignee = ?3, tracker_url = ?4, tracker_updated = ?5
       WHERE id = ?6 AND (tracker_state, tracker_priority, tracker_assignee, tracker_url, tracker_updated)
         IS NOT (?1, ?2, ?3, ?4, ?5)`,
    )
    .run(t.state, t.priority, t.assignee, t.url, t.updated, t.id);
  return result.changes > 0;
}

export function move(ctx: Ctx, id: string, dir: string): Result {
  checkDir(ctx, dir);
  getTicket(ctx.db, id);
  ctx.db
    .prepare(
      "UPDATE ticket SET dir = ?1, position = CASE WHEN dir = ?1 THEN position END, updated = ?2, updated_at = ?3 WHERE id = ?4",
    )
    .run(dir, today(ctx.now, ctx.config.timezone), nowIso(ctx.now), id);
  return { text: `${id} moved to ${dir}`, json: { id, dir } };
}

export function order(ctx: Ctx, id: string, at: number): Result {
  if (!Number.isInteger(at) || at < 0) throw new HubError(`place is 1 for the top, or 0 to take ${id} out, not ${at}`);
  const t = getTicket(ctx.db, id);
  const list = all<Ticket>(ctx.db, "SELECT * FROM ticket WHERE dir IS ? AND id != ?", t.dir, id).sort(byOrder);
  if (at > 0) list.splice(Math.min(at, list.length + 1) - 1, 0, t);
  const ordered = list.findLastIndex((x) => x.id === id || x.position !== null) + 1;
  const write = ctx.db.prepare("UPDATE ticket SET position = ? WHERE id = ?");
  for (const [i, x] of list.entries()) write.run(i < ordered ? i + 1 : null, x.id);
  if (at === 0) write.run(null, id);
  const position = at === 0 ? null : list.findIndex((x) => x.id === id) + 1;
  const text = position === null ? `${id} taken out of the order` : `${id} is #${position} in ${t.dir}`;
  return { text, json: { id, dir: t.dir, order: position } };
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
