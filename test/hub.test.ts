import assert from "node:assert/strict";
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
  report: { oversize: { id: string; field: string; length: number }[] };
  changes: number | null;
};

const EXPECTED: Counts = { tickets: 2, events: 3, notes: 5, drafts: 2, links: 2, days: 1 };

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
    assert.match((await hub("set", "ENG-7", "title", "x")).err, /unknown body field title \(status, repo/);
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
    await ok("day", "set", "2026-11-14", "--file", file);
    assert.equal(await ok("day", "2026-11-14"), "2026-11-14\nstart with ENG-7");
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
    const expected = `  [High] [TRACKER: In Review] ENG-42 | ${status.slice(0, 87)}... | PR #101 | GATE: waiting on design review | DECIDE: keep refresh tokens in cookie or header | next: write the migration for the sessions table`;
    const lines = (await ok("board")).split("\n");
    assert.deepEqual(
      lines.filter((l) => l.startsWith("==")),
      ["== inprogress", "== todo"],
    );
    assert.equal(lines[1], expected);
    assert.equal(lines[3], "  [-] ENG-7 | - | next: read the export handler");
    assert.equal(await ok("board", "export"), "== todo\n  [-] ENG-7 | - | next: read the export handler");
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
    assert.equal(lines.at(-1), "notes: Ticket body as filed; Detail; Inventory; State notes (migrated 2026-11-13)");
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
    const resume = "2026-11-13\nContinue ENG-42: write the migration for the sessions table.";
    assert.equal(await ok("day", "2026-11-13"), resume);
    now = new Date("2026-11-20T00:00:00Z");
    assert.equal(await ok("day"), resume);
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
      /has schema v1, this hub needs v4: move the file aside and re-import/,
    );
    server = await serve({ dbPath: join(dir, "other.db"), port: 0, now: () => now, env: {}, fetchers: [] });
  });
});

describe("schema upgrade", () => {
  test("a v2 database gains draft.send_at and the script table, and becomes v4, when hub serve opens it", async () => {
    await imported();
    await server.close();
    const db = new DatabaseSync(dbFile);
    db.exec(
      "ALTER TABLE draft DROP COLUMN send_at; DROP TABLE script_source; UPDATE meta SET value = '2' WHERE key = 'schema_version'",
    );
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => now, env: {}, fetchers: [] });
    assert.equal(sql<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value, "4");
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM script_source")[0]?.n, 0);
    assert.equal(sql<{ n: number }>("SELECT count(*) AS n FROM draft")[0]?.n, EXPECTED.drafts);
    await ok("draft", "ENG-7", "later", "--stdin", "--send-at", "tomorrow 12:00");
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
