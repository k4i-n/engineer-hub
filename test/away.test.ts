import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Away, awayState, collapse, parseVerdicts, slackSafe } from "../src/away.ts";
import { type Ctx, ticketNew } from "../src/commands.ts";
import { loadConfig, setConfig } from "../src/config.ts";
import { all, type ItemRow, openDb } from "../src/db.ts";
import * as items from "../src/items.ts";
import type { Ran, System } from "../src/keys.ts";
import { type Server, serve } from "../src/serve.ts";

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
let judged: { args: string[]; input: string; cwd: string | undefined }[] = [];
let judge: (input: string) => Ran = () => ({ code: 127, stdout: "", stderr: "claude: not found" });

function sys(platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}): System {
  return {
    platform,
    env,
    run: async (program, args, options) => {
      ran.push(program);
      if (program === "claude") {
        judged.push({ args, input: options?.input ?? "", cwd: options?.cwd });
        return judge(options?.input ?? "");
      }
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
  judged = [];
  judge = () => ({ code: 127, stdout: "", stderr: "claude: not found" });
  setConfig(db, "awayPing", "true", new Date(clock));
});

const away = (s: System = sys()) => new Away(s, ctx, join(dir, "judge"));

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("away ping without a judge", () => {
  beforeEach(() => setConfig(db, "judgeCommand", "[]", new Date(clock)));

  test("off: no idle check and no Keychain read", async () => {
    setConfig(db, "awayPing", "false", new Date(clock));
    arrive(alert(1));
    idle = 60 * MIN;
    await away().check();
    assert.deepEqual(ran, []);
    assert.deepEqual(posts, []);
  });

  test("present: nothing is posted", async () => {
    arrive(alert(1));
    idle = 2 * MIN;
    await away().check();
    assert.deepEqual(posts, []);
  });

  test("away: counts of what arrived since the last input, repeats collapsed", async () => {
    arrive(dm(1, "old"));
    clock += 5 * MIN;
    arrive(alert(2), alert(3), dm(4), dm(5), dm(6, "bo"));
    clock += 10 * MIN;
    idle = 12 * MIN;
    await away().check();
    assert.deepEqual(posts, ["hub: 3 new | Fix now 1 | Reply 2"]);
    assert.equal(awayState(ctx()).lastPing, new Date(clock).toISOString());
  });

  test("at most one post per awayEvery; what arrives meanwhile goes in the next", async () => {
    const hub = away();
    idle = 20 * MIN;
    clock += MIN;
    arrive(alert(1));
    await hub.check();
    clock += 5 * MIN;
    idle += 5 * MIN;
    arrive(dm(2));
    await hub.check();
    assert.equal(posts.length, 1);
    clock += 30 * MIN;
    idle += 30 * MIN;
    await hub.check();
    assert.deepEqual(posts, ["hub: 1 new | Fix now 1", "hub: 1 new | Reply 1"]);
    clock += 30 * MIN;
    idle += 30 * MIN;
    await hub.check();
    assert.equal(posts.length, 2);
  });

  test("a locked screen is away before the idle threshold", async () => {
    clock += MIN;
    arrive(dm(1));
    idle = 30_000;
    locked = true;
    await away().check();
    assert.deepEqual(posts, ["hub: 1 new | Reply 1"]);
  });

  test("closed rows and review requests are not candidates", async () => {
    arrive(dm(1), dm(2, "bo"), { kind: "review_request", url: "https://github.com/a/b/pull/1", title: "x" });
    items.close(ctx(), [dm(1).url]);
    idle = 20 * MIN;
    clock += 10 * MIN;
    await away().check();
    assert.deepEqual(posts, ["hub: 1 new | Reply 1"]);
  });

  test("no webhook URL: the error is kept and nothing is posted", async () => {
    stored = null;
    arrive(alert(1));
    idle = 20 * MIN;
    clock += MIN;
    const hub = away();
    await hub.check();
    assert.deepEqual(posts, []);
    assert.equal(hub.hasUrl, false);
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
    const hub = away();
    await hub.check();
    const failed = awayState(ctx());
    assert.equal(failed.lastPing, null);
    assert.equal(failed.error, "webhook answered 500");
    status = 200;
    clock += MIN;
    await hub.check();
    assert.equal(posts.length, 2);
    assert.equal(awayState(ctx()).error, null);
  });

  test("Linux is never away; Test reads the URL from the environment", async () => {
    arrive(alert(1));
    const linux = away(sys("linux", { HUB_WEBHOOK_KEY: HOOK }));
    await linux.check();
    assert.deepEqual(posts, []);
    assert.equal(await linux.test(), "posted hub test: 3 new | Fix now 1 | Reply 2");
    assert.deepEqual(posts, ["hub test: 3 new | Fix now 1 | Reply 2"]);
  });
});

describe("judge", () => {
  const answer = (verdicts: Record<string, { ping: boolean; why: string }>) => () => ({
    code: 0,
    stdout: `\`\`\`json\n${JSON.stringify(verdicts)}\n\`\`\``,
    stderr: "",
  });
  const ids = () =>
    Object.fromEntries(
      all<ItemRow>(db, "SELECT * FROM item WHERE source = 'slack' ORDER BY id").map((i) => [
        i.url?.split("/").at(-1),
        i.id,
      ]),
    );
  const verdicts = () =>
    all<ItemRow>(db, "SELECT * FROM item WHERE source = 'slack' ORDER BY id").map((i) => [
      i.url?.split("/").at(-1),
      i.away_ping,
      i.away_why,
    ]);

  beforeEach(() => {
    ticketNew(ctx(), "ENG-12", "Gateway rate limits", "inprogress");
    items.put(
      ctx(),
      JSON.stringify({
        source: "github",
        kind: "pr",
        url: "https://github.com/acme/infra/pull/5433",
        title: "api-gateway timeout change",
        ticket: "ENG-12",
        state: "merged",
        needs_me: false,
      }),
    );
    clock += MIN;
    arrive(
      dm(1, "kida"),
      { ...dm(2, "taro"), title: "#general · taro: thanks everyone!", url: "https://x.slack.com/archives/C2/p2" },
      alert(3),
      alert(4),
    );
    idle = 20 * MIN;
    clock += 10 * MIN;
  });

  test("the default command runs with no tools, settings or thinking, in the judge folder, and gets the context", async () => {
    judge = answer({});
    await away().check();
    const [call] = judged;
    assert.ok(call);
    assert.deepEqual(call.args.slice(0, 5), ["-p", "--model", "haiku", "--max-turns", "1"]);
    for (const flag of [
      "--tools",
      "--strict-mcp-config",
      "--setting-sources",
      "--no-session-persistence",
      "--system-prompt",
    ]) {
      assert.ok(call.args.includes(flag), flag);
    }
    assert.ok(call.args.includes('{"alwaysThinkingEnabled":false}'));
    assert.equal(call.cwd, join(dir, "judge"));
    const id = ids();
    assert.match(call.input, /^Pick which new items are worth pinging/);
    assert.match(call.input, new RegExp(`\\n${id.p1} \\| message \\| DM \\| kida \\| 1 \\| DM · kida: question 1\\n`));
    assert.match(call.input, new RegExp(`\\n${id.p4} \\| alert \\| #alerts \\| Grafana \\| 2 \\| `));
    assert.match(call.input, /\nENG-12 \| Gateway rate limits\n/);
    assert.match(
      call.input,
      /My PRs merged in the last 3h \(PR \| title \| ticket\):\ninfra#5433 \| api-gateway timeout change \| ENG-12\n/,
    );
    assert.match(call.input, /Answer with JSON only, one entry per candidate id/);
  });

  test("only what the judge picks is posted, with where, who and why; verdicts cover collapsed rows", async () => {
    const id = ids();
    judge = answer({
      [id.p1 as number]: { ping: true, why: "asks to confirm app scopes" },
      [id.p2 as number]: { ping: false, why: "thanks" },
      [id.p4 as number]: { ping: true, why: "after infra#5433 merge <!channel>" },
    });
    await away().check();
    assert.deepEqual(posts, [
      "hub: 2 need you\nReply: DM (kida), asks to confirm app scopes\nFix now: #alerts (Grafana) ×2, after infra#5433 merge &lt;!channel&gt;",
    ]);
    assert.deepEqual(verdicts(), [
      ["p1", 1, "asks to confirm app scopes"],
      ["p2", 0, "thanks"],
      ["p3", 1, "after infra#5433 merge <!channel>"],
      ["p4", 1, "after infra#5433 merge <!channel>"],
    ]);
    assert.equal(awayState(ctx()).judgeError, null);
  });

  test("each row is judged once: nothing new, no call; a no is never posted", async () => {
    const id = ids();
    judge = answer({
      [id.p1 as number]: { ping: false, why: "fyi" },
      [id.p2 as number]: { ping: false, why: "thanks" },
      [id.p4 as number]: { ping: false, why: "routine" },
    });
    const hub = away();
    await hub.check();
    clock += MIN;
    idle += MIN;
    await hub.check();
    assert.equal(judged.length, 1);
    assert.deepEqual(posts, []);
    assert.equal(awayState(ctx()).lastPing, null);
    arrive(dm(5, "bo"));
    clock += MIN;
    idle += MIN;
    judge = answer({ [ids().p5 as number]: { ping: true, why: "blocked on you" } });
    await hub.check();
    assert.equal(judged.length, 2);
    assert.doesNotMatch(judged[1]?.input ?? "", /question 1/);
    assert.deepEqual(posts, ["hub: 1 need you\nReply: DM (bo), blocked on you"]);
  });

  test("an id the judge leaves out is posted as no verdict", async () => {
    judge = answer({ [ids().p2 as number]: { ping: false, why: "thanks" } });
    await away().check();
    assert.deepEqual(posts, [
      "hub: 2 need you\nReply: DM (kida), no verdict\nFix now: #alerts (Grafana) ×2, no verdict",
    ]);
  });

  test("a failed judge posts the count, keeps its error and stores no verdict", async () => {
    judge = () => ({ code: 1, stdout: "", stderr: "rate limited" });
    await away().check();
    assert.deepEqual(posts, ["hub: 3 new | Fix now 1 | Reply 2, judge failed"]);
    assert.equal(awayState(ctx()).judgeError, "judge exit 1: rate limited");
    assert.equal(all<ItemRow>(db, "SELECT * FROM item WHERE judged_at IS NOT NULL").length, 0);
  });

  test("an answer that is not JSON is a failed judge", async () => {
    judge = () => ({ code: 0, stdout: "I think the first one matters.", stderr: "" });
    await away().check();
    assert.deepEqual(posts, ["hub: 3 new | Fix now 1 | Reply 2, judge failed"]);
    assert.equal(awayState(ctx()).judgeError, "judge answer was not JSON with a verdict per id");
  });

  test("a verdict needs a boolean ping; why is cut to 80 characters", () => {
    const group = (id: number) => ({ item: { id } as ItemRow, ids: [id] });
    assert.equal(parseVerdicts('{"1": {"ping": "yes"}}', [group(1)]), null);
    const v = parseVerdicts(`{"1": {"ping": true, "why": "${"x".repeat(100)}"}}`, [group(1)]);
    assert.equal(v?.get(1)?.why.length, 80);
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
    judged_at: null,
    away_ping: null,
    away_why: null,
    body: null,
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
      groups.map((g) => [g.item.id, g.ids.length]),
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
      groups.map((g) => [g.item.id, g.ids.length]),
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

describe("dashboard", () => {
  let server: Server;

  beforeEach(async () => {
    db.close();
    server = await serve({
      dbPath: join(dir, "hub.db"),
      port: 0,
      now: () => new Date(clock),
      env: {},
      system: sys(),
      fetchers: [],
      awayCheckMs: 3_600_000,
    });
    db = openDb(join(dir, "hub.db"));
  });

  afterEach(async () => {
    await server.close();
  });

  test("Settings shows the Away section and Test posts through the API", async () => {
    const html = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(html, /Ping when away/);
    assert.match(html, /data-act="away-test"/);
    assert.match(html, /data-config-input="judgePrompt"/);
    assert.match(html, /&quot;haiku&quot;/);
    const r = await fetch(`${server.url}/api/v1/away/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(posts, [
      "hub test: 2 need you\nReply: #help-desk (ana), asks you to confirm app scopes\nFix now: #alerts (Grafana) ×3, matches ENG-12 after web#123 merge",
    ]);
    assert.equal(all<ItemRow>(db, "SELECT * FROM item").length, 0);
  });
});
