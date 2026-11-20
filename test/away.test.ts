import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Away, awayState, collapse, slackSafe } from "../src/away.ts";
import type { Ctx } from "../src/commands.ts";
import { loadConfig, setConfig } from "../src/config.ts";
import { type ItemRow, openDb } from "../src/db.ts";
import * as items from "../src/items.ts";
import type { System } from "../src/keys.ts";

const MIN = 60_000;
const HOOK = "https://hooks.slack.com/services/T0/B0/secret";

let dir = "";
let db: DatabaseSync;
let clock = 0;
let idle = 0;
let locked = false;
let stored: string | null = HOOK;
let status = 200;
let posts: string[] = [];
let ran: string[] = [];

function sys(platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}): System {
  return {
    platform,
    env,
    run: async (program, args) => {
      ran.push(program);
      if (program === "security")
        return stored === null ? { code: 44, stdout: "", stderr: "" } : { code: 0, stdout: `${stored}\n`, stderr: "" };
      if (program !== "ioreg") return { code: 127, stdout: "", stderr: "not found" };
      if (args.includes("IOHIDSystem"))
        return { code: 0, stdout: `| "HIDIdleTime" = ${idle * 1_000_000}\n`, stderr: "" };
      const lock = locked ? `"CGSSessionScreenIsLocked"=Yes,` : "";
      return { code: 0, stdout: `"IOConsoleUsers" = ({${lock}"kCGSSessionUserNameKey"="khai"})\n`, stderr: "" };
    },
    http: async (url, init) => {
      assert.equal(url, HOOK);
      posts.push((JSON.parse(String(init.body)) as { text: string }).text);
      return { status, text: async () => "ok" };
    },
  };
}

const ctx = (): Ctx => ({ db, config: loadConfig(db), now: new Date(clock) });

function arrive(...rows: Record<string, unknown>[]): void {
  items.put(ctx(), rows.map((r) => JSON.stringify({ source: "slack", needs_me: true, ...r })).join("\n"));
}

const alert = (n: number, title = `#alerts · Grafana: [FIRING:${n}] HighErrorRate`) => ({
  kind: "alert",
  url: `https://x.slack.com/archives/C1/p${n}`,
  title,
  author: "Grafana",
  state: "alert",
});
const dm = (n: number, who = "ana") => ({
  kind: "message",
  url: `https://x.slack.com/archives/D1/p${n}`,
  title: `DM · ${who}: question ${n}`,
  author: who,
  state: "dm",
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-away-"));
  db = openDb(join(dir, "hub.db"));
  clock = Date.parse("2026-11-20T09:00:00Z");
  idle = 0;
  locked = false;
  stored = HOOK;
  status = 200;
  posts = [];
  ran = [];
  setConfig(db, "awayPing", "true", new Date(clock));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("away ping", () => {
  test("off: no idle check and no Keychain read", async () => {
    setConfig(db, "awayPing", "false", new Date(clock));
    arrive(alert(1));
    idle = 60 * MIN;
    await new Away(sys(), ctx).check();
    assert.deepEqual(ran, []);
    assert.deepEqual(posts, []);
  });

  test("present: nothing is posted", async () => {
    arrive(alert(1));
    idle = 2 * MIN;
    await new Away(sys(), ctx).check();
    assert.deepEqual(posts, []);
  });

  test("away: counts of what arrived since the last input, repeats collapsed", async () => {
    arrive(dm(1, "old"));
    clock += 5 * MIN;
    arrive(alert(2), alert(3), dm(4), dm(5), dm(6, "bo"));
    clock += 10 * MIN;
    idle = 12 * MIN;
    await new Away(sys(), ctx).check();
    assert.deepEqual(posts, ["hub: 3 new | Fix now 1 | Reply 2"]);
    assert.equal(awayState(ctx()).lastPing, new Date(clock).toISOString());
  });

  test("at most one post per awayEvery; what arrives meanwhile goes in the next", async () => {
    const away = new Away(sys(), ctx);
    idle = 20 * MIN;
    clock += MIN;
    arrive(alert(1));
    await away.check();
    clock += 5 * MIN;
    idle += 5 * MIN;
    arrive(dm(2));
    await away.check();
    assert.equal(posts.length, 1);
    clock += 30 * MIN;
    idle += 30 * MIN;
    await away.check();
    assert.deepEqual(posts, ["hub: 1 new | Fix now 1", "hub: 1 new | Reply 1"]);
    clock += 30 * MIN;
    idle += 30 * MIN;
    await away.check();
    assert.equal(posts.length, 2);
  });

  test("a locked screen is away before the idle threshold", async () => {
    clock += MIN;
    arrive(dm(1));
    idle = 30_000;
    locked = true;
    await new Away(sys(), ctx).check();
    assert.deepEqual(posts, ["hub: 1 new | Reply 1"]);
  });

  test("closed rows and review requests are not candidates", async () => {
    arrive(dm(1), dm(2, "bo"), { kind: "review_request", url: "https://github.com/a/b/pull/1", title: "x" });
    items.close(ctx(), [dm(1).url]);
    idle = 20 * MIN;
    clock += 10 * MIN;
    await new Away(sys(), ctx).check();
    assert.deepEqual(posts, ["hub: 1 new | Reply 1"]);
  });

  test("no webhook URL: the error is kept and nothing is posted", async () => {
    stored = null;
    arrive(alert(1));
    idle = 20 * MIN;
    clock += MIN;
    const away = new Away(sys(), ctx);
    await away.check();
    assert.deepEqual(posts, []);
    assert.equal(away.hasUrl, false);
    assert.match(
      awayState(ctx()).error ?? "",
      /no webhook URL: security add-generic-password -s engineer-hub -a webhook -w/,
    );
  });

  test("a failed post is retried on the next check and never names the URL", async () => {
    arrive(alert(1));
    idle = 20 * MIN;
    clock += MIN;
    status = 500;
    const away = new Away(sys(), ctx);
    await away.check();
    const failed = awayState(ctx());
    assert.equal(failed.lastPing, null);
    assert.equal(failed.error, "webhook answered 500");
    status = 200;
    clock += MIN;
    await away.check();
    assert.equal(posts.length, 2);
    assert.equal(awayState(ctx()).error, null);
  });

  test("Linux is never away; Test reads the URL from the environment", async () => {
    arrive(alert(1));
    const linux = new Away(sys("linux", { HUB_WEBHOOK_KEY: HOOK }), ctx);
    await linux.check();
    assert.deepEqual(posts, []);
    assert.equal(await linux.test(), "posted hub: test");
    assert.deepEqual(posts, ["hub: test"]);
  });
});

describe("collapse and escaping", () => {
  const row = (over: Partial<ItemRow>): ItemRow => ({
    id: 0,
    source: "slack",
    ref: "r",
    kind: "alert",
    title: "#alerts · Grafana: [FIRING:1] HighErrorRate",
    url: null,
    state: null,
    author: "Grafana",
    ticket_id: null,
    needs_me: 1,
    first_seen: "2026-11-20T09:00:00.000Z",
    changed_at: "",
    closed_at: null,
    snoozed_until: null,
    ignored: null,
    detached: 0,
    ...over,
  });

  test("alerts collapse on the title without digits within 2h; a different alert stays apart", () => {
    const groups = collapse([
      row({ id: 1 }),
      row({ id: 2, title: "#alerts · Grafana: [FIRING:2] HighErrorRate", first_seen: "2026-11-20T10:00:00.000Z" }),
      row({ id: 3, title: "#alerts · Grafana: [FIRING:1] DiskFull", first_seen: "2026-11-20T10:00:00.000Z" }),
      row({ id: 4, first_seen: "2026-11-20T11:30:00.000Z" }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.item.id, g.count]),
      [
        [2, 2],
        [3, 1],
        [4, 1],
      ],
    );
  });

  test("messages collapse on place and sender", () => {
    const groups = collapse([
      row({ id: 1, kind: "message", title: "DM · ana: a", author: "ana" }),
      row({ id: 2, kind: "message", title: "DM · ana: b", author: "ana" }),
      row({ id: 3, kind: "message", title: "DM · bo: c", author: "bo" }),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.item.id, g.count]),
      [
        [2, 2],
        [3, 1],
      ],
    );
  });

  test("Slack control characters are escaped", () => {
    assert.equal(slackSafe("<!channel> & <http://x|y>"), "&lt;!channel&gt; &amp; &lt;http://x|y&gt;");
  });
});
