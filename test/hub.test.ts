import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { openDb, SCHEMA_VERSION } from "../src/db.ts";
import { intervalText, ladder } from "../src/intervals.ts";
import { type Server, serve } from "../src/serve.ts";

const ROOT = join(import.meta.dirname, "fixtures", "root");
const NOW = new Date("2026-11-13T05:20:00Z");

type Out = { code: number; out: string; err: string };

let dir = "";
let dbFile = "";
let now = NOW;
let stdin = "";
let server: Server;

async function hub(...argv: string[]): Promise<Out> {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    readStdin: () => stdin,
    env: { HUB_DB: dbFile, HUB_URL: server.url },
    now: () => now,
  };
  const code = await run(argv, io);
  return { code, out, err };
}

async function ok(...argv: string[]): Promise<string> {
  const result = await hub(...argv);
  assert.equal(result.code, 0, `hub ${argv.join(" ")} failed: ${result.err}`);
  return result.out;
}

async function json<T>(...argv: string[]): Promise<T> {
  return JSON.parse(await ok(...argv, "--json")) as T;
}

function sql<T>(query: string, ...params: string[]): T[] {
  const db = new DatabaseSync(dbFile);
  try {
    return db
      .prepare(query)
      .all(...params)
      .map((row) => ({ ...row })) as unknown as T[];
  } finally {
    db.close();
  }
}

async function configure(): Promise<void> {
  await ok("config", "trackerHosts", '["tracker.example.com"]');
}

async function imported(): Promise<void> {
  await configure();
  await ok("import", "--root", ROOT, "--apply");
}

function checksums(path: string): string {
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .sort()
    .filter((p) => p.endsWith(".md"))
    .map(
      (p) =>
        `${p} ${createHash("sha256")
          .update(readFileSync(join(path, p)))
          .digest("hex")}`,
    )
    .join("\n");
}

type Counts = {
  tickets: number;
  events: number;
  notes: number;
  drafts: number;
  links: number;
  days: number;
};
type ImportJson = {
  counts: Counts;
  report: {
    oversize: { id: string; field: string; length: number }[];
    folded: { id: string; paths: string[] }[];
    noTicket: string[];
    fileTitles: { id: string; title: string }[];
  };
  changes: number | null;
};

const EXPECTED: Counts = { tickets: 2, events: 3, notes: 10, drafts: 2, links: 2, days: 1 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-test-"));
  dbFile = join(dir, "hub.db");
  now = NOW;
  stdin = "";
  server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("import", () => {
  test("dry run counts every entity, reports the oversize Status and writes nothing", async () => {
    await configure();
    const result = await json<ImportJson>("import", "--root", ROOT);
    assert.deepEqual(result.counts, EXPECTED);
    assert.equal(result.changes, null);
    assert.deepEqual(result.report.oversize, [{ id: "ENG-42", field: "status", length: 1000 }]);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM ticket")[0]?.n, 0);
  });

  test("apply then re-run gives identical counts and changes nothing", async () => {
    await configure();
    const first = await json<ImportJson>("import", "--root", ROOT, "--apply");
    const second = await json<ImportJson>("import", "--root", ROOT, "--apply");
    assert.deepEqual(first.counts, EXPECTED);
    assert.deepEqual(second.counts, EXPECTED);
    assert.ok((first.changes ?? 0) > 0);
    assert.equal(second.changes, 0);
    const rows = (table: string) => sql<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n;
    assert.deepEqual(["ticket", "event", "note", "draft", "item", "day"].map(rows), [
      EXPECTED.tickets,
      EXPECTED.events,
      EXPECTED.notes,
      EXPECTED.drafts,
      EXPECTED.links,
      EXPECTED.days,
    ]);
  });

  test("a ticket file with no title heading is titled from its name without the id, and the report lists it", async () => {
    await configure();
    const root = mkdtempSync(join(tmpdir(), "hub-root-"));
    try {
      mkdirSync(join(root, "tasks", "todo"), { recursive: true });
      writeFileSync(join(root, "tasks", "todo", "ENG-9-retire-old_watch.md"), "Status: open\n");
      writeFileSync(join(root, "tasks", "todo", "ENG-8-x.md"), "# ENG-8 - Real title\n");
      const dry = await json<ImportJson>("import", "--root", root);
      assert.deepEqual(dry.report.fileTitles, [{ id: "ENG-9", title: "retire old watch" }]);
      assert.match(
        await ok("import", "--root", root, "--apply"),
        /^title from file name .*: ENG-9 "retire old watch"$/m,
      );
      assert.deepEqual(sql<{ id: string; title: string }>("SELECT id, title FROM ticket ORDER BY id"), [
        { id: "ENG-8", title: "Real title" },
        { id: "ENG-9", title: "retire old watch" },
      ]);
      await ok("set", "ENG-8", "title", "ENG-8 real title");
      assert.match((await hub("lint")).out, /^ENG-8: title starts with the ticket id; set the real title$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("files sharing a ticket id or inside its folder fold into the ticket as notes, and the dry run says so", async () => {
    await configure();
    const dry = await json<ImportJson>("import", "--root", ROOT);
    assert.deepEqual(dry.report.folded, [
      { id: "ENG-42", paths: ["tasks/inprogress/ENG-42-baseline.md", "tasks/inprogress/ENG-42-trace.txt"] },
      {
        id: "ENG-7",
        paths: [
          "tasks/todo/ENG-7-notes-draft.md",
          "tasks/done/ENG-7-scripts/notes.md",
          "tasks/done/ENG-7-scripts/run.sh",
        ],
      },
    ]);
    assert.deepEqual(dry.report.noTicket, ["tasks/todo/README.md"]);
    const text = await ok("import", "--root", ROOT);
    assert.match(
      text,
      /^folded 5 files into 2 tickets \(as notes\): ENG-42 \(tasks\/inprogress\/ENG-42-baseline\.md, /m,
    );
    assert.match(text, /^not imported, no ticket: tasks\/todo\/README\.md$/m);
    await ok("import", "--root", ROOT, "--apply");
    assert.deepEqual(
      sql<{ id: string }>("SELECT id FROM ticket ORDER BY id").map((t) => t.id),
      ["ENG-42", "ENG-7"],
    );
    const notes = sql<{ title: string; body: string }>("SELECT title, body FROM note WHERE ticket_id = 'ENG-7'");
    assert.match(notes.find((n) => n.title === "tasks/done/ENG-7-scripts/notes.md")?.body ?? "", /Run run.sh/);
    assert.equal(notes.find((n) => n.title === "Other files")?.body, "- tasks/done/ENG-7-scripts/run.sh");
  });

  test("oversize field keeps limit chars plus a suffix, the full text goes to a state_notes note", async () => {
    await imported();
    const [ticket] = sql<{ status: string }>("SELECT status FROM ticket WHERE id = 'ENG-42'");
    assert.equal(ticket?.status.length, 240 + " (see State notes)".length);
    assert.ok(ticket?.status.endsWith(" (see State notes)"));
    const [note] = sql<{ title: string; body: string }>(
      "SELECT title, body FROM note WHERE ticket_id = 'ENG-42' AND kind = 'state_notes'",
    );
    assert.equal(note?.title, "State notes (migrated 2026-11-13)");
    assert.equal(note?.body.length, "Status: ".length + 1000);
  });

  test("a later re-import reuses the existing state notes title", async () => {
    await imported();
    now = new Date("2026-11-20T05:20:00Z");
    assert.equal((await json<ImportJson>("import", "--root", ROOT, "--apply")).changes, 0);
  });

  test("every section of a ticket file lands in the DB and the source files stay byte-identical", async () => {
    const before = checksums(ROOT);
    await imported();
    assert.equal(checksums(ROOT), before);
    const notes = sql<{ title: string; kind: string }>(
      "SELECT title, kind FROM note WHERE ticket_id = 'ENG-42' ORDER BY position",
    );
    assert.deepEqual(notes, [
      { title: "Ticket body as filed", kind: "ticket_body" },
      { title: "Detail", kind: "detail" },
      { title: "Inventory", kind: "other" },
      { title: "State notes (migrated 2026-11-13)", kind: "state_notes" },
      { title: "tasks/inprogress/ENG-42-baseline.md", kind: "other" },
      { title: "Other files", kind: "other" },
    ]);
    const [t] = sql<Record<string, string>>("SELECT * FROM ticket WHERE id = 'ENG-42'");
    assert.deepEqual(sql<{ id: string; position: number | null }>("SELECT id, position FROM ticket ORDER BY id"), [
      { id: "ENG-42", position: 2 },
      { id: "ENG-7", position: null },
    ]);
    assert.equal(t?.repo, "acme/web");
    assert.equal(t?.worktree, "~/wt/eng-42");
    assert.equal(t?.branch, "feat/session-sync");
    assert.equal(t?.owner, "me");
    assert.equal(t?.updated, "2026-11-12");
    assert.equal(t?.tracker_state, "In Review");
    assert.equal(t?.tracker_priority, "High");
    assert.equal(t?.tracker_assignee, "Sam Owner");
    assert.equal(t?.tracker_url, "https://tracker.example.com/acme/issue/ENG-42");
    const trackerJson = JSON.parse(t?.tracker_json ?? "{}") as Record<string, unknown>;
    assert.match(String(trackerJson.raw), /\*\*Attachments:\*\*/);
    const drafts = sql<{ label: string; status: string; posted_at: string | null; sent_text: string | null }>(
      "SELECT label, status, posted_at, sent_text FROM draft WHERE ticket_id = 'ENG-42' ORDER BY id",
    );
    assert.deepEqual(drafts, [
      {
        label: "Posted 2026-11-06",
        status: "posted",
        posted_at: "2026-11-06",
        sent_text: "Posted in #web: the rollout starts Monday.",
      },
      { label: "D24 - ask design about the banner (context)", status: "draft", posted_at: null, sent_text: null },
    ]);
    const events = sql<{ ts: string; text: string }>(
      "SELECT ts, text FROM event WHERE ticket_id = 'ENG-42' AND kind = 'log' ORDER BY id",
    );
    assert.deepEqual(events, [
      { ts: "2026-11-12 14:2x", text: "read the session middleware\nit keys sessions by device id" },
      { ts: "2026-11-12 15:00", text: "drafted the schema" },
      { ts: "2026-11-13", text: "decided on a shared table" },
    ]);
  });

  test("a missing root is an error", async () => {
    const result = await hub("import", "--root", join(dir, "nope"));
    assert.equal(result.code, 1);
    assert.match(result.err, /is not a folder/);
  });
});

describe("writes", () => {
  test("set refuses an oversize value with the documented message", async () => {
    await imported();
    const result = await hub("set", "ENG-7", "next", "x".repeat(241));
    assert.equal(result.code, 1);
    assert.equal(
      result.err,
      "next is 241 chars (max 240): put the detail in a note (hub note) or the log (hub log) and keep next to one line",
    );
  });

  test("a valid set bumps updated and updated_at", async () => {
    await imported();
    now = new Date("2026-11-14T16:00:00Z");
    await ok("set", "ENG-7", "gate", "waiting on product");
    const [t] = sql<{ gate: string; updated: string; updated_at: string }>(
      "SELECT gate, updated, updated_at FROM ticket WHERE id = 'ENG-7'",
    );
    assert.deepEqual(t, { gate: "waiting on product", updated: "2026-11-15", updated_at: "2026-11-14T16:00:00.000Z" });
  });

  test("set priority stores the label, clears on empty and refuses other values", async () => {
    await imported();
    await ok("set", "ENG-7", "priority", "high");
    const priority = () =>
      sql<{ p: string | null }>("SELECT tracker_priority AS p FROM ticket WHERE id = 'ENG-7'")[0]?.p;
    assert.equal(priority(), "High");
    assert.match(
      (await hub("set", "ENG-7", "priority", "soon")).err,
      /priority must be one of Urgent, High, Medium, Low/,
    );
    assert.equal(priority(), "High");
    await ok("set", "ENG-7", "priority", "");
    assert.equal(priority(), null);
  });

  test("set updated backdates the ticket in the config timezone and refuses the future", async () => {
    await imported();
    now = new Date("2026-11-14T16:00:00Z");
    await ok("set", "ENG-7", "updated", "2026-10-02 09:30");
    const row = () =>
      sql<{ updated: string; updated_at: string }>("SELECT updated, updated_at FROM ticket WHERE id = 'ENG-7'")[0];
    assert.deepEqual(row(), { updated: "2026-10-02", updated_at: "2026-10-02T00:30:00.000Z" });
    await ok("set", "ENG-7", "updated", "2026-11-01");
    assert.deepEqual(row(), { updated: "2026-11-01", updated_at: "2026-10-31T15:00:00.000Z" });
    assert.match((await hub("set", "ENG-7", "updated", "2026-11-16")).err, /updated cannot be in the future/);
    assert.match(
      (await hub("set", "ENG-7", "updated", "last week")).err,
      /updated takes YYYY-MM-DD or YYYY-MM-DD HH:MM/,
    );
    assert.deepEqual(row(), { updated: "2026-11-01", updated_at: "2026-10-31T15:00:00.000Z" });
  });

  test("set refuses an unknown field and an unknown ticket", async () => {
    await imported();
    assert.match((await hub("set", "ENG-7", "colour", "x")).err, /unknown body field colour \(title, status, repo/);
    assert.match((await hub("set", "ENG-1", "next", "x")).err, /no ticket ENG-1/);
  });

  test("log stamps the config timezone and events lists newest first", async () => {
    await imported();
    now = new Date("2026-11-13T23:30:00Z");
    await ok("log", "ENG-7", "measured 40 exports per minute", "--kind", "reading");
    const events = await ok("events", "ENG-7");
    assert.equal(events.split("\n")[0], "2026-11-14 08:30 [reading] measured 40 exports per minute");
    assert.match((await hub("log", "ENG-7", "x", "--kind", "chat")).err, /--kind must be one of/);
  });

  test("note, draft, posted and day set round-trip through the DB", async () => {
    await imported();
    stdin = "# Runbook\nrestart the worker";
    await ok("note", "ENG-7", "Runbook", "--stdin");
    assert.equal(await ok("note-show", "ENG-7", "Runbook"), "# Runbook\nrestart the worker");

    stdin = "Can we cap exports at 10 a minute?";
    await ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    assert.match(await ok("drafts"), /ENG-7 \| ask product \| Can we cap exports/);
    await ok("posted", "ENG-7", "ask product", "--at", "2026-11-13 15:00", "--answer", "yes, 10");
    assert.equal(await ok("drafts", "ENG-7"), "ask product | answered | #product | 2026-11-13 15:00 | wording pending");

    const file = join(dir, "plan.md");
    writeFileSync(file, "# Plan\n\n## RESUME\nstart with ENG-7\n\n## Later\n- other\n");
    assert.equal(
      await ok("day", "set", "2026-11-14", "--file", file),
      "day 2026-11-14 saved, rev: 2026-11-13T05:20:00.000Z",
    );
    assert.equal(await ok("day", "2026-11-14"), "2026-11-14\nrev: 2026-11-13T05:20:00.000Z\nstart with ENG-7");
  });

  test("posted keeps the wording actually sent, and Sent without it is pending until a sync fills it", async () => {
    await imported();
    stdin = "Can we cap exports at 10 a minute?";
    await ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    assert.equal(await ok("posted", "ENG-7", "ask product"), 'ENG-7 draft "ask product" posted, wording pending');
    assert.equal(await ok("drafts", "ENG-7"), "ask product | posted | #product | 2026-11-13 14:20 | wording pending");

    stdin = "hey, ok to limit exports to ten per minute per user?";
    const permalink = "https://acme.slack.com/archives/C1/p1763011200";
    await ok("posted", "ENG-7", "ask product", "--stdin", "--ref", permalink);
    assert.equal(await ok("drafts", "ENG-7"), "ask product | posted | #product | 2026-11-13 14:20");
    assert.equal(
      await ok("draft-show", "ENG-7", "ask product"),
      `Can we cap exports at 10 a minute?\n\n--- sent ${permalink}\nhey, ok to limit exports to ten per minute per user?`,
    );
    assert.match(await ok("search", "ten per minute"), /^draft ENG-7 ask product:/m);

    assert.equal(await ok("unposted", "ENG-7", "ask product"), 'ENG-7 draft "ask product" not sent');
    assert.equal(await ok("drafts", "ENG-7"), "ask product | draft | #product");
    assert.equal(await ok("draft-show", "ENG-7", "ask product"), "Can we cap exports at 10 a minute?");
    assert.match((await hub("unposted", "ENG-7", "ask product")).err, /is not sent/);
    await ok("posted", "ENG-7", "ask product");

    stdin = "Second try: cap at 20?";
    await ok("draft", "ENG-7", "ask product", "--stdin");
    assert.equal(await ok("drafts", "ENG-7"), "ask product | draft | #product");
  });

  test("ticket-new validates the id and dir, move changes the dir", async () => {
    await imported();
    await ok("ticket-new", "NEW-export-audit", "Audit export usage");
    assert.match((await hub("ticket-new", "bad id", "x")).err, /matches neither/);
    assert.match((await hub("ticket-new", "ENG-7", "dup")).err, /already exists/);
    assert.match((await hub("ticket-new", "ENG-8", "x", "--dir", "later")).err, /dir must be one of/);
    await ok("move", "NEW-export-audit", "inprogress");
    assert.equal(sql<{ dir: string }>("SELECT dir FROM ticket WHERE id = 'NEW-export-audit'")[0]?.dir, "inprogress");
  });
});

describe("title and rename", () => {
  test("set changes the title, and refuses an empty one", async () => {
    await imported();
    await ok("set", "ENG-7", "title", "Export audit, all regions");
    assert.equal(
      sql<{ title: string }>("SELECT title FROM ticket WHERE id = 'ENG-7'")[0]?.title,
      "Export audit, all regions",
    );
    assert.match((await hub("set", "ENG-7", "title", " ")).err, /title is empty/);
  });

  test("rename moves every row and pin to the new id, keeps search, and the old id names the new one", async () => {
    await ok("ticket-new", "NEW-sessions", "Sync sessions");
    await ok("log", "NEW-sessions", "read the session middleware");
    stdin = "keyed by device id";
    await ok("note", "NEW-sessions", "Findings", "--stdin");
    stdin = "Can we drop the old table?";
    await ok("draft", "NEW-sessions", "M1", "--stdin");
    await ok("step", "add", "NEW-sessions", "write the migration");
    await ok("link", "NEW-sessions", "https://github.com/acme/web/pull/101");
    await ok("wait", "NEW-sessions", "Ana", "https://acme.slack.com/archives/C1/p1");
    await ok("set", "NEW-sessions", "gate", "approve the migration?");
    sql("INSERT INTO pin(key, pinned_at) VALUES ('gate-NEW-sessions', 'x'), ('match-NEW-sessions-M1', 'x')");

    assert.match(await ok("rename", "NEW-sessions", "ENG-42"), /^NEW-sessions is now ENG-42$/m);
    for (const table of ["event", "note", "draft", "item", "wait", "step"]) {
      assert.deepEqual(
        sql<{ id: string }>(`SELECT DISTINCT ticket_id AS id FROM ${table}`).map((r) => r.id),
        ["ENG-42"],
        table,
      );
    }
    assert.deepEqual(
      sql<{ key: string }>("SELECT key FROM pin ORDER BY key").map((r) => r.key),
      ["gate-ENG-42", "match-ENG-42-M1"],
    );
    assert.match(await ok("events", "ENG-42", "-n", "1"), /renamed from NEW-sessions$/);
    assert.match(await ok("search", "middleware"), /ENG-42/);
    assert.match((await hub("log", "NEW-sessions", "late write")).err, /NEW-sessions is now ENG-42: use ENG-42/);

    assert.match((await hub("rename", "ENG-42", "bad id")).err, /matches neither/);
    await ok("ticket-new", "ENG-43", "Other");
    assert.match((await hub("rename", "ENG-42", "ENG-43")).err, /ticket ENG-43 already exists/);
    await ok("rename", "ENG-42", "ENG-44");
    assert.match((await hub("ticket", "NEW-sessions")).err, /NEW-sessions is now ENG-44/);
  });
});

describe("delete and merge", () => {
  async function filled(id: string, step: string): Promise<void> {
    await ok("ticket-new", id, `Ticket ${id}`);
    await ok("log", id, `worked on ${id}`);
    stdin = `notes of ${id}`;
    await ok("note", id, "Findings", "--stdin");
    stdin = `ask from ${id}`;
    await ok("draft", id, "M1", "--stdin");
    await ok("step", "add", id, step);
    await ok("link", id, `https://github.com/acme/web/pull/${id.slice(4)}`);
    await ok("wait", id, "Ana", `https://acme.slack.com/archives/C1/p${id.slice(4)}`);
    sql(`INSERT INTO pin(key, pinned_at) VALUES ('gate-${id}', 'x'), ('match-${id}-M1', 'x')`);
  }
  const count = (table: string, id: string) =>
    sql<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ticket_id = ?`, id)[0]?.n;

  test("delete backs up, removes the ticket's own rows and pins, and leaves its items unattached", async () => {
    await filled("ENG-42", "write the migration");
    await ok("rename", "ENG-42", "ENG-43");
    assert.match(await ok("ticket-delete", "ENG-43"), /^ENG-43 deleted \(backup hub-\d{8}-\d{6}-before-delete\.db\)$/m);
    for (const table of ["event", "note", "draft", "wait", "step", "item"])
      assert.equal(count(table, "ENG-43"), 0, table);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM item WHERE ticket_id IS NULL")[0]?.n, 1);
    assert.deepEqual(sql("SELECT key FROM pin"), []);
    assert.match((await hub("ticket", "ENG-43")).err, /no ticket ENG-43/);
    assert.match((await hub("ticket", "ENG-42")).err, /no ticket ENG-42/);
    assert.match(await ok("backups"), /hub-\d{8}-\d{6}-before-delete\.db/);
    await ok("ticket-new", "ENG-44", "Again");
    assert.match(await ok("ticket-delete", "ENG-44"), /before-delete-2\.db\)$/m);
    assert.match((await hub("ticket-delete", "ENG-45")).err, /no ticket ENG-45/);
  });

  test("merge moves every row into the other ticket, renames clashes, appends steps, and the old id names the new one", async () => {
    await filled("ENG-41", "read the code");
    await filled("ENG-42", "write the migration");
    await ok("step", "add", "ENG-41", "ship it");
    assert.match((await hub("merge", "ENG-42", "ENG-42")).err, /cannot merge into itself/);
    assert.match(await ok("merge", "ENG-41", "ENG-42"), /^ENG-41 merged into ENG-42 \(backup /m);
    assert.deepEqual(
      sql<{ title: string }>("SELECT title FROM note WHERE ticket_id = 'ENG-42' ORDER BY position").map((n) => n.title),
      ["Findings", "Findings (from ENG-41)"],
    );
    assert.deepEqual(
      sql<{ label: string }>("SELECT label FROM draft WHERE ticket_id = 'ENG-42' ORDER BY label").map((d) => d.label),
      ["M1", "M1 (from ENG-41)"],
    );
    assert.deepEqual(
      sql<{ n: number; title: string }>("SELECT n, title FROM step WHERE ticket_id = 'ENG-42' ORDER BY n").map(
        (s) => `${s.n} ${s.title}`,
      ),
      ["1 write the migration", "2 read the code", "3 ship it"],
    );
    for (const [table, n] of [
      ["item", 2],
      ["wait", 2],
    ] as const)
      assert.equal(count(table, "ENG-42"), n, table);
    assert.match(await ok("events", "ENG-42", "-n", "1"), /merged ENG-41: Ticket ENG-41$/);
    assert.match(await ok("search", "notes of ENG-41"), /ENG-42/);
    assert.deepEqual(
      sql<{ key: string }>("SELECT key FROM pin ORDER BY key").map((p) => p.key),
      ["gate-ENG-42", "match-ENG-42-M1"],
    );
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM ticket WHERE id = 'ENG-41'")[0]?.n, 0);
    assert.match((await hub("log", "ENG-41", "late")).err, /ENG-41 is now ENG-42/);
  });
});

describe("files", () => {
  const folder = (id: string) => join(dir, "files", id);
  const listed = async (id: string) =>
    (await json<{ folder: string; files: { path: string }[] }>("files", id)).files.map((f) => f.path);

  test("add copies a file or folder in, lists it with the folder path, and logs it; rm deletes and logs", async () => {
    await ok("ticket-new", "ENG-1", "Plan");
    const src = join(dir, "src");
    mkdirSync(join(src, "research"), { recursive: true });
    writeFileSync(join(src, "plan.md"), "# Plan");
    writeFileSync(join(src, "research", "a.csv"), "a,b");

    assert.match(await ok("file", "add", "ENG-1", join(src, "plan.md")), /^copied .*plan\.md to .*ENG-1\/plan\.md$/m);
    await ok("file", "add", "ENG-1", join(src, "research"));
    await ok("file", "add", "ENG-1", join(src, "plan.md"), "--as", "old/plan-v1.md");
    assert.deepEqual(await listed("ENG-1"), ["old/plan-v1.md", "plan.md", "research/a.csv"]);
    assert.equal(readFileSync(join(src, "plan.md"), "utf8"), "# Plan");
    const text = await ok("files", "ENG-1");
    assert.equal(text.split("\n")[0], folder("ENG-1"));
    assert.match(text, /^plan\.md {2}6 B {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    assert.match(await ok("ticket", "ENG-1"), new RegExp(`^files: 3 in ${folder("ENG-1")}$`, "m"));

    assert.match((await hub("file", "add", "ENG-1", join(src, "plan.md"))).err, /plan\.md already exists on ENG-1/);
    assert.match((await hub("file", "add", "ENG-1", join(src, "nope.md"))).err, /no file or folder/);
    for (const bad of ["../x.md", "/etc/x", ".git/x", "a/../../x"])
      assert.match((await hub("file", "add", "ENG-1", join(src, "plan.md"), "--as", bad)).err, /not a path inside/);
    assert.match((await hub("file", "add", "ENG-9", join(src, "plan.md"))).err, /no ticket ENG-9/);

    await ok("file", "add", "ENG-1", join(src, "plan.md"), "--as", "moved.md", "--move");
    assert.equal(existsSync(join(src, "plan.md")), false);
    assert.equal(readFileSync(join(folder("ENG-1"), "moved.md"), "utf8"), "# Plan");

    await ok("file", "rm", "ENG-1", "research");
    assert.deepEqual(await listed("ENG-1"), ["moved.md", "old/plan-v1.md", "plan.md"]);
    assert.match((await hub("file", "rm", "ENG-1", "research")).err, /no file research on ENG-1/);
    assert.deepEqual(
      sql<{ text: string }>("SELECT text FROM event WHERE ticket_id = 'ENG-1' ORDER BY id").map((e) => e.text),
      [
        "file added: plan.md",
        "file added: research",
        "file added: old/plan-v1.md",
        "file added: moved.md",
        "file removed: research",
      ],
    );
  });

  test("search finds text in md, csv, json and html files, follows edits by modified time, and drops removed files", async () => {
    await ok("ticket-new", "ENG-1", "Plan");
    const f = folder("ENG-1");
    mkdirSync(join(f, "data"), { recursive: true });
    writeFileSync(join(f, "plan.md"), "# Plan\n\nmove the clock to per-move timers");
    writeFileSync(join(f, "data", "rows.csv"), "game,seats\nmancala,2");
    writeFileSync(join(f, "data", "cfg.json"), '{"region": "asia-northeast1"}');
    writeFileSync(
      join(f, "report.html"),
      "<html><style>.quarterly{}</style><script>var hidden = 1</script><p>Latency&nbsp;dropped</p></html>",
    );
    writeFileSync(join(f, "shot.png"), "timers in an image");
    mkdirSync(folder("NOT-A-TICKET"), { recursive: true });
    writeFileSync(join(folder("NOT-A-TICKET"), "x.md"), "timers");

    assert.match(await ok("search", "per-move timers"), /^file ENG-1 plan\.md: .*\[timers\]/m);
    assert.match(await ok("search", "mancala"), /^file ENG-1 data\/rows\.csv:/m);
    assert.match(await ok("search", "northeast1"), /^file ENG-1 data\/cfg\.json:/m);
    assert.match(await ok("search", "latency dropped"), /^file ENG-1 report\.html:/m);
    for (const gone of ["quarterly", "hidden", "style"]) assert.equal(await ok("search", gone), "no matches", gone);
    assert.equal((await ok("search", "timers")).split("\n").length, 1);

    writeFileSync(join(f, "plan.md"), "# Plan\n\nkeep a shared clock", { flag: "w" });
    utimesSync(join(f, "plan.md"), new Date(), new Date(Date.now() + 5000));
    assert.equal(await ok("search", "per-move"), "no matches");
    assert.match(await ok("search", "shared clock"), /^file ENG-1 plan\.md:/m);

    await ok("file", "rm", "ENG-1", "data");
    assert.equal(await ok("search", "mancala"), "no matches");
    await ok("rename", "ENG-1", "ENG-2");
    assert.match(await ok("search", "shared clock"), /^file ENG-2 plan\.md:/m);
    assert.deepEqual(
      sql<{ id: string }>("SELECT DISTINCT ticket_id AS id FROM file").map((r) => r.id),
      ["ENG-2"],
    );
  });

  test("rename moves the folder, merge moves files in with (from <id>) on a clash, delete removes it", async () => {
    const src = join(dir, "plan.md");
    writeFileSync(src, "# Plan");
    await ok("ticket-new", "NEW-a", "A");
    assert.match(await ok("ticket", "NEW-a"), /^files: 0$/m);
    await ok("file", "add", "NEW-a", src);
    await ok("file", "add", "NEW-a", src, "--as", "notes.md");

    await ok("rename", "NEW-a", "ENG-1");
    assert.equal(existsSync(folder("NEW-a")), false);
    assert.deepEqual(await listed("ENG-1"), ["notes.md", "plan.md"]);

    mkdirSync(folder("ENG-3"), { recursive: true });
    assert.match((await hub("rename", "ENG-1", "ENG-3")).err, /ENG-3 already exists: move it aside/);
    assert.deepEqual(await listed("ENG-1"), ["notes.md", "plan.md"]);

    await ok("ticket-new", "ENG-2", "B");
    await ok("file", "add", "ENG-2", src);
    await ok("merge", "ENG-1", "ENG-2");
    assert.deepEqual(await listed("ENG-2"), ["notes.md", "plan (from ENG-1).md", "plan.md"]);
    assert.equal(existsSync(folder("ENG-1")), false);

    await ok("ticket-delete", "ENG-2");
    assert.equal(existsSync(folder("ENG-2")), false);
    const backups = readdirSync(join(dir, "backups")).filter((n) => n.endsWith("-before-delete.files"));
    assert.deepEqual(readdirSync(join(dir, "backups", backups[0] ?? "", "ENG-2")).sort(), [
      "notes.md",
      "plan (from ENG-1).md",
      "plan.md",
    ]);
  });
});

describe("edit notes, drafts and steps", () => {
  test("a note is renamed and removed; a taken title is refused", async () => {
    await ok("ticket-new", "ENG-42", "Sync sessions");
    stdin = "keyed by device id";
    await ok("note", "ENG-42", "Findings", "--stdin");
    await ok("note", "ENG-42", "Plan", "--stdin");
    assert.match((await hub("note-mv", "ENG-42", "Findings", "Plan")).err, /already has a note "Plan"/);
    await ok("note-mv", "ENG-42", "Findings", "Session findings");
    assert.match(await ok("note-show", "ENG-42", "Session findings"), /keyed by device id/);
    await ok("note-rm", "ENG-42", "Plan");
    assert.match(await ok("notes", "ENG-42"), /^Session findings \(detail, \d+ chars\)\n?$/);
    assert.match((await hub("note-rm", "ENG-42", "Plan")).err, /no note "Plan" on ENG-42/);
  });

  test("an unsent draft is renamed with its pin and removed; a sent one stays", async () => {
    await ok("ticket-new", "ENG-42", "Sync sessions");
    stdin = "Can we drop the old table?";
    await ok("draft", "ENG-42", "M1", "--stdin");
    await ok("draft", "ENG-42", "M2", "--stdin");
    sql("INSERT INTO pin(key, pinned_at) VALUES ('match-ENG-42-M1', 'x')");
    assert.match((await hub("draft-mv", "ENG-42", "M1", "M2")).err, /already has a draft "M2"/);
    await ok("draft-mv", "ENG-42", "M1", "Ask Ana");
    assert.deepEqual(sql("SELECT key FROM pin"), [{ key: "match-ENG-42-Ask Ana" }]);
    await ok("posted", "ENG-42", "M2");
    assert.match((await hub("draft-rm", "ENG-42", "M2")).err, /was sent; it stays as the record/);
    await ok("draft-rm", "ENG-42", "Ask Ana");
    assert.deepEqual(
      sql<{ label: string }>("SELECT label FROM draft").map((d) => d.label),
      ["M2"],
    );
    assert.deepEqual(sql("SELECT key FROM pin"), []);
  });

  test("steps are inserted, edited, undone and removed, and stay numbered 1 to n", async () => {
    await ok("ticket-new", "ENG-42", "Sync sessions");
    await ok("step", "add", "ENG-42", "read the code");
    await ok("step", "add", "ENG-42", "ship it");
    assert.match(await ok("step", "add", "ENG-42", "write the migration", "--at", "2"), /step 2 added/);
    await ok("step", "add", "ENG-42", "plan", "--at", "9");
    await ok("step", "done", "ENG-42", "1", "--evidence", "https://example.com/1");
    await ok("step", "edit", "ENG-42", "3", "ship", "behind", "a", "flag");
    assert.equal(
      await ok("steps", "ENG-42"),
      "1 [x] read the code | https://example.com/1\n2 [ ] write the migration\n3 [ ] ship behind a flag\n4 [ ] plan",
    );
    await ok("step", "undo", "ENG-42", "1");
    assert.match((await hub("step", "undo", "ENG-42", "1")).err, /step 1 on ENG-42 is not started/);
    assert.match(await ok("events", "ENG-42", "-n", "1"), /step 1 not done: read the code$/);
    await ok("step", "rm", "ENG-42", "2");
    assert.equal(await ok("steps", "ENG-42"), "1 [ ] read the code\n2 [ ] ship behind a flag\n3 [ ] plan");
    assert.match((await hub("step", "rm", "ENG-42", "9")).err, /no step 9 on ENG-42/);
    assert.match((await hub("step", "add", "ENG-42", "x", "--at", "0")).err, /--at takes a step number from 1/);
  });
});

describe("items", () => {
  test("link stores an item on the ticket, a second link changes nothing, a later link moves it", async () => {
    await imported();
    const url = "https://github.com/acme/web/pull/120";
    await ok("link", "ENG-7", url, "--title", "Rate limit exports");
    assert.equal(await ok("items", "--ticket", "ENG-7"), `#3 github/pr | Rate limit exports | ENG-7 | ${url}`);
    const before = sql<{ changed_at: string }>("SELECT changed_at FROM item WHERE ref = ?", url);
    now = new Date("2026-11-14T00:00:00Z");
    await ok("link", "ENG-7", url);
    assert.deepEqual(sql<{ changed_at: string }>("SELECT changed_at FROM item WHERE ref = ?", url), before);
    await ok("link", "ENG-42", url);
    assert.equal(await ok("items", "--ticket", "ENG-7"), "no items");
    assert.match(await ok("ticket", "ENG-42"), /^items: 3 open, 0 need you \| waits: 0 open$/m);
    assert.match((await hub("link", "ENG-7", url, "--kind", "page")).err, /--kind must be one of/);
  });
  test("item put stores a sync delta once, matches tickets by id and logs new and changed items", async () => {
    await imported();
    const review = "https://github.com/acme/web/pull/130";
    stdin = [
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: review,
        title: "ENG-7: cap exports",
        state: "open",
        needs_me: true,
      }),
      JSON.stringify({ source: "grafana", kind: "alert", ref: "alert-991", title: "API 5xx above 2%" }),
    ].join("\n");
    assert.equal(await ok("item", "put", "--stdin"), "items: 2 new, 0 changed, 0 unchanged");
    assert.equal(await ok("item", "put", "--stdin"), "items: 0 new, 0 changed, 2 unchanged");
    assert.equal(
      await ok("items", "--needs-me"),
      `#3 github/review_request | needs you | ENG-7: cap exports | open | ENG-7 | ${review} | ask: Review this? (no answer yet)`,
    );
    assert.match(await ok("events", "ENG-7"), /\[sync\] New Review request ENG-7: cap exports/);

    await ok("item", "close", "3");
    assert.equal(await ok("items", "--needs-me"), "no items");
    stdin = JSON.stringify({ source: "github", kind: "review_request", url: review, state: "open", needs_me: true });
    assert.equal(await ok("item", "put", "--stdin"), "items: 0 new, 0 changed, 1 unchanged");
    assert.equal(await ok("items", "--needs-me"), "no items");
    stdin = JSON.stringify({ source: "github", kind: "review_request", url: review, state: "merged" });
    assert.equal(await ok("item", "put", "--stdin"), "items: 0 new, 1 changed, 0 unchanged");
    assert.match(await ok("items", "--ticket", "ENG-7"), /^#3 .* \| merged \| ENG-7 \|/);
    assert.match(await ok("events", "ENG-7", "-n", "1"), /Review request ENG-7: cap exports: open → merged$/);

    await ok("item", "snooze", "alert-991", "--for", "2h");
    assert.doesNotMatch(await ok("items"), /alert-991/);
    now = new Date("2026-11-13T08:00:00Z");
    assert.match(await ok("items"), /alert-991/);
    assert.match((await hub("item", "snooze", "alert-991", "--for", "soon")).err, /--for takes a duration/);
    assert.match(await ok("item", "snooze", "alert-991", "--for", "tomorrow"), /snoozed until 2026-11-14 09:00$/);
    await ok("config", "laterHour", "7");
    assert.match(await ok("item", "snooze", "alert-991", "--for", "tomorrow"), /snoozed until 2026-11-14 07:00$/);
    assert.match((await hub("config", "laterHour", "24")).err, /laterHour is an hour from 0 to 23/);

    await ok("item", "attach", "alert-991", "ENG-42");
    assert.match(await ok("events", "ENG-42", "-n", "1"), /Attached Alert API 5xx above 2%$/);
  });

  test("item put refuses a bad line and writes nothing from the batch", async () => {
    await imported();
    const good = JSON.stringify({ source: "slack", kind: "thread", url: "https://acme.slack.com/archives/C1/p1" });
    const refused = async (line: string) => {
      stdin = `${good}\n${line}`;
      return (await hub("item", "put", "--stdin")).err;
    };
    assert.match(await refused("{nope"), /^line 2: not JSON$/);
    assert.match(await refused('{"source":"slack","kind":"thread","url":"u","colour":1}'), /unknown key colour/);
    assert.match(await refused('{"source":"slack","kind":"chat","url":"u"}'), /kind must be one of/);
    assert.match(await refused('{"source":"Slack!","kind":"thread","url":"u"}'), /source must be a lowercase name/);
    assert.match(await refused('{"source":"slack","kind":"thread"}'), /give ref or url/);
    assert.match(await refused('{"source":"slack","kind":"thread","url":"u","ticket":"ENG-9"}'), /no ticket ENG-9/);
    assert.match(await refused('{"source":"slack","kind":"thread","url":"u","needs_me":"yes"}'), /needs_me must be/);
    assert.match(
      await refused('{"source":"slack","kind":"thread","url":"u","avatar":"http://x/a.png"}'),
      /avatar must be an https URL/,
    );
    assert.equal(await ok("items", "--source", "slack"), "no items");
    assert.match((await hub("item", "close", "99")).err, /no item 99/);
  });

  test("a closed or snoozed item reopens", async () => {
    await imported();
    stdin = JSON.stringify({
      source: "slack",
      kind: "message",
      url: "https://acme.slack.com/archives/D1/p1",
      needs_me: true,
    });
    await ok("item", "put", "--stdin");
    await ok("item", "close", "3");
    await ok("item", "reopen", "3");
    await ok("item", "snooze", "3");
    await ok("item", "reopen", "3");
    assert.match(await ok("items", "--needs-me"), /^#3 slack\/message \| needs you/);
  });
});

describe("detach and wait edit", () => {
  test("a detached item stays off its ticket when it is fetched again, until attached", async () => {
    await ok("ticket-new", "ENG-42", "Sync sessions");
    const line = JSON.stringify({
      source: "github",
      ref: "https://github.com/acme/web/pull/101",
      kind: "pr",
      title: "ENG-42 sessions",
      state: "open",
    });
    stdin = line;
    await ok("item", "put", "--stdin");
    assert.match(await ok("item", "detach", "1"), /#1 detached from ENG-42/);
    assert.match(await ok("events", "ENG-42", "-n", "1"), /Detached/);
    stdin = line.replace('"open"', '"merged"');
    await ok("item", "put", "--stdin");
    assert.deepEqual(sql("SELECT ticket_id, detached FROM item"), [{ ticket_id: null, detached: 1 }]);
    await ok("item", "attach", "1", "ENG-42");
    assert.deepEqual(sql("SELECT ticket_id, detached FROM item"), [{ ticket_id: "ENG-42", detached: 0 }]);
  });

  test("an open wait changes who and when to ping; a closed one is refused", async () => {
    await ok("ticket-new", "ENG-42", "Sync sessions");
    await ok("wait", "ENG-42", "Ana", "https://acme.slack.com/archives/C1/p1", "--ping-after", "1d");
    assert.match((await hub("wait", "edit", "1")).err, /give who or ping_after/);
    assert.match(
      await ok("wait", "edit", "1", "--who", "Bo", "--ping-after", "4h"),
      /#1 ENG-42 \| Bo \| .* \| ping after /,
    );
    assert.deepEqual(sql("SELECT who, ping_after FROM wait"), [{ who: "Bo", ping_after: "2026-11-13T09:20:00.000Z" }]);
    await ok("wait", "close", "1");
    assert.match((await hub("wait", "edit", "1", "--who", "Cy")).err, /wait #1 is closed/);
  });
});

describe("waits", () => {
  test("a wait shows ping now once its time passes and closes by number or url", async () => {
    await imported();
    const thread = "https://acme.slack.com/archives/C1/p1763011200";
    assert.equal(
      await ok("wait", "ENG-7", "product", thread, "--ping-after", "1d"),
      "wait #1 on ENG-7: product, ping after 2026-11-14 14:20",
    );
    assert.equal(
      await ok("wait", "ENG-7", "product", thread, "--ping-after", "2h"),
      "wait #1 on ENG-7: product, ping after 2026-11-13 16:20",
    );
    await ok("wait", "ENG-42", "design", "https://acme.slack.com/archives/C2/p1");
    assert.equal(await ok("waits", "--due"), "no waits due");
    assert.match(await ok("ticket", "ENG-7"), /\| waits: 1 open$/m);
    now = new Date("2026-11-13T08:00:00Z");
    assert.equal(await ok("waits", "--due"), `#1 ENG-7 | product | asked 2026-11-13 14:20 | ping now | ${thread}`);
    assert.equal(await ok("wait", "close", thread), "closed #1");
    assert.equal(await ok("wait", "close", "2"), "closed #2");
    assert.equal(await ok("waits"), "no open waits");
    assert.match((await hub("wait", "close", "2")).err, /no open wait 2/);
    assert.match(
      (await hub("wait", "ENG-7", "a", "u", "--ping-after", "tomorrow")).err,
      /--ping-after takes a duration/,
    );
    await ok("wait", "reopen", "1");
    assert.equal(
      await ok("wait", "pinged", "1", "--for", "4h"),
      "wait #1: pinged product, next ping after 2026-11-13 21:00",
    );
    assert.equal(await ok("waits", "--due"), "no waits due");
    assert.match(await ok("events", "ENG-7", "-n", "1"), /\[log\] Pinged product$/);
  });
});

describe("sources", () => {
  test("a sync records its time and cursor, an error keeps the cursor, the next clean sync clears the error", async () => {
    assert.equal(await ok("sources"), "no sources synced yet");
    await ok("source", "github", "--cursor", "2026-11-13T05:00:00Z");
    now = new Date("2026-11-13T06:00:00Z");
    assert.equal(await ok("source", "github", "--error", "gh: rate limited"), "source github synced, with error");
    await ok("source", "slack", "--cursor", "1763011200.0001");
    assert.equal(
      await ok("sources"),
      [
        "github | last sync 2026-11-13 15:00 | cursor 2026-11-13T05:00:00Z | error: gh: rate limited",
        "slack | last sync 2026-11-13 15:00 | cursor 1763011200.0001",
      ].join("\n"),
    );
    await ok("source", "github");
    assert.match(await ok("sources"), /^github \| last sync 2026-11-13 15:00 \| cursor 2026-11-13T05:00:00Z$/m);
    assert.match((await hub("source", "GitHub")).err, /source must be a lowercase name/);
  });
});

describe("sync", () => {
  test("brief lists what a sync needs to judge the delta, in fixed sections", async () => {
    await imported();
    stdin = "Can we cap exports at 10 a minute?";
    await ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    await ok("posted", "ENG-7", "ask product");
    await ok("wait", "ENG-7", "product", "https://acme.slack.com/archives/C1/p1");
    await ok("source", "slack", "--cursor", "1763011200.0001");
    const text = await ok("brief");
    assert.match(text, /^sources:\n {2}slack \| since 2026-11-13 14:20 \| cursor 1763011200.0001$/m);
    assert.match(text, /^tickets:\n {2}ENG-42 Sync login sessions across devices\n {2}ENG-7 /m);
    assert.match(text, /^drafts not sent:\n {2}ENG-42 \| D24/m);
    assert.match(text, /^sent, wording pending:\n {2}ENG-7 \| ask product \| #product \| Can we cap exports/m);
    assert.match(text, /^waits:\n {2}#1 ENG-7 \| product \| /m);
    assert.match(text, /^tracked:\n {2}#\d+ /m);
    assert.ok(text.split("\n").every((line) => line.length <= 162));
  });

  test("a proposed match is confirmed with yes or dropped with no", async () => {
    await imported();
    stdin = "Can we cap exports at 10 a minute?";
    await ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    const permalink = "https://acme.slack.com/archives/C1/p1763011200";
    stdin = "ok to limit exports to ten a minute?";
    await ok("match", "ENG-7", "ask product", "--ref", permalink, "--stdin");
    assert.equal(await ok("drafts", "ENG-7"), "ask product | draft | #product | match proposed");
    await ok("match", "ENG-7", "ask product", "no");
    assert.equal(await ok("drafts", "ENG-7"), "ask product | draft | #product");
    await ok("match", "ENG-7", "ask product", "--ref", permalink, "--stdin");
    await ok("match", "ENG-7", "ask product", "yes");
    assert.equal(await ok("drafts", "ENG-7"), "ask product | posted | #product | 2026-11-13 14:20");
    assert.match(await ok("draft-show", "ENG-7", "ask product"), /--- sent .*\nok to limit exports to ten a minute\?$/);
    assert.match((await hub("match", "ENG-7", "ask product", "yes")).err, /no proposed match/);
    assert.match(
      (await hub("match", "ENG-7", "ask product", "--ref", permalink, "--stdin")).err,
      /already has its sent wording/,
    );
  });
});

describe("steps", () => {
  test("steps are numbered in order, done ones log an event, the ticket shows progress and the steps being done", async () => {
    await imported();
    await ok("step", "add", "ENG-7", "read the export handler");
    await ok("step", "add", "ENG-7", "add", "the", "limiter");
    await ok("step", "add", "ENG-7", "open the PR");
    const pr = "https://github.com/acme/web/pull/140";
    assert.equal(await ok("step", "done", "ENG-7", "1"), "ENG-7 step 1 done (1/3)");
    assert.match(await ok("ticket", "ENG-7"), /^steps: 1\/3$/m);
    await ok("step", "done", "ENG-7", "3", "--evidence", pr);
    assert.equal(
      await ok("steps", "ENG-7"),
      `1 [x] read the export handler\n2 [ ] add the limiter\n3 [x] open the PR | ${pr}`,
    );
    assert.match(await ok("events", "ENG-7", "-n", "1"), /\[step\] step 3 done: open the PR$/);
    assert.match((await hub("step", "done", "ENG-7", "3")).err, /already done/);
    assert.match((await hub("step", "done", "ENG-7", "9")).err, /no step 9 on ENG-7/);
    assert.match((await hub("step", "add", "ENG-7", "x".repeat(241))).err, /max 240/);
  });
});

describe("doing steps", () => {
  test("start marks a step doing, several at once; undo takes it back to todo; done works from todo or doing", async () => {
    await imported();
    for (const title of ["schema", "world-v2 prod PRs", "world prod PRs", "cleanup"])
      await ok("step", "add", "ENG-7", title);
    assert.equal(await ok("step", "start", "ENG-7", "2"), "ENG-7 step 2 started");
    await ok("step", "start", "ENG-7", "3");
    assert.match((await hub("step", "start", "ENG-7", "2")).err, /already started/);
    assert.match(await ok("ticket", "ENG-7"), /^steps: 0\/4 \| doing: 2 world-v2 prod PRs; 3 world prod PRs$/m);
    assert.equal(
      await ok("steps", "ENG-7"),
      "1 [ ] schema\n2 [>] world-v2 prod PRs\n3 [>] world prod PRs\n4 [ ] cleanup",
    );
    assert.equal(await ok("step", "done", "ENG-7", "2"), "ENG-7 step 2 done (1/4), still doing: 3");
    assert.match((await hub("step", "start", "ENG-7", "2")).err, /already done/);
    assert.equal(await ok("step", "undo", "ENG-7", "3"), "ENG-7 step 3 not started");
    await ok("step", "done", "ENG-7", "1");
    const started = sql<{ n: number; started_at: string | null }>(
      "SELECT n, started_at FROM step WHERE ticket_id = 'ENG-7' ORDER BY n",
    );
    assert.deepEqual(
      started.map((r) => r.started_at !== null),
      [true, true, false, false],
    );
    assert.equal(await ok("step", "undo", "ENG-7", "1"), "ENG-7 step 1 not done");
    assert.equal(await ok("steps", "ENG-7").then((t) => t.split("\n")[0]), "1 [ ] schema");
    assert.match(await ok("events", "ENG-7", "-n", "6"), /\[step\] step 2 started: world-v2 prod PRs/);
  });
});

describe("schema upgrade to v27", () => {
  test("steps gain started_at and read as todo or done", async () => {
    await imported();
    await ok("step", "add", "ENG-7", "one");
    await ok("step", "add", "ENG-7", "two");
    await ok("step", "done", "ENG-7", "1");
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec("ALTER TABLE step DROP COLUMN started_at; UPDATE meta SET value = '26' WHERE key = 'schema_version'");
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(await ok("steps", "ENG-7"), "1 [x] one\n2 [ ] two");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM step WHERE started_at IS NOT NULL")[0]?.n, 0);
  });
});

describe("reads", () => {
  test("board prints the exact line for the rich ticket", async () => {
    await imported();
    const status = sql<{ status: string }>("SELECT status FROM ticket WHERE id = 'ENG-42'")[0]?.status ?? "";
    const expected = `  [High] [TRACKER: In Review] #2 ENG-42 | ${status.slice(0, 87)}... | PR #101 | GATE: waiting on design review | next: write the migration for the sessions table`;
    const lines = (await ok("board")).split("\n");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("==")),
      ["== inprogress", "== todo"],
    );
    assert.equal(lines[1], expected);
    assert.equal(lines[3], "  [-] ENG-7 | - | next: read the export handler");
    assert.equal(await ok("board", "export"), "== todo\n  [-] ENG-7 | - | next: read the export handler");
  });

  test("board and ticket show the state of the ticket's PRs", async () => {
    await imported();
    stdin = [
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: "https://github.com/acme/web/pull/140",
        title: "ENG-42: sessions table",
        state: "approved",
      }),
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: "https://github.com/acme/web/pull/141",
        title: "ENG-42: refresh tokens",
        state: "checks failing",
      }),
    ].join("\n");
    await ok("item", "put", "--stdin");
    assert.match(await ok("board"), / ENG-42 \| .* \| PR #101, #140 approved, #141 checks failing \| GATE: /);
    assert.match(await ok("ticket", "ENG-42"), /^pulls: #101, #140 approved, #141 checks failing$/m);
    const pulls = (await json<{ pulls: { state: string }[] }>("ticket", "ENG-42")).pulls.map((i) => i.state);
    assert.deepEqual(pulls, [null, "approved", "checks failing"]);

    await ok("item", "close", "https://github.com/acme/web/pull/141");
    assert.match(await ok("board"), / ENG-42 \| .* \| PR #101, #140 approved \| GATE: /);
  });

  test("board hides unfiled tickets the tracker closed", async () => {
    await imported();
    await ok("ticket-new", "ENG-99", "Rotate the staging signing key", "--dir", "unfiled");
    assert.match(await ok("board"), /ENG-99/);
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE ticket SET tracker_state = 'Done' WHERE id = 'ENG-99'").run();
    db.close();
    assert.doesNotMatch(await ok("board"), /ENG-99/);
  });

  test("next orders by dir, then tracker priority, then most recent", async () => {
    await imported();
    now = new Date("2026-11-13T06:00:00Z");
    await ok("ticket-new", "ENG-8", "Second todo");
    assert.deepEqual(
      (await ok("next")).split("\n").map((l) => l.split(" | ")[0]),
      ["ENG-42", "ENG-8", "ENG-7"],
    );
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE ticket SET tracker_priority = 'Urgent' WHERE id = 'ENG-7'").run();
    db.close();
    assert.deepEqual(
      (await ok("next")).split("\n").map((l) => l.split(" | ")[0]),
      ["ENG-42", "ENG-7", "ENG-8"],
    );
  });

  test("ticket view stays under 25 lines", async () => {
    await imported();
    const lines = (await ok("ticket", "ENG-42")).split("\n");
    assert.ok(lines.length < 25);
    assert.equal(lines[0], "ENG-42 | inprogress | Sync login sessions across devices");
    assert.equal(
      lines.at(-2),
      "notes: Ticket body as filed; Detail; Inventory; State notes (migrated 2026-11-13); tasks/inprogress/ENG-42-baseline.md; Other files",
    );
    assert.equal(lines.at(-1), "files: 0");
  });

  test("search finds a term in a note, an event and a draft", async () => {
    await imported();
    assert.match(await ok("search", "shared session table"), /^note ENG-42 Detail:/m);
    assert.match(await ok("search", "middleware"), /^event ENG-42 2026-11-12 14:2x:/m);
    assert.match(await ok("search", "banner"), /^draft ENG-42 D24/m);
    assert.match(await ok("search", 'quote"d'), /no matches/);
  });

  test("gates and changed", async () => {
    await imported();
    assert.equal(await ok("gates"), "ENG-42 | GATE: waiting on design review");
    now = new Date("2026-11-16T01:00:00Z");
    await ok("log", "ENG-7", "started");
    assert.equal(await ok("changed", "--since", "today"), "ENG-7: 1 event(s)\n  2026-11-16 10:00 [log] started");
    assert.match((await hub("changed", "--since", "last week")).err, /--since takes/);
  });

  test("day returns the RESUME block of the plan, by date or the latest", async () => {
    await imported();
    const resume =
      "2026-11-13\nrev: 2026-11-13T05:20:00.000Z\nContinue ENG-42: write the migration for the sessions table.";
    assert.equal(await ok("day", "2026-11-13"), resume);
    now = new Date("2026-11-20T00:00:00Z");
    assert.equal(await ok("day"), resume);
  });

  test("day --full returns the whole plan, and the rev in JSON", async () => {
    stdin = "# Plan\n\n## RESUME\nstart with ENG-7\n\n## Later\n- other\n";
    await ok("day", "set", "2026-11-14", "--stdin");
    assert.equal(
      await ok("day", "2026-11-14", "--full"),
      "2026-11-14\nrev: 2026-11-13T05:20:00.000Z\n# Plan\n\n## RESUME\nstart with ENG-7\n\n## Later\n- other\n",
    );
    const row = await json<{ rev: string; body: string }>("day", "2026-11-14");
    assert.equal(row.rev, "2026-11-13T05:20:00.000Z");
  });

  test("day set refuses to replace a plan without the current rev", async () => {
    stdin = "## RESUME\nfirst";
    await ok("day", "set", "2026-11-14", "--stdin");
    now = new Date("2026-11-13T06:00:00Z");
    stdin = "## RESUME\nsecond";
    assert.equal(
      (await hub("day", "set", "2026-11-14", "--stdin")).err,
      "plan for 2026-11-14 already exists (rev 2026-11-13T05:20:00.000Z); read it with day 2026-11-14 (full), merge, then day_set with rev 2026-11-13T05:20:00.000Z",
    );
    assert.equal(
      (await hub("day", "set", "2026-11-14", "--stdin", "--rev", "2026-11-12T00:00:00.000Z")).err,
      "plan for 2026-11-14 changed since you read it (rev 2026-11-13T05:20:00.000Z, yours 2026-11-12T00:00:00.000Z); read it with day 2026-11-14 (full), merge, then retry with rev 2026-11-13T05:20:00.000Z",
    );
    assert.match(await ok("day", "2026-11-14"), /first$/);

    await ok("day", "set", "2026-11-14", "--stdin", "--rev", "2026-11-13T05:20:00.000Z");
    assert.equal(await ok("day", "2026-11-14"), "2026-11-14\nrev: 2026-11-13T06:00:00.000Z\nsecond");
    assert.match(
      (await hub("day", "set", "2026-11-14", "--stdin", "--rev", "2026-11-13T05:20:00.000Z")).err,
      /changed since you read it/,
    );
  });

  test("lint reports missing and oversize fields and exits 1", async () => {
    await imported();
    await ok("ticket-new", "NEW-audit", "Audit export usage");
    const result = await hub("lint");
    assert.equal(result.code, 1);
    assert.match(result.out, /ENG-42: status is 258 chars \(max 240\)/);
    assert.match(result.out, /NEW-audit: missing status/);
  });
});

describe("gates", () => {
  test("a gate answered yes or no is logged as a decision and cleared", async () => {
    await imported();
    await ok("set", "ENG-7", "gate", "merge PR #120?");
    assert.equal(await ok("gate", "ENG-7", "yes"), "ENG-7 gate answered yes");
    assert.match(await ok("events", "ENG-7", "-n", "1"), /\[decision\] Yes: merge PR #120\?$/);
    assert.equal(await ok("gates"), "ENG-42 | GATE: waiting on design review");
    assert.match((await hub("gate", "ENG-7", "yes")).err, /has no gate/);
  });
});

describe("config", () => {
  test("defaults on an empty DB, a valid write is stored, bad writes are refused", async () => {
    assert.equal(await ok("config", "timezone"), 'timezone = "Asia/Tokyo"');
    await ok("config", "limits", '{"next":300}');
    const limits = await json<Record<string, number>>("config", "limits");
    assert.equal(limits.next, 300);
    assert.equal(limits.status, 240);
    assert.match((await hub("config", "colour", '"red"')).err, /unknown config key colour/);
    assert.match((await hub("config", "timezone", "42")).err, /timezone takes a JSON string/);
    assert.match((await hub("config", "timezone", '"Mars/Base"')).err, /not an IANA time zone/);
    assert.match((await hub("config", "limits", '{"title":10}')).err, /limits.title is not a known key/);
    assert.match((await hub("config", "taskDirs", "[1]")).err, /array of strings/);
    await ok("config", "openLinearIn", '"app"');
    assert.match((await hub("config", "theme", '"pink"')).err, /theme must be one of system, light, dark/);
    assert.match((await hub("config", "notifyNew", '"yes"')).err, /notifyNew takes a JSON boolean/);
    assert.match(
      (await hub("config", "recordActions", '["deploy("]')).err,
      /recordActions has deploy\(, which is not a valid regular expression/,
    );
  });

  test("intervals take any duration in their range; the old choices stay valid", async () => {
    assert.equal(await ok("config", "syncEvery", '"45m"'), 'syncEvery = "45m"');
    assert.equal(await ok("config", "syncEvery", '"3h"'), 'syncEvery = "3h"');
    for (const bad of ['"0m"', '"9h"', '"soon"'])
      assert.match(
        (await hub("config", "syncEvery", bad)).err,
        /syncEvery takes a duration from 5m to 8h, e\.g\. 45m or 3h/,
      );
    assert.match((await hub("config", "fetchEvery", '"2h"')).err, /from 1m to 60m/);
    assert.match((await hub("config", "backupKeep", "0")).err, /backupKeep is a count from 1 to 100/);
    const old: [string, string][] = [
      ["syncEvery", "4h"],
      ["fetchEvery", "30m"],
      ["awayAfter", "5m"],
      ["awayEvery", "2h"],
      ["watchFor", "6h"],
      ["backupEvery", "7d"],
    ];
    for (const [key, value] of old) await ok("config", key, JSON.stringify(value));
    await ok("config", "backupKeep", "30");
  });
});

describe("intervals", () => {
  test("the slider steps are 5 min below 1 hour, 15 min to 4 hours, then hours, then days", () => {
    assert.deepEqual(ladder("fetchEvery").slice(0, 4), ["1m", "5m", "10m", "15m"]);
    assert.equal(ladder("fetchEvery").at(-1), "1h");
    assert.deepEqual(ladder("syncEvery").slice(11, 16), ["1h", "75m", "90m", "105m", "2h"]);
    assert.deepEqual(ladder("syncEvery").slice(-4), ["5h", "6h", "7h", "8h"]);
    assert.ok(ladder("syncEvery").includes("3h"));
    assert.deepEqual(ladder("backupEvery").slice(-3), ["5d", "6d", "7d"]);
    assert.equal(intervalText("45m"), "45 min");
    assert.equal(intervalText("75m"), "1 hour 15 min");
    assert.equal(intervalText("3h"), "3 hours");
    assert.equal(intervalText("1d"), "1 day");
  });
});

describe("record gate", () => {
  test("the Stop hook blocks on the database's recordActions, and never fails the stop", async () => {
    const path = join(dir, "session.jsonl");
    const use = (command: string) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    });
    writeFileSync(path, `${JSON.stringify(use("./deploy.sh prod"))}\n`);
    stdin = JSON.stringify({ hook_event_name: "Stop", transcript_path: path });
    assert.equal(await ok("record-gate", "--hook"), "");
    await ok("config", "recordActions", '["deploy\\\\.sh"]');
    assert.match(await ok("record-gate", "--hook"), /"decision":"block".*deploy\.sh prod/);
    stdin = "not json";
    assert.deepEqual(await hub("record-gate", "--hook"), { code: 0, out: "", err: "" });
  });
});

describe("record hook", () => {
  test("links the PR a push or PR command printed to the one ticket on the checkout's branch", async () => {
    await imported();
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "feat/limits", repo]);
    const pr = "https://github.com/acme/web/pull/150";
    const post = (command: string, stdout: string) =>
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, tool_response: { stdout, stderr: "" }, cwd: repo });

    stdin = post("gh pr create --fill", `${pr}\n`);
    assert.equal(await ok("record", "--hook"), "");
    await ok("set", "ENG-7", "branch", "feat/limits");
    stdin = post("gh pr view 150", `${pr}\n`);
    assert.equal(await ok("record", "--hook"), "");
    stdin = post("gh pr create --fill", `${pr}\n`);
    assert.match(
      await ok("record", "--hook"),
      /"additionalContext":"hub linked https:\/\/github.com\/acme\/web\/pull\/150 to ENG-7/,
    );
    assert.match(await ok("items", "--ticket", "ENG-7"), /pull\/150/);
    assert.equal(await ok("record", "--hook"), "");

    stdin = post("git push", "remote: https://github.com/acme/web/pull/151#issuecomment-1\n");
    await ok("set", "ENG-42", "branch", "feat/limits");
    assert.equal(await ok("record", "--hook"), "");
    stdin = "not json";
    assert.deepEqual(await hub("record", "--hook"), { code: 0, out: "", err: "" });
  });
});

describe("db", () => {
  test("a database from another schema version is refused when hub serve opens it", async () => {
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    db.close();
    assert.throws(
      () => serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] }),
      /has schema v1, this hub needs v31: move the file aside and re-import/,
    );
    server = await serve({ dbPath: join(dir, "other.db"), port: 0, now: () => now, env: {}, fetchers: [] });
  });
});

describe("schema upgrade", () => {
  test("a v2 database gains draft.send_at, the script table, ticket.position and item.ignored, source.warning, item.detached, script_source.enabled and section, item verdicts, item.body and item.detail, draft.item, draft.closed_item and draft.match_no, item.ask, draft.verdict and draft comments, draft.internal, item.avatar, the plan_line table, wait.reopened_at, the columns and tables only the fresh schema had, and ends with the fresh schema's columns, when hub serve opens it", async () => {
    await imported();
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(
      "ALTER TABLE ticket ADD COLUMN prs TEXT; ALTER TABLE ticket ADD COLUMN decide TEXT; ALTER TABLE draft DROP COLUMN send_at; DROP TABLE script_source; ALTER TABLE ticket DROP COLUMN position; ALTER TABLE item DROP COLUMN ignored; ALTER TABLE source DROP COLUMN warning; ALTER TABLE item DROP COLUMN detached; ALTER TABLE item DROP COLUMN judged_at; ALTER TABLE item DROP COLUMN away_ping; ALTER TABLE item DROP COLUMN away_why; ALTER TABLE item DROP COLUMN body; ALTER TABLE item DROP COLUMN detail; DROP INDEX draft_item; DROP INDEX draft_item_label; ALTER TABLE draft DROP COLUMN item; ALTER TABLE draft DROP COLUMN closed_item; ALTER TABLE draft DROP COLUMN match_no; ALTER TABLE item DROP COLUMN ask; ALTER TABLE item DROP COLUMN ask_answer; ALTER TABLE item DROP COLUMN ask_at; ALTER TABLE draft DROP COLUMN verdict; ALTER TABLE draft DROP COLUMN match_verdict; DROP TABLE draft_comment; ALTER TABLE draft DROP COLUMN internal; ALTER TABLE item DROP COLUMN avatar; DROP TABLE plan_line; ALTER TABLE wait DROP COLUMN reopened_at; ALTER TABLE wait DROP COLUMN pinged_at; ALTER TABLE item DROP COLUMN snoozed_until; ALTER TABLE draft DROP COLUMN match_text; ALTER TABLE draft DROP COLUMN match_ref; DROP TABLE step; DROP TABLE pin; UPDATE meta SET value = '2' WHERE key = 'schema_version'",
    );
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(
      sql<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value,
      SCHEMA_VERSION,
    );
    const columns = (db: DatabaseSync) =>
      db
        .prepare(
          "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY 1, 2",
        )
        .all()
        .map((row) => `${row.tbl}.${row.col}`);
    const upgraded = new DatabaseSync(dbFile);
    assert.deepEqual(columns(upgraded), columns(openDb(":memory:")));
    upgraded.close();
    assert.equal(
      sql<{ n: number }>("SELECT count(*) AS n FROM draft WHERE item IS NOT NULL OR internal != 0")[0]?.n,
      0,
    );
    assert.equal(
      sql<{ n: number }>(
        "SELECT count(*) AS n FROM item WHERE judged_at IS NOT NULL OR body IS NOT NULL OR detail IS NOT NULL",
      )[0]?.n,
      0,
    );
    assert.equal(
      sql<{ n: number }>("SELECT count(*) AS n FROM script_source WHERE enabled = 1 OR section IS NOT NULL")[0]?.n,
      0,
    );
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM item WHERE detached = 0")[0]?.n, EXPECTED.links);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM source WHERE warning IS NOT NULL")[0]?.n, 0);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM wait WHERE reopened_at IS NOT NULL")[0]?.n, 0);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM script_source")[0]?.n, 0);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM draft")[0]?.n, EXPECTED.drafts);
    await ok("draft", "ENG-7", "later", "--stdin", "--send-at", "tomorrow 12:00");
    assert.equal(await ok("order", "ENG-7", "1"), "ENG-7 is #1 in todo");
  });
});

describe("schema upgrade to v11", () => {
  test("ignored repos move into the GitHub searches as -repo: terms and ignoreRepos is gone", async () => {
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`ALTER TABLE ticket ADD COLUMN prs TEXT; ALTER TABLE ticket ADD COLUMN decide TEXT;
      INSERT INTO config(key, value) VALUES
      ('githubReviewQuery', '"is:pr is:open review-requested:@me"'),
      ('ignoreRepos', '{"review_request":["acme/noisy","acme/old"],"pr":["acme/web"]}');
      ALTER TABLE item DROP COLUMN judged_at; ALTER TABLE item DROP COLUMN away_ping; ALTER TABLE item DROP COLUMN away_why;
      ALTER TABLE item DROP COLUMN body; ALTER TABLE item DROP COLUMN detail; DROP INDEX draft_item; DROP INDEX draft_item_label;
      ALTER TABLE draft DROP COLUMN item; ALTER TABLE draft DROP COLUMN closed_item; ALTER TABLE draft DROP COLUMN match_no;
      ALTER TABLE item DROP COLUMN ask; ALTER TABLE item DROP COLUMN ask_answer; ALTER TABLE item DROP COLUMN ask_at;
      ALTER TABLE draft DROP COLUMN verdict; ALTER TABLE draft DROP COLUMN match_verdict; DROP TABLE draft_comment;
      ALTER TABLE draft DROP COLUMN internal; ALTER TABLE item DROP COLUMN avatar; DROP TABLE plan_line;
      ALTER TABLE wait DROP COLUMN reopened_at; UPDATE meta SET value = '10' WHERE key = 'schema_version'`);
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(
      await ok("config", "githubReviewQuery"),
      'githubReviewQuery = "is:pr is:open review-requested:@me -repo:acme/noisy -repo:acme/old"',
    );
    assert.equal(await ok("config", "githubPrQuery"), 'githubPrQuery = "is:pr author:@me -repo:acme/web"');
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM config WHERE key = 'ignoreRepos'")[0]?.n, 0);
  });
});

describe("schema upgrade to v20", () => {
  test("open review requests with no question get reviewAsk; closed, ignored and asked ones keep theirs", async () => {
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(
      "ALTER TABLE ticket ADD COLUMN prs TEXT; ALTER TABLE ticket ADD COLUMN decide TEXT; ALTER TABLE item DROP COLUMN avatar; DROP TABLE plan_line; ALTER TABLE wait DROP COLUMN reopened_at",
    );
    const insert = db.prepare(
      `INSERT INTO item(source, ref, kind, first_seen, changed_at, closed_at, ignored, ask)
       VALUES ('github', ?, ?, '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z', ?, ?, ?)`,
    );
    insert.run("open", "review_request", null, null, null);
    insert.run("closed", "review_request", "2026-11-20T01:00:00Z", null, null);
    insert.run("ignored", "review_request", "2026-11-20T01:00:00Z", "item", null);
    insert.run("asked", "review_request", null, null, "Approve as is?");
    insert.run("pr", "pr", null, null, null);
    db.exec("UPDATE meta SET value = '19' WHERE key = 'schema_version'");
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    const asks = Object.fromEntries(
      sql<{ ref: string; ask: string | null }>("SELECT ref, ask FROM item").map((r) => [r.ref, r.ask]),
    );
    assert.deepEqual(asks, {
      open: "Review this?",
      closed: null,
      ignored: null,
      asked: "Approve as is?",
      pr: null,
    });
  });
});

describe("schema upgrade to v25", () => {
  test("decide moves into an empty gate, else into the ticket log, and the column is gone", async () => {
    await imported();
    await ok("ticket-new", "ENG-9", "only decide");
    await ok("set", "ENG-7", "gate", "-");
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`ALTER TABLE ticket ADD COLUMN prs TEXT; ALTER TABLE ticket ADD COLUMN decide TEXT;
      UPDATE ticket SET decide = 'Cookie or header?' WHERE id = 'ENG-42';
      UPDATE ticket SET decide = 'Ship today?' WHERE id IN ('ENG-9', 'ENG-7');
      UPDATE meta SET value = '24' WHERE key = 'schema_version'`);
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    const gates = sql<{ id: string; gate: string | null }>("SELECT id, gate FROM ticket ORDER BY id");
    assert.deepEqual(gates, [
      { id: "ENG-42", gate: "waiting on design review" },
      { id: "ENG-7", gate: "Ship today?" },
      { id: "ENG-9", gate: "Ship today?" },
    ]);
    assert.match(await ok("events", "ENG-42"), /\[log\] decide \(removed\): Cookie or header\?/);
    assert.doesNotMatch(await ok("events", "ENG-9"), /decide \(removed\)/);
    assert.equal(
      sql<{ n: number }>("SELECT count(*) AS n FROM pragma_table_info('ticket') WHERE name = 'decide'")[0]?.n,
      0,
    );
    assert.match(await ok("search", "design"), /ticket ENG-42/);
  });
});

describe("schema upgrade to v26", () => {
  test("the prs text goes to the ticket log and the column is gone", async () => {
    await imported();
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`ALTER TABLE ticket ADD COLUMN prs TEXT;
      UPDATE ticket SET prs = 'core#38115 merged, world#10175 open' WHERE id = 'ENG-42';
      UPDATE ticket SET prs = '-' WHERE id = 'ENG-7';
      UPDATE meta SET value = '25' WHERE key = 'schema_version'`);
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.match(await ok("events", "ENG-42"), /\[log\] prs \(removed\): core#38115 merged, world#10175 open/);
    assert.doesNotMatch(await ok("events", "ENG-7"), /prs \(removed\)/);
    assert.equal(
      sql<{ n: number }>("SELECT count(*) AS n FROM pragma_table_info('ticket') WHERE name = 'prs'")[0]?.n,
      0,
    );
    assert.doesNotMatch(await ok("ticket", "ENG-42"), /^prs:/m);
  });
});

describe("schema upgrade to v30", () => {
  const downgrade = async (setup: string) => {
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`${setup}; UPDATE meta SET value = '29' WHERE key = 'schema_version'`);
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
  };

  test("the bare slack source becomes a workspace named by its Slack address, with its cursor and switch", async () => {
    await imported();
    await downgrade(`INSERT INTO config(key, value, updated_at) VALUES
        ('fetch', '{"github":true,"linear":false,"slack":true,"slack-zuno8":true}', '2026-11-20T00:00:00Z'),
        ('slackWorkspaces', '["zuno8"]', '2026-11-20T00:00:00Z');
      INSERT INTO meta(key, value) VALUES ('slack-team:up-sider.slack.com', 'T01'), ('slack-team:zuno8.slack.com', 'T02');
      INSERT INTO source(name, cursor, last_sync) VALUES ('slack', '1795700000.000100', '2026-11-27T00:00:00Z')`);
    assert.equal(await ok("config", "slackWorkspaces"), 'slackWorkspaces = ["up-sider","zuno8"]');
    assert.equal(
      await ok("config", "fetch"),
      'fetch = {"github":true,"linear":false,"slack-zuno8":true,"slack-up-sider":true}',
    );
    assert.match(await ok("sources"), /^slack-up-sider \| last sync .* \| cursor 1795700000\.000100$/m);
    assert.doesNotMatch(await ok("sources"), /^slack \|/m);
  });

  test("a bare slack source that never fetched is dropped; Settings asks for a workspace", async () => {
    await imported();
    await downgrade(`INSERT INTO config(key, value, updated_at) VALUES
        ('fetch', '{"github":true,"linear":false,"slack":true}', '2026-11-20T00:00:00Z')`);
    assert.equal(await ok("config", "slackWorkspaces"), "slackWorkspaces = []");
    assert.equal(await ok("config", "fetch"), 'fetch = {"github":true,"linear":false}');
  });
});

describe("order", () => {
  const backlog = async () =>
    (await json<Record<string, { id: string; position: number | null }[]>>("board")).backlog?.map(
      (t) => `${t.id}:${t.position ?? "-"}`,
    );

  beforeEach(async () => {
    for (const [i, id] of ["ENG-101", "ENG-102", "ENG-103"].entries()) {
      now = new Date(NOW.getTime() + i * 60_000);
      await ok("ticket-new", id, `ticket ${id}`, "--dir", "backlog");
    }
  });

  test("a ticket goes to a place in its folder and the tickets above it keep their places", async () => {
    assert.deepEqual(await backlog(), ["ENG-103:-", "ENG-102:-", "ENG-101:-"]);
    assert.equal(await ok("order", "ENG-101", "1"), "ENG-101 is #1 in backlog");
    assert.deepEqual(await backlog(), ["ENG-101:1", "ENG-103:-", "ENG-102:-"]);
    await ok("order", "ENG-102", "2");
    assert.deepEqual(await backlog(), ["ENG-101:1", "ENG-102:2", "ENG-103:-"]);
    await ok("order", "ENG-103", "1");
    assert.deepEqual(await backlog(), ["ENG-103:1", "ENG-101:2", "ENG-102:3"]);
    assert.match(await ok("board"), /\[-\] #1 ENG-103 \|/);
    assert.match(await ok("ticket", "ENG-103"), /\| order: 1$/m);
  });

  test("a place past the end is the last place, and taking one out closes up the rest", async () => {
    await ok("order", "ENG-103", "1");
    await ok("order", "ENG-101", "2");
    assert.equal(await ok("order", "ENG-103", "9"), "ENG-103 is #3 in backlog");
    assert.deepEqual(await backlog(), ["ENG-101:1", "ENG-102:2", "ENG-103:3"]);
    assert.equal(await ok("order", "ENG-101", "-"), "ENG-101 taken out of the order");
    assert.deepEqual(await backlog(), ["ENG-102:1", "ENG-103:2", "ENG-101:-"]);
  });

  test("moving to another folder drops the place, and next follows the order", async () => {
    await ok("order", "ENG-101", "1");
    await ok("move", "ENG-101", "todo");
    await ok("move", "ENG-102", "todo");
    assert.equal(
      sql<{ position: number | null }>("SELECT position FROM ticket WHERE id = 'ENG-101'")[0]?.position,
      null,
    );
    await ok("order", "ENG-101", "1");
    await ok("move", "ENG-101", "todo");
    const next = await json<{ id: string; order: number | null }[]>("next");
    assert.deepEqual(
      next.map((t) => `${t.id}:${t.order ?? "-"}`),
      ["ENG-101:1", "ENG-102:-"],
    );
  });

  test("a place is a whole number from 1, or - to drop it", async () => {
    assert.match((await hub("order", "ENG-101", "0")).err, /usage: hub order <id> <place \| ->/);
    assert.match((await hub("order", "ENG-101", "first")).err, /usage: hub order/);
    assert.match((await hub("order", "ENG-404", "1")).err, /ENG-404/);
  });
});

describe("send at", () => {
  test("a draft's send time takes a duration, tomorrow, a clock time or a date and time", async () => {
    await imported();
    const send = async (when: string) => {
      stdin = "text";
      return ok("draft", "ENG-7", "x", "--stdin", "--send-at", when);
    };
    assert.match(await send("4h"), /send at 2026-11-13 18:20$/);
    assert.match(await send("tomorrow"), /send at 2026-11-14 09:00$/);
    assert.match(await send("tomorrow 12:00"), /send at 2026-11-14 12:00$/);
    assert.match(await send("15:00"), /send at 2026-11-13 15:00$/);
    assert.match(await send("12:00"), /send at 2026-11-14 12:00$/);
    assert.match(await send("2026-11-20 09:30"), /send at 2026-11-20 09:30$/);
    assert.match((await hub("draft", "ENG-7", "x", "--stdin", "--send-at", "noon")).err, /send_at takes 30m, 4h/);
    assert.match((await hub("draft", "ENG-7", "x", "--stdin", "--send-at", "25:00")).err, /no time 25:00/);
    assert.match(await ok("draft-later", "ENG-7", "x", "--for", "tomorrow 08:00"), /send at 2026-11-14 08:00$/);
    assert.match(await ok("brief"), /ENG-7 \| x \| - \| send 2026-11-14 08:00 \| text/);
    stdin = "";
    await ok("draft", "ENG-7", "x", "--stdin");
    assert.doesNotMatch(await ok("brief"), /send 2026/);
  });
});

describe("drafts on items", () => {
  const review = "https://github.com/acme/web/pull/131";
  const request = async () => {
    stdin = JSON.stringify({
      source: "github",
      kind: "review_request",
      url: review,
      title: "Cap exports",
      state: "open",
      needs_me: true,
    });
    await ok("item", "put", "--stdin");
  };

  test("a draft on an item needs no ticket, and Sent closes its review request until Not sent", async () => {
    await imported();
    await request();
    stdin = "LGTM, one nit on the limit.";
    assert.equal(await ok("draft", `${review}/#discussion`, "review", "--stdin"), `${review} draft "review" saved`);
    assert.deepEqual(sql("SELECT ticket_id, item FROM draft WHERE label = 'review'"), [
      { ticket_id: null, item: review },
    ]);
    assert.match(await ok("drafts"), new RegExp(`^${review} \\| review \\| LGTM`, "m"));
    assert.equal(await ok("drafts", review), "review | draft");
    assert.match(await ok("brief"), new RegExp(`${review} \\| review \\| - \\| LGTM`));

    await ok("posted", review, "review");
    assert.equal(await ok("items", "--needs-me"), "no items");
    await ok("unposted", review, "review");
    assert.match(await ok("items", "--needs-me"), /Cap exports/);

    await ok("item", "close", review);
    await ok("posted", review, "review");
    await ok("unposted", review, "review");
    assert.equal(await ok("items", "--needs-me"), "no items");

    await ok("draft-mv", review, "review", "review 2");
    assert.equal(await ok("draft-rm", review, "review 2"), `${review} draft "review 2" removed`);
    assert.match((await hub("draft", "not-a-ticket", "x", "--stdin")).err, /no ticket not-a-ticket/);
  });

  test("a ticket draft keeps its item until cleared, and the item finds it unless two drafts share a label", async () => {
    await imported();
    await request();
    stdin = "Approve once the limit is configurable.";
    await ok("draft", "ENG-7", "review", "--stdin", "--item", review);
    assert.equal(await ok("drafts", "ENG-7"), `review | draft | ${review}`);
    assert.match(await ok("brief"), new RegExp(`ENG-7 \\| review \\| - \\| for ${review} \\|`));
    await ok("draft", "ENG-7", "review", "--stdin");
    assert.equal(await ok("drafts", review), "review | draft | ENG-7");

    await ok("draft", review, "review", "--stdin");
    assert.equal(await ok("drafts", review), "review | draft | ENG-7");

    await ok("draft", review, "nit", "--stdin");
    await ok("draft", "ENG-7", "nit", "--stdin", "--item", review);
    assert.match((await hub("posted", review, "nit")).err, /2 drafts "nit" on .*: name the ticket \(.*ENG-7/);
    await ok("posted", "ENG-7", "review");
    assert.equal(await ok("items", "--needs-me"), "no items");
    await ok("draft-rm", "ENG-7", "nit");
    assert.match(
      (await hub("draft", review, "nit", "--stdin", "--item", "")).err,
      /has no ticket, so it keeps its item/,
    );

    await ok("draft", "ENG-7", "review", "--stdin", "--item", "");
    assert.equal(await ok("drafts", "ENG-7"), "review | draft");
  });
});

describe("review drafts", () => {
  test("a review draft keeps a verdict and file:line comments until replaced, and they go with the draft", async () => {
    await imported();
    const pr = "https://github.com/acme/web/pull/133";
    const file = join(dir, "comments.json");
    writeFileSync(
      file,
      JSON.stringify([
        { path: "src/limit.ts", line: 12, body: "Make the limit configurable." },
        { path: "src/limit.test.ts", line: 3, body: "Test the edge." },
      ]),
    );
    stdin = "Close, two things.";
    await ok("draft", pr, "review", "--stdin", "--verdict", "request_changes", "--comments", file);
    assert.equal(
      await ok("draft-show", pr, "review"),
      "Close, two things.\n\nverdict: request_changes\nsrc/limit.ts:12 Make the limit configurable.\nsrc/limit.test.ts:3 Test the edge.",
    );
    assert.equal(await ok("drafts", pr), "review | draft | request_changes, 2 comments");
    assert.match(await ok("brief"), /\| review \| - \| request_changes \| 2 comments \| Close, two things\./);

    stdin = "Close, one thing.";
    await ok("draft", pr, "review", "--stdin");
    assert.equal(await ok("drafts", pr), "review | draft | request_changes, 2 comments");
    writeFileSync(file, "[]");
    await ok("draft", pr, "review", "--stdin", "--comments", file, "--verdict", "approve");
    assert.equal(await ok("drafts", pr), "review | draft | approve");
    await ok("draft", pr, "review", "--stdin", "--verdict", "");
    assert.equal(await ok("drafts", pr), "review | draft");

    assert.match((await hub("draft", pr, "review", "--stdin", "--verdict", "lgtm")).err, /verdict must be one of/);
    writeFileSync(file, JSON.stringify([{ path: "a.ts", line: 0, body: "x" }]));
    assert.match(
      (await hub("draft", pr, "review", "--stdin", "--comments", file)).err,
      /comment 1: line is a positive/,
    );
    writeFileSync(file, "not json");
    assert.match((await hub("draft", pr, "review", "--stdin", "--comments", file)).err, /is not JSON/);

    writeFileSync(file, JSON.stringify([{ path: "a.ts", line: 1, body: "x" }]));
    await ok("draft", pr, "review", "--stdin", "--comments", file);
    await ok("draft", "ENG-7", "review", "--stdin", "--comments", file);
    await ok("draft-rm", pr, "review");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM draft_comment")[0]?.n, 1);
    await ok("ticket-delete", "ENG-7");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM draft_comment")[0]?.n, 0);
  });
});

describe("item questions", () => {
  test("the agent asks, the human answers yes or no, and both show on the item", async () => {
    await imported();
    const pr = "https://github.com/acme/web/pull/132";
    stdin = JSON.stringify({
      source: "github",
      kind: "review_request",
      url: pr,
      title: "Retry webhooks",
      needs_me: true,
    });
    await ok("item", "put", "--stdin");
    assert.equal(await ok("item", "ask", pr, "Review", "this?"), "#3 asks: Review this?");
    assert.match(await ok("items", "--needs-me"), /\| ask: Review this\? \(no answer yet\)$/);
    assert.match(await ok("brief"), /Retry webhooks .*\| ask: Review this\? \(no answer yet\)/);
    assert.equal(await ok("item", "answer", pr, "yes"), "#3 Review this? yes");
    assert.match(await ok("items", "--needs-me"), /\| ask: Review this\? yes$/);
    assert.match((await hub("item", "answer", pr, "maybe")).err, /answer must be yes or no/);
    assert.equal(await ok("item", "unanswer", pr), "#3 asks again: Review this?");
    assert.match((await hub("item", "unanswer", pr)).err, /has no answer/);
    assert.match((await hub("item", "ask", pr, "x".repeat(201))).err, /one line of at most 200/);
    assert.equal(await ok("item", "ask", pr, ""), "#3 has no question");
    assert.match((await hub("item", "answer", pr, "no")).err, /has no question/);
  });
});

describe("brief for judging", () => {
  test("brief names what hub fetches itself and lists the user's sent messages to judge, apart from tracked", async () => {
    await imported();
    await ok("slack", "add", "acme");
    await ok("slack", "add", "beta");
    stdin = [
      '{"source":"slack","kind":"message","url":"https://acme.slack.com/archives/C1/p1763350000000100","title":"#web khai: shipped it","author":"me","state":"sent"}',
      '{"source":"slack","kind":"message","url":"https://acme.slack.com/archives/C1/p1763350000000200","title":"#ops ana: on call?","state":"mention","needs_me":true}',
    ].join("\n");
    await ok("item", "put", "--stdin");
    const brief = await ok("brief");
    assert.match(brief, /^hub fetches itself, do not read: github, slack\n/);
    assert.match(
      brief,
      /to judge, the user's sent messages:\n {2}#\d+ \| #web khai: shipped it \| https:\/\/acme\.slack\.com\/archives\/C1\/p1763350000000100/,
    );
    const tracked = brief.slice(brief.indexOf("tracked:"));
    assert.doesNotMatch(tracked, /shipped it/);
    assert.match(tracked, /on call\?/);
    stdin = "shipped it";
    await ok("draft", "ENG-7", "tell web", "--stdin");
    await ok("posted", "ENG-7", "tell web", "--ref", "https://acme.slack.com/archives/C1/p1763350000000100", "--stdin");
    assert.match(await ok("brief"), /to judge, the user's sent messages: none/);
    assert.match(await ok("items", "--all", "--source", "slack"), /shipped it \| sent \| https:\S+ \| closed/);
  });
});

describe("review question", () => {
  const put = (url: string, extra: object = {}) => {
    stdin = JSON.stringify({ source: "github", kind: "review_request", url, state: "open", needs_me: true, ...extra });
    return ok("item", "put", "--stdin");
  };

  test("a fetch never overwrites an agent's question or the human's answer", async () => {
    await imported();
    const own = "https://github.com/acme/web/pull/140";
    const answered = "https://github.com/acme/web/pull/141";
    await put(own);
    await put(answered);
    await ok("item", "ask", own, "Approve", "as", "is?");
    await ok("item", "answer", answered, "yes");
    await put(own, { title: "renamed" });
    await put(answered, { title: "renamed too" });
    const needs = await ok("items", "--needs-me");
    assert.match(needs, /pull\/140 \| ask: Approve as is\? \(no answer yet\)$/m);
    assert.match(needs, /pull\/141 \| ask: Review this\? yes$/m);
  });

  test("No to reviewAsk closes the item and unanswer reopens it; No to another question does not close", async () => {
    await imported();
    const pr = "https://github.com/acme/web/pull/142";
    const other = "https://github.com/acme/web/pull/143";
    await put(pr);
    await put(other);
    await ok("item", "ask", other, "Approve", "as", "is?");
    await ok("item", "answer", pr, "no");
    await ok("item", "answer", other, "no");
    assert.doesNotMatch(await ok("items", "--needs-me"), /pull\/142/);
    assert.match(await ok("items", "--needs-me"), /pull\/143 \| ask: Approve as is\? no$/m);
    assert.match(await ok("items", "--all"), /pull\/142 \| ask: Review this\? no \| closed$/m);
    await ok("item", "unanswer", pr);
    assert.match(await ok("items", "--needs-me"), /pull\/142 \| ask: Review this\? \(no answer yet\)$/m);

    await ok("item", "close", pr);
    now = new Date(now.getTime() + 60_000);
    await ok("item", "answer", pr, "no");
    await ok("item", "unanswer", pr);
    assert.match(await ok("items", "--all"), /pull\/142 \| ask: Review this\? \(no answer yet\) \| closed$/m);
  });

  test("the review question is fixed: reviewAsk is no longer a config key", async () => {
    assert.match((await hub("config", "reviewAsk", '"Look at this?"')).err, /unknown config key reviewAsk/);
  });

  test("v28: review requests that asked the old configured question still close on No", async () => {
    await imported();
    const pr = "https://github.com/acme/web/pull/150";
    const other = "https://github.com/acme/web/pull/151";
    await put(pr);
    await put(other);
    await ok("item", "ask", other, "Approve", "as", "is?");
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(`ALTER TABLE item DROP COLUMN review_ask;
UPDATE item SET ask = 'Look at this?' WHERE ref = '${pr}';
INSERT INTO config(key, value, updated_at) VALUES ('reviewAsk', '"Look at this?"', '2026-11-20T00:00:00Z');
UPDATE meta SET value = '27' WHERE key = 'schema_version'`);
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM config WHERE key = 'reviewAsk'")[0]?.n, 0);
    await ok("item", "answer", pr, "no");
    await ok("item", "answer", other, "no");
    assert.match(await ok("items", "--all"), /pull\/150 \| ask: Look at this\? no \| closed$/m);
    assert.match(await ok("items", "--needs-me"), /pull\/151 \| ask: Approve as is\? no$/m);
  });
});

describe("alert folding", () => {
  const minutes = (n: number) => {
    now = new Date(now.getTime() + n * 60_000);
  };
  const alert = (
    n: number,
    title = "#tech_alert_critical · Cloudflare: SSL alert [PCI]: certificate 6bb63dcf updated",
  ) =>
    JSON.stringify({
      source: "slack",
      kind: "alert",
      url: `https://acme.slack.com/archives/C9/p17957500000${String(n).padStart(5, "0")}`,
      title,
      body: title,
      state: "alert",
      needs_me: true,
    });
  const alerts = async () => (await ok("items", "--needs-me", "--source", "slack")).split("\n").filter((l) => l !== "");

  test("identical alerts within an hour are one row with a count; a re-fetch does not count twice", async () => {
    await imported();
    await ok("moved", "--as", "s1", "--start");
    stdin = [1, 2, 3, 4, 5, 6, 7].map((n) => alert(n)).join("\n");
    assert.equal(await ok("item", "put", "--stdin"), "items: 1 new, 6 changed, 0 unchanged");
    stdin = alert(7);
    assert.equal(await ok("item", "put", "--stdin"), "items: 0 new, 0 changed, 1 unchanged");
    assert.equal((await alerts()).length, 1);
    minutes(1);
    const moved = await ok("moved", "--as", "s1");
    assert.equal(moved.split("\n").filter((l) => l.includes("SSL alert")).length, 1);
    assert.match(moved, /SSL alert .* ×7 \(alert\)/);
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(home, /×7, last \d{2}:\d{2}/);
    assert.match(home, /p1795750000000007/);
  });

  test("two hours apart, another text, or after the row is closed: a new row", async () => {
    await imported();
    stdin = alert(1);
    await ok("item", "put", "--stdin");
    minutes(120);
    stdin = alert(2);
    await ok("item", "put", "--stdin");
    stdin = alert(3, "#tech_alert_critical · Cloudflare: SSL alert [PCI]: certificate 9aa11b00 updated");
    await ok("item", "put", "--stdin");
    assert.equal((await alerts()).length, 3);
    for (const id of (await alerts()).map((l) => l.split(" ")[0]?.slice(1) ?? "")) await ok("item", "close", id);
    stdin = alert(4);
    await ok("item", "put", "--stdin");
    assert.equal((await alerts()).length, 1);
  });
});

describe("moved", () => {
  const later = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000);
  };

  test("session start counts what needs you; later looks list only what moved since the last one", async () => {
    await imported();
    assert.equal(await ok("moved", "--as", "s1", "--start"), "");
    stdin = [
      '{"source":"github","kind":"review_request","url":"https://github.com/acme/web/pull/7","title":"Fix login","needs_me":true}',
      '{"source":"grafana","kind":"alert","ref":"a-1","title":"5xx","needs_me":true}',
    ].join("\n");
    await ok("item", "put", "--stdin");
    later(1);
    assert.equal(
      await ok("moved", "--as", "s2", "--start"),
      "hub: 2 need you: 1 review request, 1 alert. The hub brief tool has the details.",
    );
    later(1);
    assert.equal(await ok("moved", "--as", "s2"), "");
    later(1);
    stdin =
      '{"source":"slack","kind":"message","url":"https://acme.slack.com/archives/C1/p1763350000123456","title":"ana: on call?","state":"mention","needs_me":true}';
    await ok("item", "put", "--stdin");
    await ok("wait", "ENG-42", "Ken", "https://acme.slack.com/archives/C1/p1763340000000100");
    await ok("wait", "close", "https://acme.slack.com/archives/C1/p1763340000000100");
    later(1);
    assert.equal(
      await ok("moved", "--as", "s2"),
      ["hub, since your last prompt:", "  Message: ana: on call? (mention)", "  answered: Ken on ENG-42"].join("\n"),
    );
    later(1);
    assert.equal(await ok("moved", "--as", "s2"), "");
    stdin =
      '{"source":"slack","kind":"message","url":"https://acme.slack.com/archives/C1/p1763350000123456","state":"replied","needs_me":false}';
    await ok("item", "put", "--stdin");
    later(1);
    assert.equal(
      await ok("moved", "--as", "s2"),
      ["hub, since your last prompt:", "  replied: ana: on call?"].join("\n"),
    );
    assert.match(await ok("moved", "--as", "s1"), /Review request: Fix login[\s\S]*replied: ana: on call\?/);
    assert.match((await hub("moved", "--as", "bad id!")).err, /agent must be a session id/);
  });

  test("the hook reads the session from stdin, and stays silent on bad input or with hub down", async () => {
    await imported();
    stdin = '{"source":"grafana","kind":"alert","ref":"a-1","title":"5xx","needs_me":true}';
    await ok("item", "put", "--stdin");
    later(1);
    stdin = JSON.stringify({ session_id: "abc-1", hook_event_name: "SessionStart" });
    assert.equal(await ok("moved", "--hook"), "hub: 1 need you: 1 alert. The hub brief tool has the details.");
    later(1);
    stdin = JSON.stringify({ session_id: "abc-1", hook_event_name: "UserPromptSubmit", prompt: "go" });
    const quiet = await hub("moved", "--hook");
    assert.deepEqual([quiet.code, quiet.out, quiet.err], [0, "", ""]);
    stdin = "not json";
    assert.deepEqual(await hub("moved", "--hook"), { code: 0, out: "", err: "" });
    await server.close();
    stdin = JSON.stringify({ session_id: "abc-1", hook_event_name: "UserPromptSubmit" });
    assert.deepEqual(await hub("moved", "--hook"), { code: 0, out: "", err: "" });
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
  });
});

describe("client", () => {
  test("with no hub running the CLI says how to start one", async () => {
    const url = server.url;
    await server.close();
    server = await serve({ dbPath: join(dir, "other.db"), port: 0, now: () => now, env: {}, fetchers: [] });
    const errors: string[] = [];
    const io: Io = {
      stdout: () => {},
      stderr: (t) => errors.push(t),
      readStdin: () => "",
      env: { HUB_DB: dbFile, HUB_URL: url },
      now: () => now,
    };
    assert.equal(await run(["board"], io), 1);
    assert.match(
      errors[0] ?? "",
      /^hub is not running at http:\/\/127\.0\.0\.1:\d+: hub service install, or hub serve$/,
    );
  });

  test("a CLI pointed at another database than the hub serves is refused", async () => {
    const errors: string[] = [];
    const io: Io = {
      stdout: () => {},
      stderr: (t) => errors.push(t),
      readStdin: () => "",
      env: { HUB_DB: join(dir, "elsewhere.db"), HUB_URL: server.url },
      now: () => now,
    };
    assert.equal(await run(["board"], io), 1);
    assert.match(errors[0] ?? "", /serves .*hub\.db, not .*elsewhere\.db: point HUB_DB or --db at it/);
  });

  test("mcp-headers prints the bearer header from the token next to the database", async () => {
    const token = readFileSync(join(dir, "token"), "utf8").trim();
    assert.deepEqual(JSON.parse(await ok("mcp-headers")), { Authorization: `Bearer ${token}` });
  });

  test("syncCommand is written from the terminal straight to the database", async () => {
    assert.match(await ok("config", "syncCommand", '["true"]'), /^syncCommand = \["true"\]$/);
    assert.equal(await ok("config", "syncCommand"), 'syncCommand = ["true"]');
  });
});

describe("cli", () => {
  test("unknown command prints usage and exits 2", async () => {
    const result = await hub("frobnicate");
    assert.equal(result.code, 2);
    assert.match(result.err, /^usage: hub/);
    assert.equal((await hub("board", "--nope")).code, 2);
  });
});

describe("plan lines", () => {
  const DAY = "2026-11-13";
  const PR = "https://github.com/acme/web/pull/71";
  const REVIEW = "https://github.com/acme/web/pull/80";
  const THREAD = "https://acme.slack.com/archives/C1/p1";

  async function lines(date = DAY): Promise<string> {
    return ((await ok("day", date)).split(`## Today\n`)[1] ?? "").split("\n\n## From hub")[0] ?? "";
  }

  async function put(item: Record<string, unknown>): Promise<void> {
    stdin = JSON.stringify({ source: "github", kind: "pr", title: "pr", state: "open", ...item });
    await ok("item", "put", "--stdin");
  }

  beforeEach(async () => {
    await imported();
  });

  test("a step line ticks on step done and keeps its step when steps renumber", async () => {
    await ok("step", "add", "ENG-42", "write the migration");
    await ok("plan", "add", "ENG-42 migration", "--ref", "step:ENG-42#1", "--time", "16:00");
    await ok("step", "add", "ENG-42", "read the handler", "--at", "1");
    assert.equal(await lines(), "- [ ] 1. 16:00 ENG-42 migration (ENG-42 step 2: open)");
    now = new Date("2026-11-13T07:12:00Z");
    await ok("step", "done", "ENG-42", "2");
    assert.equal(await lines(), "- [x] 1. 16:00 ENG-42 migration (ENG-42 step 2, 16:12)");
  });

  test("a draft line stays open while a match is pending and ticks when posted", async () => {
    stdin = "can we ship?";
    await ok("draft", "ENG-7", "ask-qa", "--stdin");
    await ok("plan", "add", "ask QA", "--ref", "draft:ENG-7/ask-qa");
    stdin = "can we ship on Friday?";
    await ok("match", "ENG-7", "ask-qa", "--ref", THREAD, "--stdin");
    assert.equal(await lines(), "- [ ] 1. ask QA (draft ask-qa: sent?)");
    await ok("match", "ENG-7", "ask-qa", "yes");
    assert.match(await lines(), /^- \[x\] 1\. ask QA \(draft ask-qa, sent 14:20\)$/);
  });

  test("an item line ticks on merge, on item close, and when a review request is done", async () => {
    await put({ url: PR });
    await put({ url: REVIEW, kind: "review_request", needs_me: true });
    await ok("plan", "add", "merge my PR", "--ref", PR);
    await ok("plan", "add", "review", "--ref", `item:${REVIEW}`);
    await ok("plan", "add", "close it", "--ref", "item:1");
    await put({ url: PR, state: "merged" });
    await put({ url: REVIEW, kind: "review_request", state: "done" });
    const shown = await lines();
    assert.match(shown, /^- \[x\] 1\. merge my PR \(acme\/web#71, merged 14:20\)$/m);
    assert.match(shown, /^- \[x\] 2\. review \(acme\/web#80, 14:20\)$/m);
    await ok("plan", "edit", "3", "--ref", `item:${REVIEW}`);
    await ok("item", "reopen", REVIEW);
    await ok("item", "close", REVIEW);
    assert.match(await lines(), /^- \[x\] 3\. close it/m);
  });

  test("wait and gate lines tick when the wait closes and when the engineer answers the gate", async () => {
    await ok("wait", "ENG-7", "ana", THREAD, "--ping-after", "1d");
    await ok("set", "ENG-42", "gate", "merge the migration?");
    await ok("plan", "add", "hear from ana", "--ref", "wait:1");
    await ok("plan", "add", "migration go", "--ref", "gate:ENG-42");
    assert.equal(
      await lines(),
      "- [ ] 1. hear from ana (wait ana: ping 11-14 14:20)\n- [ ] 2. migration go (gate ENG-42: open)",
    );
    await ok("wait", "close", "1");
    await ok("gate", "ENG-42", "yes");
    assert.equal(
      await lines(),
      "- [x] 1. hear from ana (wait ana, answered 14:20)\n- [x] 2. migration go (gate ENG-42: yes)",
    );
  });

  test("a line with several refs ticks only when all are done", async () => {
    await ok("step", "add", "ENG-7", "fix");
    await ok("plan", "add", "fix and close", "--ref", "step:ENG-7#1 ticket:ENG-7");
    await ok("step", "done", "ENG-7", "1");
    assert.match(await lines(), /^- \[ \] 1\. fix and close \(ENG-7 step 1, 14:20 · ENG-7: todo\)$/);
    await ok("move", "ENG-7", "done");
    assert.match(await lines(), /^- \[x\] 1\./);
  });

  test("plan done ticks a line without refs and is refused on a ref line, naming the real action", async () => {
    await ok("step", "add", "ENG-42", "write the migration");
    await ok("plan", "add", "lunch with the team");
    await ok("plan", "add", "migration", "--ref", "step:ENG-42#1");
    assert.match(await ok("plan", "done", "1"), /^2026-11-13 line 1 done: \[x\] 1\. lunch with the team \(14:20\)$/);
    assert.equal(
      (await hub("plan", "done", "2")).err,
      "plan line done works only on a line without refs; this one ticks from its refs: step_done ENG-42 1",
    );
    await ok("plan", "undo", "1");
    assert.match(await lines(), /^- \[ \] 1\. lunch with the team$/m);
  });

  test("an unknown ref is refused; a text naming a ticket without a ref warns", async () => {
    assert.match((await hub("plan", "add", "x", "--ref", "step:ENG-42#9")).err, /no step 9 on ENG-42/);
    assert.match((await hub("plan", "add", "x", "--ref", "wait:4")).err, /no wait 4/);
    assert.match((await hub("plan", "add", "x", "--ref", "pr:4")).err, /ref kind pr is not one of/);
    assert.match((await hub("plan", "add", "x", "--ref", "draft:ENG-7/nope")).err, /no draft ENG-7\/nope/);
    assert.match(await ok("plan", "add", "ship ENG-7"), /warning: the text names ENG-7 but the line has no ref/);
    assert.doesNotMatch(await ok("plan", "add", "ship ENG-7", "--ref", "ticket:ENG-7"), /warning/);
  });

  test("the first day set of a date carries open lines, skips done and dropped ones, and Today tasks are refused", async () => {
    await ok("plan", "add", "carry me", "--time", "09:00");
    await ok("plan", "add", "done today");
    await ok("plan", "add", "not happening");
    await ok("plan", "done", "2");
    await ok("plan", "drop", "3", "QA moved it to next week");
    assert.match(await lines(), /^- ~~3\. not happening~~ \(dropped: QA moved it to next week\)$/m);
    now = new Date("2026-11-16T00:00:00Z");
    stdin = "## Today\n\n- [ ] ship it\n";
    assert.match((await hub("day", "set", "2026-11-16", "--stdin")).err, /## Today has task lines: .*use plan_add/);
    stdin = "## RESUME\nstart\n\n## Today\n";
    const saved = await ok("day", "set", "2026-11-16", "--stdin");
    assert.match(
      saved,
      /carried over \(plan_drop or plan_edit each that no longer holds\):\n- \[ \] 1\. 09:00 carry me · carried from 11-13$/,
    );
    assert.equal(
      await ok("day", "2026-11-16", "--full"),
      "2026-11-16\nrev: 2026-11-16T00:00:00.000Z\n## RESUME\nstart\n\n## Today\n- [ ] 1. 09:00 carry me · carried from 11-13\n",
    );
    stdin = "## RESUME\nstart\n\n## From hub\n- pr acme/web#71: open\n";
    assert.match(
      (await hub("day", "set", "2026-11-16", "--stdin", "--rev", "2026-11-16T00:00:00.000Z")).err,
      /## From hub is generated by day from the cards: leave it out of the body/,
    );
    stdin = "## RESUME\nstart\n\n## Today\n";
    await ok("day", "set", "2026-11-16", "--stdin", "--rev", "2026-11-16T00:00:00.000Z");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM plan_line WHERE date = '2026-11-16'")[0]?.n, 1);
  });

  test("two sessions adding lines at once keep both, with no rev", async () => {
    await Promise.all([ok("plan", "add", "one"), ok("plan", "add", "two")]);
    assert.deepEqual(
      sql<{ text: string; pos: number }>("SELECT text, pos FROM plan_line ORDER BY pos").map((l) => l.pos),
      [1, 2],
    );
  });

  test("a past day shows a line done only if its ref was done by the end of that day", async () => {
    await ok("step", "add", "ENG-42", "a");
    await ok("step", "add", "ENG-42", "b");
    await ok("plan", "add", "a", "--ref", "step:ENG-42#1");
    await ok("plan", "add", "b", "--ref", "step:ENG-42#2");
    now = new Date("2026-11-13T10:00:00Z");
    await ok("step", "done", "ENG-42", "1");
    now = new Date("2026-11-13T16:00:00Z");
    await ok("step", "done", "ENG-42", "2");
    assert.match(await lines(), /^- \[x\] 1\. a \(ENG-42 step 1, 19:00\)\n- \[ \] 2\. b \(ENG-42 step 2: open\)$/);
  });

  test("move, edit and drop undo work by line number", async () => {
    await ok("plan", "add", "one");
    await ok("plan", "add", "two");
    await ok("plan", "add", "zero", "--at", "1");
    await ok("plan", "move", "3", "1");
    await ok("plan", "edit", "2", "nil", "--time", "08:30");
    await ok("plan", "drop", "3", "no time");
    await ok("plan", "undo", "3");
    assert.equal(await lines(), "- [ ] 1. two\n- [ ] 2. 08:30 nil\n- [ ] 3. one");
    assert.match((await hub("plan", "done", "4")).err, /no plan line 4 on 2026-11-13/);
  });
});

describe("from hub", () => {
  test("day ends with my open PRs, open waits, drafts set for later and open gates, today only", async () => {
    await imported();
    stdin = JSON.stringify({
      source: "github",
      kind: "pr",
      url: "https://github.com/acme/web/pull/71",
      title: "Rate limit",
      state: "approved",
    });
    await ok("item", "put", "--stdin");
    stdin = JSON.stringify({
      source: "github",
      kind: "pr",
      url: "https://github.com/acme/web/pull/72",
      title: "Old",
      state: "merged",
    });
    await ok("item", "put", "--stdin");
    await ok("wait", "ENG-7", "ana", "https://acme.slack.com/archives/C1/p1", "--ping-after", "1d");
    stdin = "can we ship?";
    await ok("draft", "ENG-7", "ask-qa", "--stdin", "--send-at", "tomorrow 12:00");
    stdin = "now";
    await ok("draft", "ENG-7", "now-one", "--stdin");
    await ok("set", "ENG-42", "gate", "merge the migration?");
    assert.equal(
      (await ok("day")).split("## From hub\n")[1],
      [
        "- pr acme/web#71: Rate limit · approved",
        "- wait ana (ENG-7): ping 11-14 14:20",
        "- draft ENG-7/ask-qa: send 11-14 12:00",
        "- gate ENG-42: merge the migration?",
      ].join("\n"),
    );
    now = new Date("2026-11-16T00:00:00Z");
    assert.doesNotMatch(await ok("day", "2026-11-13", "--full"), /From hub/);
  });
});
