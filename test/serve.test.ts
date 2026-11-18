import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

async function syncState(): Promise<{ status: string; detail: string | null }> {
  return (await (await fetch(`${server.url}/api/status`)).json()) as { status: string; detail: string | null };
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
    assert.match(html, /Needs you/);
    assert.match(html, /href="\/t\/ENG-42">ENG-42<\/a><span class="t-title">Sync login sessions across devices/);
    assert.match(html, /waiting on design review/);
    const nonce = /script-src 'nonce-([^']+)'/.exec(index.headers.get("content-security-policy") ?? "")?.[1];
    assert.ok(nonce !== undefined && html.includes(`<script nonce="${nonce}">`));

    const part = await (await fetch(`${server.url}/?part=1`)).text();
    assert.doesNotMatch(part, /<!doctype|<script/);

    const ticket = await (await fetch(`${server.url}/t/ENG-42`)).text();
    assert.match(ticket, /<h1>Sync login sessions across devices<\/h1>/);
    assert.match(ticket, /Timeline/);
    assert.equal((await fetch(`${server.url}/t/NOPE-1`)).status, 404);
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

  test("actions write through the same functions as the CLI", async () => {
    const review = JSON.stringify({
      source: "github",
      kind: "review_request",
      url: "https://github.com/acme/web/pull/9",
      needs_me: true,
    });
    hub(["item", "put", "--stdin"], review);
    const id = /^#(\d+)/.exec(hub(["items", "--needs-me"]))?.[1] ?? "";
    assert.match(await (await fetch(`${server.url}/`)).text(), /data-act="item-done" data-id="\d+"/);
    assert.equal((await post("/api/item-snooze", { id })).status, 200);
    assert.equal(hub(["items", "--needs-me"]), "no items");
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
    assert.match(await (await fetch(`${server.url}/?part=1`)).text(), /Syncing…/);
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
});
