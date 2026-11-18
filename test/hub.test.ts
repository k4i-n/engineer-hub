import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";

const ROOT = join(import.meta.dirname, "fixtures", "root");
const NOW = new Date("2026-11-13T05:20:00Z");

type Out = { code: number; out: string; err: string };

let dir = "";
let dbFile = "";
let now = NOW;
let stdin = "";

function hub(...argv: string[]): Out {
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
    env: { HUB_DB: dbFile },
    now: () => now,
  };
  const code = run(argv, io);
  return { code, out, err };
}

function ok(...argv: string[]): string {
  const result = hub(...argv);
  assert.equal(result.code, 0, `hub ${argv.join(" ")} failed: ${result.err}`);
  return result.out;
}

function json<T>(...argv: string[]): T {
  return JSON.parse(ok(...argv, "--json")) as T;
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

function configure(): void {
  ok("config", "trackerHosts", '["tracker.example.com"]');
}

function imported(): void {
  configure();
  ok("import", "--root", ROOT, "--apply");
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
  report: { oversize: { id: string; field: string; length: number }[] };
  changes: number | null;
};

const EXPECTED: Counts = { tickets: 2, events: 3, notes: 5, drafts: 2, links: 2, days: 1 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-test-"));
  dbFile = join(dir, "hub.db");
  now = NOW;
  stdin = "";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("import", () => {
  test("dry run counts every entity, reports the oversize Status and writes nothing", () => {
    configure();
    const result = json<ImportJson>("import", "--root", ROOT);
    assert.deepEqual(result.counts, EXPECTED);
    assert.equal(result.changes, null);
    assert.deepEqual(result.report.oversize, [{ id: "ENG-42", field: "status", length: 1000 }]);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM ticket")[0]?.n, 0);
  });

  test("dry run without a DB does not create one", () => {
    const result = json<ImportJson>("import", "--root", ROOT);
    assert.equal(result.counts.tickets, 2);
    assert.deepEqual(readdirSync(dir), []);
  });

  test("apply then re-run gives identical counts and changes nothing", () => {
    configure();
    const first = json<ImportJson>("import", "--root", ROOT, "--apply");
    const second = json<ImportJson>("import", "--root", ROOT, "--apply");
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

  test("oversize field keeps limit chars plus a suffix, the full text goes to a state_notes note", () => {
    imported();
    const [ticket] = sql<{ status: string }>("SELECT status FROM ticket WHERE id = 'ENG-42'");
    assert.equal(ticket?.status.length, 240 + " (see State notes)".length);
    assert.ok(ticket?.status.endsWith(" (see State notes)"));
    const [note] = sql<{ title: string; body: string }>(
      "SELECT title, body FROM note WHERE ticket_id = 'ENG-42' AND kind = 'state_notes'",
    );
    assert.equal(note?.title, "State notes (migrated 2026-11-13)");
    assert.equal(note?.body.length, "Status: ".length + 1000);
  });

  test("a later re-import reuses the existing state notes title", () => {
    imported();
    now = new Date("2026-11-20T05:20:00Z");
    assert.equal(json<ImportJson>("import", "--root", ROOT, "--apply").changes, 0);
  });

  test("every section of a ticket file lands in the DB and the source files stay byte-identical", () => {
    const before = checksums(ROOT);
    imported();
    assert.equal(checksums(ROOT), before);
    const notes = sql<{ title: string; kind: string }>(
      "SELECT title, kind FROM note WHERE ticket_id = 'ENG-42' ORDER BY position",
    );
    assert.deepEqual(notes, [
      { title: "Ticket body as filed", kind: "ticket_body" },
      { title: "Detail", kind: "detail" },
      { title: "Inventory", kind: "other" },
      { title: "State notes (migrated 2026-11-13)", kind: "state_notes" },
    ]);
    const [t] = sql<Record<string, string>>("SELECT * FROM ticket WHERE id = 'ENG-42'");
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

  test("a missing root is an error", () => {
    const result = hub("import", "--root", join(dir, "nope"));
    assert.equal(result.code, 1);
    assert.match(result.err, /is not a folder/);
  });
});

describe("writes", () => {
  test("set refuses an oversize value with the documented message", () => {
    imported();
    const result = hub("set", "ENG-7", "next", "x".repeat(241));
    assert.equal(result.code, 1);
    assert.equal(
      result.err,
      "next is 241 chars (max 240): put the detail in a note (hub note) or the log (hub log) and keep next to one line",
    );
  });

  test("a valid set bumps updated and updated_at", () => {
    imported();
    now = new Date("2026-11-14T16:00:00Z");
    ok("set", "ENG-7", "gate", "waiting on product");
    const [t] = sql<{ gate: string; updated: string; updated_at: string }>(
      "SELECT gate, updated, updated_at FROM ticket WHERE id = 'ENG-7'",
    );
    assert.deepEqual(t, { gate: "waiting on product", updated: "2026-11-15", updated_at: "2026-11-14T16:00:00.000Z" });
  });

  test("set refuses an unknown field and an unknown ticket", () => {
    imported();
    assert.match(hub("set", "ENG-7", "title", "x").err, /field must be one of/);
    assert.match(hub("set", "ENG-1", "next", "x").err, /no ticket ENG-1/);
  });

  test("log stamps the config timezone and events lists newest first", () => {
    imported();
    now = new Date("2026-11-13T23:30:00Z");
    ok("log", "ENG-7", "measured 40 exports per minute", "--kind", "reading");
    const events = ok("events", "ENG-7");
    assert.equal(events.split("\n")[0], "2026-11-14 08:30 [reading] measured 40 exports per minute");
    assert.match(hub("log", "ENG-7", "x", "--kind", "chat").err, /--kind must be one of/);
  });

  test("note, draft, posted and day set round-trip through the DB", () => {
    imported();
    stdin = "# Runbook\nrestart the worker";
    ok("note", "ENG-7", "Runbook", "--stdin");
    assert.equal(ok("note-show", "ENG-7", "Runbook"), "# Runbook\nrestart the worker");

    stdin = "Can we cap exports at 10 a minute?";
    ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    assert.match(ok("drafts"), /ENG-7 \| ask product \| Can we cap exports/);
    ok("posted", "ENG-7", "ask product", "--at", "2026-11-13 15:00", "--answer", "yes, 10");
    assert.equal(ok("drafts", "ENG-7"), "ask product | answered | #product | 2026-11-13 15:00 | wording pending");

    const file = join(dir, "plan.md");
    writeFileSync(file, "# Plan\n\n## RESUME\nstart with ENG-7\n\n## Later\n- other\n");
    ok("day", "set", "2026-11-14", "--file", file);
    assert.equal(ok("day", "2026-11-14"), "2026-11-14\nstart with ENG-7");
  });

  test("posted keeps the wording actually sent, and Sent without it is pending until a sync fills it", () => {
    imported();
    stdin = "Can we cap exports at 10 a minute?";
    ok("draft", "ENG-7", "ask product", "--stdin", "--channel", "#product");
    assert.equal(ok("posted", "ENG-7", "ask product"), 'ENG-7 draft "ask product" posted, wording pending');
    assert.equal(ok("drafts", "ENG-7"), "ask product | posted | #product | 2026-11-13 14:20 | wording pending");

    stdin = "hey, ok to limit exports to ten per minute per user?";
    const permalink = "https://acme.slack.com/archives/C1/p1763011200";
    ok("posted", "ENG-7", "ask product", "--stdin", "--ref", permalink);
    assert.equal(ok("drafts", "ENG-7"), "ask product | posted | #product | 2026-11-13 14:20");
    assert.equal(
      ok("draft-show", "ENG-7", "ask product"),
      `Can we cap exports at 10 a minute?\n\n--- sent ${permalink}\nhey, ok to limit exports to ten per minute per user?`,
    );
    assert.match(ok("search", "ten per minute"), /^draft ENG-7 ask product:/m);

    stdin = "Second try: cap at 20?";
    ok("draft", "ENG-7", "ask product", "--stdin");
    assert.equal(ok("drafts", "ENG-7"), "ask product | draft | #product");
  });

  test("ticket-new validates the id and dir, move changes the dir", () => {
    imported();
    ok("ticket-new", "NEW-export-audit", "Audit export usage");
    assert.match(hub("ticket-new", "bad id", "x").err, /matches neither/);
    assert.match(hub("ticket-new", "ENG-7", "dup").err, /already exists/);
    assert.match(hub("ticket-new", "ENG-8", "x", "--dir", "later").err, /dir must be one of/);
    ok("move", "NEW-export-audit", "inprogress");
    assert.equal(sql<{ dir: string }>("SELECT dir FROM ticket WHERE id = 'NEW-export-audit'")[0]?.dir, "inprogress");
  });
});

describe("items", () => {
  test("link stores an item on the ticket, a second link changes nothing, a later link moves it", () => {
    imported();
    const url = "https://github.com/acme/web/pull/120";
    ok("link", "ENG-7", url, "--title", "Rate limit exports");
    assert.equal(ok("items", "--ticket", "ENG-7"), `#3 github/pr | Rate limit exports | ENG-7 | ${url}`);
    const before = sql<{ changed_at: string }>("SELECT changed_at FROM item WHERE ref = ?", url);
    now = new Date("2026-11-14T00:00:00Z");
    ok("link", "ENG-7", url);
    assert.deepEqual(sql<{ changed_at: string }>("SELECT changed_at FROM item WHERE ref = ?", url), before);
    ok("link", "ENG-42", url);
    assert.equal(ok("items", "--ticket", "ENG-7"), "no items");
    assert.match(ok("ticket", "ENG-42"), /^items: 3 open, 0 need you \| waits: 0 open$/m);
    assert.match(hub("link", "ENG-7", url, "--kind", "page").err, /--kind must be one of/);
  });
  test("item put stores a sync delta once, matches tickets by id and logs new and changed items", () => {
    imported();
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
    assert.equal(ok("item", "put", "--stdin"), "items: 2 new, 0 changed, 0 unchanged");
    assert.equal(ok("item", "put", "--stdin"), "items: 0 new, 0 changed, 2 unchanged");
    assert.equal(
      ok("items", "--needs-me"),
      `#3 github/review_request | needs you | ENG-7: cap exports | open | ENG-7 | ${review}`,
    );
    assert.match(ok("events", "ENG-7"), /\[sync\] new github\/review_request: ENG-7: cap exports/);

    ok("item", "close", "3");
    assert.equal(ok("items", "--needs-me"), "no items");
    stdin = JSON.stringify({ source: "github", kind: "review_request", url: review, state: "open", needs_me: true });
    assert.equal(ok("item", "put", "--stdin"), "items: 0 new, 0 changed, 1 unchanged");
    assert.equal(ok("items", "--needs-me"), "no items");
    stdin = JSON.stringify({ source: "github", kind: "review_request", url: review, state: "merged" });
    assert.equal(ok("item", "put", "--stdin"), "items: 0 new, 1 changed, 0 unchanged");
    assert.match(ok("items", "--ticket", "ENG-7"), /^#3 .* \| merged \| ENG-7 \|/);
    assert.match(ok("events", "ENG-7", "-n", "1"), /review_request: ENG-7: cap exports: open -> merged$/);

    ok("item", "attach", "alert-991", "ENG-42");
    assert.match(ok("events", "ENG-42", "-n", "1"), /attached grafana\/alert: API 5xx above 2%$/);
  });

  test("item put refuses a bad line and writes nothing from the batch", () => {
    imported();
    const good = JSON.stringify({ source: "slack", kind: "thread", url: "https://acme.slack.com/archives/C1/p1" });
    const refused = (line: string) => {
      stdin = `${good}\n${line}`;
      return hub("item", "put", "--stdin").err;
    };
    assert.match(refused("{nope"), /^line 2: not JSON$/);
    assert.match(refused('{"source":"slack","kind":"thread","url":"u","colour":1}'), /unknown key colour/);
    assert.match(refused('{"source":"slack","kind":"chat","url":"u"}'), /kind must be one of/);
    assert.match(refused('{"source":"Slack!","kind":"thread","url":"u"}'), /source must be a lowercase name/);
    assert.match(refused('{"source":"slack","kind":"thread"}'), /give ref or url/);
    assert.match(refused('{"source":"slack","kind":"thread","url":"u","ticket":"ENG-9"}'), /no ticket ENG-9/);
    assert.match(refused('{"source":"slack","kind":"thread","url":"u","needs_me":"yes"}'), /needs_me must be/);
    assert.equal(ok("items", "--source", "slack"), "no items");
    assert.match(hub("item", "close", "99").err, /no item 99/);
  });
});

describe("waits", () => {
  test("a wait shows ping now once its time passes and closes by number or url", () => {
    imported();
    const thread = "https://acme.slack.com/archives/C1/p1763011200";
    assert.equal(
      ok("wait", "ENG-7", "product", thread, "--ping-after", "1d"),
      "wait #1 on ENG-7: product, ping after 2026-11-14 14:20",
    );
    assert.equal(
      ok("wait", "ENG-7", "product", thread, "--ping-after", "2h"),
      "wait #1 on ENG-7: product, ping after 2026-11-13 16:20",
    );
    ok("wait", "ENG-42", "design", "https://acme.slack.com/archives/C2/p1");
    assert.equal(ok("waits", "--due"), "no waits due");
    assert.match(ok("ticket", "ENG-7"), /\| waits: 1 open$/m);
    now = new Date("2026-11-13T08:00:00Z");
    assert.equal(ok("waits", "--due"), `#1 ENG-7 | product | asked 2026-11-13 14:20 | ping now | ${thread}`);
    assert.equal(ok("wait", "close", thread), "closed #1");
    assert.equal(ok("wait", "close", "2"), "closed #2");
    assert.equal(ok("waits"), "no open waits");
    assert.match(hub("wait", "close", "2").err, /no open wait 2/);
    assert.match(hub("wait", "ENG-7", "a", "u", "--ping-after", "tomorrow").err, /--ping-after takes a duration/);
  });
});

describe("sources", () => {
  test("a sync records its time and cursor, an error keeps the cursor, the next clean sync clears the error", () => {
    assert.equal(ok("sources"), "no sources synced yet");
    ok("source", "github", "--cursor", "2026-11-13T05:00:00Z");
    now = new Date("2026-11-13T06:00:00Z");
    assert.equal(ok("source", "github", "--error", "gh: rate limited"), "source github synced, with error");
    ok("source", "slack", "--cursor", "1763011200.0001");
    assert.equal(
      ok("sources"),
      [
        "github | last sync 2026-11-13 15:00 | cursor 2026-11-13T05:00:00Z | error: gh: rate limited",
        "slack | last sync 2026-11-13 15:00 | cursor 1763011200.0001",
      ].join("\n"),
    );
    ok("source", "github");
    assert.match(ok("sources"), /^github \| last sync 2026-11-13 15:00 \| cursor 2026-11-13T05:00:00Z$/m);
    assert.match(hub("source", "GitHub").err, /source must be a lowercase name/);
  });
});

describe("reads", () => {
  test("board prints the exact line for the rich ticket", () => {
    imported();
    const status = sql<{ status: string }>("SELECT status FROM ticket WHERE id = 'ENG-42'")[0]?.status ?? "";
    const expected = `  [High] [TRACKER: In Review] ENG-42 | ${status.slice(0, 87)}... | PR #101 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header | next: write the migration for the sessions table`;
    const lines = ok("board").split("\n");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("==")),
      ["== inprogress", "== todo"],
    );
    assert.equal(lines[1], expected);
    assert.equal(lines[3], "  [-] ENG-7 | - | next: read the export handler");
    assert.equal(ok("board", "export"), "== todo\n  [-] ENG-7 | - | next: read the export handler");
  });

  test("board hides unfiled tickets the tracker closed", () => {
    imported();
    ok("ticket-new", "ENG-99", "Rotate the staging signing key", "--dir", "unfiled");
    assert.match(ok("board"), /ENG-99/);
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE ticket SET tracker_state = 'Done' WHERE id = 'ENG-99'").run();
    db.close();
    assert.doesNotMatch(ok("board"), /ENG-99/);
  });

  test("next orders by dir, then tracker priority, then most recent", () => {
    imported();
    now = new Date("2026-11-13T06:00:00Z");
    ok("ticket-new", "ENG-8", "Second todo");
    assert.deepEqual(
      ok("next")
        .split("\n")
        .map((l) => l.split(" | ")[0]),
      ["ENG-42", "ENG-8", "ENG-7"],
    );
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE ticket SET tracker_priority = 'Urgent' WHERE id = 'ENG-7'").run();
    db.close();
    assert.deepEqual(
      ok("next")
        .split("\n")
        .map((l) => l.split(" | ")[0]),
      ["ENG-42", "ENG-7", "ENG-8"],
    );
  });

  test("ticket view stays under 25 lines", () => {
    imported();
    const lines = ok("ticket", "ENG-42").split("\n");
    assert.ok(lines.length < 25);
    assert.equal(lines[0], "ENG-42 | inprogress | Sync login sessions across devices");
    assert.equal(lines.at(-1), "notes: Ticket body as filed; Detail; Inventory; State notes (migrated 2026-11-13)");
  });

  test("search finds a term in a note, an event and a draft", () => {
    imported();
    assert.match(ok("search", "shared session table"), /^note ENG-42 Detail:/m);
    assert.match(ok("search", "middleware"), /^event ENG-42 2026-11-12 14:2x:/m);
    assert.match(ok("search", "banner"), /^draft ENG-42 D24/m);
    assert.match(ok("search", 'quote"d'), /no matches/);
  });

  test("gates and changed", () => {
    imported();
    assert.equal(
      ok("gates"),
      "ENG-42 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header",
    );
    now = new Date("2026-11-16T01:00:00Z");
    ok("log", "ENG-7", "started");
    assert.equal(ok("changed", "--since", "today"), "ENG-7: 1 event(s)\n  2026-11-16 10:00 [log] started");
    assert.match(hub("changed", "--since", "last week").err, /--since takes/);
  });

  test("day returns the RESUME block of the plan, by date or the latest", () => {
    imported();
    const resume = "2026-11-13\nContinue ENG-42: write the migration for the sessions table.";
    assert.equal(ok("day", "2026-11-13"), resume);
    now = new Date("2026-11-20T00:00:00Z");
    assert.equal(ok("day"), resume);
  });

  test("lint reports missing and oversize fields and exits 1", () => {
    imported();
    ok("ticket-new", "NEW-audit", "Audit export usage");
    const result = hub("lint");
    assert.equal(result.code, 1);
    assert.match(result.out, /ENG-42: status is 258 chars \(max 240\)/);
    assert.match(result.out, /NEW-audit: missing status/);
  });
});

describe("config", () => {
  test("defaults on an empty DB, a valid write is stored, bad writes are refused", () => {
    assert.equal(ok("config", "timezone"), 'timezone = "Asia/Tokyo"');
    ok("config", "limits", '{"next":300}');
    const limits = json<Record<string, number>>("config", "limits");
    assert.equal(limits.next, 300);
    assert.equal(limits.status, 240);
    assert.match(hub("config", "colour", '"red"').err, /unknown config key colour/);
    assert.match(hub("config", "timezone", "42").err, /timezone takes a JSON string/);
    assert.match(hub("config", "timezone", '"Mars/Base"').err, /not an IANA time zone/);
    assert.match(hub("config", "limits", '{"title":10}').err, /limits.title is not a known key/);
    assert.match(hub("config", "taskDirs", "[1]").err, /array of strings/);
  });
});

describe("db", () => {
  test("a database from another schema version is refused", () => {
    ok("board");
    const db = new DatabaseSync(dbFile);
    db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
    db.close();
    assert.match(hub("board").err, /has schema v1, this hub needs v2: move the file aside and re-import/);
  });
});

describe("cli", () => {
  test("unknown command prints usage and exits 2", () => {
    const result = hub("frobnicate");
    assert.equal(result.code, 2);
    assert.match(result.err, /^usage: hub/);
    assert.equal(hub("board", "--nope").code, 2);
  });
});
