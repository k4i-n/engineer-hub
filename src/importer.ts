import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Config } from "./config.ts";
import { all, LIMITED_FIELDS, one, type Ticket, transaction } from "./db.ts";
import {
  type ParsedDraft,
  type ParsedNote,
  parseChanges,
  parseTeamFile,
  parseTicket,
  splitResume,
  type Tracker,
} from "./parse.ts";
import { HubError, linkKind, linkSource, nowIso, today } from "./util.ts";

const TICKET_COLUMNS = [
  "title",
  "dir",
  "path",
  "status",
  "repo",
  "worktree",
  "branch",
  "prs",
  "gate",
  "decide",
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

const TRACKER_COLUMNS = [
  "tracker_state",
  "tracker_priority",
  "tracker_assignee",
  "tracker_url",
  "tracker_updated",
  "tracker_json",
] as const;

type Column = (typeof TICKET_COLUMNS)[number];
type TrackerColumn = (typeof TRACKER_COLUMNS)[number];
type TicketRec = { id: string } & Record<Column, string | null>;
type TrackerUpdate = { id: string } & Record<TrackerColumn, string | null>;
type EventRec = { ticket_id: string; ts: string; kind: string; text: string; source: string };
type NoteRec = { ticket_id: string } & ParsedNote;
type DraftRec = { ticket_id: string } & ParsedDraft;
type LinkRec = { ticket_id: string; url: string; source: string; kind: string; added_by: string };
type DayRec = { date: string; resume: string | null; body: string };

export type ImportReport = {
  oversize: { id: string; field: string; length: number }[];
  unclassified: { id: string; heading: string }[];
  duplicates: { id: string; paths: string[] }[];
  noState: string[];
  mineMissing: string[];
  unknownChanges: number;
};

export type ImportPlan = {
  root: string;
  tickets: TicketRec[];
  trackerUpdates: TrackerUpdate[];
  events: EventRec[];
  notes: NoteRec[];
  drafts: DraftRec[];
  links: LinkRec[];
  days: DayRec[];
  report: ImportReport;
};

type TicketFile = { path: string; dir: string; id: string; stem: string };

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".md"))
    .map((p) => join(dir, p))
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

export function ticketFiles(root: string, config: Config): TicketFile[] {
  const match = idMatcher(config);
  const files: TicketFile[] = [];
  for (const dir of config.taskDirs) {
    for (const file of markdownFiles(join(root, "tasks", dir))) {
      const name = basename(file);
      const stem = name.slice(0, -3);
      if (name.endsWith("-draft.md") || /^(STATUS|README)/i.test(stem)) continue;
      const id = match(stem);
      if (!id) continue;
      files.push({ path: relative(root, file).split(sep).join("/"), dir, id, stem });
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

function mergeTracker(base: Record<TrackerColumn, string | null>, update: TrackerUpdate): TrackerUpdate {
  const merged = { ...update };
  for (const column of TRACKER_COLUMNS) merged[column] = update[column] ?? base[column];
  const baseJson = base.tracker_json ? (JSON.parse(base.tracker_json) as Record<string, unknown>) : {};
  const teamJson = JSON.parse(update.tracker_json ?? "{}") as Record<string, unknown>;
  merged.tracker_json = JSON.stringify({ ...baseJson, team: teamJson.team });
  return merged;
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

function collectTickets(db: DatabaseSync, root: string, config: Config, now: Date, plan: ImportPlan): void {
  const files = ticketFiles(root, config);
  const parsed = files.map((file) => ({
    file,
    ticket: parseTicket(readFileSync(join(root, file.path), "utf8"), file.stem, config),
  }));

  const owners = new Map<string, string>();
  for (const { file, ticket } of parsed) if (ticket.hasState && !owners.has(file.id)) owners.set(file.id, file.path);
  for (const { file } of parsed) if (!owners.has(file.id)) owners.set(file.id, file.path);
  const byId = new Map<string, string[]>();
  for (const { file } of parsed) byId.set(file.id, [...(byId.get(file.id) ?? []), file.path]);
  for (const [id, paths] of byId) if (paths.length > 1) plan.report.duplicates.push({ id, paths });

  const date = today(now, config.timezone);
  for (const { file, ticket } of parsed) {
    const id = owners.get(file.id) === file.path ? file.id : file.stem;
    const rec = emptyTicket(id);
    rec.title = ticket.title;
    rec.dir = file.dir;
    rec.path = file.path;
    for (const [key, value] of Object.entries(ticket.state)) rec[key as Column] = value ?? null;
    if (ticket.tracker) {
      rec.tracker_state = ticket.tracker.state ?? null;
      rec.tracker_priority = ticket.tracker.priority ?? null;
      rec.tracker_assignee = ticket.tracker.assignee ?? null;
      rec.tracker_updated = ticket.tracker.updated ?? null;
      rec.tracker_url = rec.tracker_url ?? ticket.tracker.url ?? null;
      rec.tracker_json = trackerJson(ticket.tracker);
      for (const url of ticket.tracker.attachments) {
        const source = linkSource(url, config.trackerHosts);
        plan.links.push({ ticket_id: id, url, source, kind: linkKind(url, source), added_by: "sync" });
      }
    }
    if (!ticket.hasState) plan.report.noState.push(id);

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
    for (const heading of ticket.otherHeadings) plan.report.unclassified.push({ id, heading });
    for (const event of ticket.events) plan.events.push({ ticket_id: id, ...event, kind: "log", source: "import" });
    for (const note of ticket.notes) plan.notes.push({ ticket_id: id, ...note });
    for (const draft of ticket.drafts) plan.drafts.push({ ticket_id: id, ...draft });
  }
}

function collectTeam(root: string, config: Config, known: Set<string>, plan: ImportPlan): void {
  if (!config.teamDir) return;
  const teamRoot = join(root, config.teamDir);
  if (!existsSync(teamRoot)) return;
  const match = idMatcher(config);
  const stateDirs = readdirSync(teamRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "changes")
    .map((d) => d.name)
    .sort();

  for (const stateDir of stateDirs) {
    for (const file of markdownFiles(join(teamRoot, stateDir))) {
      const stem = basename(file, ".md");
      const id = match(stem) ?? stem;
      const raw = readFileSync(file, "utf8");
      const team = parseTeamFile(raw, stateDir, stem);
      const update: TrackerUpdate = {
        id,
        tracker_state: team.tracker.state ?? null,
        tracker_priority: team.tracker.priority ?? null,
        tracker_assignee: team.tracker.assignee ?? null,
        tracker_url: team.tracker.url ?? null,
        tracker_updated: team.tracker.updated ?? null,
        tracker_json: JSON.stringify({ team: JSON.parse(trackerJson(team.tracker)) }),
      };
      if (known.has(id)) {
        plan.trackerUpdates.push(update);
        continue;
      }
      const mine = config.teamOwnerMatch !== "" && (team.tracker.assignee ?? "").includes(config.teamOwnerMatch);
      if (!mine) continue;
      const rec = { ...emptyTicket(id), ...update, title: team.title, dir: "unfiled" };
      plan.tickets.push(rec);
      plan.report.mineMissing.push(id);
      known.add(id);
    }
  }

  for (const file of markdownFiles(join(teamRoot, "changes"))) {
    const date = basename(file, ".md");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const change of parseChanges(readFileSync(file, "utf8"), date, config.teamOwnerMatch)) {
      if (!known.has(change.id)) {
        plan.report.unknownChanges++;
        continue;
      }
      plan.events.push({ ticket_id: change.id, ts: change.ts, kind: "tracker", text: change.text, source: "sync" });
    }
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
    trackerUpdates: [],
    events: [],
    notes: [],
    drafts: [],
    links: [],
    days: [],
    report: { oversize: [], unclassified: [], duplicates: [], noState: [], mineMissing: [], unknownChanges: 0 },
  };
}

function requireRoot(root: string): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HubError(`--root ${root} is not a folder`);
}

export function collectImport(db: DatabaseSync, root: string, config: Config, now: Date): ImportPlan {
  requireRoot(root);
  const plan = emptyPlan(root);
  collectTickets(db, root, config, now, plan);
  collectTeam(root, config, new Set(plan.tickets.map((t) => t.id)), plan);
  for (const update of plan.trackerUpdates) {
    const rec = plan.tickets.find((t) => t.id === update.id);
    if (rec) Object.assign(rec, mergeTracker(rec, update));
  }
  plan.trackerUpdates = [];
  collectDays(root, config, plan);
  return plan;
}

export function collectTeamSync(db: DatabaseSync, root: string, config: Config): ImportPlan {
  requireRoot(root);
  const plan = emptyPlan(root);
  const known = new Set(all<{ id: string }>(db, "SELECT id FROM ticket").map((t) => t.id));
  collectTeam(root, config, known, plan);
  return plan;
}

function differs(existing: Record<string, unknown>, rec: Record<string, unknown>, columns: readonly string[]): boolean {
  return columns.some((c) => (existing[c] ?? null) !== (rec[c] ?? null));
}

function upsertTicket(
  db: DatabaseSync,
  rec: Record<string, string | null>,
  columns: readonly string[],
  at: string,
): number {
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
    for (const rec of plan.tickets) changes += upsertTicket(db, rec, TICKET_COLUMNS, at);
    for (const update of plan.trackerUpdates) {
      const existing = one<Ticket>(db, "SELECT * FROM ticket WHERE id = ?", update.id);
      changes += upsertTicket(db, existing ? mergeTracker(existing, update) : update, TRACKER_COLUMNS, at);
    }

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
        `INSERT INTO draft(ticket_id, label, body, status, posted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticket_id, label) DO UPDATE SET body = excluded.body, status = excluded.status,
           posted_at = excluded.posted_at, updated_at = excluded.updated_at`,
      ).run(d.ticket_id, d.label, d.body, d.status, d.posted_at, at, at);
      changes++;
    }

    for (const l of plan.links) {
      const result = db
        .prepare(
          `INSERT INTO link(ticket_id, source, kind, url, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(ticket_id, url) DO NOTHING`,
        )
        .run(l.ticket_id, l.source, l.kind, l.url, l.added_by, at);
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
  unfiled: number;
  events: number;
  notes: number;
  drafts: number;
  links: number;
  days: number;
};

export function countPlan(plan: ImportPlan): ImportCounts {
  return {
    tickets: plan.tickets.length,
    unfiled: plan.tickets.filter((t) => t.dir === "unfiled").length,
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
    `tickets ${c.tickets} (unfiled ${c.unfiled}), tracker updates ${plan.trackerUpdates.length}, events ${c.events}, notes ${c.notes}, drafts ${c.drafts}, links ${c.links}, days ${c.days}`,
  ];
  if (r.oversize.length > 0) {
    lines.push(
      `oversize (cut, full text in State notes): ${r.oversize.map((o) => `${o.id} ${o.field} ${o.length}`).join("; ")}`,
    );
  }
  if (r.unclassified.length > 0) {
    lines.push(`other headings (stored as notes): ${r.unclassified.map((u) => `${u.id}: ${u.heading}`).join("; ")}`);
  }
  if (r.duplicates.length > 0) {
    lines.push(`duplicate ids: ${r.duplicates.map((d) => `${d.id} (${d.paths.join(", ")})`).join("; ")}`);
  }
  if (r.noState.length > 0) lines.push(`no State block: ${r.noState.join(", ")}`);
  if (r.mineMissing.length > 0) lines.push(`mine in tracker, no local file (unfiled): ${r.mineMissing.join(", ")}`);
  if (r.unknownChanges > 0) lines.push(`change lines for unknown tickets: ${r.unknownChanges}`);
  if (changes !== null) lines.push(`changes: ${changes}`);
  return lines.join("\n");
}
