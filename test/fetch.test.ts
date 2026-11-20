import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { DEFAULT_LAYOUT } from "../src/config.ts";
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
  viewerDidAuthor: true,
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  ...extra,
});

function graphql(requested: unknown[], mine: unknown[], byUrl: Record<string, unknown> = {}): (args: string[]) => Ran {
  return (args) => {
    if (args[0] === "auth") return { code: 0, stdout: "", stderr: "Logged in to github.com" };
    const lookups = args.flatMap((a) => {
      const m = /^(p\d+)=(.*)$/.exec(a);
      return m?.[1] === undefined || m[2] === undefined ? [] : [[m[1], byUrl[m[2]] ?? null]];
    });
    return {
      code: 0,
      stdout: JSON.stringify({
        data: { requested: { nodes: requested }, mine: { nodes: mine }, ...Object.fromEntries(lookups) },
      }),
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
    assert.ok(calls.some((c) => c.includes(`mine=is:pr author:@me updated:>=${cursor}`)));
  });

  test("a PR's description is kept without template comments or HTML tags and unfolds under its row", async () => {
    const body =
      "<!-- describe the change -->\nAdds the **cookie** path.\n\n- one\n- two\n\n<details>\n<summary>Notes</summary>\n<p>keeps <code>Map<string, number></code></p>\n</details>";
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7", { body })], []);
    await hub("fetch", "github");
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      page,
      /data-key="nbody-item-\d+"><summary><span class="n-line">Adds the <strong>cookie<\/strong> path\. one two Notes keeps Map&lt;string, number&gt;<\/span><div class="n-body md"><p>Adds the <strong>cookie<\/strong> path\.<\/p><ul><li>one<\/li><li>two<\/li><\/ul><p>Notes<br>keeps Map&lt;string, number&gt;<\/p><\/div>/,
    );
    assert.doesNotMatch(page, /describe the change/);
  });

  test("the user's open PRs get a status: draft, in review, commented, changes requested, checks failing, approved", async () => {
    answers.gh = graphql(
      [],
      [
        PR("https://github.com/acme/web/pull/201", { isDraft: true }),
        PR("https://github.com/acme/web/pull/202"),
        PR("https://github.com/acme/web/pull/203", { latestReviews: { nodes: [{ state: "COMMENTED" }] } }),
        PR("https://github.com/acme/web/pull/204", { reviewDecision: "CHANGES_REQUESTED" }),
        PR("https://github.com/acme/web/pull/205", { reviewDecision: "APPROVED" }),
      ],
    );
    await hub("fetch", "github");
    const items = await hub("items", "--all", "--source", "github");
    const state = (n: number) => new RegExp(`title of ${n} \\| ([a-z ]+?) \\|`).exec(items)?.[1];
    assert.deepEqual([201, 202, 203, 204, 205].map(state), [
      "draft",
      "in review",
      "commented",
      "changes requested",
      "approved",
    ]);
    const needs = await hub("items", "--needs-me");
    assert.doesNotMatch(needs, /title of 20[12]/);
    assert.match(needs, /title of 203/);
    const query = (calls.find((c) => c[1] === "api") ?? []).join(" ");
    assert.match(query, /isDraft/);
    assert.match(query, /latestReviews\(first: 20\) \{ nodes \{ state \} \}/);
  });

  test("a stored PR that search no longer returns is looked up by URL, so a missed merge does not stay in review", async () => {
    const url = "https://github.com/acme/web/pull/601";
    answers.gh = graphql([], [PR(url)]);
    await hub("fetch", "github");
    answers.gh = graphql([], [], { [url]: PR(url, { merged: true, state: "MERGED" }) });
    await hub("fetch", "github");
    assert.match(await hub("items", "--all", "--source", "github"), /title of 601 \| merged \|/);
    const query = calls.filter((c) => c[1] === "api").at(-1) ?? [];
    assert.ok(query.includes(`p0=${url}`));
    assert.ok(query.some((a) => a.includes("p0: resource(url: $p0)")));

    await hub("fetch", "github");
    assert.ok(!(calls.filter((c) => c[1] === "api").at(-1) ?? []).some((a) => a.startsWith("p0=")));
  });

  test("stored PRs are looked up 50 to a call, apart from the search", async () => {
    const urls = Array.from({ length: 51 }, (_, n) => `https://github.com/acme/web/pull/${700 + n}`);
    answers.gh = graphql(
      [],
      urls.map((url) => PR(url)),
    );
    await hub("fetch", "github");
    calls = [];
    answers.gh = graphql([], [], Object.fromEntries(urls.map((url) => [url, PR(url, { merged: true })])));
    await hub("fetch", "github");
    const sizes = calls.filter((c) => c[1] === "api").map((c) => c.filter((a) => /^p\d+=/.test(a)).length);
    assert.deepEqual(sizes, [0, 50, 1]);
    assert.doesNotMatch(await hub("items", "--all", "--source", "github"), /\| in review \|/);
  });

  test("a teammate's PR linked to a ticket gets its state but never needs you", async () => {
    const url = "https://github.com/acme/web/pull/602";
    await hub("link", "ENG-42", url);
    answers.gh = graphql([], [], { [url]: PR(url, { viewerDidAuthor: false, reviewDecision: "APPROVED" }) });
    await hub("fetch", "github");
    assert.match(await hub("items", "--all", "--source", "github"), /title of 602 \| approved \| ENG-42 \|/);
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/602/);
  });

  test("a PR attaches to the ticket named in its title, else its branch name or body, in any case", async () => {
    await hub("ticket-new", "ENG-43", "Clean up");
    const pulls = () => [
      PR("https://github.com/acme/web/pull/401", { body: "Part of ENG-42" }),
      PR("https://github.com/acme/web/pull/402", { headRefName: "khai/eng-43-cleanup", body: "" }),
      PR("https://github.com/acme/web/pull/403", { title: "ENG-43 tidy", body: "fixes ENG-42" }),
      PR("https://github.com/acme/web/pull/404", { body: "fixes ENG-999" }),
    ];
    answers.gh = graphql([PR("https://github.com/acme/web/pull/405", { body: "fixes ENG-42" })], pulls());
    await hub("fetch", "github");
    const ticketOf = async (n: number) =>
      (await hub("items", "--all", "--source", "github"))
        .split("\n")
        .find((l) => l.includes(`/pull/${n}`))
        ?.match(/\| (ENG-\d+) \|/)?.[1] ?? null;
    assert.deepEqual(await Promise.all([401, 402, 403, 404, 405].map(ticketOf)), [
      "ENG-42",
      "ENG-43",
      "ENG-43",
      null,
      "ENG-42",
    ]);
    await hub("item", "detach", "https://github.com/acme/web/pull/401");
    answers.gh = graphql(
      [],
      pulls().map((pr) => ({ ...pr, reviewDecision: "APPROVED" })),
    );
    await hub("fetch", "github");
    assert.equal(await ticketOf(401), null);
    const query = (calls.find((c) => c[1] === "api") ?? []).join(" ");
    assert.match(query, /url title headRefName body author/);
  });

  test("the review request search comes from config, shows in Settings, and a narrower one drops what it leaves out", async () => {
    answers.gh = graphql([PR("https://github.com/acme/noisy/pull/1"), PR("https://github.com/acme/web/pull/7")], []);
    await hub("fetch", "github");
    const narrow = "is:pr is:open review-requested:@me archived:false -repo:acme/noisy";
    await hub("config", "githubReviewQuery", JSON.stringify(narrow));
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    await hub("fetch", "github");
    assert.ok((calls.filter((c) => c[1] === "api").at(-1) ?? []).includes(`requested=${narrow}`));
    const needs = await hub("items", "--needs-me");
    assert.match(needs, /pull\/7/);
    assert.doesNotMatch(needs, /noisy/);
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes(`data-config-input="githubReviewQuery" value="${narrow}"`));
    assert.match(
      settings,
      /GitHub<\/span>[\s\S]*?<div class="src-info"><span class="src-status tone-green"><span class="dot"><\/span>Synced just now<\/span><span class="src-how">gh, signed in<\/span><\/div>/,
    );
    const empty = await fetch(`${server.url}/api/v1/config/githubReviewQuery`, {
      method: "PUT",
      headers: { authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ value: " " }),
    });
    assert.equal(empty.status, 400);
  });

  test("the My PRs search comes from config and shows in Settings", async () => {
    const narrow = "is:pr author:@me -repo:acme/noisy";
    await hub("config", "githubPrQuery", JSON.stringify(narrow));
    answers.gh = graphql([], []);
    await hub("fetch", "github");
    const query = calls.find((c) => c[1] === "api") ?? [];
    assert.ok(query.some((a) => a.startsWith(`mine=${narrow} updated:>=`)));
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes(`data-config-input="githubPrQuery" value="${narrow}"`));
  });

  test("an ignored PR stays out whatever changes, dimmed in its card's All tab with Undo and in hub items --all, until unignored", async () => {
    const mine = "https://github.com/acme/web/pull/101";
    answers.gh = graphql([], [PR(mine, { reviewDecision: "APPROVED" })]);
    await hub("fetch", "github");
    assert.match(await hub("item", "ignore", mine), /^#\d+ ignored$/);
    answers.gh = graphql(
      [],
      [PR(mine, { commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } })],
    );
    await hub("fetch", "github");
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/101/);
    assert.match(await hub("items", "--all"), /pull\/101 \| ignored$/m);
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      page,
      /<li class="need tone-\w+ is-dim" data-key="item-\d+"[^>]*>[\s\S]*?title of 101[\s\S]*?<span class="dim-label">ignored<\/span>[\s\S]*?data-act="item-unignore"/,
    );
    assert.doesNotMatch(await (await fetch(`${server.url}/settings`)).text(), /Ignored/);
    await hub("item", "unignore", mine);
    assert.match(await hub("items", "--needs-me"), /pull\/101/);
  });

  test("a -repo: term in a GitHub search hides that repo's stored items, new ones too, until it is taken out", async () => {
    const noisy = "https://github.com/acme/noisy/pull/1";
    const mine = "https://github.com/acme/noisy/pull/5";
    answers.gh = graphql(
      [PR(noisy), PR("https://github.com/acme/web/pull/7")],
      [PR(mine, { reviewDecision: "APPROVED" })],
    );
    await hub("fetch", "github");
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(page, /<span>Ignore this PR<\/span>/);
    assert.doesNotMatch(page, /Ignore (review requests|my PRs) from/);
    await hub("config", "githubReviewQuery", '"is:pr is:open review-requested:@me -repo:acme/noisy"');
    let needs = await hub("items", "--needs-me");
    assert.doesNotMatch(needs, /noisy\/pull\/1/);
    assert.match(needs, /noisy\/pull\/5/);
    await hub("config", "githubPrQuery", '"is:pr author:@me -repo:Acme/Noisy"');
    answers.gh = graphql([PR("https://github.com/acme/noisy/pull/2"), PR("https://github.com/acme/web/pull/7")], []);
    calls = [];
    await hub("fetch", "github");
    assert.ok(!(calls.filter((c) => c[1] === "api").at(-1) ?? []).some((a) => a === `p0=${mine}`));
    needs = await hub("items", "--needs-me");
    assert.doesNotMatch(needs, /noisy/);
    assert.match(needs, /web\/pull\/7/);
    assert.match(await hub("items", "--all"), /noisy\/pull\/5 \| ignored$/m);
    await assert.rejects(hub("item", "unignore", mine), /left out by -repo: in githubPrQuery/);
    await hub("config", "githubReviewQuery", '"is:pr is:open review-requested:@me"');
    assert.match(await hub("items", "--needs-me"), /noisy\/pull\/2/);
    answers.gh = graphql([PR(noisy), PR("https://github.com/acme/noisy/pull/2")], []);
    await hub("fetch", "github");
    assert.match(await hub("items", "--needs-me"), /noisy\/pull\/1/);
  });

  test("without gh the source shows the error and Settings says how to fix it", async () => {
    assert.match(await hub("fetch"), /^github: gh is not installed$/);
    assert.match(await hub("sources"), /github \| last sync .* \| error: gh is not installed/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(
      settings,
      /gh is not installed[\s\S]*?<div class="md code-block"><pre><code>brew install gh<\/code><\/pre><\/div>/,
    );
    assert.match(settings, /<span class="src-status tone-red"><span class="dot"><\/span>gh is not installed<\/span>/);
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

describe("sync", () => {
  const sync = (method: string, body: object = {}) =>
    fetch(`${server.url}/api/v1/sync`, {
      method,
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
  const ended = async (): Promise<[string, string]> => {
    for (let i = 0; i < 200; i++) {
      const state = (await (await sync("GET")).json()) as { status: string; detail: string };
      if (state.status !== "running") return [state.status, state.detail];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("sync still running");
  };

  test("by default Sync fetches hub's own sources and never runs the agent", async () => {
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    await hub("config", "syncCommand", '["sh","-c","echo ran > claude-ran"]');
    assert.equal((await sync("POST")).status, 202);
    assert.deepEqual(await ended(), ["finished", "github: items: 1 new, 0 changed, 0 unchanged"]);
    assert.equal(existsSync(join(dir, "claude-ran")), false);
    assert.match(await hub("items", "--needs-me"), /pull\/7/);
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      page,
      /<div class="sources"><span class="src src-ok" title="last sync [^"]*"><i><\/i>GitHub<\/span><span class="src src-idle" title="not run yet\nauto sync off"><i><\/i>Agent<\/span><\/div>/,
    );
  });

  test("Sync of all fetches first and then runs the agent command", async () => {
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    await hub("config", "syncCommand", '["sh","-c","echo judged"]');
    assert.equal((await sync("POST", { what: "all" })).status, 202);
    assert.deepEqual(await ended(), ["finished", "judged"]);
    assert.match(await hub("items", "--needs-me"), /pull\/7/);
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
            updatedAt: "2026-11-19T02:00:00.000Z",
            priorityLabel: "High",
            assignee: { name: "Khai" },
            state: { name: "In Progress", type: "started" },
          },
          {
            identifier: "ENG-63",
            title: "Export times out",
            description: "CSV export of **50k rows** hits the 30s limit.",
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
      comments: { nodes: [] },
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
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      page,
      /<div class="n-body md"><p>CSV export of <strong>50k rows<\/strong> hits the 30s limit\.<\/p><\/div>/,
    );
    assert.equal([...page.matchAll(/data-key="nbody-/g)].length, 1);
  });

  test("new comments from others on my issues and tickets are Reply items on the ticket timeline", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    const issue = (id: string) => ({ identifier: id, title: "t", url: `https://linear.app/acme/issue/${id}` });
    const withComments = {
      data: {
        ...LINEAR.data,
        comments: {
          nodes: [
            {
              url: "https://linear.app/acme/issue/ENG-42#comment-2",
              body: "rebased,\nplease re-check",
              user: { name: "Ana" },
              issue: issue("ENG-42"),
            },
            {
              url: "https://linear.app/acme/issue/ENG-42#comment-1",
              body: "can you check the cookie path?",
              user: { name: "Yui" },
              issue: issue("ENG-42"),
            },
            {
              url: "https://linear.app/acme/issue/ENG-63#comment-3",
              body: "repro attached",
              user: null,
              issue: issue("ENG-63"),
            },
          ],
        },
      },
    };
    await hub("ticket-new", "ENG-7", "Same team");
    await hub("ticket-new", "PLF-3793", "Other team");
    await hub("ticket-new", "NEW-agent-token-diet", "Local");
    await hub("ticket-new", "DRAFT-12", "Local with a number");
    httpAnswer = (_url, body) => {
      const sent = JSON.parse(body) as { query: string; variables: { since: string; comments: unknown } };
      assert.match(sent.query, /comments\(filter: \$comments, first: 50\)/);
      assert.deepEqual(sent.variables.comments, {
        createdAt: { gt: sent.variables.since },
        user: { isMe: { eq: false } },
        issue: {
          or: [
            { assignee: { isMe: { eq: true } } },
            { team: { key: { eq: "ENG" } }, number: { in: [42, 7] } },
            { team: { key: { eq: "PLF" } }, number: { in: [3793] } },
          ],
        },
      });
      return { status: 200, body: JSON.stringify(withComments) };
    };
    assert.match(await hub("fetch"), /^linear: items: 6 new/);
    const needs = await hub("items", "--needs-me", "--source", "linear");
    assert.match(
      needs,
      /linear\/message \| needs you \| ENG-42 Ana commented: rebased, please re-check \| comment \| ENG-42/,
    );
    assert.match(needs, /linear\/message \| needs you \| ENG-63 someone commented: repro attached \| comment/);
    assert.equal(needs.match(/cookie path/g)?.length, 1);
    assert.match(await hub("events", "ENG-42"), /\[sync\] New .*Ana commented: rebased/);
    const page = await (await fetch(server.url)).text();
    assert.match(page, /Reply[\s\S]*Ana commented: rebased/);
  });

  test("an issue that is a ticket fills the ticket's tracker fields, once per change", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    httpAnswer = () => ({ status: 200, body: JSON.stringify(LINEAR) });
    assert.match(await hub("fetch"), /; tickets: 1 updated$/m);
    const t = JSON.parse(await hub("ticket", "ENG-42", "--json")) as { ticket: Record<string, string> };
    assert.deepEqual(
      [t.ticket.tracker_state, t.ticket.tracker_priority, t.ticket.tracker_assignee, t.ticket.tracker_updated],
      ["In Progress", "High", "Khai", "2026-11-19T02:00:00.000Z"],
    );
    assert.match(await hub("board"), /\[High\] \[TRACKER: In Progress\] ENG-42/);
    assert.doesNotMatch(await hub("fetch"), /tickets:/);
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
            stdout: JSON.stringify({ data: null, errors: [{ message: "Authentication required" }] }),
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
        if (u.searchParams.get("ts") !== thread)
          return { status: 200, body: JSON.stringify({ ok: true, messages: [] }) };
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
    assert.match(needs, /slack\/message \| needs you \| #ops · ana: @khai are you on call\? \| mention/);
    assert.match(needs, /slack\/thread \| needs you \| Ken answered: yes, ship it \| answered \| ENG-42/);
    assert.match(
      await hub("items", "--source", "slack"),
      /slack\/message \| #web · me: Shipped the fix, can you look\? \| sent/,
    );
    assert.match(await hub("waits"), /no open waits/);
    const auth = JSON.parse(calls.find((c) => c[0] === "http")?.[3] ?? "{}");
    assert.equal(auth.Authorization, "Bearer xoxp-1");
    assert.match(
      await hub("sources"),
      /slack \| last sync .* \| cursor \d{10}\.\d{6} \| warning: missing reactions:read: names, DMs or reactions are left out/,
    );
  });

  test("with every scope, ids read as names, DMs are named, a ✅ from me closes a mention and a reaction answers a wait", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const asked = ts(600);
    await hub("wait", "ENG-42", "Ken", `https://acme.slack.com/archives/C01/p${asked.replace(".", "")}`);
    const dm = ts(100);
    const group = ts(110);
    const done = ts(120);
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai" });
      if (u.pathname === "/api/search.messages") {
        if ((p.get("query") ?? "").startsWith("from:")) {
          const sentTs = ts(130);
          return ok({
            messages: {
              matches: [
                {
                  ts: sentTs,
                  text: "on it",
                  permalink: `https://acme.slack.com/archives/D01/p${sentTs.replace(".", "")}`,
                  user: ME,
                  channel: { id: "D01", name: "U2", is_im: true },
                },
              ],
            },
          });
        }
        return ok({
          messages: {
            matches: [
              {
                ts: dm,
                text: "<@U0ME> see <https://x.dev/a|the doc> &amp; <#C09> for <!subteam^S1>, <!here>",
                permalink: `https://acme.slack.com/archives/D01/p${dm.replace(".", "")}`,
                user: "U2",
                channel: { id: "D01", name: "U2", is_im: true },
              },
              {
                ts: group,
                text: "lunch?",
                permalink: `https://acme.slack.com/archives/G01/p${group.replace(".", "")}`,
                user: "U3",
                channel: { id: "G01", name: "mpdm-ana--khai--ken-1", is_mpim: true },
              },
              {
                ts: done,
                text: "<@U0ME> deploy?",
                permalink: permalink(done),
                user: "U3",
                channel: { id: "C01", name: "ops" },
              },
            ],
          },
        });
      }
      if (u.pathname === "/api/users.info") {
        const names: Record<string, string> = { U0ME: "Khai", U2: "Ana Sato", U3: "Ken" };
        return ok({ user: { id: p.get("user"), profile: { display_name: names[p.get("user") ?? ""] ?? "" } } });
      }
      if (u.pathname === "/api/conversations.info") {
        const id = p.get("channel");
        if (id === "D01") return ok({ channel: { id, is_im: true, user: "U2" } });
        if (id === "G01") return ok({ channel: { id, is_mpim: true, name: "mpdm-ana--khai--ken-1" } });
        return ok({ channel: { id, name: "releases" } });
      }
      if (u.pathname === "/api/usergroups.list") return ok({ usergroups: [{ id: "S1", handle: "oncall" }] });
      if (u.pathname === "/api/reactions.get") {
        const at = p.get("timestamp");
        if (at === done) return ok({ message: { user: "U3", reactions: [{ name: "white_check_mark", users: [ME] }] } });
        if (at === dm) return ok({ message: { user: "U2", reactions: [{ name: "eyes", users: [ME, "U3"] }] } });
        if (at === asked) return ok({ message: { user: ME, reactions: [{ name: "+1", users: ["U3"] }] } });
        return ok({ message: { reactions: [] } });
      }
      if (u.pathname === "/api/conversations.replies") return ok({ messages: [{ ts: asked, text: "q", user: ME }] });
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack"), /items: 5 new/);
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /DM · Ana Sato: @Khai see the doc & #releases for @oncall, @here \| reacted :eyes:/);
    assert.match(needs, /group DM @ana, @ken · Ken: lunch\? \| mention/);
    assert.match(needs, /Ken reacted :\+1: \| answered \| ENG-42/);
    assert.doesNotMatch(needs, /deploy\?/);
    assert.match(await hub("items", "--source", "slack"), /#ops · Ken: @Khai deploy\? \| reacted :white_check_mark:/);
    assert.match(await hub("items", "--source", "slack"), /DM @Ana Sato · me: on it \| sent/);
    assert.match(await hub("waits"), /no open waits/);
    assert.doesNotMatch(await hub("sources"), /warning/);
  });

  test("messages in alert channels are alerts that need you until my ✅, even a mention, and my thread reply keeps them open", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    await hub("config", "slackAlertChannels", '["#alerts-prod","oncall"]');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const bot = ts(300);
    const pinged = ts(200);
    const fixed = ts(100);
    const mine = ts(50);
    const at = (t: string, channel = "C07") => `https://acme.slack.com/archives/${channel}/p${t.replace(".", "")}`;
    const alerts = { id: "C07", name: "alerts-prod" };
    const queries: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai" });
      if (u.pathname === "/api/search.messages") {
        const q = p.get("query") ?? "";
        queries.push(q);
        const page = (matches: unknown[]) => ok({ messages: { matches } });
        if (q.startsWith("from:")) {
          return page([
            {
              ts: mine,
              text: "looking",
              permalink: `${at(mine)}?thread_ts=${bot}&cid=C07`,
              user: ME,
              channel: alerts,
            },
          ]);
        }
        const ping = { ts: pinged, text: `<@${ME}> db disk 90%`, permalink: at(pinged), user: "U2", channel: alerts };
        if (q.startsWith("in:#alerts-prod")) {
          return page([
            {
              ts: bot,
              text: "",
              attachments: [
                { title: "API 5xx above 2%", text: "rate 2.4%\nservice api", fallback: "[FIRING] API 5xx" },
              ],
              permalink: at(bot),
              username: "Grafana",
              channel: alerts,
            },
            ping,
            { ts: mine, text: "looking", permalink: at(mine), user: ME, channel: alerts },
          ]);
        }
        if (q.startsWith("in:#oncall")) {
          return page([
            {
              ts: fixed,
              text: "deploy failed",
              permalink: at(fixed, "C08"),
              username: "CI",
              channel: { id: "C08", name: "oncall" },
            },
          ]);
        }
        return page([ping]);
      }
      if (u.pathname === "/api/reactions.get") {
        if (p.get("timestamp") === fixed) {
          return ok({ message: { reactions: [{ name: "white_check_mark", users: [ME] }] } });
        }
        return ok({ message: { reactions: [] } });
      }
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack"), /items: 4 new/);
    assert.ok(queries.some((q) => /^in:#alerts-prod after:\d{4}-\d{2}-\d{2}$/.test(q)));
    assert.ok(queries.some((q) => /^in:#oncall after:/.test(q)));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /slack\/alert \| needs you \| #alerts-prod · Grafana: API 5xx above 2% \| alert/);
    assert.match(needs, /slack\/alert \| needs you \| #alerts-prod · U2: @U0ME db disk 90% \| alert/);
    assert.doesNotMatch(needs, /deploy failed/);
    assert.match(
      await hub("items", "--source", "slack"),
      /slack\/alert \| #oncall · CI: deploy failed \| reacted :white_check_mark:/,
    );
    assert.doesNotMatch(await hub("items", "--source", "slack"), /slack\/alert[^\n]*looking/);
    const page = await (await fetch(server.url)).text();
    assert.match(page, /data-group="fix"(?:(?!<\/section>)[\s\S])*API 5xx above 2%/);
    assert.match(page, /<div class="n-body md"><p>API 5xx above 2%<\/p><p>rate 2\.4%<br>service api<\/p><\/div>/);
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes('data-config-input="slackAlertChannels" data-list value="#alerts-prod, #oncall"'));
    await assert.rejects(hub("config", "slackAlertChannels", '["Alerts Prod"]'), /not a Slack channel name/);
  });

  test("my later reply in a mention's thread takes it off my list, in this fetch or a later one", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const top = ts(600);
    const parent = ts(900);
    const inThread = ts(500);
    const other = ts(400);
    const reply = (at: string, thread: string, text: string) => ({
      ts: at,
      text,
      permalink: `${permalink(at)}?thread_ts=${thread}&cid=C01`,
      user: ME,
      channel: { id: "C01", name: "ops" },
    });
    const mention = (at: string, link: string, text: string) => ({
      ts: at,
      text: `<@${ME}> ${text}`,
      permalink: link,
      user: "U2",
      username: "ana",
      channel: { id: "C01", name: "ops" },
    });
    let sent = [
      reply(ts(300), top, "yes, I am on call"),
      reply(ts(290), parent, "elsewhere"),
      { ...reply(ts(280), other, "top level"), permalink: permalink(ts(280)) },
    ];
    let mentions = [
      mention(top, permalink(top), "are you on call?"),
      mention(inThread, `${permalink(inThread)}?thread_ts=${other}&cid=C01`, "can you review?"),
    ];
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return { status: 200, body: JSON.stringify({ ok: true, user_id: ME }) };
      if (u.pathname === "/api/search.messages") {
        const matches = (u.searchParams.get("query") ?? "").startsWith("from:") ? sent : mentions;
        return { status: 200, body: JSON.stringify({ ok: true, messages: { matches } }) };
      }
      if (u.pathname === "/api/reactions.get") return { status: 200, body: JSON.stringify({ ok: true, message: {} }) };
      return { status: 404, body: "" };
    };
    await hub("fetch", "slack");
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.doesNotMatch(needs, /on call\?/);
    assert.match(needs, /#ops · ana: @U0ME can you review\? \| mention/);
    assert.match(await hub("items", "--source", "slack"), /#ops · ana: @U0ME are you on call\? \| replied/);

    sent = [reply(ts(5), other, "approved")];
    mentions = [];
    assert.match(await hub("fetch", "slack"), /items: 1 new, 1 changed/);
    assert.doesNotMatch(await hub("items", "--needs-me", "--source", "slack"), /can you review\?/);
    assert.match(await hub("items", "--source", "slack"), /can you review\? \| replied/);
  });

  test("DMs and replies in threads I posted in need me without a mention, until my later reply", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const link = (channel: string, t: string, thread?: string) =>
      `https://acme.slack.com/archives/${channel}/p${t.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${channel}` : ""}`;
    const ops = { id: "C01", name: "ops" };
    const web = { id: "C02", name: "web" };
    const parent = ts(4 * 86_400);
    const posted = ts(300);
    const said = (t: string, user: string, text: string, channel: object, permalink: string) => ({
      ts: t,
      text,
      user,
      channel,
      permalink,
    });
    const lgtm = ts(30);
    let sent = [
      said(ts(3 * 86_400), ME, "on it", ops, link("C01", ts(3 * 86_400), parent)),
      said(posted, ME, "PR is up", web, link("C02", posted)),
      said(ts(20), ME, "great", { id: "D02", is_im: true }, link("D02", ts(20))),
    ];
    let toMe = [
      said(ts(100), "U2", "can we talk?", { id: "D01", is_im: true }, link("D01", ts(100))),
      said(ts(50), "U3", "build is green", { id: "D02", is_im: true }, link("D02", ts(50))),
      said(ts(60), "U4", "not a DM", web, link("C02", ts(60))),
      said(ts(70), ME, "mine", { id: "D01", is_im: true }, link("D01", ts(70))),
      said(ts(80), "U7", "your build finished", { id: "D03", is_im: true }, link("D03", ts(80))),
      said(ts(81), "USLACKBOT", "reminder: standup", { id: "D04", is_im: true }, link("D04", ts(81))),
      { ...said(ts(82), "U8", "new comment", { id: "D05", is_im: true }, link("D05", ts(82))), bot_id: "B1" },
    ];
    let mentions = [
      said(lgtm, "U6", `<@${ME}> looks good`, web, link("C02", lgtm, posted)),
      said(ts(83), "U7", `<@${ME}> your deploy finished`, { id: "D03", is_im: true }, link("D03", ts(83))),
      { ...said(ts(84), "U8", `<@${ME}> was assigned`, { id: "D05", is_im: true }, link("D05", ts(84))), bot_id: "B1" },
    ];
    let inOps = [
      { ts: parent, text: "deploy?", user: "U5" },
      { ts: ts(3 * 86_400), text: "on it", user: ME },
      { ts: ts(40), text: "thanks, merged", user: "U5" },
    ];
    const queries: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai" });
      if (u.pathname === "/api/search.messages") {
        const q = p.get("query") ?? "";
        queries.push(q);
        const matches = q.startsWith("from:") ? sent : q.startsWith("to:") ? toMe : mentions;
        return ok({ messages: { matches } });
      }
      if (u.pathname === "/api/conversations.replies") {
        if (p.get("channel") === "C01") return ok({ messages: inOps });
        return ok({
          messages: [
            { ts: posted, text: "PR is up", user: ME },
            { ts: lgtm, text: "lgtm", user: "U6" },
          ],
        });
      }
      if (u.pathname === "/api/users.info") {
        const names: Record<string, string> = { U2: "Ana", U3: "Ken", U5: "Bo", U6: "Yui", U7: "CI" };
        const id = p.get("user") ?? "";
        return ok({ user: { id, is_bot: id === "U7", profile: { display_name: names[id] ?? "" } } });
      }
      if (u.pathname === "/api/conversations.info") return ok({ channel: { id: p.get("channel"), is_im: true } });
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack"), /items: 6 new/);
    assert.ok(queries.some((q) => new RegExp(`^to:<@${ME}> after:\\d{4}-\\d{2}-\\d{2}$`).test(q)));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /slack\/message \| needs you \| DM · Ana: can we talk\? \| dm/);
    assert.match(needs, /slack\/message \| needs you \| #ops · Bo: thanks, merged \| reply/);
    assert.match(needs, /slack\/message \| needs you \| #web · Yui: @U0ME looks good \| mention/);
    assert.doesNotMatch(needs, /not a DM|build is green|mine/);
    const all = await hub("items", "--source", "slack");
    assert.doesNotMatch(all, /build finished|standup|new comment|deploy finished|was assigned/);
    assert.match(all, /DM · Ken: build is green \| replied/);
    assert.equal(all.match(/looks good/g)?.length, 1);

    sent = [said(ts(5), ME, "nice", ops, link("C01", ts(5), parent))];
    toMe = [];
    mentions = [];
    inOps = [];
    assert.match(await hub("fetch", "slack"), /items: 1 new, 1 changed/);
    const later = await hub("items", "--needs-me", "--source", "slack");
    assert.doesNotMatch(later, /thanks, merged/);
    assert.match(later, /DM · Ana: can we talk\? \| dm/);
    assert.match(await hub("items", "--source", "slack"), /#ops · Bo: thanks, merged \| replied/);
  });

  test("a scope Slack refuses leaves its details out and becomes a warning, not an error", async () => {
    await hub("config", "fetch", '{"github":false,"slack":true}');
    answers.security = (args) =>
      args.includes("slack") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const at = ts(100);
    const refused = (needed: string) => ({
      status: 200,
      body: JSON.stringify({ ok: false, error: "missing_scope", needed }),
    });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return { status: 200, body: JSON.stringify({ ok: true, user_id: ME }) };
      if (u.pathname === "/api/search.messages") {
        const mine = (u.searchParams.get("query") ?? "").startsWith("from:");
        const matches = mine
          ? []
          : [
              {
                ts: at,
                text: "<@U9> ping",
                permalink: `https://acme.slack.com/archives/D01/p${at.replace(".", "")}`,
                user: "U2",
                channel: { id: "D01", is_im: true },
              },
            ];
        return { status: 200, body: JSON.stringify({ ok: true, messages: { matches } }) };
      }
      if (u.pathname === "/api/users.info") return refused("users:read");
      if (u.pathname === "/api/conversations.info") return refused("im:read");
      if (u.pathname === "/api/reactions.get") return refused("reactions:read");
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack"), /items: 1 new/);
    assert.match(await hub("items", "--needs-me", "--source", "slack"), /DM · U2: @U9 ping \| mention/);
    assert.match(
      await hub("sources"),
      /warning: missing im:read, reactions:read, users:read: names, DMs or reactions are left out/,
    );
    const page = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(page, /<span class="src src-warn" title="[^"]*missing im:read[^"]*"><i><\/i>Slack<\/span>/);
    assert.match(page, /tone-text-amber">missing im:read, reactions:read, users:read/);
    assert.match(page, /--allow &#39;GET \/api\/reactions\.get&#39;/);
  });

  test("a Slack error answer is the source error", async () => {
    answers.security = () => ({ code: 0, stdout: "xoxp-1\n", stderr: "" });
    httpAnswer = () => ({ status: 200, body: JSON.stringify({ ok: false, error: "missing_scope" }) });
    assert.match(await hub("fetch", "slack"), /^slack: slack auth.test: missing_scope$/);
  });
});

describe("script sources", () => {
  async function fails(...argv: string[]): Promise<string> {
    let err = "";
    const io: Io = {
      stdout: () => {},
      stderr: (t) => {
        err += t;
      },
      readStdin: () => "",
      env: { HUB_DB: dbFile, HUB_URL: server.url },
      now: () => new Date(),
    };
    assert.equal(await run(argv, io), 1);
    return err;
  }

  test("added from the terminal, run with HUB_SINCE, their lines become items under the script's name", async () => {
    assert.match(
      await hub("source", "add", "pagerduty", "--every", "5m", "--", "pd-items", "--team", "web"),
      /^script source pagerduty: pd-items --team web, every 5m$/,
    );
    const seen: string[][] = [];
    answers["pd-items"] = (args) => {
      seen.push(args);
      return {
        code: 0,
        stdout:
          '{"kind":"alert","ref":"PD-1","title":"API down","needs_me":true}\n\n{"source":"pd","kind":"alert","ref":"PD-2","title":"disk"}\n',
        stderr: "",
      };
    };
    assert.match(await hub("fetch", "pagerduty"), /^pagerduty: items: 2 new/);
    assert.deepEqual(seen[0], ["--team", "web"]);
    assert.match(await hub("items", "--needs-me"), /pagerduty\/alert \| needs you \| API down/);
    assert.match(await hub("items", "--source", "pd"), /pd\/alert \| disk/);
    assert.match(await hub("sources"), /script pagerduty: pd-items --team web \| every 5m/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /data-act="source-set" data-name="pagerduty" data-on="0"[\s\S]*?pd-items --team web/);
    assert.match(settings, /data-source="pagerduty" data-field="every" value="5m"/);
    assert.doesNotMatch(settings, /hub source remove pagerduty/);
    assert.match(await hub("source", "remove", "pagerduty"), /removed/);
    assert.match(await fails("fetch", "pagerduty"), /no source pagerduty to fetch/);
  });

  test("the dashboard turns a script source off and on, changes its interval and removes it, never its command", async () => {
    await hub("source", "add", "inc", "--every", "5m", "--", "inc-items");
    let runs = 0;
    answers["inc-items"] = () => {
      runs += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    const api = (method: string, path: string, body: object) =>
      fetch(`${server.url}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await api("PATCH", "/sources/inc", { on: false })).status, 200);
    assert.match(await hub("fetch"), /^github:/);
    assert.equal(runs, 0);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /data-act="source-set" data-name="inc" data-on="1"/);
    assert.match(await hub("fetch", "inc"), /^inc: nothing new/);
    assert.equal(runs, 1);
    assert.match(await hub("source", "set", "inc", "--on", "--every", "2h"), /^script source inc: on, every 2h$/);
    assert.equal((await api("PATCH", "/sources/inc", { every: "soon" })).status, 400);
    assert.equal((await api("PATCH", "/sources/inc", { argv: ["sh", "-c", "id"] })).status, 400);
    assert.equal((await api("PATCH", "/sources/nope", { on: true })).status, 400);
    assert.match(await hub("sources"), /script inc: inc-items \| every 2h/);
    assert.match(await fails("source", "set", "inc"), /usage: hub source set/);
    assert.equal((await api("POST", "/sources/inc/remove", {})).status, 200);
    assert.match(await fails("fetch", "inc"), /no source inc to fetch/);
  });

  test("a script source with a section puts its items in a card of that name, which moves and hides like the others", async () => {
    await hub("source", "add", "oncall", "--every", "5m", "--", "oncall-items");
    answers["oncall-items"] = () => ({
      code: 0,
      stdout: '{"kind":"alert","ref":"OC-1","title":"pager fired","needs_me":true}\n',
      stderr: "",
    });
    await hub("fetch", "oncall");
    const page = async () => (await fetch(`${server.url}/?part=1`)).text();
    const card = (html: string, id: string) =>
      html.match(new RegExp(`data-block="${id}" id="b-${id}">([\\s\\S]*?)</section></div>`))?.[1] ?? "";
    assert.match(card(await page(), "fix"), /pager fired/);

    assert.match(
      await hub("source", "set", "oncall", "--section", "On call"),
      /^script source oncall: on, every 5m, section On call$/,
    );
    const html = await page();
    assert.match(card(html, "section-on-call"), /g-label">On call<[\s\S]*pager fired/);
    assert.doesNotMatch(card(html, "fix"), /pager fired/);
    assert.match(html, /href="#b-section-on-call"/);
    assert.match(await hub("sources"), /script oncall: oncall-items \| every 5m \| section On call/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /data-source="oncall" data-field="section" value="On call"/);
    assert.match(settings, /data-config="hiddenBlocks" data-value="\[&quot;section-on-call&quot;\]">On call</);

    await hub("config", "layout", '{"top":["section-on-call","overview"],"left":[],"right":[]}');
    assert.match(await page(), /data-col="top"><div class="block" data-block="section-on-call"/);
    await hub("config", "hiddenBlocks", '["section-on-call"]');
    assert.match(await page(), /data-block="section-on-call" id="b-section-on-call" hidden>/);
    await hub("config", "hiddenBlocks", "[]");
    await hub("config", "layout", JSON.stringify(DEFAULT_LAYOUT));

    assert.match(await fails("source", "set", "oncall", "--section", "!!!"), /a section is a card title/);
    const r = await fetch(`${server.url}/api/v1/sources/oncall`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ section: "当番" }),
    });
    assert.equal(r.status, 200);
    assert.match(card(await page(), "section-当番"), /pager fired/);
    await hub("source", "set", "oncall", "--section", "");
    assert.match(card(await page(), "fix"), /pager fired/);
    await hub("source", "remove", "oncall");
  });

  test("Settings shows the add command for the terminal, with no form", async () => {
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /hub source add &lt;name&gt; --every 5m -- &lt;program&gt;/);
    assert.doesNotMatch(settings, /data-source-form|<input[^>]*name="command"/);
  });

  test("a failing run or a bad line writes nothing and is the source error", async () => {
    await hub("source", "add", "cf", "--every", "1m", "--", "cf-items");
    answers["cf-items"] = () => ({
      code: 0,
      stdout: '{"kind":"alert","ref":"a","title":"ok"}\n{"kind":"nope","ref":"b"}\n',
      stderr: "",
    });
    assert.match(await hub("fetch", "cf"), /^cf: line 2: kind must be one of/);
    assert.match(await hub("items", "--all", "--source", "cf"), /no items/);
    answers["cf-items"] = () => ({ code: 3, stdout: "", stderr: "warming up\nunauthorized: check the key\n" });
    assert.match(await hub("fetch", "cf"), /^cf: exit 3: unauthorized: check the key$/);
    assert.match(await hub("sources"), /cf \| last sync .* \| error: exit 3: unauthorized: check the key/);
  });

  test("names of built-ins are taken, an interval and a program are required, and the API cannot add one", async () => {
    assert.match(await fails("source", "add", "github", "--every", "5m", "--", "x"), /github, linear, slack are taken/);
    assert.match(await fails("source", "add", "cf", "--", "x"), /usage: hub source add/);
    assert.match(await fails("source", "add", "cf", "--every", "soon", "--", "x"), /--every takes a duration/);
    assert.match(await fails("source", "add", "cf", "--every", "5m"), /give the program after --/);
    const r = await fetch(`${server.url}/api/v1/sources/cf`, {
      method: "PUT",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({ argv: ["sh", "-c", "id"] }),
    });
    assert.equal(r.status, 400);
  });

  test("the real runner passes argv with no shell and HUB_SINCE from the last good run", async () => {
    await server.close();
    server = await serve({
      dbPath: dbFile,
      port: 0,
      now: () => new Date(),
      env: {},
      fetchers: [],
      fetchCheckMs: 3_600_000,
    });
    const script = join(dir, "echo-items.mjs");
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({kind:"other",ref:"since-"+(process.env.HUB_SINCE||"none"),title:process.argv.slice(2).join("|")})+"\\n")',
    );
    await hub("source", "add", "echo", "--every", "1m", "--", process.execPath, script, "a b", "$(id)");
    await hub("fetch", "echo");
    assert.match(await hub("items", "--source", "echo"), /echo\/other \| a b\|\$\(id\) \| since-none/);
    const cursor = (await hub("sources")).match(/echo \| last sync .* \| cursor (\S+)/)?.[1] ?? "";
    await hub("fetch", "echo");
    assert.match(await hub("items", "--source", "echo"), new RegExp(`since-${cursor.replaceAll(".", "\\.")}`));
  });
});
