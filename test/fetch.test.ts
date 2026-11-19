import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { github } from "../src/fetchers/github.ts";
import { linear } from "../src/fetchers/linear.ts";
import { slack, threadOf } from "../src/fetchers/slack.ts";
import type { Ran, System } from "../src/keys.ts";
import { type Server, serve } from "../src/serve.ts";

let dir = "";
let dbFile = "";
let server: Server;
let calls: string[][] = [];
let answers: Record<string, (args: string[], input: string) => Ran> = {};
let httpAnswer: (url: string, body: string) => { status: number; body: string } = () => ({ status: 404, body: "" });

function fake(platform: NodeJS.Platform = "darwin", env: NodeJS.ProcessEnv = {}): System {
  return {
    platform,
    env,
    run: async (program, args, options) => {
      calls.push([program, ...args]);
      const answer = answers[program];
      if (answer === undefined) return { code: 127, stdout: "", stderr: `${program}: not found` };
      return answer(args, options?.input ?? "");
    },
    http: async (url, init) => {
      calls.push(["http", String(init.method), url, JSON.stringify(init.headers)]);
      const r = httpAnswer(url, String(init.body ?? ""));
      return { status: r.status, text: async () => r.body };
    },
  };
}

async function hub(...argv: string[]): Promise<string> {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    readStdin: () => "",
    env: { HUB_DB: dbFile, HUB_URL: server.url },
    now: () => new Date(),
  };
  assert.equal(await run(argv, io), 0, `hub ${argv.join(" ")}: ${err}`);
  return out;
}

const PR = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  title: `title of ${url.split("/").at(-1)}`,
  author: { login: "ana" },
  state: "OPEN",
  merged: false,
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...extra,
});

function graphql(requested: unknown[], mine: unknown[]): (args: string[]) => Ran {
  return (args) => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "Logged in to github.com" };
    return {
      code: 0,
      stdout: JSON.stringify({ data: { requested: { nodes: requested }, mine: { nodes: mine } } }),
      stderr: "",
    };
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hub-fetch-"));
  dbFile = join(dir, "hub.db");
  calls = [];
  answers = {};
  httpAnswer = () => ({ status: 404, body: "" });
  server = await serve({
    dbPath: dbFile,
    port: 0,
    now: () => new Date(),
    env: {},
    fetchers: [github, linear, slack],
    system: fake(),
    fetchCheckMs: 3_600_000,
  });
  await hub("ticket-new", "ENG-42", "Sync sessions");
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("github", () => {
  test("review requests and the user's PRs become items; a finished review leaves the list", async () => {
    answers.gh = graphql(
      [PR("https://github.com/acme/web/pull/7")],
      [
        PR("https://github.com/acme/web/pull/101", { title: "ENG-42 sessions", reviewDecision: "APPROVED" }),
        PR("https://github.com/acme/web/pull/102", { merged: true, state: "MERGED" }),
        PR("https://github.com/acme/web/pull/103", {
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
        }),
      ],
    );
    assert.match(await hub("fetch"), /^github: items: 4 new/);
    const needs = await hub("items", "--needs-me");
    assert.match(needs, /github\/review_request \| needs you \| title of 7 \| open/);
    assert.match(needs, /github\/pr \| needs you \| ENG-42 sessions \| approved \| ENG-42 \|/);
    assert.match(needs, /github\/pr \| needs you \| title of 103 \| checks failing/);
    assert.doesNotMatch(needs, /pull\/102/);
    assert.match(await hub("sources"), /^github \| last sync .* \| cursor \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const query = calls.find((c) => c[1] === "api") ?? [];
    assert.ok(query.includes("requested=is:pr is:open review-requested:@me archived:false"));
    assert.ok(query.some((a) => /^mine=is:pr author:@me updated:>=\d{4}-/.test(a)));

    answers.gh = graphql([], []);
    await hub("fetch", "github");
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/7/);
    assert.match(await hub("items", "--all", "--source", "github"), /review_request \| title of 7 \| done/);
    const cursor = (await hub("sources")).match(/cursor (\S+)/)?.[1] ?? "";
    await hub("fetch", "github");
    assert.ok((calls.filter((c) => c[1] === "api").at(-1) ?? []).includes(`mine=is:pr author:@me updated:>=${cursor}`));
  });

  test("without gh the source shows the error and Settings says how to fix it", async () => {
    assert.match(await hub("fetch"), /^github: gh is not installed$/);
    assert.match(await hub("sources"), /github \| last sync .* \| error: gh is not installed/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /gh is not installed[\s\S]*?<pre class="text code">brew install gh<\/pre>/);
  });

  test("the timer fetches only sources that are on, once their interval passed", async () => {
    await server.close();
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    server = await serve({
      dbPath: dbFile,
      port: 0,
      now: () => new Date(),
      env: {},
      fetchers: [github, linear, slack],
      system: fake(),
      fetchCheckMs: 20,
    });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls.filter((c) => c[1] === "api").length, 1);
    await hub("config", "fetch", '{"github":false}');
    await hub("source", "github", "--cursor", "2000-01-01T00:00:00Z");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(calls.filter((c) => c[1] === "api").length, 1);
  });
});

describe("linear", () => {
  const LINEAR = {
    data: {
      issues: {
        nodes: [
          {
            identifier: "ENG-42",
            title: "Sync sessions",
            url: "https://linear.app/acme/issue/ENG-42",
            state: { name: "In Progress", type: "started" },
          },
          {
            identifier: "ENG-63",
            title: "Export times out",
            url: "https://linear.app/acme/issue/ENG-63",
            state: { name: "Triage", type: "triage" },
          },
          {
            identifier: "ENG-9",
            title: "Old",
            url: "https://linear.app/acme/issue/ENG-9",
            state: { name: "Done", type: "completed" },
          },
        ],
      },
      notifications: {
        nodes: [
          {
            type: "issueCommentMention",
            createdAt: "2026-11-19T01:00:00.000Z",
            issue: { identifier: "ENG-42", title: "Sync sessions", url: "https://linear.app/acme/issue/ENG-42" },
            comment: { url: "https://linear.app/acme/issue/ENG-42#comment-1", body: "can you check\nthe cookie path?" },
            actor: { name: "Yui" },
          },
          {
            type: "issueStatusChanged",
            createdAt: "2026-11-19T01:00:00.000Z",
            issue: { identifier: "ENG-42", title: "x", url: "u" },
          },
        ],
      },
    },
  };

  test("assigned issues and mentions come in through hub's own key", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    httpAnswer = (url, body) => {
      assert.equal(url, "https://api.linear.app/graphql");
      assert.match(JSON.parse(body).variables.since, /^\d{4}-\d{2}-\d{2}T/);
      return { status: 200, body: JSON.stringify(LINEAR) };
    };
    assert.match(await hub("fetch"), /^linear: items: 4 new/);
    const auth = JSON.parse(calls.find((c) => c[0] === "http")?.[3] ?? "{}");
    assert.equal(auth.Authorization, "lin_api_x");
    const needs = await hub("items", "--needs-me", "--source", "linear");
    assert.match(needs, /linear\/issue \| needs you \| ENG-63 Export times out \| Triage/);
    assert.doesNotMatch(needs, /ENG-42 Sync sessions \| In Progress/);
    assert.doesNotMatch(needs, /ENG-9/);
    assert.match(
      needs,
      /linear\/message \| needs you \| ENG-42 Yui mentioned you: can you check the cookie path\? \| mention \| ENG-42/,
    );
  });

  test("with no key the source says how to store one, either way", async () => {
    assert.match(await hub("fetch", "linear"), /^linear: no linear key$/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /security add-generic-password -s engineer-hub -a linear -w/);
    assert.match(
      settings,
      /sealcall add linear --host api.linear.app --header &#39;Authorization: \{key\}&#39; --allow &#39;POST \/graphql&#39;/,
    );
  });

  test("a sealcall route is used when present, and a GraphQL error is the source error", async () => {
    answers.sealcall = (args) =>
      args[0] === "routes"
        ? { code: 0, stdout: "linear  api.linear.app  POST /graphql\n", stderr: "" }
        : {
            code: 0,
            stdout: JSON.stringify({ errors: [{ message: "Authentication required" }] }),
            stderr: "HTTP 200\n",
          };
    assert.match(await hub("fetch", "linear"), /^linear: linear: Authentication required$/);
    assert.ok(calls.some((c) => c.join(" ").startsWith("sealcall call linear POST /graphql --data -")));
    assert.equal(calls.filter((c) => c[0] === "http").length, 0);
  });
});

describe("slack", () => {
  const ME = "U0ME";
  const now = Math.floor(Date.now() / 1000);
  const ts = (agoS: number, micro = "000100") => `${now - agoS}.${micro}`;
  const permalink = (t: string) => `https://acme.slack.com/archives/C01/p${t.replace(".", "")}`;

  test("a permalink gives the thread: its own ts, or thread_ts for a reply link", () => {
    assert.deepEqual(threadOf("https://acme.slack.com/archives/C02DEF/p1763350000123456"), {
      channel: "C02DEF",
      ts: "1763350000.123456",
    });
    assert.deepEqual(
      threadOf("https://acme.slack.com/archives/C02DEF/p1763350000123456?thread_ts=1763340000.000100&cid=C02DEF"),
      {
        channel: "C02DEF",
        ts: "1763340000.000100",
      },
    );
    assert.equal(threadOf("https://github.com/acme/web/pull/1"), null);
  });

  test("mentions need you, sent messages wait for judging, and a reply in a waited thread closes the wait", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    await hub("wait", "ENG-42", "Ken", permalink(thread), "--ping-after", "1d");
    const asked = Date.now() / 1000;
    const reply = `${Math.floor(asked) + 30}.000200`;
    const queries: string[] = [];
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return { status: 200, body: JSON.stringify({ ok: true, user_id: ME }) };
      if (u.pathname === "/api/search.messages") {
        const q = u.searchParams.get("query") ?? "";
        queries.push(q);
        const matches = q.startsWith("from:")
          ? [
              {
                ts: ts(60),
                text: "Shipped the fix, can you look?",
                permalink: permalink(ts(60)),
                user: ME,
                username: "khai",
                channel: { id: "C01", name: "web" },
              },
            ]
          : [
              {
                ts: ts(120),
                text: `<@${ME}> are you on call?`,
                permalink: permalink(ts(120)),
                user: "U2",
                username: "ana",
                channel: { id: "C01", name: "ops" },
              },
              { ts: ts(9 * 86_400), text: "old", permalink: permalink(ts(9 * 86_400)), user: "U2", username: "ana" },
            ];
        return { status: 200, body: JSON.stringify({ ok: true, messages: { matches } }) };
      }
      if (u.pathname === "/api/conversations.replies") {
        assert.equal(u.searchParams.get("channel"), "C01");
        assert.equal(u.searchParams.get("ts"), thread);
        return {
          status: 200,
          body: JSON.stringify({
            ok: true,
            messages: [
              { ts: thread, text: "q", user: ME },
              { ts: reply, text: "yes, ship it", user: "U3" },
            ],
          }),
        };
      }
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack"), /^slack: items: 3 new, 0 changed, 0 unchanged; closed #1$/);
    assert.match(queries[0] ?? "", new RegExp(`^<@${ME}> after:\\d{4}-\\d{2}-\\d{2}$`));
    assert.match(queries[1] ?? "", new RegExp(`^from:<@${ME}> after:`));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /slack\/message \| needs you \| #ops ana: <@U0ME> are you on call\? \| mention/);
    assert.match(needs, /slack\/thread \| needs you \| Ken answered: yes, ship it \| answered \| ENG-42/);
    assert.match(
      await hub("items", "--source", "slack"),
      /slack\/message \| #web khai: Shipped the fix, can you look\? \| sent/,
    );
    assert.match(await hub("waits"), /no open waits/);
    const auth = JSON.parse(calls.find((c) => c[0] === "http")?.[3] ?? "{}");
    assert.equal(auth.Authorization, "Bearer xoxp-1");
    assert.match(await hub("sources"), /slack \| last sync .* \| cursor \d{10}\.\d{6}/);
  });

  test("a Slack error answer is the source error", async () => {
    answers.security = () => ({ code: 0, stdout: "xoxp-1\n", stderr: "" });
    httpAnswer = () => ({ status: 200, body: JSON.stringify({ ok: false, error: "missing_scope" }) });
    assert.match(await hub("fetch", "slack"), /^slack: slack auth.test: missing_scope$/);
  });
});
