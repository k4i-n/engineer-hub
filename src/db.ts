import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { HubError } from "./util.ts";

export const SCHEMA_VERSION = "8";

export type Ticket = {
  id: string;
  title: string | null;
  dir: string | null;
  path: string | null;
  status: string | null;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  prs: string | null;
  gate: string | null;
  decide: string | null;
  next: string | null;
  owner: string | null;
  updated: string | null;
  tracker_state: string | null;
  tracker_priority: string | null;
  tracker_assignee: string | null;
  tracker_url: string | null;
  tracker_updated: string | null;
  tracker_json: string | null;
  team: string | null;
  position: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export type EventRow = {
  id: number;
  ticket_id: string | null;
  ts: string;
  kind: string;
  text: string;
  source: string;
  ref: string | null;
};
export type NoteRow = { ticket_id: string; title: string; body: string; kind: string; position: number };
export type ScriptRow = { name: string; argv: string; every: string; created_at: string };

export type DraftRow = {
  ticket_id: string;
  label: string;
  body: string;
  status: string;
  channel: string | null;
  posted_at: string | null;
  sent_text: string | null;
  sent_ref: string | null;
  answer: string | null;
  match_text: string | null;
  match_ref: string | null;
  send_at: string | null;
};
export type ItemRow = {
  id: number;
  source: string;
  ref: string;
  kind: string;
  title: string | null;
  url: string | null;
  state: string | null;
  author: string | null;
  ticket_id: string | null;
  needs_me: number;
  first_seen: string;
  changed_at: string;
  closed_at: string | null;
  snoozed_until: string | null;
  ignored: string | null;
  detached: number;
};
export type WaitRow = {
  id: number;
  ticket_id: string;
  who: string;
  url: string;
  asked_at: string;
  ping_after: string | null;
  pinged_at: string | null;
  closed_at: string | null;
};
export type SourceRow = {
  name: string;
  cursor: string | null;
  last_sync: string;
  last_error: string | null;
  warning: string | null;
};
export type StepRow = {
  id: number;
  ticket_id: string;
  n: number;
  title: string;
  done_at: string | null;
  evidence: string | null;
};
export type DayRow = { date: string; resume: string | null; body: string; updated_at: string | null };

export const LIMITED_FIELDS = ["status", "repo", "prs", "gate", "decide", "next", "owner"] as const;
export const SETTABLE_FIELDS = [
  "title",
  "status",
  "repo",
  "worktree",
  "branch",
  "prs",
  "gate",
  "decide",
  "next",
  "owner",
] as const;

function ftsTable(table: string, fts: string, key: string, columns: string[]): string {
  const cols = columns.join(", ");
  const values = (prefix: string) => columns.map((c) => `${prefix}.${c}`).join(", ");
  return `
CREATE VIRTUAL TABLE ${fts} USING fts5(${cols}, content='${table}', content_rowid='${key}');
CREATE TRIGGER ${fts}_ai AFTER INSERT ON ${table} BEGIN
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.${key}, ${values("new")});
END;
CREATE TRIGGER ${fts}_ad AFTER DELETE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.${key}, ${values("old")});
END;
CREATE TRIGGER ${fts}_au AFTER UPDATE ON ${table} BEGIN
  INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.${key}, ${values("old")});
  INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.${key}, ${values("new")});
END;`;
}

const SCHEMA = `
CREATE TABLE ticket(
  id TEXT PRIMARY KEY,
  title TEXT, dir TEXT, path TEXT,
  status TEXT, repo TEXT, worktree TEXT, branch TEXT, prs TEXT, gate TEXT, decide TEXT, next TEXT, owner TEXT, updated TEXT,
  tracker_state TEXT, tracker_priority TEXT, tracker_assignee TEXT, tracker_url TEXT, tracker_updated TEXT, tracker_json TEXT,
  team TEXT, position INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE event(id INTEGER PRIMARY KEY, ticket_id TEXT, ts TEXT, kind TEXT, text TEXT, source TEXT, ref TEXT, created_at TEXT);
CREATE INDEX event_ticket ON event(ticket_id, ts);
CREATE TABLE note(id INTEGER PRIMARY KEY, ticket_id TEXT, title TEXT, body TEXT, kind TEXT, position INTEGER, updated_at TEXT,
  UNIQUE(ticket_id, title));
CREATE TABLE draft(id INTEGER PRIMARY KEY, ticket_id TEXT, label TEXT, body TEXT, status TEXT, channel TEXT, posted_at TEXT,
  sent_text TEXT, sent_ref TEXT, answer TEXT, match_text TEXT, match_ref TEXT, send_at TEXT,
  created_at TEXT, updated_at TEXT, UNIQUE(ticket_id, label));
CREATE TABLE item(id INTEGER PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT,
  url TEXT, state TEXT, author TEXT, ticket_id TEXT, needs_me INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL, changed_at TEXT NOT NULL, closed_at TEXT, snoozed_until TEXT, ignored TEXT,
  detached INTEGER NOT NULL DEFAULT 0);
CREATE INDEX item_ticket ON item(ticket_id);
CREATE TABLE wait(id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, who TEXT NOT NULL, url TEXT NOT NULL,
  asked_at TEXT NOT NULL, ping_after TEXT, pinged_at TEXT, closed_at TEXT);
CREATE TABLE step(id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, n INTEGER NOT NULL, title TEXT NOT NULL,
  done_at TEXT, evidence TEXT, created_at TEXT NOT NULL, UNIQUE(ticket_id, n));
CREATE TABLE source(name TEXT PRIMARY KEY, cursor TEXT, last_sync TEXT NOT NULL, last_error TEXT, warning TEXT);
CREATE TABLE day(date TEXT PRIMARY KEY, resume TEXT, body TEXT, updated_at TEXT);
CREATE TABLE pin(key TEXT PRIMARY KEY, pinned_at TEXT NOT NULL);
CREATE TABLE script_source(name TEXT PRIMARY KEY, argv TEXT NOT NULL, every TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
${ftsTable("ticket", "ticket_fts", "rowid", ["id", "title", "status", "next", "gate", "decide"])}
${ftsTable("note", "note_fts", "id", ["ticket_id", "title", "body"])}
${ftsTable("event", "event_fts", "id", ["ticket_id", "text"])}
${ftsTable("draft", "draft_fts", "id", ["ticket_id", "label", "body", "sent_text"])}
INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

const UPGRADES: Record<string, { to: string; sql: string }> = {
  "2": { to: "3", sql: "ALTER TABLE draft ADD COLUMN send_at TEXT;" },
  "3": {
    to: "4",
    sql: "CREATE TABLE script_source(name TEXT PRIMARY KEY, argv TEXT NOT NULL, every TEXT NOT NULL, created_at TEXT NOT NULL);",
  },
  "4": { to: "5", sql: "ALTER TABLE ticket ADD COLUMN position INTEGER;" },
  "5": { to: "6", sql: "ALTER TABLE item ADD COLUMN ignored TEXT;" },
  "6": { to: "7", sql: "ALTER TABLE source ADD COLUMN warning TEXT;" },
  "7": { to: "8", sql: "ALTER TABLE item ADD COLUMN detached INTEGER NOT NULL DEFAULT 0;" },
};

export function opensAs(version: string | undefined): boolean {
  let v = version;
  while (v !== undefined && v !== SCHEMA_VERSION) v = UPGRADES[v]?.to;
  return v === SCHEMA_VERSION;
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) {
    transaction(db, () => db.exec(SCHEMA));
    return db;
  }
  let version = one<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'schema_version'")?.value;
  for (let upgrade = UPGRADES[version ?? ""]; upgrade !== undefined; upgrade = UPGRADES[version ?? ""]) {
    const step = upgrade;
    transaction(db, () => {
      db.exec(step.sql);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(step.to);
    });
    version = step.to;
  }
  if (version === SCHEMA_VERSION) return db;
  db.close();
  throw new HubError(
    `${path} has schema v${version ?? "?"}, this hub needs v${SCHEMA_VERSION}: move the file aside and re-import`,
  );
}

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function one<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function getTicket(db: DatabaseSync, id: string): Ticket {
  const ticket = one<Ticket>(db, "SELECT * FROM ticket WHERE id = ?", id);
  if (ticket) return ticket;
  const renamed = one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", `moved-id:${id}`)?.value;
  if (renamed !== undefined) throw new HubError(`${id} is now ${renamed}: use ${renamed}`);
  throw new HubError(`no ticket ${id} (hub board lists them; hub ticket-new creates one)`);
}

export function checkLimit(field: string, value: string, limits: Record<string, number>): void {
  const limit = limits[field];
  if (limit === undefined || value.length <= limit) return;
  throw new HubError(
    `${field} is ${value.length} chars (max ${limit}): put the detail in a note (hub note) or the log (hub log) and keep ${field} to one line`,
  );
}

export function ftsQuery(input: string): string {
  const tokens = input.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new HubError("search needs a query");
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
}
