import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { type Server, serve } from "../src/serve.ts";

const ROOT = join(import.meta.dirname, "fixtures", "root");

let dir = "";
let dbFile = "";
let server: Server;

function hub(argv: string[], stdin = ""): string {
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
    now: () => new Date(),
  };
  assert.equal(run(argv, io), 0, `hub ${argv.join(" ")} failed: ${err}`);
  return out;
}

function post(path: string, body: Record<string, string>, token = server.token): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-token": token },
    body: JSON.stringify(body),
  });
}

function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${server.url}${path}`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

type SyncState = { status: string; at: string | null; detail: string | null };

async function syncState(): Promise<SyncState> {
  return (await (await fetch(`${server.url}/api/status`)).json()) as SyncState;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-serve-"));
  dbFile = join(dir, "hub.db");
  hub(["config", "trackerHosts", '["tracker.example.com"]']);
  hub(["import", "--root", ROOT, "--apply"]);
  server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env });
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("serve", () => {
  test("index and ticket pages render from the DB; a part request returns the body only", async () => {
    const index = await fetch(`${server.url}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /^<!doctype html>/);
    assert.match(
      html,
      /<div class="col" data-col="left"><div class="block" data-block="today">[\s\S]*?<div class="block" data-block="tickets">[\s\S]*?<div class="block" data-block="activity">[\s\S]*?<div class="col" data-col="right">/,
    );
    assert.match(html, /href="\/t\/ENG-42">ENG-42<\/a><span class="t-title">Sync login sessions across devices/);
    assert.match(html, /waiting on design review/);
    assert.match(index.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(html, /<script src="\/app.js" defer><\/script>/);
    assert.equal((await fetch(`${server.url}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(await (await fetch(`${server.url}/app.css`)).text(), /--accent/);

    const part = await (await fetch(`${server.url}/?part=1`)).text();
    assert.doesNotMatch(part, /<!doctype|<script/);

    const ticket = await (await fetch(`${server.url}/t/ENG-42`)).text();
    assert.match(ticket, /<h1>Sync login sessions across devices<\/h1>/);
    assert.match(ticket, /Timeline/);
    assert.equal((await fetch(`${server.url}/t/NOPE-1`)).status, 404);
  });

  test("needs you ranks by kind, keeps done rows in place dimmed with undo, and answers gates", async () => {
    const lines = [
      {
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/web/pull/9",
        title: "Retry webhook",
        needs_me: true,
      },
      { source: "grafana", kind: "alert", ref: "alert-1", title: "API 5xx", needs_me: true },
    ];
    hub(["item", "put", "--stdin"], lines.map((l) => JSON.stringify(l)).join("\n"));
    const verbs = (html: string) =>
      [...html.matchAll(/data-key="(item-\d+|wait-\d+|gate-[^"]+|decide-[^"]+)"/g)].map((m) => m[1]);
    const groups = (html: string) => [...html.matchAll(/data-group="([a-z]+)"/g)].map((m) => m[1]);
    const before = await (await fetch(`${server.url}/?part=1`)).text();
    assert.deepEqual(groups(before).slice(0, 2), ["fix", "review"]);
    assert.doesNotMatch(before, /class="stat /);
    assert.match(before, /data-needs-count="4"/);
    const id = /data-act="item-done" data-id="(\d+)"/.exec(before)?.[1] ?? "";
    await post("/api/item-done", { id });
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    assert.deepEqual(verbs(after), verbs(before));
    assert.match(
      after,
      /is-dim[^>]*data-key="item-\d+"[\s\S]*?<span class="dim-label">done<\/span>[\s\S]*?<span class="rail"><button[^>]*data-act="item-reopen"[^>]*data-hotkey="u"/,
    );
    assert.match(after, /data-needs-count="3"/);
    assert.equal((await post("/api/gate", { ticket: "ENG-42", answer: "yes" })).status, 200);
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /<span class="dim-label">yes<\/span>/);
  });

  test("every needs row has the same three controls, and a pinned row moves to the top", async () => {
    hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "grafana", kind: "alert", ref: "alert-1", needs_me: true }),
    );
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const rows = [...html.matchAll(/<li class="need [^"]*" data-key="([^"]+)"[\s\S]*?<\/li>/g)];
    assert.ok(rows.length >= 3);
    for (const [row] of rows) {
      assert.match(
        row,
        /<span class="rail"><button[^>]*class="ic ic-(ok|undo)"[\s\S]*?class="ic ic-later"[\s\S]*?<summary class="ic ic-more"/,
      );
      assert.match(row, /data-act="pin"/);
    }
    const last = rows.at(-1)?.[1] ?? "";
    assert.notEqual(rows[0]?.[1], last);
    assert.equal((await post("/api/pin", { row: last, on: "1" })).status, 200);
    const pinned = await (await fetch(`${server.url}/?part=1`)).text();
    const first = /<li class="(need [^"]*)" data-key="([^"]+)"/.exec(pinned);
    assert.equal(first?.[2], last);
    assert.match(first?.[1] ?? "", /\bpinned\b/);
    assert.match(pinned, new RegExp(`data-act="pin" data-row="${last}" data-on="0"`));
    assert.equal((await post("/api/pin", { row: "ticket-1", on: "1" })).status, 400);
  });

  test("settings show the database and save config through the same checks as the CLI", async () => {
    const html = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(html.includes(dbFile));
    assert.match(html, /Schema<\/span><div class="set-control">v2/);
    assert.equal((await post("/api/config", { key: "openLinearIn", value: '"app"' })).status, 200);
    const command = await post("/api/config", { key: "syncCommand", value: '["sh","-c","touch /tmp/x"]' });
    assert.equal(command.status, 400);
    assert.doesNotMatch(html, /data-config-input="syncCommand"/);
    const bad = await post("/api/config", { key: "theme", value: '"pink"' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /theme must be one of/);
    hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "linear", kind: "issue", url: "https://linear.app/acme/issue/ENG-7", needs_me: true }),
    );
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /href="linear:\/\/acme\/issue\/ENG-7"/);
  });

  test("tickets split into ongoing and recently done tabs", async () => {
    hub(["move", "ENG-7", "done"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const panel = (tab: string) =>
      new RegExp(`<ul class="rows ticket-list" data-tab-panel="${tab}"[^>]*>([\\s\\S]*?)</ul>`).exec(html)?.[1] ?? "";
    assert.match(panel("done"), /class="ticket is-closed" data-key="t-ENG-7"[\s\S]*?<span class="t-next">done /);
    assert.doesNotMatch(panel("ongoing"), /data-key="t-ENG-7"/);
    assert.match(html, /data-tab="done" aria-selected="false">Done <b>1<\/b>/);
  });

  test("the page shows each thing once: no ticket id twice, no Sent? draft in Drafts, only unhealthy sources", async () => {
    hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/web/pull/9",
        title: "ENG-42: banner",
        needs_me: true,
      }),
    );
    hub(["source", "github", "--cursor", "c1"]);
    hub(["source", "slack", "--error", "no connector"]);
    hub(["draft", "ENG-7", "ask product", "--stdin"], "Can we cap exports?");
    hub(
      ["match", "ENG-7", "ask product", "--ref", "https://acme.slack.com/archives/C1/p1", "--stdin"],
      "can we cap exports",
    );
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, />banner<\/a>/);
    const drafts = /<section class="drafts">[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    assert.doesNotMatch(drafts, /ask product/);
    assert.match(html, /<span class="synced"[^>]*>synced just now<\/span><span class="src src-bad"[^>]*><i><\/i>slack/);
    assert.doesNotMatch(html, /class="src src-ok"/);
  });

  test("blocks render in the saved layout, a bad layout is refused, and tickets show what needs you", async () => {
    hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/web/pull/9",
        ticket: "ENG-42",
        needs_me: true,
      }),
    );
    const layout = { left: ["today", "review"], right: ["tickets"] };
    assert.equal((await post("/api/config", { key: "layout", value: JSON.stringify(layout) })).status, 200);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const order = (col: string) =>
      [
        ...(
          new RegExp(`data-col="${col}">([\\s\\S]*?)</div>\\s*(<div class="col"|</main>)`).exec(html)?.[1] ?? ""
        ).matchAll(/<div class="block" data-block="([a-z]+)"(?! hidden)/g),
      ].map((m) => m[1]);
    assert.deepEqual(order("left").slice(0, 2), ["today", "review"]);
    assert.equal(order("right")[0], "tickets");
    assert.match(
      html,
      /data-key="t-ENG-42"[\s\S]*?<span class="pill tone-red need-pill" title="[^"]*Review[^"]*">\d+ needs? you<\/span>/,
    );
    const ticket = await (await fetch(`${server.url}/t/ENG-42?part=1`)).text();
    assert.match(ticket, /<h2>Needs you<\/h2>[\s\S]*?pull\/9/);
    const bad = await post("/api/config", { key: "layout", value: '{"left":["today","today"],"right":[]}' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /layout lists a block twice/);
    assert.equal((await post("/api/config", { key: "layout", value: '{"left":["nope"],"right":[]}' })).status, 400);
  });

  test("search finds tickets, items, steps and notes from one box", async () => {
    hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: "https://github.com/acme/web/pull/77",
        title: "Webhook retry jitter",
        ticket: "ENG-42",
        needs_me: true,
      }),
    );
    hub(["step", "add", "ENG-7", "measure webhook latency"]);
    const find = async (q: string) =>
      (await (await fetch(`${server.url}/api/search?q=${encodeURIComponent(q)}`)).json()) as {
        kind: string;
        title: string;
        sub: string;
        href: string | null;
      }[];
    const sync = await find("sync login");
    assert.equal(sync[0]?.kind, "Ticket");
    assert.equal(sync[0]?.href, "/t/ENG-42");
    const migration = await find("migration");
    assert.ok(migration.some((h) => h.kind === "Ticket" && /\uE000migration\uE001/i.test(h.sub)));
    const hook = await find("webhook");
    assert.ok(hook.some((h) => h.kind === "Item" && h.href === "https://github.com/acme/web/pull/77"));
    assert.ok(hook.some((h) => h.kind === "Step" && h.href === "/t/ENG-7"));
    assert.deepEqual(await find("   "), []);
    assert.ok(Array.isArray(await find('"%_\\')));
    const page = await (await fetch(`${server.url}/`)).text();
    assert.match(page, /data-search-box/);
    assert.doesNotMatch(page, /data-filter/);
    assert.match(await (await fetch(`${server.url}/settings`)).text(), /<a class="gear on" href="\/"/);
  });

  test("text from the DB is escaped", async () => {
    hub(["ticket-new", "NEW-xss", "<script>alert(1)</script>"]);
    const html = await (await fetch(`${server.url}/`)).text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test("a foreign Host or a missing token is refused", async () => {
    assert.equal(await rawGet("/", "evil.example:80"), 403);
    const port = new URL(server.url).port;
    assert.equal(await rawGet("/", `localhost:${port}`), 200);
    assert.equal((await post("/api/item-done", { id: "1" }, "wrong")).status, 403);
  });

  test("the token is kept in a file only the user can read and survives a restart", async () => {
    const file = join(dir, "token");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").trim(), server.token);
    const first = server.token;
    await server.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env });
    assert.equal(server.token, first);
    assert.equal((await post("/api/item-done", { id: "1" }, first)).status, 200);

    await server.close();
    chmodSync(file, 0o644);
    await assert.rejects(
      async () => serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env }),
      /token is readable by others: chmod 600/,
    );
    chmodSync(file, 0o600);
    writeFileSync(file, "not a token\n");
    await assert.rejects(
      async () => serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env }),
      /does not hold a hub token/,
    );
    rmSync(file);
    server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env });
    assert.notEqual(server.token, first);
  });

  test("actions write through the same functions as the CLI", async () => {
    const review = JSON.stringify({
      source: "github",
      kind: "review_request",
      url: "https://github.com/acme/web/pull/9",
      needs_me: true,
    });
    hub(["item", "put", "--stdin"], review);
    const id = /^#(\d+)/.exec(hub(["items", "--needs-me"]))?.[1] ?? "";
    const page = await (await fetch(`${server.url}/`)).text();
    assert.match(page, /data-act="item-done" data-id="\d+"/);
    assert.match(
      page,
      /<details class="menu"[^>]*><summary class="ic ic-more"[^>]*>[\s\S]*?<div class="menu-pop">[\s\S]*?data-act="item-snooze" data-id="\d+" data-for="1h"/,
    );
    assert.equal((await post("/api/item-snooze", { id, for: "1h" })).status, 200);
    assert.equal(hub(["items", "--needs-me"]), "no items");
    const db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT snoozed_until FROM item WHERE id = ?").get(Number(id)) as { snoozed_until: string };
    db.close();
    const minutes = (Date.parse(row.snoozed_until) - Date.now()) / 60000;
    assert.ok(minutes > 58 && minutes <= 60, `snoozed ${minutes} minutes`);
    assert.equal((await post("/api/item-snooze", { id, for: "soon" })).status, 400);
    assert.equal((await post("/api/item-done", { id })).status, 200);
    assert.match(hub(["items", "--all"]), /pull\/9 \| closed$/m);

    hub(["draft", "ENG-7", "ask product", "--stdin"], "Can we cap exports?");
    assert.equal((await post("/api/sent", { ticket: "ENG-7", label: "ask product" })).status, 200);
    assert.match(hub(["drafts", "ENG-7"]), /ask product \| posted \| .* \| wording pending/);

    const bad = await post("/api/wait-close", { id: "42" });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /no open wait 42/);
    assert.equal((await post("/api/nope", {})).status, 404);
  });

  test("a write from another process reaches open pages as a change event", async () => {
    const events = await fetch(`${server.url}/events`);
    const reader = events.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let seen = "";
    const changed = (async () => {
      while (!seen.includes("event: change")) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value);
      }
    })();
    hub(["log", "ENG-7", "written elsewhere"]);
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error("no change")), 2000))]);
    await reader.cancel();
  });

  test("Sync runs the configured command once at a time with HUB_DB set, and reports failure", async () => {
    const db = new DatabaseSync(dbFile);
    const setCommand = (argv: string[]) =>
      db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('syncCommand', ?)").run(JSON.stringify(argv));
    setCommand(["node", "-e", "setTimeout(() => process.stdout.write(process.env.HUB_DB), 300)"]);
    assert.equal((await post("/api/sync", {})).status, 202);
    assert.equal((await post("/api/sync", {})).status, 409);
    assert.match(
      await (await fetch(`${server.url}/?part=1`)).text(),
      /class="top syncing"[\s\S]*class="ic ic-sync sync-btn" data-act="sync" title="Syncing" aria-label="Syncing" disabled>/,
    );
    const finished = await waitFor(async () => {
      const s = await syncState();
      return s.status === "running" ? undefined : s;
    });
    assert.deepEqual([finished.status, finished.detail], ["finished", dbFile]);

    setCommand(["node", "-e", "console.error('no connector'); process.exit(3)"]);
    assert.equal((await post("/api/sync", {})).status, 202);
    const failed = await waitFor(async () => {
      const s = await syncState();
      return s.status === "running" ? undefined : s;
    });
    db.close();
    assert.deepEqual([failed.status, failed.detail], ["failed", "exit 3: no connector"]);
  });

  test("auto sync runs once the interval passes, and not when it is off", async () => {
    await server.close();
    let clock = new Date("2026-11-18T09:00:00Z");
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('syncCommand', ?)").run(
      JSON.stringify(["node", "-e", "process.stdout.write('auto')"]),
    );
    db.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => clock, env: process.env, autoSyncCheckMs: 20 });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await syncState()).status, "idle");
    clock = new Date("2026-11-18T09:16:00Z");
    const ran = await waitFor(async () => {
      const s = await syncState();
      return s.status === "finished" ? s : undefined;
    });
    assert.equal(ran.detail, "auto");

    hub(["config", "autoSync", "false"]);
    clock = new Date("2026-11-18T10:00:00Z");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await syncState()).at, ran.at);
    assert.equal((await post("/api/config", { key: "syncEvery", value: '"5m"' })).status, 400);
  });
});
