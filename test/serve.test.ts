import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { ROUTES } from "../src/api.ts";
import { type Io, run } from "../src/cli.ts";
import { type Server, serve } from "../src/serve.ts";

const ROOT = join(import.meta.dirname, "fixtures", "root");

let dir = "";
let dbFile = "";
let server: Server;

async function hub(argv: string[], stdin = ""): Promise<string> {
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
    now: () => new Date(),
  };
  assert.equal(await run(argv, io), 0, `hub ${argv.join(" ")} failed: ${err}`);
  return out;
}

function call(method: string, path: string, body?: unknown, token = server.token): Promise<Response> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${server.url}/api/v1${path}`, init);
}

function setConfigKey(key: string, value: string): Promise<Response> {
  return call("PUT", `/config/${key}`, { value: JSON.parse(value) });
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

function tabCounts(html: string, group: string): Record<string, number> {
  const bar = new RegExp(`data-tabs="${group}">[\\s\\S]*?</span>`).exec(html)?.[0] ?? "";
  return Object.fromEntries(
    [...bar.matchAll(/data-tab="([a-z]+)" aria-selected="[a-z]+">[^<]+<b>(\d+)<\/b>/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]),
  );
}

function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

type SyncState = { status: string; at: string | null; detail: string | null };

async function syncState(): Promise<SyncState> {
  return (await (await call("GET", "/sync")).json()) as SyncState;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-serve-"));
  dbFile = join(dir, "hub.db");
  server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env, fetchers: [] });
  await hub(["config", "trackerHosts", '["tracker.example.com"]']);
  await hub(["import", "--root", ROOT, "--apply"]);
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
      /<div class="col" data-col="left"><div class="block" data-block="today"[^>]*>[\s\S]*?<div class="block" data-block="tickets"[^>]*>[\s\S]*?<div class="block" data-block="activity"[^>]*>[\s\S]*?<div class="col" data-col="right">/,
    );
    assert.match(
      html,
      /href="\/t\/ENG-42" title="ENG-42">ENG-42<\/a><span class="t-title">Sync login sessions across devices/,
    );
    assert.match(html, /waiting on design review/);
    assert.match(index.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.match(html, /<script src="\/app.js" defer><\/script>/);
    assert.match(html, /<div class="news" aria-live="polite" hidden><\/div>/);
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
    await hub(["item", "put", "--stdin"], lines.map((l) => JSON.stringify(l)).join("\n"));
    const verbs = (html: string) =>
      [...html.matchAll(/data-key="(item-\d+|wait-\d+|gate-[^"]+|decide-[^"]+)"/g)].map((m) => m[1]);
    const groups = (html: string) => [...html.matchAll(/data-group="([a-z]+)"/g)].map((m) => m[1]);
    const before = await (await fetch(`${server.url}/?part=1`)).text();
    assert.deepEqual(groups(before).slice(0, 2), ["fix", "review"]);
    assert.doesNotMatch(before, /class="stat /);
    assert.match(before, /data-needs-count="5"/);
    const id = /data-act="item-done" data-id="(\d+)"/.exec(before)?.[1] ?? "";
    await call("POST", `/items/${id}/close`, {});
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    assert.deepEqual(verbs(after), verbs(before));
    assert.match(
      after,
      /is-dim[^>]*data-key="item-\d+"[\s\S]*?<span class="dim-label">done<\/span>[\s\S]*?<span class="rail"><button[^>]*data-act="item-reopen"[^>]*data-hotkey="u"/,
    );
    assert.match(after, /data-needs-count="4"/);
    assert.equal((await call("POST", "/tickets/ENG-42/gate", { answer: "yes" })).status, 200);
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /<span class="dim-label">yes<\/span>/);
  });

  test("My PRs lists every open PR with its status; ones waiting on others do not count as needing you", async () => {
    const before = Number(/data-needs-count="(\d+)"/.exec(await (await fetch(`${server.url}/?part=1`)).text())?.[1]);
    const pr = (n: number, state: string | null, needs_me: boolean) =>
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: `https://github.com/acme/web/pull/${n}`,
        title: `pr ${n}`,
        state,
        needs_me,
      });
    await hub(
      ["item", "put", "--stdin"],
      [
        pr(301, "draft", false),
        pr(302, "in review", false),
        pr(303, "commented", true),
        pr(304, "changes requested", true),
        pr(305, "approved", true),
        pr(306, "merged", false),
        pr(307, null, false),
      ].join("\n"),
    );
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const card = /data-group="prs"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const row = (n: number) =>
      new RegExp(
        `<li class="need tone-([a-z]+)"[^>]*>\\s*<span class="n-caret"></span>\\s*<span class="need-main"><span class="need-line"><span class="verb verb-inline">([^<]+)</span><a[^>]*>pr ${n}<`,
      )
        .exec(card)
        ?.slice(1, 3);
    assert.deepEqual(row(301), ["grey", "Draft"]);
    assert.deepEqual(row(302), ["blue", "In review"]);
    assert.deepEqual(row(303), ["teal", "Comments"]);
    assert.deepEqual(row(304), ["orange", "Fix PR"]);
    assert.deepEqual(row(305), ["green", "Approved"]);
    assert.deepEqual(row(306), ["violet", "Merged"]);
    assert.deepEqual(row(307), ["grey", "Linked"]);
    assert.match(html, new RegExp(`data-needs-count="${before + 3}"`));
    assert.deepEqual(tabCounts(card, "needs-prs"), { open: 3, draft: 1, review: 1, all: 8 });
    assert.match(
      card,
      /data-tab-panel="all" hidden>\s*<span class="n-caret"><\/span>\s*<span class="need-main">[\s\S]*?>pr 306</,
    );
    assert.match(
      card,
      /data-tab-panel="all" hidden>\s*<span class="n-caret"><\/span>\s*<span class="need-main">[\s\S]*?>pr 307</,
    );
    assert.match(
      card,
      /data-tab-panel="draft all" hidden>\s*<span class="n-caret"><\/span>\s*<span class="need-main">[\s\S]*?>pr 301</,
    );
    assert.match(
      card,
      /data-tab-panel="review all" hidden>\s*<span class="n-caret"><\/span>\s*<span class="need-main">[\s\S]*?>pr 302</,
    );
    assert.match(
      card,
      /data-tab-panel="open all">\s*<span class="n-caret"><\/span>\s*<span class="need-main">[\s\S]*?>pr 303</,
    );
  });

  test("needs cards, Today and Activity open on what is still to do, with the rest under All", async () => {
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "grafana", kind: "alert", ref: "alert-1", title: "API 5xx", needs_me: true }),
    );
    await hub(
      ["day", "set", today(), "--stdin"],
      "## Today\n\n- [x] write the migration\n- [ ] ship it\n- read the handler\n",
    );
    await hub(["step", "add", "ENG-42", "write the migration"]);
    await hub(["step", "done", "ENG-42", "1"]);
    await hub(["log", "ENG-42", "read the export code", "--kind", "reading"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const fix = /data-group="fix"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    assert.deepEqual(tabCounts(fix, "needs-fix"), { open: 1, all: 1 });
    assert.deepEqual(tabCounts(html, "today"), { open: 1, all: 2 });
    const activity = tabCounts(html, "activity");
    assert.equal((activity.all ?? 0) - (activity.work ?? 0) >= 1, true);
    assert.match(
      html,
      /<div data-tab-panel="work">[\s\S]*?step 1 done[\s\S]*?<div data-tab-panel="all" hidden>[\s\S]*?read the export code/,
    );
    assert.doesNotMatch(
      /<div data-tab-panel="work">[\s\S]*?<div data-tab-panel="all"/.exec(html)?.[0] ?? "",
      /read the export code/,
    );
  });

  test("a ticket page opens Steps, Items, Waiting on and Timeline on what is still open", async () => {
    await hub(["step", "add", "ENG-7", "measure"]);
    await hub(["step", "add", "ENG-7", "fix"]);
    await hub(["step", "done", "ENG-7", "1"]);
    await hub(["wait", "ENG-7", "ana", "https://acme.slack.com/archives/C1/p1"]);
    await hub(["wait", "ENG-7", "bo", "https://acme.slack.com/archives/C1/p2"]);
    await hub(["wait", "close", "https://acme.slack.com/archives/C1/p2"]);
    await hub(
      ["item", "put", "--stdin"],
      ["https://github.com/acme/web/pull/71", "https://github.com/acme/web/pull/72"]
        .map((url) => JSON.stringify({ source: "github", kind: "pr", url, title: url.slice(-2), state: "open" }))
        .join("\n"),
    );
    for (const ref of ["https://github.com/acme/web/pull/71", "https://github.com/acme/web/pull/72"])
      await hub(["item", "attach", ref, "ENG-7"]);
    await hub(["item", "close", "https://github.com/acme/web/pull/72"]);
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    const steps = tabCounts(page, "steps");
    assert.equal((steps.all ?? 0) - (steps.open ?? 0), 1);
    assert.match(
      page,
      /<li class="done" data-key="s-\d+" data-tab-panel="all" hidden><span class="check"><\/span><span class="s-title">measure/,
    );
    assert.deepEqual(tabCounts(page, "waits"), { open: 1, all: 2 });
    assert.match(page, /data-tab-panel="all" hidden>[\s\S]*?>bo</);
    const items = tabCounts(page, "items");
    assert.equal((items.all ?? 0) - (items.open ?? 0), 1);
    assert.match(
      page,
      /data-tab-panel="all" hidden>\s*<span class="n-caret"><\/span>\s*<span class="verb">[^<]+<\/span>\s*<span class="need-main"><span class="need-line"><a[^>]*>72</,
    );
    const open = /<li class="need [^"]*" data-key="item-\d+"[^>]*>[\s\S]*?>71<[\s\S]*?<\/li>/.exec(page)?.[0] ?? "";
    assert.match(open, /data-act="item-done" data-id="\d+"/);
    assert.match(open, /data-act="item-snooze" data-id="\d+" data-for="tomorrow"/);
    assert.match(open, /data-act="item-detach" data-id="\d+" data-ticket="ENG-7"/);
    const closed = /<li class="need [^"]*" data-key="item-\d+"[^>]*>[\s\S]*?>72<[\s\S]*?<\/li>/.exec(page)?.[0] ?? "";
    assert.match(closed, /data-act="item-reopen"/);
    assert.match(page, /data-key="timeline-work" data-tab-panel="work">/);
    assert.match(page, /data-key="timeline-all" data-tab-panel="all" hidden>/);
  });

  test("every needs row has the same three controls, and a pinned row moves to the top", async () => {
    await hub(
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
    assert.equal((await call("PUT", `/pins/${encodeURIComponent(last ?? "")}`, { on: true })).status, 200);
    const pinned = await (await fetch(`${server.url}/?part=1`)).text();
    const first = /<li class="(need [^"]*)" data-key="([^"]+)"/.exec(pinned);
    assert.equal(first?.[2], last);
    assert.match(first?.[1] ?? "", /\bpinned\b/);
    assert.match(pinned, new RegExp(`data-act="pin" data-row="${last}" data-on="0"`));
    assert.equal((await call("PUT", "/pins/ticket-1", { on: true })).status, 400);
  });

  test("settings show the database and save config through the same checks as the CLI", async () => {
    const html = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(html.includes(dbFile));
    assert.match(html, /Schema<\/span><div class="set-control">v19/);
    const titles = [...html.matchAll(/<h2><button type="button" class="fold" data-fold="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(titles, ["Sources", "Agent", "Away", "Database", "Behavior", "Dashboard", "Keyboard"]);
    assert.equal(html.match(/<div class="col">/g)?.length, 1);
    assert.equal((await setConfigKey("openLinearIn", '"app"')).status, 200);
    const command = await setConfigKey("syncCommand", '["sh","-c","touch /tmp/x"]');
    assert.equal(command.status, 400);
    assert.equal((await setConfigKey("judgeCommand", '["sh","-c","touch /tmp/x"]')).status, 400);
    assert.doesNotMatch(html, /data-config-input="syncCommand"/);
    const bad = await setConfigKey("theme", '"pink"');
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /theme must be one of/);
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "linear", kind: "issue", url: "https://linear.app/acme/issue/ENG-7", needs_me: true }),
    );
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /href="linear:\/\/acme\/issue\/ENG-7"/);
  });

  test("ongoing ticket rows can be dragged within their folder, and a drop is a human action the brief reports", async () => {
    await hub(["ticket-new", "ENG-8", "Second todo", "--dir", "todo"]);
    await hub(["move", "ENG-42", "done"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, /data-key="t-ENG-7" data-href="\/t\/ENG-7" draggable="true" data-id="ENG-7" data-dir="todo"/);
    assert.doesNotMatch(html, /data-key="t-ENG-42"[^>]*draggable/);
    await call("GET", "/brief");
    const drop = await fetch(`${server.url}/api/v1/tickets/ENG-7/order`, {
      method: "PUT",
      headers: { authorization: `Bearer ${server.token}`, "x-hub-actor": "human", "content-type": "application/json" },
      body: JSON.stringify({ place: 2 }),
    });
    assert.equal(drop.status, 200);
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    assert.ok(after.indexOf('data-key="t-ENG-8"') < after.indexOf('data-key="t-ENG-7"'));
    const brief = await (
      await fetch(`${server.url}/api/v1/brief`, {
        headers: { authorization: `Bearer ${server.token}`, accept: "text/plain" },
      })
    ).text();
    assert.match(brief, /ENG-7 put at #2 in its folder/);
    assert.equal((await call("PUT", "/tickets/ENG-7/order", { place: -1 })).status, 400);
  });

  test("tickets split into a tab per open folder, in openDirs order, and a recently done tab", async () => {
    await hub(["ticket-new", "ENG-9", "Look at flaky test", "--dir", "triage"]);
    let html = await (await fetch(`${server.url}/?part=1`)).text();
    const panel = (tab: string) =>
      new RegExp(`<ul class="rows ticket-list" data-tab-panel="${tab}"([^>]*)>([\\s\\S]*?)</ul>`).exec(html) ?? [];
    assert.match(
      html,
      /<span class="tabs" role="tablist" data-tabs="tickets"><button[^>]*data-tab="inprogress" aria-selected="true">In progress <b>1<\/b><\/button><button[^>]*data-tab="todo" aria-selected="false">To do <b>1<\/b><\/button><button[^>]*data-tab="triage" aria-selected="false">Triage <b>1<\/b><\/button><button[^>]*data-tab="backlog" aria-selected="false">Backlog <b>0<\/b><\/button><button[^>]*data-tab="unfiled" aria-selected="false">Unfiled <b>0<\/b><\/button><button[^>]*data-tab="done" aria-selected="false">Done <b>0<\/b><\/button><\/span>/,
    );
    assert.equal(panel("inprogress")[1], "");
    assert.match(panel("inprogress")[2] ?? "", /data-key="t-ENG-42"/);
    assert.doesNotMatch(panel("inprogress")[2] ?? "", /data-key="t-ENG-7"/);
    assert.equal(panel("todo")[1], " hidden");
    assert.match(panel("todo")[2] ?? "", /data-key="t-ENG-7"/);
    assert.match(panel("triage")[2] ?? "", /data-key="t-ENG-9"/);
    assert.match(panel("backlog")[2] ?? "", /<li class="empty">/);

    await hub(["move", "ENG-7", "done"]);
    html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      panel("done")[2] ?? "",
      /class="ticket is-closed" data-key="t-ENG-7"[\s\S]*?<span class="t-next">done /,
    );
    assert.doesNotMatch(panel("todo")[2] ?? "", /data-key="t-ENG-7"/);
    assert.match(html, /data-tab="done" aria-selected="false">Done <b>1<\/b>/);
    assert.match(html, /title="done in the last 14 days">1 done</);
    assert.equal((await setConfigKey("horizon", '"month"')).status, 200);
    const month = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(month, /title="done this month">1 done</);
    assert.match(month, /data-tab="done" aria-selected="false">Done <b>1<\/b>/);
  });

  test("a ticket row shows three PR chips and folds the rest behind +N", async () => {
    const prs = [1, 2, 3, 4, 5].map((n) =>
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: `https://github.com/acme/web/pull/${n}`,
        title: `pr ${n}`,
        ticket: "ENG-7",
      }),
    );
    await hub(["item", "put", "--stdin"], prs.join("\n"));
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const row = /data-key="t-ENG-7"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    const chips = /<span class="chips">([\s\S]*?)<details/.exec(row)?.[1] ?? "";
    assert.equal(chips.match(/class="chip /g)?.length, 3);
    assert.match(
      row,
      /<details class="menu chip-more" data-key="prs-ENG-7"><summary class="chip" title="2 more PRs">\+2<\/summary>/,
    );
    assert.match(row, /chip-pop">.*pull\/4.*pull\/5/);
  });

  test("a folding row has a chevron button and its body after the header cells; a plain row keeps an empty slot", async () => {
    await hub(["set", "ENG-7", "decide", "pick one"]);
    await hub(["draft", "ENG-7", "ask ops", "--stdin"], "a long body");
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const row = /<li[^>]*data-key="send-ENG-7-ask ops"[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
    assert.match(
      row,
      /data-fold-key="nfold-send-ENG-7-ask ops">\s*<button type="button" class="n-caret" data-fold-toggle aria-expanded="false"[\s\S]*?<span class="need-main">[\s\S]*?<span class="need-ticket">[\s\S]*?<span class="need-age">[\s\S]*?<span class="rail">[\s\S]*?<div class="n-ask">[\s\S]*?<div class="n-more"><div class="n-body md"><p>a long body<\/p><\/div><\/div>\s*<\/li>/,
    );
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/web/pull/9",
        title: "Plain",
        needs_me: true,
      }),
    );
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    const plain = /<li[^>]*data-key="item-\d+"[^>]*>\s*<span class="n-caret"><\/span>(?:(?!<\/li>)[\s\S])*>Plain</.exec(
      after,
    );
    assert.ok(plain);
    assert.doesNotMatch(plain[0], /data-fold-key/);
  });

  test("ticket priority shows as bars before the id, urgent as a filled mark, none as an empty slot", async () => {
    const db = new DatabaseSync(dbFile);
    const setPriority = (id: string, priority: string | null) =>
      db.prepare("UPDATE ticket SET tracker_priority = ? WHERE id = ?").run(priority, id);
    setPriority("ENG-42", "High");
    setPriority("ENG-7", null);
    let html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      html,
      /<div class="t-top"><span class="prio tone-orange" title="High" aria-label="High priority"><svg viewBox="0 0 16 16">(<rect class="on"[^>]*\/>){3}<\/svg><\/span><a[^>]*>ENG-42</,
    );
    assert.match(
      html,
      /<div class="t-top"><span class="prio tone-grey" aria-hidden="true"><svg viewBox="0 0 16 16">(<rect x[^>]*\/>){3}<\/svg><\/span><a[^>]*>ENG-7</,
    );
    assert.doesNotMatch(html, /class="pill tone-orange">High</);
    setPriority("ENG-7", "Urgent");
    db.close();
    html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      html,
      /<div class="t-top"><span class="prio tone-red prio-urgent" title="Urgent"[^>]*><svg[\s\S]*?<\/svg><\/span><a[^>]*>ENG-7</,
    );
    assert.match(
      await (await fetch(`${server.url}/t/ENG-42`)).text(),
      /<div class="page-head"><span class="prio tone-orange" title="High"/,
    );
  });

  test("an unsent ticket draft is a Send row under Reply's Open tab; once sent it stays on the ticket page only", async () => {
    const home = async () => {
      const html = await (await fetch(`${server.url}/?part=1`)).text();
      return {
        html,
        reply: /data-group="reply"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "",
        needs: Number(/data-needs-count="(\d+)"/.exec(html)?.[1]),
      };
    };
    const counts = async (path: string) => tabCounts(await (await fetch(`${server.url}${path}`)).text(), "drafts");
    const before = await home();
    const page = await counts("/t/ENG-7?part=1");
    assert.doesNotMatch(before.html, /data-block="drafts"|data-fold="Drafts"/);
    for (const key of ["Overview", "Tickets", "Today", "Activity"])
      assert.match(before.html, new RegExp(`<h2><button type="button" class="fold" data-fold="${key}"`));

    await hub(["draft", "ENG-7", "tell qa", "--stdin", "--channel", "#qa"], "fix is on staging");
    const drafted = await home();
    assert.match(
      drafted.reply,
      /<li class="need tone-teal" data-key="send-ENG-7-tell qa"[^>]*>[\s\S]*?<span class="need-title">tell qa<\/span>[\s\S]*?<span class="need-sub">#qa<\/span>[\s\S]*?data-copy="fix is on staging"/,
    );
    assert.equal(drafted.needs, before.needs + 1);
    assert.equal(tabCounts(drafted.html, "needs-reply").open, (tabCounts(before.html, "needs-reply").open ?? 0) + 1);

    await hub(["posted", "ENG-7", "tell qa"]);
    const sent = await home();
    assert.doesNotMatch(sent.html, /tell qa/);
    assert.equal(sent.needs, before.needs);
    const pageAfter = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.deepEqual(tabCounts(pageAfter, "drafts"), { open: page.open, all: (page.all ?? 0) + 1 });
    assert.match(pageAfter, /data-key="td-tell qa" data-tab-panel="all" hidden>/);
    assert.match(pageAfter, /data-act="draft-unsent" data-ticket="ENG-7" data-label="tell qa">Not sent</);

    assert.equal((await call("POST", "/tickets/ENG-7/drafts/tell%20qa/unposted", {})).status, 200);
    assert.match((await home()).reply, /data-key="send-ENG-7-tell qa"/);
  });

  test("an item row shows its open drafts with Copy and Sent, and the ticket page shows drafts of its items", async () => {
    const pr = "https://github.com/acme/web/pull/140";
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "github", kind: "review_request", url: pr, title: "Cap exports", needs_me: true }),
    );
    await hub(["draft", pr, "review", "--stdin"], "LGTM");
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    const row =
      /<li[^>]*data-key="item-\d+"[\s\S]*?<\/li>/.exec(home.slice(home.indexOf("Cap exports") - 2000))?.[0] ?? "";
    assert.match(row, /<span class="chip tone-teal" title="draft">review<\/span>/);
    assert.match(row, /class="chip-btn" data-copy="LGTM">Copy</);
    assert.match(
      row,
      new RegExp(`class="chip-btn primary" data-act="sent" data-ticket="${pr}" data-label="review">Sent<`),
    );
    assert.match(row, /<div class="n-body n-draft md"><p>LGTM<\/p><\/div>/);
    assert.doesNotMatch(home, new RegExp(`data-key="send-${pr}`));
    assert.equal([...home.matchAll(/data-act="sent"[^>]*data-label="review"/g)].length, 1);
    const needs = (html: string) => Number(/data-needs-count="(\d+)"/.exec(html)?.[1]);
    const id = /data-key="item-(\d+)"/.exec(row)?.[1] ?? "";

    assert.equal((await call("POST", `/items/${id}/snooze`, { for: "1h" })).status, 200);
    const snoozed = await (await fetch(`${server.url}/?part=1`)).text();
    const reply = /data-group="reply"[\s\S]*?<\/section>/.exec(snoozed)?.[0] ?? "";
    assert.match(reply, new RegExp(`data-key="send-${pr}-review"[\\s\\S]*?<span class="need-sub">acme/web#140</span>`));
    assert.equal([...snoozed.matchAll(/data-act="sent"[^>]*data-label="review"/g)].length, 1);
    assert.equal(needs(snoozed), needs(home));
    assert.equal((await call("POST", `/items/${id}/reopen`, {})).status, 200);

    assert.equal((await call("POST", `/items/${id}/close`, {})).status, 200);
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), new RegExp(`data-key="send-${pr}-review"`));
    assert.equal((await call("POST", `/items/${id}/reopen`, {})).status, 200);

    await hub(["item", "attach", pr, "ENG-7"]);
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(page, new RegExp(`data-key="td-${pr}-review"`));
    assert.match(page, new RegExp(`data-act="sent" data-ticket="${pr}" data-label="review"`));
  });

  test("an item's question shows Yes and No on its row, and the answer stays on the row and in the log", async () => {
    const pr = "https://github.com/acme/web/pull/141";
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "github", kind: "review_request", url: pr, title: "Retry webhooks", needs_me: true }),
    );
    await hub(["item", "ask", pr, "Review", "this?"]);
    const row = async () => {
      const home = await (await fetch(`${server.url}/?part=1`)).text();
      return /<li[^>]*data-key="item-\d+"(?:(?!<\/li>)[\s\S])*Retry webhooks[\s\S]*?<\/li>/.exec(home)?.[0] ?? "";
    };
    assert.match(
      await row(),
      /<span class="ask"><span>Review this\?<\/span><button[^>]*data-act="item-answer"[^>]*data-answer="yes"/,
    );
    const id = /data-key="item-(\d+)"/.exec(await row())?.[1] ?? "";
    const answered = await fetch(`${server.url}/api/v1/items/${id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "x-hub-actor": "human" },
      body: JSON.stringify({ answer: "yes" }),
    });
    assert.equal(answered.status, 200);
    assert.match(await row(), /<span class="ask"><span>Review this\? Yes<\/span><\/span>/);
    assert.match(await hub(["brief"]), /yes to "Review this\?": review_request Retry webhooks/);
    assert.equal((await call("POST", `/items/${id}/unanswer`, {})).status, 200);
    assert.match(await row(), /data-act="item-answer"/);
  });

  test("a review draft shows its verdict and each file:line comment with Copy", async () => {
    const pr = "https://github.com/acme/web/pull/142";
    const file = join(dir, "comments.json");
    writeFileSync(file, JSON.stringify([{ path: "src/limit.ts", line: 12, body: "Make it configurable." }]));
    await hub(["draft", pr, "review", "--stdin", "--verdict", "request_changes", "--comments", file], "Close.");
    const comment =
      /<li><code class="d-path">src\/limit\.ts:12<\/code><div class="d-cbody md"><p>Make it configurable\.<\/p><\/div><button type="button" class="chip-btn" data-copy="Make it configurable\.">Copy<\/button><\/li>/;
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    const send = new RegExp(`data-key="send-${pr}-review"[\\s\\S]*?</li>`).exec(home)?.[0] ?? "";
    assert.match(send, /<span class="pill tone-orange">request changes<\/span>/);
    assert.match(send, comment);

    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({ source: "github", kind: "review_request", url: pr, title: "Cap limits", needs_me: true }),
    );
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    assert.doesNotMatch(after, new RegExp(`data-key="send-${pr}`));
    const row = /<li[^>]*data-key="item-\d+"(?:(?!<\/li>)[\s\S])*Cap limits[\s\S]*?<\/li>/.exec(after)?.[0] ?? "";
    assert.match(row, /<div class="n-body n-draft md"><p>Close\.<\/p><\/div>/);
    assert.match(row, /<span class="pill tone-orange">request changes<\/span>/);
    assert.match(row, comment);
  });

  test("a ticket page marks its drafts sent like the dashboard", async () => {
    await hub(["draft", "ENG-7", "ask ops", "--stdin"], "can we cap exports?");
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(page, /data-act="sent" data-ticket="ENG-7" data-label="ask ops"/);
  });

  test("ticket ids carry their full id as a title and text fields render markdown", async () => {
    await hub(["set", "ENG-7", "decide", "use `retry_after` or **backoff**?"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, /<a class="tid" href="\/t\/ENG-7" title="ENG-7">ENG-7<\/a>/);
    assert.match(html, /<span class="need-title">use <code>retry_after<\/code> or <strong>backoff<\/strong>\?<\/span>/);
    assert.match(
      html,
      /data-fold-key="nfold-decide-ENG-7">\s*<button type="button" class="n-caret" data-fold-toggle aria-expanded="false"[^>]*><svg[^>]*>[\s\S]*?<\/svg><\/button>\s*<span class="need-main"><span class="need-line"><span class="need-title">use <code>retry_after[\s\S]*?<\/span><\/span><span class="need-sub">[^<]*<\/span><\/span>/,
    );
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(
      page,
      /<dd class="md tone-text-amber"><p>use <code>retry_after<\/code> or <strong>backoff<\/strong>\?<\/p><\/dd>/,
    );
  });

  test("draft bodies and labels and note titles render markdown, Copy keeps the raw text", async () => {
    await hub(["draft", "ENG-7", "ask `ops`", "--stdin"], "Run:\n```\nmake db\n```");
    await hub(["note", "ENG-7", "about **limits**", "--stdin"], "body");
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, /<span class="need-title">ask <code>ops<\/code><\/span>/);
    assert.match(html, /<div class="n-body md"><p>Run:<\/p><pre><code>make db<\/code><\/pre><\/div>/);
    assert.match(html, /data-copy="Run:\n```\nmake db\n```"/);
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(page, /<span class="d-label">ask <code>ops<\/code><\/span>/);
    assert.match(page, /<summary>about <strong>limits<\/strong><\/summary>/);
  });

  test("the page shows each thing once: no ticket id twice, a Sent? draft has no Send row", async () => {
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/web/pull/9",
        title: "ENG-42: banner",
        needs_me: true,
      }),
    );
    await hub(["source", "github", "--cursor", "c1"]);
    await hub(["source", "slack", "--error", "no connector"]);
    await hub(["draft", "ENG-7", "ask product", "--stdin"], "Can we cap exports?");
    await hub(
      ["match", "ENG-7", "ask product", "--ref", "https://acme.slack.com/archives/C1/p1", "--stdin"],
      "can we cap exports",
    );
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, />banner<\/a>/);
    assert.match(html, /data-key="match-ENG-7-ask product"/);
    assert.doesNotMatch(html, /data-key="send-ENG-7-ask product"/);
    assert.doesNotMatch(html, /class="live"/);
  });

  test("blocks render in the saved layout, a bad layout is refused, and tickets show what needs you", async () => {
    await hub(
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
    assert.equal((await setConfigKey("layout", JSON.stringify(layout))).status, 200);
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
    assert.match(ticket, /data-fold="Needs you" aria-expanded="true">Needs you<\/button><\/h2>[\s\S]*?pull\/9/);
    const bad = await setConfigKey("layout", '{"left":["today","today"],"right":[]}');
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /layout lists a block twice/);
    assert.equal((await setConfigKey("layout", '{"left":["nope"],"right":[]}')).status, 400);
  });

  test("the overview sits in the top row and counts needs, steps, tickets and steps done per day", async () => {
    await hub(["step", "add", "ENG-42", "write the migration"]);
    await hub(["step", "add", "ENG-42", "ship it"]);
    await hub(["step", "done", "ENG-42", "1"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const top = /data-col="top">([\s\S]*?)<\/div>\s*<div class="col" data-col="left">/.exec(html)?.[1] ?? "";
    assert.match(top, /data-block="overview"/);
    assert.match(top, /<span class="tile-title">Needs you<\/span>[\s\S]*?<div class="hero">3<\/div>/);
    assert.match(top, /<b>50%<\/b><small>1 of 2 steps<\/small>/);
    assert.match(top, /<title>In progress 1<\/title>/);
    assert.match(top, /<span class="tile-title">Steps done<\/span><\/div><div class="hero">1<\/div>/);
    assert.equal([...top.matchAll(/data-tip="/g)].length, 14);
    assert.match(
      html,
      /data-key="t-ENG-42"[\s\S]*?<span class="t-progress style-ring"><svg class="ring"[\s\S]*?<span class="pct">50%<\/span>/,
    );

    assert.equal((await setConfigKey("horizon", '"7d"')).status, 200);
    assert.equal((await setConfigKey("progressStyle", '"half"')).status, 200);
    const after = await (await fetch(`${server.url}/?part=1`)).text();
    assert.equal([...after.matchAll(/data-tip="/g)].length, 7);
    assert.match(after, /<span class="t-progress style-half"><svg class="half"/);
    const ticket = await (await fetch(`${server.url}/t/ENG-42?part=1`)).text();
    assert.match(ticket, /<span class="t-progress style-half big">/);
    assert.equal((await setConfigKey("horizon", '"9d"')).status, 400);
    assert.equal((await setConfigKey("progressStyle", '"pie"')).status, 400);
  });

  test("a card can move to the top row or be hidden, and settings can show it again", async () => {
    const layout = { top: ["tickets"], left: ["today"], right: ["overview"] };
    assert.equal((await setConfigKey("layout", JSON.stringify(layout))).status, 200);
    assert.equal((await setConfigKey("hiddenBlocks", '["activity"]')).status, 200);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, /data-col="top"><div class="block" data-block="tickets" id="b-tickets">/);
    assert.match(html, /<div class="block" data-block="activity" id="b-activity" hidden><\/div>/);
    assert.match(html, /data-col="right"><div class="block" data-block="overview" id="b-overview"><details/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(
      settings,
      /class="chip-toggle" aria-pressed="false" data-config="hiddenBlocks" data-value="\[\]">Activity</,
    );
    const bad = await setConfigKey("hiddenBlocks", '["nope"]');
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /hiddenBlocks has an unknown block nope/);
    const twice = await setConfigKey("layout", '{"top":["today"],"left":["today"],"right":[]}');
    assert.equal(twice.status, 400);
  });

  test("pages carry the EngineerHub name and logo", async () => {
    const home = await (await fetch(`${server.url}/`)).text();
    assert.match(home, /<title>EngineerHub<\/title>/);
    assert.match(home, /<a class="brand" href="\/"><span class="logo"><svg [^>]*>[\s\S]*?<\/svg><\/span>EngineerHub/);
    assert.match(await (await fetch(`${server.url}/settings`)).text(), /<title>Settings · EngineerHub<\/title>/);
  });

  test("a setting that only matters while a switch is on is off with it", async () => {
    const offRow = (html: string, label: string) =>
      new RegExp(`<div class="set-row off" inert><span class="set-label">${label}</span>`).test(html);
    const settings = async () => (await fetch(`${server.url}/settings?part=1`)).text();
    let html = await settings();
    assert.ok(offRow(html, "Slack team ID"));
    assert.ok(offRow(html, "Alert channels"));
    assert.ok(!offRow(html, "Review requests"));
    assert.ok(!offRow(html, "Keep"));
    assert.equal((await setConfigKey("openSlackIn", '"app"')).status, 200);
    assert.equal((await setConfigKey("autoBackup", "false")).status, 200);
    assert.equal((await setConfigKey("fetch", '{"github":false}')).status, 200);
    html = await settings();
    assert.ok(!offRow(html, "Slack team ID"));
    assert.ok(offRow(html, "Keep"));
    assert.ok(offRow(html, "Review requests"));
  });

  test("search finds tickets, items, steps and notes from one box", async () => {
    await hub(
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
    await hub(["step", "add", "ENG-7", "measure webhook latency"]);
    const find = async (q: string) =>
      (await (await call("GET", `/find?q=${encodeURIComponent(q)}`)).json()) as {
        kind: string;
        title: string;
        sub: string;
        href: string | null;
        out: string | null;
      }[];
    const sync = await find("sync login");
    assert.equal(sync[0]?.kind, "Ticket");
    assert.equal(sync[0]?.href, "/t/ENG-42");
    const migration = await find("migration");
    assert.ok(migration.some((h) => h.kind === "Ticket" && /\uE000migration\uE001/i.test(h.sub)));
    const hook = await find("webhook");
    assert.ok(
      hook.some((h) => h.kind === "Item" && h.href === "/t/ENG-42" && h.out === "https://github.com/acme/web/pull/77"),
    );
    await hub(
      ["item", "put", "--stdin"],
      JSON.stringify({
        source: "github",
        kind: "review_request",
        url: "https://github.com/acme/api/pull/5",
        title: "Webhook signer",
        needs_me: true,
      }),
    );
    const loose = (await find("signer")).find((h) => h.kind === "Item");
    assert.match(loose?.href ?? "", /^\/#item-\d+$/);
    assert.equal(loose?.out, "https://github.com/acme/api/pull/5");
    assert.ok(hook.some((h) => h.kind === "Step" && h.href === "/t/ENG-7"));
    assert.deepEqual(await find("   "), []);
    assert.ok(Array.isArray(await find('"%_\\')));
    const page = await (await fetch(`${server.url}/`)).text();
    assert.match(page, /data-search-box/);
    assert.doesNotMatch(page, /data-filter/);
    assert.match(await (await fetch(`${server.url}/settings`)).text(), /<a class="gear on" href="\/"/);
  });

  test("in app mode a Slack message keeps its permalink, a channel and Linear open in the app, and Open matches", async () => {
    await hub(["config", "openSlackIn", '"app"']);
    await hub(["config", "slackTeamId", '"T0TEST1"']);
    await hub(["config", "openLinearIn", '"app"']);
    const message = "https://acme.slack.com/archives/C01ABC/p1763440000123456";
    await hub(
      ["item", "put", "--stdin"],
      [
        { source: "slack", kind: "message", url: message, title: "ping", needs_me: true },
        { source: "linear", kind: "issue", url: "https://linear.app/acme/issue/ENG-9", title: "bug", needs_me: true },
      ]
        .map((i) => JSON.stringify(i))
        .join("\n"),
    );
    await hub(["link", "ENG-7", "https://acme.slack.com/archives/C01ABC"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, new RegExp(`<a class="need-title" href="${message}" target="_blank"`));
    assert.match(html, new RegExp(`data-href="${message}"[\\s\\S]*?data-open="${message}"`));
    assert.match(
      html,
      /data-href="linear:\/\/acme\/issue\/ENG-9"[\s\S]*?data-open="linear:\/\/acme\/issue\/ENG-9"[\s\S]*?data-copy="https:\/\/linear.app\/acme\/issue\/ENG-9"/,
    );
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(page, /href="slack:\/\/channel\?team=T0TEST1&amp;id=C01ABC"/);
  });

  test("the page script declares no global that hides a browser function", () => {
    const script = readFileSync(new URL("../src/web/app.js", import.meta.url), "utf8");
    for (const name of [
      "open",
      "close",
      "print",
      "alert",
      "confirm",
      "prompt",
      "find",
      "focus",
      "blur",
      "stop",
      "scroll",
      "fetch",
      "postMessage",
    ]) {
      assert.doesNotMatch(script, new RegExp(`^(async )?function ${name}\\(`, "m"), name);
    }
  });

  test("text from the DB is escaped", async () => {
    await hub(["ticket-new", "NEW-xss", "<script>alert(1)</script>"]);
    const html = await (await fetch(`${server.url}/`)).text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  test("a foreign Host or a missing token is refused", async () => {
    assert.equal(await rawGet("/", "evil.example:80"), 403);
    const port = new URL(server.url).port;
    assert.equal(await rawGet("/", `localhost:${port}`), 200);
    assert.equal((await call("POST", "/items/1/close", {}, "wrong")).status, 401);
  });

  test("the token is kept in a file only the user can read and survives a restart", async () => {
    const file = join(dir, "token");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8").trim(), server.token);
    const first = server.token;
    await server.close();
    server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env, fetchers: [] });
    assert.equal(server.token, first);
    assert.equal((await call("POST", "/items/1/close", {}, first)).status, 200);

    await server.close();
    chmodSync(file, 0o644);
    await assert.rejects(
      async () => serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env, fetchers: [] }),
      /token is readable by others: chmod 600/,
    );
    chmodSync(file, 0o600);
    writeFileSync(file, "not a token\n");
    await assert.rejects(
      async () => serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env, fetchers: [] }),
      /does not hold a hub token/,
    );
    rmSync(file);
    server = await serve({ dbPath: dbFile, port: 0, now: () => new Date(), env: process.env, fetchers: [] });
    assert.notEqual(server.token, first);
  });

  test("actions write through the same functions as the CLI", async () => {
    const review = JSON.stringify({
      source: "github",
      kind: "review_request",
      url: "https://github.com/acme/web/pull/9",
      needs_me: true,
    });
    await hub(["item", "put", "--stdin"], review);
    const id = /^#(\d+)/.exec(await hub(["items", "--needs-me"]))?.[1] ?? "";
    const page = await (await fetch(`${server.url}/`)).text();
    assert.match(page, /data-act="item-done" data-id="\d+"/);
    assert.match(
      page,
      /<details class="menu"[^>]*><summary class="ic ic-more"[^>]*>[\s\S]*?<div class="menu-pop">[\s\S]*?data-act="item-snooze" data-id="\d+" data-for="1h"/,
    );
    assert.equal((await call("POST", `/items/${id}/snooze`, { for: "1h" })).status, 200);
    assert.equal(await hub(["items", "--needs-me"]), "no items");
    const db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT snoozed_until FROM item WHERE id = ?").get(Number(id)) as { snoozed_until: string };
    db.close();
    const minutes = (Date.parse(row.snoozed_until) - Date.now()) / 60000;
    assert.ok(minutes > 58 && minutes <= 60, `snoozed ${minutes} minutes`);
    assert.equal((await call("POST", `/items/${id}/snooze`, { for: "soon" })).status, 400);
    assert.equal((await call("POST", `/items/${id}/close`, {})).status, 200);
    assert.match(await hub(["items", "--all"]), /pull\/9 \| closed$/m);

    await hub(["draft", "ENG-7", "ask product", "--stdin"], "Can we cap exports?");
    assert.equal(
      (await call("POST", `/tickets/ENG-7/drafts/${encodeURIComponent("ask product")}/posted`, {})).status,
      200,
    );
    assert.match(await hub(["drafts", "ENG-7"]), /ask product \| posted \| .* \| wording pending/);

    const bad = await call("POST", "/waits/42/close", {});
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /no open wait 42/);
    assert.equal((await call("POST", "/nope", {})).status, 404);
  });

  test("every dashboard click that changes state can be taken back", async () => {
    const json = async (r: Promise<Response>) => {
      const res = await r;
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as Record<string, unknown>;
    };
    const ticket = async (id: string) => (await json(call("GET", `/tickets/${id}`))) as { gate: string | null };
    const gate = (await ticket("ENG-42")).gate;
    await json(call("POST", "/tickets/ENG-42/gate", { answer: "yes" }));
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(home, /data-act="gate-reopen" data-ticket="ENG-42"/);
    await json(call("POST", "/tickets/ENG-42/gate/reopen", {}));
    assert.equal((await ticket("ENG-42")).gate, gate);
    assert.doesNotMatch(await hub(["events", "ENG-42", "--full"]), /Yes: /);
    assert.equal((await call("POST", "/tickets/ENG-42/gate/reopen", {})).status, 400);

    const wait = await json(
      call("POST", "/waits", {
        ticket: "ENG-7",
        who: "ana",
        url: "https://acme.slack.com/archives/C1/p9",
        ping_after: "1h",
      }),
    );
    const pinged = await json(call("POST", `/waits/${wait.id}/pinged`, { for: "tomorrow" }));
    assert.deepEqual(pinged.before, { ping_after: wait.ping_after, pinged_at: null });
    assert.match(await hub(["events", "ENG-7", "--full"]), /Pinged ana/);
    await json(call("POST", `/waits/${wait.id}/unpinged`, { ping_after: wait.ping_after }));
    assert.doesNotMatch(await hub(["events", "ENG-7", "--full"]), /Pinged ana/);
    assert.match(await hub(["waits"]), /ana/);

    await hub(["draft", "ENG-7", "tell qa", "--stdin"], "fix is on staging");
    const later = await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/later", { for: "4h" }));
    assert.deepEqual(later.before, { send_at: null });
    await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/send-at", {}));
    assert.equal(await hub(["drafts", "ENG-7"]).then((t) => /tell qa \| draft(?! .*send)/.test(t)), true);

    const sent = { sent_text: "fix is live on staging", sent_ref: "https://acme.slack.com/archives/C1/p10" };
    await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/match", sent));
    const asked = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(asked, /data-act="match" data-ticket="ENG-7" data-label="tell qa" data-text="fix is live on staging"/);
    await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/match", { answer: "yes" }));
    await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/unposted", {}));
    await json(call("POST", "/tickets/ENG-7/drafts/tell%20qa/match", sent));
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /data-key="match-ENG-7-tell qa"/);
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
    await hub(["log", "ENG-7", "written elsewhere"]);
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error("no change")), 2000))]);
    await reader.cancel();
  });

  test("Sync of sources with no source on fails and names the setting", async () => {
    assert.equal((await call("POST", "/sync", {})).status, 202);
    const failed = await waitFor(async () => {
      const s = await syncState();
      return s.status === "running" ? undefined : s;
    });
    assert.deepEqual([failed.status, failed.detail], ["failed", "no source is on (hub config fetch)"]);
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      html,
      /<div class="sync"><button type="button" class="ic ic-sync sync-btn bad" data-act="sync" data-what="sources" title="Sync sources\nFailed: no source is on \(hub config fetch\)"/,
    );
    assert.equal((await call("POST", "/sync", { what: "everything" })).status, 400);
  });

  test("Sync of the agent runs the configured command once at a time with HUB_DB and HUB_URL set, and reports failure", async () => {
    const db = new DatabaseSync(dbFile);
    const setCommand = (argv: string[]) =>
      db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('syncCommand', ?)").run(JSON.stringify(argv));
    setCommand([
      "node",
      "-e",
      "setTimeout(() => process.stdout.write(process.env.HUB_DB + ' ' + process.env.HUB_URL), 300)",
    ]);
    assert.equal((await call("POST", "/sync", { what: "agent" })).status, 202);
    assert.equal((await call("POST", "/sync", {})).status, 409);
    const running = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      running,
      /class="ic ic-sync sync-btn" data-act="sync" data-what="sources" title="Syncing" aria-label="Syncing" disabled>/,
    );
    assert.match(running, /<button type="button" data-act="sync" data-what="all" disabled>/);
    assert.match(running, /<span class="src src-busy" title="started [^"]*"><i><\/i>Agent<\/span>/);
    const finished = await waitFor(async () => {
      const s = await syncState();
      return s.status === "running" ? undefined : s;
    });
    assert.deepEqual([finished.status, finished.detail], ["finished", `${dbFile} ${server.url}`]);
    assert.match(
      await (await fetch(`${server.url}/?part=1`)).text(),
      /<div class="sync"><button type="button" class="ic ic-sync sync-btn" data-act="sync" data-what="sources" title="Sync sources\n[^"]+"/,
    );

    setCommand(["node", "-e", "console.error('no connector'); process.exit(3)"]);
    assert.equal((await call("POST", "/sync", { what: "agent" })).status, 202);
    const failed = await waitFor(async () => {
      const s = await syncState();
      return s.status === "running" ? undefined : s;
    });
    db.close();
    assert.deepEqual([failed.status, failed.detail], ["failed", "exit 3: no connector"]);
    assert.match(
      await (await fetch(`${server.url}/?part=1`)).text(),
      /<span class="src src-bad" title="last run [^"]*\nauto sync off\nexit 3: no connector"><i><\/i>Agent<\/span>/,
    );
  });

  test("auto sync runs the agent once the interval passes, and not when auto sync is off", async () => {
    await server.close();
    let clock = new Date("2026-11-18T09:00:00Z");
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('syncCommand', ?)").run(
      JSON.stringify(["node", "-e", "process.stdout.write('auto')"]),
    );
    db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES ('autoSync', 'true')").run();
    db.close();
    server = await serve({
      dbPath: dbFile,
      port: 0,
      now: () => clock,
      env: process.env,
      autoSyncCheckMs: 20,
      fetchers: [],
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await syncState()).status, "idle");
    clock = new Date("2026-11-18T13:01:00Z");
    const ran = await waitFor(async () => {
      const s = await syncState();
      return s.status === "finished" ? s : undefined;
    });
    assert.equal(ran.detail, "auto");

    await hub(["config", "autoSync", "false"]);
    clock = new Date("2026-11-18T18:00:00Z");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await syncState()).at, ran.at);
    assert.equal((await setConfigKey("syncEvery", '"5m"')).status, 400);
  });
});

describe("api v1", () => {
  test("every route needs the token except the OpenAPI document, which lists them all", async () => {
    const bare = await fetch(`${server.url}/api/v1/tickets`);
    assert.equal(bare.status, 401);
    assert.match(((await bare.json()) as { error: string }).error, /Authorization: Bearer/);
    const doc = (await (await fetch(`${server.url}/api/v1/openapi.json`)).json()) as {
      paths: Record<
        string,
        Record<string, { operationId: string; parameters?: { in: string; description?: string }[] }>
      >;
    };
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    assert.deepEqual(ops.map((o) => o.operationId).sort(), ROUTES.map((r) => r.name).sort());
    for (const o of ops) for (const p of o.parameters ?? []) assert.ok(p.description, `${o.operationId} ${p.in} param`);
  });

  test("reads return the CLI's JSON, or its text with Accept: text/plain", async () => {
    const json = (await (await call("GET", "/tickets/ENG-42")).json()) as { ticket: { id: string } };
    assert.equal(json.ticket.id, "ENG-42");
    const text = await fetch(`${server.url}/api/v1/tickets/ENG-42`, {
      headers: { authorization: `Bearer ${server.token}`, accept: "text/plain" },
    });
    assert.equal(text.headers.get("x-hub-exit"), "0");
    assert.equal(await text.text(), await hub(["ticket", "ENG-42"]));
    const lint = await fetch(`${server.url}/api/v1/lint`, {
      headers: { authorization: `Bearer ${server.token}`, accept: "text/plain" },
    });
    assert.equal(lint.status, 200);
    assert.equal(lint.headers.get("x-hub-exit"), "1");
  });

  test("bodies are checked against the route's fields", async () => {
    const error = async (r: Response) => ((await r.json()) as { error: string }).error;
    assert.match(await error(await call("POST", "/tickets/ENG-42/events", { txt: "x" })), /unknown body field txt/);
    assert.match(await error(await call("POST", "/tickets/ENG-42/events", {})), /missing text/);
    assert.match(await error(await call("POST", "/tickets/ENG-42/events", { text: 3 })), /text must be a string/);
    assert.match(await error(await call("POST", "/tickets/ENG-42/events?text=x", {})), /JSON body, not the query/);
    assert.match(await error(await call("GET", "/items?needs=1")), /unknown query field needs/);
    assert.equal((await call("DELETE", "/tickets/ENG-42")).status, 405);
    assert.equal((await call("GET", "/nope")).status, 404);
    assert.equal((await call("POST", "/tickets/ENG-42/events", { text: "from the api" })).status, 200);
    assert.match(await hub(["events", "ENG-42", "-n", "1"]), /from the api$/);
  });

  test("a ticket patch is all or nothing", async () => {
    const before = await hub(["ticket", "ENG-42"]);
    const bad = await call("PATCH", "/tickets/ENG-42", { next: "ship it", status: "x".repeat(300) });
    assert.equal(bad.status, 400);
    assert.equal(await hub(["ticket", "ENG-42"]), before);
    const ok = await call("PATCH", "/tickets/ENG-42", { next: "ship it", dir: "todo" });
    assert.equal(ok.status, 200);
    assert.match(await hub(["ticket", "ENG-42"]), /^ENG-42 \| todo \|[\s\S]*next: ship it/);
  });

  test("items go in as a batch and waits close by thread url", async () => {
    const put = await call("POST", "/items", {
      items: [
        { source: "github", kind: "review_request", url: "https://github.com/acme/web/pull/1", needs_me: true },
        { source: "slack", kind: "thread", url: "https://acme.slack.com/archives/C1/p1" },
      ],
    });
    assert.equal(put.status, 200);
    assert.match(await hub(["items", "--needs-me"]), /pull\/1/);
    const url = "https://acme.slack.com/archives/C1/p1";
    assert.equal((await call("POST", "/waits", { ticket: "ENG-42", who: "ana", url, ping_after: "1d" })).status, 200);
    assert.equal((await call("POST", `/waits/${encodeURIComponent(url)}/close`, {})).status, 200);
    assert.match(await hub(["waits"]), /no open waits|^$/);
  });
});

describe("mcp", () => {
  async function rpc(method: string, params?: unknown, id: number | null = 1): Promise<Response> {
    return fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(id === null ? {} : { id }), ...(params ? { params } : {}) }),
    });
  }
  type Tool = {
    name: string;
    inputSchema: { properties: Record<string, unknown>; required?: string[] };
    annotations: Record<string, boolean>;
  };
  const result = async <T>(r: Response) => ((await r.json()) as { result: T }).result;

  test("initialize answers the asked protocol version, and a notification gets 202", async () => {
    const init = await result<{ protocolVersion: string; serverInfo: { name: string }; instructions: string }>(
      await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
    );
    assert.equal(init.protocolVersion, "2025-06-18");
    assert.equal(init.serverInfo.name, "engineer-hub");
    assert.match(init.instructions, /Never answer a gate/);
    const note = await rpc("notifications/initialized", undefined, null);
    assert.equal(note.status, 202);
    assert.equal(await note.text(), "");
  });

  test("tools mirror the API without the dashboard's own routes or the human's answers", async () => {
    const { tools } = await result<{ tools: Tool[] }>(await rpc("tools/list"));
    const names = tools.map((t) => t.name);
    for (const gone of [
      "away_test",
      "gate",
      "pin",
      "config_set",
      "sync",
      "find",
      "ticket_delete",
      "ticket_merge",
      "source_set",
      "source_remove",
      "item_answer",
      "item_unanswer",
    ]) {
      assert.ok(!names.includes(gone), gone);
    }
    for (const kept of [
      "brief",
      "ticket",
      "ticket_set",
      "log",
      "item_put",
      "wait_add",
      "posted",
      "match",
      "step_done",
      "item_ask",
    ]) {
      assert.ok(names.includes(kept), kept);
    }
    const tool = (name: string) => tools.find((t) => t.name === name) as Tool;
    assert.equal(tool("match").inputSchema.properties.answer, undefined);
    assert.deepEqual(tool("step_done").inputSchema.required, ["id", "n"]);
    assert.equal(tool("board").annotations.readOnlyHint, true);
    assert.equal(tool("note_save").annotations.destructiveHint, true);
    assert.equal(tool("log").annotations.destructiveHint, false);
  });

  test("a tool call writes through the same functions, and a refusal is a tool error", async () => {
    const ok = await result<{ content: { text: string }[]; isError: boolean }>(
      await rpc("tools/call", { name: "log", arguments: { id: "ENG-42", text: "from mcp" } }),
    );
    assert.equal(ok.isError, false);
    assert.match(await hub(["events", "ENG-42", "-n", "1"]), /from mcp$/);
    const bad = await result<{ content: { text: string }[]; isError: boolean }>(
      await rpc("tools/call", { name: "ticket_set", arguments: { id: "ENG-42", next: "x".repeat(300) } }),
    );
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]?.text ?? "", /next is 300 chars/);
    const answer = await result<{ isError: boolean; content: { text: string }[] }>(
      await rpc("tools/call", { name: "match", arguments: { id: "ENG-42", label: "x", answer: "yes" } }),
    );
    assert.match(answer.content[0]?.text ?? "", /unknown argument field answer/);
    const unknown = (await (await rpc("tools/call", { name: "gate", arguments: {} })).json()) as {
      error: { code: number };
    };
    assert.equal(unknown.error.code, -32602);
    const method = (await (await rpc("resources/list")).json()) as { error: { code: number } };
    assert.equal(method.error.code, -32601);
  });

  test("mcp needs the token, refuses a foreign Origin and takes POST only", async () => {
    assert.equal((await fetch(`${server.url}/mcp`, { method: "POST", body: "{}" })).status, 401);
    const foreign = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: "https://evil.example" },
      body: "{}",
    });
    assert.equal(foreign.status, 403);
    assert.equal(
      (await fetch(`${server.url}/mcp`, { headers: { authorization: `Bearer ${server.token}` } })).status,
      405,
    );
    const garbled = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
      body: "{not json",
    });
    assert.equal(((await garbled.json()) as { error: { code: number } }).error.code, -32700);
  });
});

describe("send later", () => {
  test("a draft due to send is a Send row under Reply's Open tab, a later one waits dimmed under All with its time", async () => {
    await hub(["draft", "ENG-7", "due now", "--stdin", "--send-at", "1m"], "ping product");
    await hub(["draft", "ENG-7", "for later", "--stdin", "--send-at", "2026-12-31 12:00"], "year end");
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE draft SET send_at = ? WHERE label = 'due now'").run(new Date(Date.now() - 60_000).toISOString());
    db.close();
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const reply = /data-group="reply"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    assert.match(reply, /data-key="send-ENG-7-due now"[\s\S]*?data-copy="ping product"/);
    assert.match(
      reply,
      /data-fold-key="nfold-send-ENG-7-due now">(?:(?!<\/li>)[\s\S])*<div class="n-more"><div class="n-body md"><p>ping product<\/p><\/div><\/div>/,
    );
    assert.match(reply, /data-act="sent" data-ticket="ENG-7" data-label="due now"/);
    assert.match(reply, /data-act="draft-later" data-ticket="ENG-7" data-label="due now" data-for="tomorrow"/);
    assert.match(reply, /<li class="need tone-teal" data-key="send-ENG-7-due now"/);
    assert.match(
      reply,
      /<li class="need tone-teal is-dim" data-key="send-ENG-7-for later"[\s\S]*?<span class="dim-label">send 12-31 12:00<\/span>/,
    );
    const later = await call("POST", `/tickets/ENG-7/drafts/${encodeURIComponent("due now")}/later`, { for: "1h" });
    assert.equal(later.status, 200);
    const moved = /data-group="reply"[\s\S]*?<\/section>/.exec(await (await fetch(`${server.url}/?part=1`)).text());
    assert.match(moved?.[0] ?? "", /<li class="need tone-teal is-dim" data-key="send-ENG-7-due now"/);
  });

  test("a draft for an item hub has no row is a Send row; an internal draft shows on its ticket page only", async () => {
    await hub(["draft", "https://github.com/acme/web/pull/150", "review", "--stdin"], "Looks good.");
    await hub(["draft", "ENG-7", "PR body", "--stdin", "--internal"], "Adds a cap.");
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    const reply = /data-group="reply"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    assert.match(reply, /<li class="need tone-teal" data-key="send-https:\/\/github.com\/acme\/web\/pull\/150-review"/);
    assert.doesNotMatch(html, /PR body/);
    const page = await (await fetch(`${server.url}/t/ENG-7?part=1`)).text();
    assert.match(page, /data-key="td-PR body"/);
    await hub(["draft", "ENG-7", "PR body", "--stdin"], "Adds a cap, configurable.");
    assert.doesNotMatch(await (await fetch(`${server.url}/?part=1`)).text(), /PR body/);
    assert.equal((await call("PUT", "/tickets/ENG-7/drafts/PR%20body", { body: "x", internal: false })).status, 200);
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /data-key="send-ENG-7-PR body"/);
  });

  test("a stored layout and hidden list that still name the Drafts card render and save", async () => {
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)").run(
      "layout",
      JSON.stringify({ top: ["overview"], left: ["today", "drafts"], right: ["reply"] }),
    );
    db.prepare("INSERT OR REPLACE INTO config(key, value) VALUES (?, ?)").run("hiddenBlocks", '["drafts"]');
    db.close();
    const html = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(html, /data-block="today"/);
    assert.doesNotMatch(html, /data-block="drafts"/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.doesNotMatch(settings, /drafts/i);
    assert.equal((await setConfigKey("hiddenBlocks", '["activity"]')).status, 200);
  });

  test("brief lists what the human did on the dashboard since the last brief, once", async () => {
    await hub(
      ["item", "put", "--stdin"],
      '{"source":"github","kind":"review_request","url":"https://github.com/acme/web/pull/9","title":"Fix login","needs_me":true}',
    );
    await hub(["draft", "ENG-7", "ask product", "--stdin"], "Can we cap exports?");
    await call("GET", "/brief");
    const human = (method: string, path: string, body: unknown) =>
      fetch(`${server.url}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${server.token}`,
          "x-hub-actor": "human",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const key = encodeURIComponent("https://github.com/acme/web/pull/9");
    assert.equal((await human("POST", `/items/${key}/close`, {})).status, 200);
    assert.equal((await call("POST", "/tickets/ENG-7/events", { text: "an agent wrote this" })).status, 200);
    assert.equal(
      (await human("POST", `/tickets/ENG-7/drafts/${encodeURIComponent("ask product")}/posted`, {})).status,
      200,
    );
    const brief = await (
      await fetch(`${server.url}/api/v1/brief`, {
        headers: { authorization: `Bearer ${server.token}`, accept: "text/plain" },
      })
    ).text();
    const section = brief.slice(brief.indexOf("from you since"));
    assert.match(section, /done: review_request Fix login/);
    assert.match(section, /ENG-7 sent draft "ask product"/);
    assert.doesNotMatch(section, /an agent wrote this/);
    const again = await (
      await fetch(`${server.url}/api/v1/brief`, {
        headers: { authorization: `Bearer ${server.token}`, accept: "text/plain" },
      })
    ).text();
    assert.match(again, /from you since [\d-]+ [\d:]+: none$/);
  });
});

describe("backups", () => {
  test("hub backs up at start and on demand, restores in place, and shows a failed backup", async () => {
    const own = mkdtempSync(join(tmpdir(), "hub-backups-"));
    let clock = new Date("2026-11-19T00:00:00Z");
    const s = await serve({ dbPath: join(own, "hub.db"), port: 0, now: () => clock, env: process.env, fetchers: [] });
    const req = (method: string, path: string, body?: unknown) =>
      fetch(`${s.url}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${s.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const names = async () => ((await (await req("GET", "/backups")).json()) as { name: string }[]).map((b) => b.name);
    try {
      assert.deepEqual(await names(), ["hub-20261119-000000.db"]);
      assert.ok((await req("POST", "/tickets", { id: "ENG-1", title: "after the backup" })).ok);
      clock = new Date("2026-11-19T00:00:05Z");
      assert.ok((await req("POST", "/backups")).ok);
      assert.deepEqual(await names(), ["hub-20261119-000005.db", "hub-20261119-000000.db"]);

      clock = new Date("2026-11-19T00:00:10Z");
      const restored = await req("POST", "/backups/restore", { name: "hub-20261119-000000.db" });
      assert.deepEqual(await restored.json(), {
        restored: "hub-20261119-000000.db",
        saved: "hub-20261119-000010-before-restore.db",
      });
      assert.equal((await req("GET", "/tickets/ENG-1")).ok, false);
      clock = new Date("2026-11-19T00:00:15Z");
      assert.ok((await req("POST", "/backups/restore", { name: "hub-20261119-000010-before-restore.db" })).ok);
      assert.ok((await req("GET", "/tickets/ENG-1")).ok);
      assert.equal((await req("POST", "/backups/restore", { name: "../hub.db" })).status, 400);

      const settings = await (await fetch(`${s.url}/settings?part=1`)).text();
      assert.match(settings, /data-config-input="backupDir" value="" placeholder="[^"]*\/backups"/);
      assert.match(settings, /hub-20261119-000015-before-restore\.db · /);
      assert.equal((await req("PUT", "/config/backupDir", { value: "relative/dir" })).status, 400);
      assert.ok((await req("PUT", "/config/backupDir", { value: join(own, "hub.db") })).ok);
      clock = new Date("2026-11-19T00:00:20Z");
      assert.equal((await req("POST", "/backups")).ok, false);
      assert.match(
        await (await fetch(`${s.url}/?part=1`)).text(),
        /<a class="src src-bad" href="\/settings" title="[^"]+"><i><\/i>Backup<\/a>/,
      );
    } finally {
      await s.close();
      rmSync(own, { recursive: true, force: true });
    }
  });
  test("the schedule backs up when the newest backup is older than backupEvery, unless switched off", async () => {
    const own = mkdtempSync(join(tmpdir(), "hub-backups-"));
    let clock = new Date("2026-11-19T00:00:00Z");
    const s = await serve({
      dbPath: join(own, "hub.db"),
      port: 0,
      now: () => clock,
      env: process.env,
      fetchers: [],
      backupCheckMs: 10,
    });
    const req = (method: string, path: string, body?: unknown) =>
      fetch(`${s.url}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${s.token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const count = async () => ((await (await req("GET", "/backups")).json()) as unknown[]).length;
    const settle = () => new Promise((r) => setTimeout(r, 60));
    try {
      assert.ok((await req("PUT", "/config/backupEvery", { value: "1h" })).ok);
      clock = new Date("2026-11-19T00:30:00Z");
      await settle();
      assert.equal(await count(), 1);
      clock = new Date("2026-11-19T01:30:00Z");
      await waitFor(async () => ((await count()) === 2 ? true : undefined));
      assert.ok((await req("PUT", "/config/autoBackup", { value: false })).ok);
      clock = new Date("2026-11-19T05:00:00Z");
      await settle();
      assert.equal(await count(), 2);
    } finally {
      await s.close();
      rmSync(own, { recursive: true, force: true });
    }
  });
});
