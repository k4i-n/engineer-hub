import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DEFAULTS, REVIEW_ASK, WORKSPACE } from "./config.ts";
import { HubError, nowIso, nowTs } from "./util.ts";

export const SCHEMA_VERSION = "30";

export type Ticket = {
  id: string;
  title: string | null;
  dir: string | null;
  path: string | null;
  status: string | null;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  gate: string | null;
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
export type ScriptRow = {
  name: string;
  argv: string;
  every: string;
  created_at: string;
  enabled: number;
  section: string | null;
};

export type DraftRow = {
  id: number;
  ticket_id: string | null;
  item: string | null;
  closed_item: number | null;
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
  match_no: string | null;
  verdict: string | null;
  match_verdict: string | null;
  send_at: string | null;
  internal: number;
  created_at: string | null;
};
export type CommentRow = { draft_id: number; pos: number; path: string; line: number; body: string };
export type ItemRow = {
  id: number;
  source: string;
  ref: string;
  kind: string;
  title: string | null;
  url: string | null;
  state: string | null;
  author: string | null;
  avatar: string | null;
  ticket_id: string | null;
  needs_me: number;
  first_seen: string;
  changed_at: string;
  closed_at: string | null;
  snoozed_until: string | null;
  ignored: string | null;
  detached: number;
  judged_at: string | null;
  away_ping: number | null;
  away_why: string | null;
  body: string | null;
  detail: string | null;
  ask: string | null;
  ask_answer: string | null;
  ask_at: string | null;
  review_ask: number;
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
  reopened_at: string | null;
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
  started_at: string | null;
};
export type DayRow = { date: string; resume: string | null; body: string; updated_at: string | null };
export type PlanLineRow = {
  id: number;
  date: string;
  pos: number;
  time: string | null;
  text: string;
  refs: string;
  done_at: string | null;
  dropped_at: string | null;
  why: string | null;
  carried_from: string | null;
  created_at: string;
  updated_at: string;
};

export const LIMITED_FIELDS = ["status", "repo", "gate", "next", "owner"] as const;
export const SETTABLE_FIELDS = [
  "title",
  "status",
  "repo",
  "worktree",
  "branch",
  "gate",
  "next",
  "owner",
  "priority",
] as const;
export const PRIORITIES = ["Urgent", "High", "Medium", "Low"] as const;

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

const DRAFT_ITEM_INDEX = `CREATE INDEX draft_item ON draft(item);
CREATE UNIQUE INDEX draft_item_label ON draft(item, label) WHERE ticket_id IS NULL;`;

const DRAFT_COMMENT = `CREATE TABLE draft_comment(id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL, pos INTEGER NOT NULL,
  path TEXT NOT NULL, line INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(draft_id, pos));`;

const PLAN_LINE = `CREATE TABLE plan_line(id INTEGER PRIMARY KEY, date TEXT NOT NULL, pos INTEGER NOT NULL, time TEXT,
  text TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '[]', done_at TEXT, dropped_at TEXT, why TEXT, carried_from TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX plan_line_date ON plan_line(date, pos);`;

const STEP = `CREATE TABLE IF NOT EXISTS step(id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, n INTEGER NOT NULL,
  title TEXT NOT NULL, done_at TEXT, evidence TEXT, created_at TEXT NOT NULL, started_at TEXT, UNIQUE(ticket_id, n));`;

const PIN = "CREATE TABLE IF NOT EXISTS pin(key TEXT PRIMARY KEY, pinned_at TEXT NOT NULL);";
const ITEM_FOLD = `CREATE TABLE IF NOT EXISTS item_fold(ref TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE, url TEXT, seen_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS item_fold_item ON item_fold(item_id);`;

const UNMIGRATED_COLUMNS = [
  ["wait", "pinged_at"],
  ["item", "snoozed_until"],
  ["draft", "match_text"],
  ["draft", "match_ref"],
] as const;

const TICKET_FTS = ["id", "title", "status", "next", "gate"];

const SCHEMA = `
CREATE TABLE ticket(
  id TEXT PRIMARY KEY,
  title TEXT, dir TEXT, path TEXT,
  status TEXT, repo TEXT, worktree TEXT, branch TEXT, gate TEXT, next TEXT, owner TEXT, updated TEXT,
  tracker_state TEXT, tracker_priority TEXT, tracker_assignee TEXT, tracker_url TEXT, tracker_updated TEXT, tracker_json TEXT,
  team TEXT, position INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE event(id INTEGER PRIMARY KEY, ticket_id TEXT, ts TEXT, kind TEXT, text TEXT, source TEXT, ref TEXT, created_at TEXT);
CREATE INDEX event_ticket ON event(ticket_id, ts);
CREATE TABLE note(id INTEGER PRIMARY KEY, ticket_id TEXT, title TEXT, body TEXT, kind TEXT, position INTEGER, updated_at TEXT,
  UNIQUE(ticket_id, title));
CREATE TABLE draft(id INTEGER PRIMARY KEY, ticket_id TEXT, label TEXT, body TEXT, status TEXT, channel TEXT, posted_at TEXT,
  sent_text TEXT, sent_ref TEXT, answer TEXT, match_text TEXT, match_ref TEXT, send_at TEXT,
  created_at TEXT, updated_at TEXT, item TEXT, closed_item INTEGER, match_no TEXT,
  verdict TEXT, match_verdict TEXT, internal INTEGER NOT NULL DEFAULT 0, UNIQUE(ticket_id, label));
${DRAFT_COMMENT}
${DRAFT_ITEM_INDEX}
CREATE TABLE item(id INTEGER PRIMARY KEY, source TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT,
  url TEXT, state TEXT, author TEXT, ticket_id TEXT, needs_me INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL, changed_at TEXT NOT NULL, closed_at TEXT, snoozed_until TEXT, ignored TEXT,
  detached INTEGER NOT NULL DEFAULT 0, judged_at TEXT, away_ping INTEGER, away_why TEXT, body TEXT, detail TEXT,
  ask TEXT, ask_answer TEXT, ask_at TEXT, avatar TEXT, review_ask INTEGER NOT NULL DEFAULT 0);
CREATE INDEX item_ticket ON item(ticket_id);
${ITEM_FOLD}
CREATE TABLE wait(id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL, who TEXT NOT NULL, url TEXT NOT NULL,
  asked_at TEXT NOT NULL, ping_after TEXT, pinged_at TEXT, closed_at TEXT, reopened_at TEXT);
${STEP}
CREATE TABLE source(name TEXT PRIMARY KEY, cursor TEXT, last_sync TEXT NOT NULL, last_error TEXT, warning TEXT);
CREATE TABLE day(date TEXT PRIMARY KEY, resume TEXT, body TEXT, updated_at TEXT);
${PLAN_LINE}
${PIN}
CREATE TABLE script_source(name TEXT PRIMARY KEY, argv TEXT NOT NULL, every TEXT NOT NULL, created_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, section TEXT);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE config(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
${ftsTable("ticket", "ticket_fts", "rowid", TICKET_FTS)}
${ftsTable("note", "note_fts", "id", ["ticket_id", "title", "body"])}
${ftsTable("event", "event_fts", "id", ["ticket_id", "text"])}
${ftsTable("draft", "draft_fts", "id", ["ticket_id", "label", "body", "sent_text"])}
INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

const UPGRADES: Record<string, { to: string; sql: string | ((db: DatabaseSync) => string) }> = {
  "2": { to: "3", sql: "ALTER TABLE draft ADD COLUMN send_at TEXT;" },
  "3": {
    to: "4",
    sql: "CREATE TABLE script_source(name TEXT PRIMARY KEY, argv TEXT NOT NULL, every TEXT NOT NULL, created_at TEXT NOT NULL);",
  },
  "4": { to: "5", sql: "ALTER TABLE ticket ADD COLUMN position INTEGER;" },
  "5": { to: "6", sql: "ALTER TABLE item ADD COLUMN ignored TEXT;" },
  "6": { to: "7", sql: "ALTER TABLE source ADD COLUMN warning TEXT;" },
  "7": { to: "8", sql: "ALTER TABLE item ADD COLUMN detached INTEGER NOT NULL DEFAULT 0;" },
  "8": { to: "9", sql: "ALTER TABLE script_source ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;" },
  "9": { to: "10", sql: "ALTER TABLE script_source ADD COLUMN section TEXT;" },
  "10": {
    to: "11",
    sql: `${excludeIgnoredRepos("githubReviewQuery", "review_request")}
${excludeIgnoredRepos("githubPrQuery", "pr")}
DELETE FROM config WHERE key = 'ignoreRepos';`,
  },
  "11": {
    to: "12",
    sql: "ALTER TABLE item ADD COLUMN judged_at TEXT; ALTER TABLE item ADD COLUMN away_ping INTEGER; ALTER TABLE item ADD COLUMN away_why TEXT;",
  },
  "12": { to: "13", sql: "ALTER TABLE item ADD COLUMN body TEXT;" },
  "13": { to: "14", sql: "ALTER TABLE item ADD COLUMN detail TEXT;" },
  "14": {
    to: "15",
    sql: `ALTER TABLE draft ADD COLUMN item TEXT; ALTER TABLE draft ADD COLUMN closed_item INTEGER;
${DRAFT_ITEM_INDEX}`,
  },
  "15": { to: "16", sql: "ALTER TABLE draft ADD COLUMN match_no TEXT;" },
  "16": {
    to: "17",
    sql: "ALTER TABLE item ADD COLUMN ask TEXT; ALTER TABLE item ADD COLUMN ask_answer TEXT; ALTER TABLE item ADD COLUMN ask_at TEXT;",
  },
  "17": {
    to: "18",
    sql: `ALTER TABLE draft ADD COLUMN verdict TEXT; ALTER TABLE draft ADD COLUMN match_verdict TEXT;
${DRAFT_COMMENT}`,
  },
  "18": { to: "19", sql: "ALTER TABLE draft ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;" },
  "19": {
    to: "20",
    sql: `UPDATE item SET ask = '${REVIEW_ASK}'
WHERE kind = 'review_request' AND ask IS NULL AND closed_at IS NULL AND ignored IS NULL;`,
  },
  "20": { to: "21", sql: "ALTER TABLE item ADD COLUMN avatar TEXT;" },
  "21": { to: "22", sql: PLAN_LINE },
  "22": { to: "23", sql: "ALTER TABLE wait ADD COLUMN reopened_at TEXT;" },
  "23": { to: "24", sql: addUnmigrated },
  "24": { to: "25", sql: dropDecide },
  "25": { to: "26", sql: dropPrs },
  "26": {
    to: "27",
    sql: (db) => (hasColumn(db, "step", "started_at") ? "" : "ALTER TABLE step ADD COLUMN started_at TEXT;"),
  },
  "27": {
    to: "28",
    sql: (
      db,
    ) => `${hasColumn(db, "item", "review_ask") ? "" : "ALTER TABLE item ADD COLUMN review_ask INTEGER NOT NULL DEFAULT 0;"}
UPDATE item SET review_ask = 1 WHERE kind = 'review_request'
  AND ask = coalesce((SELECT json_extract(value, '$') FROM config WHERE key = 'reviewAsk'), '${REVIEW_ASK}');
DELETE FROM config WHERE key = 'reviewAsk';`,
  },
  "28": { to: "29", sql: ITEM_FOLD },
  "29": { to: "30", sql: slackAsPeer },
};

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined;
}

function logRemoved(db: DatabaseSync, column: string, where: string): void {
  const zone = one<{ value: string }>(db, "SELECT value FROM config WHERE key = 'timezone'")?.value;
  const now = new Date();
  const ts = nowTs(now, zone === undefined ? DEFAULTS.timezone : (JSON.parse(zone) as string));
  db.prepare(
    `INSERT INTO event(ticket_id, ts, kind, text, source, created_at)
     SELECT id, ?, 'log', '${column} (removed): ' || ${column}, 'import', ? FROM ticket WHERE ${where}`,
  ).run(ts, nowIso(now));
}

function configValue<T>(db: DatabaseSync, key: string, fallback: T): T {
  const raw = one<{ value: string }>(db, "SELECT value FROM config WHERE key = ?", key)?.value;
  return raw === undefined ? fallback : (JSON.parse(raw) as T);
}

function slackAsPeer(db: DatabaseSync): string {
  const named = configValue<string[]>(db, "slackWorkspaces", []);
  const fetch = configValue<Record<string, boolean>>(db, "fetch", {});
  const used = fetch.slack !== undefined || one(db, "SELECT 1 FROM source WHERE name = 'slack'") !== undefined;
  if (!used) return "";
  const hosts = all<{ key: string }>(db, "SELECT key FROM meta WHERE key LIKE 'slack-team:%'").map(
    (r) => r.key.slice("slack-team:".length).split(".")[0] ?? "",
  );
  const left = [...new Set(hosts)].filter((h) => WORKSPACE.test(h) && !named.includes(h));
  const name = left.length === 1 ? (left[0] as string) : null;
  const { slack: on, ...rest } = fetch;
  const at = nowIso(new Date());
  const set = db.prepare(
    "INSERT INTO config(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  );
  if (name === null) {
    db.prepare("DELETE FROM source WHERE name = 'slack'").run();
  } else {
    set.run("slackWorkspaces", JSON.stringify([name, ...named]), at);
    rest[`slack-${name}`] = on === true;
    db.prepare("UPDATE source SET name = ? WHERE name = 'slack'").run(`slack-${name}`);
  }
  if (on !== undefined) set.run("fetch", JSON.stringify(rest), at);
  return "";
}

function dropPrs(db: DatabaseSync): string {
  logRemoved(db, "prs", "trim(coalesce(prs, '')) NOT IN ('', '-')");
  return "ALTER TABLE ticket DROP COLUMN prs;";
}

function dropDecide(db: DatabaseSync): string {
  const set = "trim(coalesce(decide, '')) <> ''";
  const noGate = "trim(coalesce(gate, '')) IN ('', '-')";
  logRemoved(db, "decide", `${set} AND NOT ${noGate}`);
  return `UPDATE ticket SET gate = decide WHERE ${set} AND ${noGate};
DROP TRIGGER ticket_fts_ai; DROP TRIGGER ticket_fts_ad; DROP TRIGGER ticket_fts_au; DROP TABLE ticket_fts;
ALTER TABLE ticket DROP COLUMN decide;
${ftsTable("ticket", "ticket_fts", "rowid", TICKET_FTS)}
INSERT INTO ticket_fts(ticket_fts) VALUES ('rebuild');`;
}

function addUnmigrated(db: DatabaseSync): string {
  const columns = UNMIGRATED_COLUMNS.filter(([table, column]) => !hasColumn(db, table, column)).map(
    ([table, column]) => `ALTER TABLE ${table} ADD COLUMN ${column} TEXT;`,
  );
  return [...columns, STEP, PIN].join("\n");
}

function excludeIgnoredRepos(key: "githubReviewQuery" | "githubPrQuery", kind: string): string {
  const repos = `FROM config c, json_each(c.value, '$.${kind}') r WHERE c.key = 'ignoreRepos'`;
  return `INSERT INTO config(key, value, updated_at)
SELECT '${key}',
  json_quote(coalesce((SELECT value ->> '$' FROM config WHERE key = '${key}'), '${DEFAULTS[key]}')
    || (SELECT group_concat(' -repo:' || r.value, '') ${repos})),
  strftime('%Y-%m-%dT%H:%M:%fZ')
WHERE EXISTS (SELECT 1 ${repos})
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`;
}

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
      db.exec(typeof step.sql === "string" ? step.sql : step.sql(db));
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

export function draftOwner(d: DraftRow): string {
  return d.ticket_id ?? d.item ?? "";
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
