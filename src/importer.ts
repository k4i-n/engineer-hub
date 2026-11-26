import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Config } from "./config.ts";
import { LIMITED_FIELDS, one, type Ticket, transaction } from "./db.ts";
import { fileTitle, type ParsedDraft, type ParsedNote, parseTicket, splitResume, type Tracker } from "./parse.ts";
import { HubError, linkKind, linkSource, nowIso, today } from "./util.ts";

const TICKET_COLUMNS = [
  "title",
  "dir",
  "path",
  "status",
  "repo",
  "worktree",
  "branch",
  "gate",
  "next",
  "owner",
  "updated",
  "tracker_state",
  "tracker_priority",
  "tracker_assignee",
  "tracker_url",
  "tracker_updated",
  "tracker_json",
] as const;

type Column = (typeof TICKET_COLUMNS)[number];
type TicketRec = { id: string; position: number | null } & Record<Column, string | null>;
type EventRec = { ticket_id: string; ts: string; kind: string; text: string; source: string };
type NoteRec = { ticket_id: string } & ParsedNote;
type DraftRec = { ticket_id: string } & ParsedDraft;
type LinkRec = { ticket_id: string; url: string; source: string; kind: string };
type DayRec = { date: string; resume: string | null; body: string };

export type ImportReport = {
  oversize: { id: string; field: string; length: number }[];
  unclassified: { id: string; heading: string }[];
  folded: { id: string; paths: string[] }[];
  noTicket: string[];
  noState: string[];
  fileTitles: { id: string; title: string }[];
};

export type ImportPlan = {
  root: string;
  tickets: TicketRec[];
  events: EventRec[];
  notes: NoteRec[];
  drafts: DraftRec[];
  links: LinkRec[];
  days: DayRec[];
  report: ImportReport;
};

type TaskFile = { path: string; dir: string; id: string | null; stem: string; markdown: boolean; ticket: boolean };

const OTHER_FILES = "Other files";

function filesUnder(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => !p.split(sep).some((part) => part.startsWith(".")) && statSync(join(dir, p)).isFile())
    .sort();
}

function idMatcher(config: Config): (stem: string) => string | null {
  const tracker = new RegExp(`^(${config.ticketIdPattern})(?![A-Za-z0-9])`);
  return (stem) => {
    const bare = stem.replace(/^P\d+-\d+-/, "");
    if (config.localIdPrefixes.some((p) => bare.startsWith(p))) return bare;
    return bare.match(tracker)?.[1] ?? null;
  };
}

function taskFiles(root: string, config: Config): TaskFile[] {
  const match = idMatcher(config);
  const files: TaskFile[] = [];
  for (const dir of config.taskDirs) {
    const base = join(root, "tasks", dir);
    for (const rel of filesUnder(base)) {
      const name = basename(rel);
      const markdown = name.endsWith(".md");
      const stem = markdown ? name.slice(0, -3) : name.replace(/\.[^.]*$/, "");
      const own = match(stem);
      const folder =
        rel
          .split(sep)
          .slice(0, -1)
          .reverse()
          .map(match)
          .find((id) => id !== null) ?? null;
      const ticket = markdown && own !== null && !name.endsWith("-draft.md") && !/^(STATUS|README)/i.test(stem);
      const path = relative(root, join(base, rel)).split(sep).join("/");
      files.push({ path, dir, id: own ?? folder, stem, markdown, ticket });
    }
  }
  return files;
}

function emptyTicket(id: string): TicketRec {
  const rec = { id } as TicketRec;
  for (const column of TICKET_COLUMNS) rec[column] = null;
  return rec;
}

function trackerJson(tracker: Tracker): string {
  const { attachments, raw, ...fields } = tracker;
  return JSON.stringify({ raw, ...fields, attachments });
}

function stateNoteTitle(db: DatabaseSync, id: string, date: string): string {
  const existing = one<{ title: string }>(
    db,
    "SELECT title FROM note WHERE ticket_id = ? AND kind = 'state_notes' ORDER BY id LIMIT 1",
    id,
  );
  return existing?.title ?? `State notes (migrated ${date})`;
}

function fieldLabel(field: string, config: Config): string {
  return config.stateFields.find((f) => f.toLowerCase() === field) ?? field;
}

function foldFiles(root: string, id: string, files: TaskFile[], position: number, plan: ImportPlan): void {
  if (files.length === 0) return;
  plan.report.folded.push({ id, paths: files.map((f) => f.path) });
  const markdown = files.filter((f) => f.markdown);
  for (const [i, f] of markdown.entries()) {
    const body = readFileSync(join(root, f.path), "utf8");
    plan.notes.push({ ticket_id: id, title: f.path, body, kind: "other", position: position + i });
  }
  const rest = files.filter((f) => !f.markdown);
  if (rest.length === 0) return;
  const body = rest.map((f) => `- ${f.path}`).join("\n");
  plan.notes.push({ ticket_id: id, title: OTHER_FILES, body, kind: "other", position: position + markdown.length });
}

function collectTickets(db: DatabaseSync, root: string, config: Config, now: Date, plan: ImportPlan): void {
  const files = taskFiles(root, config);
  const parsed = files
    .filter((file) => file.ticket)
    .map((file) => {
      const text = readFileSync(join(root, file.path), "utf8");
      return { file, ticket: parseTicket(text, fileTitle(file.stem, file.id ?? ""), config) };
    });

  const owners = new Map<string, string>();
  for (const { file, ticket } of parsed) {
    if (ticket.hasState && file.id !== null && !owners.has(file.id)) owners.set(file.id, file.path);
  }
  for (const { file } of parsed) if (file.id !== null && !owners.has(file.id)) owners.set(file.id, file.path);
  const folded = files.filter((f) => f.id !== null && owners.has(f.id) && owners.get(f.id) !== f.path);
  plan.report.noTicket = files.filter((f) => f.id === null || !owners.has(f.id)).map((f) => f.path);

  const date = today(now, config.timezone);
  for (const { file, ticket } of parsed) {
    if (file.id === null || owners.get(file.id) !== file.path) continue;
    const id = file.id;
    const rec = emptyTicket(id);
    rec.title = ticket.title;
    rec.dir = file.dir;
    rec.path = file.path;
    const { order, ...fields } = ticket.state;
    for (const [key, value] of Object.entries(fields)) rec[key as Column] = value ?? null;
    rec.position = order ?? null;
    if (ticket.tracker) {
      rec.tracker_state = ticket.tracker.state ?? null;
      rec.tracker_priority = ticket.tracker.priority ?? null;
      rec.tracker_assignee = ticket.tracker.assignee ?? null;
      rec.tracker_updated = ticket.tracker.updated ?? null;
      rec.tracker_url = rec.tracker_url ?? ticket.tracker.url ?? null;
      rec.tracker_json = trackerJson(ticket.tracker);
      for (const url of ticket.tracker.attachments) {
        const source = linkSource(url, config.trackerHosts);
        plan.links.push({ ticket_id: id, url, source, kind: linkKind(url, source) });
      }
    }
    if (!ticket.hasState) plan.report.noState.push(id);
    if (ticket.titleFromFile) plan.report.fileTitles.push({ id, title: ticket.title });

    const stateNotes: string[] = [];
    for (const field of LIMITED_FIELDS) {
      const value = rec[field];
      const limit = config.limits[field];
      if (value === null || limit === undefined || value.length <= limit) continue;
      plan.report.oversize.push({ id, field, length: value.length });
      stateNotes.push(`${fieldLabel(field, config)}: ${value}`);
      rec[field] = `${value.slice(0, limit)} (see State notes)`;
    }
    if (stateNotes.length > 0) {
      plan.notes.push({
        ticket_id: id,
        title: stateNoteTitle(db, id, date),
        body: stateNotes.join("\n"),
        kind: "state_notes",
        position: ticket.notes.length,
      });
    }

    plan.tickets.push(rec);
    const extra = folded.filter((f) => f.id === id);
    foldFiles(root, id, extra, ticket.notes.length + (stateNotes.length > 0 ? 1 : 0), plan);
    for (const heading of ticket.otherHeadings) plan.report.unclassified.push({ id, heading });
    for (const event of ticket.events) plan.events.push({ ticket_id: id, ...event, kind: "log", source: "import" });
    for (const note of ticket.notes) plan.notes.push({ ticket_id: id, ...note });
    for (const draft of ticket.drafts) plan.drafts.push({ ticket_id: id, ...draft });
  }
}

function collectDays(root: string, config: Config, plan: ImportPlan): void {
  if (!config.planDir) return;
  const dir = join(root, config.planDir);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const date = name.match(/^plan-(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
    if (!date) continue;
    const body = readFileSync(join(dir, name), "utf8");
    plan.days.push({ date, resume: splitResume(body, config.resumeHeading), body });
  }
}

function emptyPlan(root: string): ImportPlan {
  return {
    root,
    tickets: [],
    events: [],
    notes: [],
    drafts: [],
    links: [],
    days: [],
    report: { oversize: [], unclassified: [], folded: [], noTicket: [], noState: [], fileTitles: [] },
  };
}

function requireRoot(root: string): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HubError(`--root ${root} is not a folder`);
}

export function collectImport(db: DatabaseSync, root: string, config: Config, now: Date): ImportPlan {
  requireRoot(root);
  const plan = emptyPlan(root);
  collectTickets(db, root, config, now, plan);
  collectDays(root, config, plan);
  return plan;
}

function differs(existing: Record<string, unknown>, rec: Record<string, unknown>, columns: readonly string[]): boolean {
  return columns.some((c) => (existing[c] ?? null) !== (rec[c] ?? null));
}

function upsertTicket(db: DatabaseSync, rec: TicketRec, at: string): number {
  const columns = [...TICKET_COLUMNS, "position"] as const;
  const existing = one<Ticket>(db, "SELECT * FROM ticket WHERE id = ?", rec.id ?? "");
  if (!existing) {
    const cols = ["id", ...columns, "created_at", "updated_at"];
    const values: SQLInputValue[] = [rec.id ?? "", ...columns.map((c) => rec[c] ?? null), at, at];
    db.prepare(`INSERT INTO ticket(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...values);
    return 1;
  }
  if (!differs(existing, rec, columns)) return 0;
  const sets = columns.map((c) => `${c} = ?`).join(", ");
  db.prepare(`UPDATE ticket SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...columns.map((c) => rec[c] ?? null),
    at,
    rec.id ?? "",
  );
  return 1;
}

export function applyImport(db: DatabaseSync, plan: ImportPlan, now: Date): number {
  const at = nowIso(now);
  return transaction(db, () => {
    let changes = 0;
    for (const rec of plan.tickets) changes += upsertTicket(db, rec, at);

    for (const e of plan.events) {
      const seen = one(
        db,
        "SELECT 1 FROM event WHERE ticket_id = ? AND ts = ? AND substr(text, 1, 80) = ?",
        e.ticket_id,
        e.ts,
        e.text.slice(0, 80),
      );
      if (seen) continue;
      db.prepare("INSERT INTO event(ticket_id, ts, kind, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
        e.ticket_id,
        e.ts,
        e.kind,
        e.text,
        e.source,
        at,
      );
      changes++;
    }

    for (const n of plan.notes) {
      const existing = one<{ body: string; kind: string }>(
        db,
        "SELECT body, kind FROM note WHERE ticket_id = ? AND title = ?",
        n.ticket_id,
        n.title,
      );
      if (existing && existing.body === n.body && existing.kind === n.kind) continue;
      db.prepare(
        `INSERT INTO note(ticket_id, title, body, kind, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, title) DO UPDATE SET body = excluded.body, kind = excluded.kind, updated_at = excluded.updated_at`,
      ).run(n.ticket_id, n.title, n.body, n.kind, n.position, at);
      changes++;
    }

    for (const d of plan.drafts) {
      const existing = one<{ body: string; status: string }>(
        db,
        "SELECT body, status FROM draft WHERE ticket_id = ? AND label = ?",
        d.ticket_id,
        d.label,
      );
      if (existing && existing.body === d.body && existing.status === d.status) continue;
      db.prepare(
        `INSERT INTO draft(ticket_id, label, body, status, posted_at, sent_text, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, label) DO UPDATE SET body = excluded.body, status = excluded.status,
           posted_at = excluded.posted_at, sent_text = excluded.sent_text, updated_at = excluded.updated_at`,
      ).run(d.ticket_id, d.label, d.body, d.status, d.posted_at, d.status === "posted" ? d.body : null, at, at);
      changes++;
    }

    for (const l of plan.links) {
      const result = db
        .prepare(
          `INSERT INTO item(source, ref, kind, url, ticket_id, first_seen, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref) DO NOTHING`,
        )
        .run(l.source, l.url, l.kind, l.url, l.ticket_id, at, at);
      changes += Number(result.changes);
    }

    for (const day of plan.days) {
      const existing = one<{ resume: string | null; body: string }>(
        db,
        "SELECT resume, body FROM day WHERE date = ?",
        day.date,
      );
      if (existing && existing.resume === day.resume && existing.body === day.body) continue;
      db.prepare(
        `INSERT INTO day(date, resume, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET resume = excluded.resume, body = excluded.body, updated_at = excluded.updated_at`,
      ).run(day.date, day.resume, day.body, at);
      changes++;
    }
    return changes;
  });
}

export type ImportCounts = {
  tickets: number;
  events: number;
  notes: number;
  drafts: number;
  links: number;
  days: number;
};

export function countPlan(plan: ImportPlan): ImportCounts {
  return {
    tickets: plan.tickets.length,
    events: plan.events.length,
    notes: plan.notes.length,
    drafts: plan.drafts.length,
    links: plan.links.length,
    days: plan.days.length,
  };
}

export function formatSummary(plan: ImportPlan, changes: number | null): string {
  const c = countPlan(plan);
  const r = plan.report;
  const lines = [
    `import from ${plan.root} (${changes === null ? "dry run; --apply writes" : "applied"})`,
    `tickets ${c.tickets}, events ${c.events}, notes ${c.notes}, drafts ${c.drafts}, links ${c.links}, days ${c.days}`,
  ];
  if (r.oversize.length > 0) {
    lines.push(
      `oversize (cut, full text in State notes): ${r.oversize.map((o) => `${o.id} ${o.field} ${o.length}`).join("; ")}`,
    );
  }
  if (r.unclassified.length > 0) {
    lines.push(`other headings (stored as notes): ${r.unclassified.map((u) => `${u.id}: ${u.heading}`).join("; ")}`);
  }
  if (r.folded.length > 0) {
    const n = r.folded.reduce((sum, f) => sum + f.paths.length, 0);
    lines.push(
      `folded ${n} files into ${r.folded.length} tickets (as notes): ${r.folded.map((f) => `${f.id} (${f.paths.join(", ")})`).join("; ")}`,
    );
  }
  if (r.noTicket.length > 0) lines.push(`not imported, no ticket: ${r.noTicket.join(", ")}`);
  if (r.noState.length > 0) lines.push(`no State block: ${r.noState.join(", ")}`);
  if (r.fileTitles.length > 0) {
    lines.push(
      `title from file name (no "# <id> - <title>" heading; hub set <id> title fixes it): ${r.fileTitles.map((t) => `${t.id} "${t.title}"`).join("; ")}`,
    );
  }
  if (changes !== null) lines.push(`changes: ${changes}`);
  return lines.join("\n");
}
