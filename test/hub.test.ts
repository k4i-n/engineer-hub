import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
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
    assert.match((await hub("step", "undo", "ENG-42", "1")).err, /step 1 on ENG-42 is not done/);
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
      `#3 github/review_request | needs you | ENG-7: cap exports | open | ENG-7 | ${review}`,
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
  test("steps are numbered in order, done ones log an event, the ticket shows progress and the next step", async () => {
    await imported();
    await ok("step", "add", "ENG-7", "read the export handler");
    await ok("step", "add", "ENG-7", "add", "the", "limiter");
    await ok("step", "add", "ENG-7", "open the PR");
    const pr = "https://github.com/acme/web/pull/140";
    assert.equal(await ok("step", "done", "ENG-7", "1"), "ENG-7 step 1 done (1/3), next: 2 add the limiter");
    await ok("step", "done", "ENG-7", "3", "--evidence", pr);
    assert.equal(
      await ok("steps", "ENG-7"),
      `1 [x] read the export handler\n2 [ ] add the limiter\n3 [x] open the PR | ${pr}`,
    );
    assert.match(await ok("ticket", "ENG-7"), /^steps: 2\/3 \| next step: 2 add the limiter$/m);
    assert.match(await ok("events", "ENG-7", "-n", "1"), /\[step\] step 3 done: open the PR$/);
    assert.match((await hub("step", "done", "ENG-7", "3")).err, /already done/);
    assert.match((await hub("step", "done", "ENG-7", "9")).err, /no step 9 on ENG-7/);
    assert.match((await hub("step", "add", "ENG-7", "x".repeat(241))).err, /max 240/);
  });
});

describe("reads", () => {
  test("board prints the exact line for the rich ticket", async () => {
    await imported();
    const status = sql<{ status: string }>("SELECT status FROM ticket WHERE id = 'ENG-42'")[0]?.status ?? "";
    const expected = `  [High] [TRACKER: In Review] #2 ENG-42 | ${status.slice(0, 87)}... | PR #101 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header | next: write the migration for the sessions table`;
    const lines = (await ok("board")).split("\n");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("==")),
      ["== inprogress", "== todo"],
    );
    assert.equal(lines[1], expected);
    assert.equal(lines[3], "  [-] ENG-7 | - | next: read the export handler");
    assert.equal(await ok("board", "export"), "== todo\n  [-] ENG-7 | - | next: read the export handler");
  });

  test("board and ticket show the state of the ticket's PRs in place of the prs text", async () => {
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
    assert.match(await ok("ticket", "ENG-42"), /^prs: #101 \| #101, #140 approved, #141 checks failing$/m);
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
      lines.at(-1),
      "notes: Ticket body as filed; Detail; Inventory; State notes (migrated 2026-11-13); tasks/inprogress/ENG-42-baseline.md; Other files",
    );
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
    assert.equal(
      await ok("gates"),
      "ENG-42 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header",
    );
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
    assert.equal(
      await ok("gates"),
      "ENG-42 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header",
    );
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
    assert.match((await hub("config", "slackTeamId", '"acme"')).err, /workspace id/);
    assert.match(
      (await hub("config", "recordActions", '["deploy("]')).err,
      /recordActions has deploy\(, which is not a valid regular expression/,
    );
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
      /has schema v1, this hub needs v18: move the file aside and re-import/,
    );
    server = await serve({ dbPath: join(dir, "other.db"), port: 0, now: () => now, env: {}, fetchers: [] });
  });
});

describe("schema upgrade", () => {
  test("a v2 database gains draft.send_at, the script table, ticket.position and item.ignored, source.warning, item.detached, script_source.enabled and section, item verdicts, item.body and item.detail, draft.item, draft.closed_item and draft.match_no, item.ask, draft.verdict and draft comments, and becomes v18, when hub serve opens it", async () => {
    await imported();
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(
      "ALTER TABLE draft DROP COLUMN send_at; DROP TABLE script_source; ALTER TABLE ticket DROP COLUMN position; ALTER TABLE item DROP COLUMN ignored; ALTER TABLE source DROP COLUMN warning; ALTER TABLE item DROP COLUMN detached; ALTER TABLE item DROP COLUMN judged_at; ALTER TABLE item DROP COLUMN away_ping; ALTER TABLE item DROP COLUMN away_why; ALTER TABLE item DROP COLUMN body; ALTER TABLE item DROP COLUMN detail; DROP INDEX draft_item; DROP INDEX draft_item_label; ALTER TABLE draft DROP COLUMN item; ALTER TABLE draft DROP COLUMN closed_item; ALTER TABLE draft DROP COLUMN match_no; ALTER TABLE item DROP COLUMN ask; ALTER TABLE item DROP COLUMN ask_answer; ALTER TABLE item DROP COLUMN ask_at; ALTER TABLE draft DROP COLUMN verdict; ALTER TABLE draft DROP COLUMN match_verdict; DROP TABLE draft_comment; UPDATE meta SET value = '2' WHERE key = 'schema_version'",
    );
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(sql<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value, "18");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM draft WHERE item IS NOT NULL")[0]?.n, 0);
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
    db.exec(`INSERT INTO config(key, value) VALUES
      ('githubReviewQuery', '"is:pr is:open review-requested:@me"'),
      ('ignoreRepos', '{"review_request":["acme/noisy","acme/old"],"pr":["acme/web"]}');
      ALTER TABLE item DROP COLUMN judged_at; ALTER TABLE item DROP COLUMN away_ping; ALTER TABLE item DROP COLUMN away_why;
      ALTER TABLE item DROP COLUMN body; ALTER TABLE item DROP COLUMN detail; DROP INDEX draft_item; DROP INDEX draft_item_label;
      ALTER TABLE draft DROP COLUMN item; ALTER TABLE draft DROP COLUMN closed_item; ALTER TABLE draft DROP COLUMN match_no;
      ALTER TABLE item DROP COLUMN ask; ALTER TABLE item DROP COLUMN ask_answer; ALTER TABLE item DROP COLUMN ask_at;
      ALTER TABLE draft DROP COLUMN verdict; ALTER TABLE draft DROP COLUMN match_verdict; DROP TABLE draft_comment; UPDATE meta SET value = '10' WHERE key = 'schema_version'`);
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
    await ok("config", "fetch", '{"github":true,"slack":true}');
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
