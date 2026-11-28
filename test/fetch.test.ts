import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { DEFAULT_LAYOUT } from "../src/config.ts";
import { github } from "../src/fetchers/github.ts";
import { linear } from "../src/fetchers/linear.ts";
import { threadOf } from "../src/fetchers/slack.ts";
import type { Ran, System } from "../src/keys.ts";
import { type Server, serve } from "../src/serve.ts";
import { teamOf } from "../src/slackteam.ts";

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

function group(html: string, key: string): string {
  return html.split('data-group="').find((c) => c.startsWith(`${key}"`)) ?? "";
}

const PR = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  title: `title of ${url.split("/").at(-1)}`,
  author: { login: "ana", avatarUrl: "https://avatars.githubusercontent.com/u/7?s=40" },
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
    fetchers: [github, linear],
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
    assert.ok(query.includes("requested=is:pr is:open review-requested:@me archived:false draft:false"));
    assert.ok(query.some((a) => /^mine=is:pr author:@me updated:>=\d{4}-/.test(a)));
    const db = new DatabaseSync(dbFile);
    const avatars = db.prepare("SELECT DISTINCT avatar FROM item WHERE source = 'github'").all();
    db.close();
    assert.deepEqual(
      avatars.map((r) => r.avatar),
      ["https://avatars.githubusercontent.com/u/7?s=40"],
    );

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
      /data-fold-key="nfold-item-\d+">\s*<button type="button" class="n-caret" data-fold-toggle aria-expanded="false"(?:(?!<\/li>)[\s\S])*<div class="n-more"><div class="n-body md"><p>Adds the <strong>cookie<\/strong> path\.<\/p><ul><li>one<\/li><li>two<\/li><\/ul><p>Notes<br>keeps Map&lt;string, number&gt;<\/p><\/div>/,
    );
    assert.doesNotMatch(page, /describe the change/);
  });

  test("a PR row shows its size, a base other than the default branch, comments, reviews and who it waits on", async () => {
    const facts = {
      additions: 120,
      deletions: 30,
      changedFiles: 1,
      totalCommentsCount: 3,
      repository: { defaultBranchRef: { name: "main" } },
      latestReviews: {
        nodes: [
          { state: "APPROVED", author: { login: "bo" } },
          { state: "PENDING", author: null },
        ],
      },
      reviewRequests: { nodes: [{ requestedReviewer: { login: "cy" } }, { requestedReviewer: { name: "web-team" } }] },
    };
    answers.gh = graphql(
      [PR("https://github.com/acme/web/pull/7", { ...facts, baseRefName: "release/1.2" })],
      [PR("https://github.com/acme/web/pull/8", { ...facts, baseRefName: "main", reviewDecision: "APPROVED" })],
    );
    await hub("fetch", "github");
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(
      page,
      /title="acme\/web#7 · ana · open · \+120 −30 · 1 file · into release\/1\.2 · 3 comments · bo approved · waiting on cy, web-team"/,
    );
    assert.match(
      page,
      /acme\/web#8 · ana · approved · \+120 −30 · 1 file · 3 comments · bo approved · waiting on cy, web-team<\/span><span class="row-id">#\d+<\/span></,
    );
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
    assert.match(query, /latestReviews\(first: 20\) \{ nodes \{ state author \{ login \} \} \}/);
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

  test("my review on a PR with an open draft is proposed as Sent?, Yes marks it sent, No is not asked again", async () => {
    const url = "https://github.com/acme/web/pull/650";
    const file = join(dir, "review.md");
    writeFileSync(file, "LGTM, one nit on the limit.");
    answers.gh = graphql([PR(url, { viewerDidAuthor: false })], []);
    await hub("fetch", "github");
    await hub("draft", url, "review", "--file", file);
    await hub("draft", url, "nit", "--file", file, "--verdict", "request_changes");
    const review = (n: number, minutes: number, extra: Record<string, unknown> = {}) => ({
      url,
      viewerLatestReview: {
        url: `${url}#pullrequestreview-${n}`,
        body: "LGTM, one nit.",
        state: "APPROVED",
        submittedAt: new Date(Date.now() + minutes * 60_000).toISOString(),
        ...extra,
      },
    });

    answers.gh = graphql([PR(url, { viewerDidAuthor: false })], [], { [url]: review(1, -60) });
    assert.doesNotMatch(await hub("fetch", "github"), /sent\?/);
    answers.gh = graphql([], [], { [url]: review(2, 1, { state: "PENDING", submittedAt: null }) });
    assert.doesNotMatch(await hub("fetch", "github"), /sent\?/);
    const query = calls.filter((c) => c[1] === "api").at(-1) ?? [];
    assert.ok(query.some((a) => a.includes("viewerLatestReview { url body state submittedAt }")));
    assert.ok(query.includes(`p0=${url}`));

    answers.gh = graphql([], [], { [url]: review(3, 1) });
    assert.match(await hub("fetch", "github"), /drafts: 2 sent\?/);
    assert.equal(
      await hub("drafts", url),
      "review | draft | match proposed\nnit | draft | request_changes | match proposed",
    );
    await hub("match", url, "review", "yes");
    assert.match(
      await hub("draft-show", url, "review"),
      new RegExp(`--- sent ${url}#pullrequestreview-3\nLGTM, one nit.$`),
    );
    assert.equal(await hub("items", "--needs-me"), "no items");
    await hub("unposted", url, "review");
    assert.doesNotMatch(await hub("fetch", "github"), /sent\?/);
    await hub("match", url, "nit", "no");
    assert.doesNotMatch(await hub("fetch", "github"), /sent\?/);

    answers.gh = graphql([], [], { [url]: review(4, 2, { body: "" }) });
    assert.match(await hub("fetch", "github"), /drafts: 2 sent\?/);
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(group(home, "review"), /class="need-title"[^>]*>acme\/web#650<\/a>/);
    assert.match(home, /“approved”/);
    assert.match(home, /Your draft nit\? Draft says request changes, GitHub says approve/);
  });

  test("my review with the only draft's verdict and no inline comments marks it sent, else it asks", async () => {
    const review = (url: string, state: string) => ({
      url,
      viewerLatestReview: {
        url: `${url}#pullrequestreview-1`,
        body: "",
        state,
        submittedAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const text = join(dir, "lgtm.md");
    writeFileSync(text, "LGTM");
    const comments = join(dir, "comments.json");
    writeFileSync(comments, JSON.stringify([{ path: "src/a.ts", line: 3, body: "nit" }]));
    const same = "https://github.com/acme/web/pull/660";
    const other = "https://github.com/acme/web/pull/661";
    const inline = "https://github.com/acme/web/pull/662";
    answers.gh = graphql(
      [same, other, inline].map((url) => PR(url, { viewerDidAuthor: false })),
      [],
    );
    await hub("fetch", "github");
    await hub("draft", same, "review", "--file", text, "--verdict", "approve");
    await hub("draft", other, "review", "--file", text, "--verdict", "request_changes");
    await hub("draft", inline, "review", "--file", text, "--verdict", "approve", "--comments", comments);

    answers.gh = graphql([], [], {
      [same]: review(same, "APPROVED"),
      [other]: review(other, "APPROVED"),
      [inline]: review(inline, "APPROVED"),
    });
    assert.match(await hub("fetch", "github"), /drafts: 1 sent; drafts: 2 sent\?/);
    assert.match(
      await hub("draft-show", same, "review"),
      new RegExp(`--- sent ${same}#pullrequestreview-1\napproved$`),
    );
    assert.match(await hub("drafts", other), /match proposed/);
    assert.match(await hub("drafts", inline), /match proposed/);
    const home = await (await fetch(`${server.url}/?part=1`)).text();
    assert.doesNotMatch(home, /acme\/web#660<\/a>/);
    assert.match(group(home, "review"), /acme\/web#661<\/a>[\s\S]*acme\/web#662<\/a>/);
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/660/);
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
    const narrow = "is:pr is:open review-requested:@me archived:false draft:false -repo:acme/noisy";
    await hub("config", "githubReviewQuery", JSON.stringify(narrow));
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    await hub("fetch", "github");
    assert.ok((calls.filter((c) => c[1] === "api").at(-1) ?? []).includes(`requested=${narrow}`));
    const needs = await hub("items", "--needs-me");
    assert.match(needs, /pull\/7/);
    assert.doesNotMatch(needs, /noisy/);
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.match(
      settings,
      /Review requests<\/span><div class="set-control"><span class="src-state">custom search<\/span><code class="src-script">is:pr is:open review-requested:@me archived:false draft:false -repo:acme\/noisy<\/code><button[^>]*data-act="skip-from-query" data-key="githubReviewQuery">/,
    );
    assert.doesNotMatch(settings, /data-config-input="github/);
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
    assert.ok(settings.includes(`<code class="src-script">${narrow}</code>`));
  });

  test("Skip repos is added to both searches as -repo: terms and hides stored items from those repos", async () => {
    const noisy = "https://github.com/acme/noisy/pull/1";
    answers.gh = graphql([PR(noisy), PR("https://github.com/acme/web/pull/7")], []);
    await hub("fetch", "github");
    assert.match(
      await hub("config", "skipRepos", '["acme/noisy","acme/old"]'),
      /skipRepos = \["acme\/noisy","acme\/old"\]/,
    );
    assert.doesNotMatch(await hub("items", "--needs-me"), /noisy/);
    await hub("config", "skipRepos", "[]");
    assert.match(await hub("items", "--needs-me"), /noisy\/pull\/1/);
    await hub("config", "skipRepos", '["acme/noisy","acme/old"]');
    calls = [];
    answers.gh = graphql([PR("https://github.com/acme/web/pull/7")], []);
    await hub("fetch", "github");
    const sent = calls.filter((c) => c[1] === "api").at(-1) ?? [];
    assert.ok(
      sent.includes(
        "requested=is:pr is:open review-requested:@me archived:false draft:false -repo:acme/noisy -repo:acme/old",
      ),
    );
    assert.ok(sent.some((a) => a.startsWith("mine=is:pr author:@me -repo:acme/noisy -repo:acme/old updated:>=")));
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /data-config-input="skipRepos" data-list value="acme\/noisy, acme\/old"/);
    assert.doesNotMatch(settings, /custom search/);
    await assert.rejects(hub("config", "skipRepos", '["noisy"]'), /a repo is owner\/name/);
    await assert.rejects(hub("config", "skipRepos", '["a/b","A/b"]'), /lists a repo twice/);
  });

  test("a custom search's -repo: terms move into Skip repos; the search goes back to its default", async () => {
    await hub("config", "skipRepos", '["acme/old"]');
    await hub(
      "config",
      "githubReviewQuery",
      '"is:pr is:open review-requested:@me archived:false draft:false -repo:acme/noisy"',
    );
    await hub("config", "githubPrQuery", '"is:pr author:@me org:acme -repo:acme/old"');
    const move = (key: string) =>
      fetch(`${server.url}/api/v1/config/${key}/skip-repos`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
        body: "{}",
      });
    assert.equal((await move("githubReviewQuery")).status, 200);
    assert.equal((await move("githubPrQuery")).status, 200);
    assert.equal(await hub("config", "skipRepos"), 'skipRepos = ["acme/old","acme/noisy"]');
    assert.equal(
      await hub("config", "githubReviewQuery"),
      'githubReviewQuery = "is:pr is:open review-requested:@me archived:false draft:false"',
    );
    assert.equal(await hub("config", "githubPrQuery"), 'githubPrQuery = "is:pr author:@me org:acme"');
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.doesNotMatch(settings, /Review requests<\/span>/);
    assert.match(settings, /<code class="src-script">is:pr author:@me org:acme<\/code><\/div>/);
    assert.equal((await move("githubPrQuery")).status, 400);
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
    await assert.rejects(hub("item", "unignore", mine), /left out by Skip repos or -repo: in githubPrQuery/);
    await hub("config", "githubReviewQuery", '"is:pr is:open review-requested:@me"');
    assert.match(await hub("items", "--needs-me"), /noisy\/pull\/2/);
    answers.gh = graphql([PR(noisy), PR("https://github.com/acme/noisy/pull/2")], []);
    await hub("fetch", "github");
    assert.match(await hub("items", "--needs-me"), /noisy\/pull\/1/);
  });

  test("a new review request asks Review this? at once; an ignored repo asks nothing", async () => {
    const asked = "https://github.com/acme/web/pull/7";
    answers.gh = graphql([PR(asked)], []);
    await hub("fetch", "github");
    assert.match(await hub("items", "--needs-me"), /pull\/7 \| ask: Review this\? \(no answer yet\)$/m);
    const page = await (await fetch(`${server.url}/?part=1`)).text();
    assert.match(page, /<span class="ask"><span>Review this\?<\/span><button[^>]*data-act="item-answer"/);

    await hub("config", "githubReviewQuery", '"is:pr is:open review-requested:@me -repo:acme/noisy"');
    answers.gh = graphql(
      [PR(asked), PR("https://github.com/acme/web/pull/8"), PR("https://github.com/acme/noisy/pull/1")],
      [],
    );
    await hub("fetch", "github");
    const all = await hub("items", "--all");
    assert.match(all, /web\/pull\/8 \| ask: Review this\? \(no answer yet\)$/m);
    assert.match(all, /noisy\/pull\/1 \| ignored$/m);
    assert.match(all, /web\/pull\/7 \| ask: Review this\? \(no answer yet\)$/m);
  });

  for (const answer of ["no", "yes"]) {
    test(`a review request answered ${answer}, done and then requested again asks again`, async () => {
      const pr = "https://github.com/acme/web/pull/7";
      answers.gh = graphql([PR(pr)], []);
      await hub("fetch", "github");
      await hub("item", "answer", pr, answer);
      answers.gh = graphql([], []);
      await hub("fetch", "github");
      assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/7/);
      answers.gh = graphql([PR(pr)], []);
      await hub("fetch", "github");
      assert.match(await hub("items", "--needs-me"), /pull\/7 \| ask: Review this\? \(no answer yet\)$/m);
      const page = await (await fetch(`${server.url}/?part=1`)).text();
      assert.match(page, /<span class="ask"><span>Review this\?<\/span><button[^>]*data-act="item-answer"/);
    });
  }

  test("a review request answered no and still requested keeps its answer and stays closed", async () => {
    const pr = "https://github.com/acme/web/pull/7";
    answers.gh = graphql([PR(pr)], []);
    await hub("fetch", "github");
    await hub("item", "answer", pr, "no");
    answers.gh = graphql([PR(pr, { title: "renamed" })], []);
    await hub("fetch", "github");
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/7/);
    assert.match(await hub("items", "--all"), /pull\/7 \| ask: Review this\? no \| closed$/m);
  });

  test("an ignored review request requested again stays ignored with its answer", async () => {
    const pr = "https://github.com/acme/web/pull/7";
    answers.gh = graphql([PR(pr)], []);
    await hub("fetch", "github");
    await hub("item", "answer", pr, "no");
    await hub("item", "ignore", pr);
    answers.gh = graphql([], []);
    await hub("fetch", "github");
    answers.gh = graphql([PR(pr)], []);
    await hub("fetch", "github");
    assert.doesNotMatch(await hub("items", "--needs-me"), /pull\/7/);
    assert.match(await hub("items", "--all"), /pull\/7 \| ask: Review this\? no \| ignored$/m);
  });

  test("a PR reopened by a state change keeps an agent question's answer", async () => {
    const mine = "https://github.com/acme/web/pull/9";
    answers.gh = graphql([], [PR(mine)]);
    await hub("fetch", "github");
    await hub("item", "ask", mine, "Approve", "as", "is?");
    await hub("item", "answer", mine, "yes");
    answers.gh = graphql([], [PR(mine, { reviewDecision: "CHANGES_REQUESTED" })]);
    await hub("fetch", "github");
    assert.match(await hub("items", "--needs-me"), /pull\/9 \| ask: Approve as is\? yes$/m);
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
      fetchers: [github, linear],
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
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(
      settings,
      /<details class="replace-fold" data-key="replace-key-linear">[\s\S]*?security add-generic-password -U -s engineer-hub -a linear -w/,
    );
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
    assert.equal([...page.matchAll(/<div class="n-body md">/g)].length, 1);
  });

  test("a reply on a waited comment thread is one row: the thread item answers the wait, no message item", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    await hub("wait", "ENG-42", "yui", "https://linear.app/acme/issue/ENG-42/sync-sessions#comment-1");
    const later = new Date(Date.now() + 60_000).toISOString();
    const issue = { identifier: "ENG-42", title: "t", url: "https://linear.app/acme/issue/ENG-42" };
    const reply = "https://linear.app/acme/issue/ENG-42#comment-5";
    httpAnswer = () => ({
      status: 200,
      body: JSON.stringify({
        data: {
          issues: { nodes: [] },
          notifications: {
            nodes: [
              {
                type: "issueCommentMention",
                createdAt: later,
                issue,
                comment: { url: reply, body: "yes, rotate it" },
                actor: { name: "Yui Sato" },
              },
            ],
          },
          comments: {
            nodes: [
              {
                url: "https://linear.app/acme/issue/ENG-42#comment-4",
                body: "looking",
                createdAt: later,
                user: { name: "Ana" },
                issue,
                parent: { url: "https://linear.app/acme/issue/ENG-42#comment-1" },
              },
              {
                url: reply,
                body: "yes, rotate it",
                createdAt: new Date(Date.now() + 120_000).toISOString(),
                user: { name: "Yui Sato" },
                issue,
                parent: { url: "https://linear.app/acme/issue/ENG-42#comment-1" },
              },
              {
                url: "https://linear.app/acme/issue/ENG-42#comment-6",
                body: "unrelated",
                createdAt: later,
                user: { name: "Ana" },
                issue,
                parent: { url: "https://linear.app/acme/issue/ENG-42#comment-3" },
              },
            ],
          },
        },
      }),
    });
    await hub("fetch", "linear");
    const needs = await hub("items", "--needs-me", "--source", "linear");
    assert.match(needs, /linear\/thread \| needs you \| Yui Sato answered: yes, rotate it \| answered \| ENG-42/);
    assert.doesNotMatch(needs, /linear\/message .*(rotate it|looking)/);
    assert.match(needs, /linear\/message \| needs you \| ENG-42 Ana commented: unrelated/);
    assert.match(await hub("waits"), /no open waits/);
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

  test("Linear's note that a comment thread is synced to Slack needs no one; its Slack thread joins the ticket", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    const issue = { identifier: "ENG-42", title: "Sync sessions", url: "https://linear.app/acme/issue/ENG-42" };
    const thread = "https://acme.slack.com/archives/C1/p1700000000000100";
    const comments = [
      {
        url: "https://linear.app/acme/issue/ENG-42#comment-9",
        body: `This comment thread is synced to a corresponding [thread in Slack](${thread}). All replies are displayed in both locations.`,
        user: { name: "dmitry" },
        issue,
      },
      { url: "https://linear.app/acme/issue/ENG-42#comment-10", body: "looks good", user: { name: "Yui" }, issue },
    ];
    httpAnswer = () => ({
      status: 200,
      body: JSON.stringify({ data: { ...LINEAR.data, comments: { nodes: comments } } }),
    });
    await hub("fetch");
    const needs = await hub("items", "--needs-me");
    assert.doesNotMatch(needs, /synced to a corresponding/);
    assert.match(needs, /ENG-42 Yui commented: looks good/);
    assert.match(await hub("items", "--ticket", "ENG-42"), /slack\/thread \| .*ENG-42 Sync sessions/);
    assert.match(await hub("items", "--ticket", "ENG-42", "--json"), new RegExp(thread.replaceAll("/", "\\/")));
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

  test("the tracker's title replaces a title taken from the file name, never one set by hand", async () => {
    await hub("config", "fetch", '{"github":false,"linear":true}');
    answers.security = () => ({ code: 0, stdout: "lin_api_x\n", stderr: "" });
    httpAnswer = () => ({ status: 200, body: JSON.stringify(LINEAR) });
    const title = async () =>
      (JSON.parse(await hub("ticket", "ENG-42", "--json")) as { ticket: { title: string } }).ticket.title;
    await hub("set", "ENG-42", "title", "ENG-42-session-sync");
    await hub("fetch");
    assert.equal(await title(), "Sync sessions");
    await hub("set", "ENG-42", "title", "session sync");
    await hub("fetch");
    assert.equal(await title(), "session sync");
  });

  test("with no key the source says how to store one, either way", async () => {
    assert.match(await hub("fetch", "linear"), /^linear: no linear key$/);
    const settings = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(settings, /security add-generic-password -U -s engineer-hub -a linear -w/);
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
  beforeEach(async () => {
    await hub("slack", "add", "acme");
  });

  const ME = "U0ME";
  const WORKSPACE = { url: "https://acme.slack.com/", team_id: "T0ACME" };
  const BETA = { url: "https://beta.slack.com/", team_id: "T0BETA" };
  const twoKeys = (args: string[]) =>
    args.includes("slack-beta")
      ? { code: 0, stdout: "xoxp-2\n", stderr: "" }
      : args.includes("slack-acme")
        ? { code: 0, stdout: "xoxp-1\n", stderr: "" }
        : { code: 44, stdout: "", stderr: "" };
  const fromBeta = () => JSON.parse(calls.at(-1)?.[3] ?? "{}").Authorization === "Bearer xoxp-2";
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

  test("mentions need you, sent messages wait for judging, and a reply in a waited thread closes the wait as its author", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    await hub("wait", "ENG-42", "product", permalink(thread), "--ping-after", "1d");
    const asked = Date.now() / 1000;
    const reply = `${Math.floor(asked) + 30}.000200`;
    const queries: string[] = [];
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test")
        return { status: 200, body: JSON.stringify({ ok: true, user_id: ME, ...WORKSPACE }) };
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
      if (u.pathname === "/api/users.info") {
        const id = u.searchParams.get("user");
        return {
          status: 200,
          body: JSON.stringify({ ok: true, user: { id, profile: { display_name: id === "U3" ? "Ken" : "ana" } } }),
        };
      }
      if (u.pathname === "/api/usergroups.list")
        return { status: 200, body: JSON.stringify({ ok: true, usergroups: [] }) };
      if (u.pathname === "/api/users.list")
        return {
          status: 200,
          body: JSON.stringify({ ok: true, members: [{ id: "U3", profile: { display_name: "Ken" } }] }),
        };
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
    assert.match(await hub("fetch", "slack-acme"), /^slack-acme: items: 3 new, 0 changed, 0 unchanged; closed #1$/);
    assert.match(queries[0] ?? "", new RegExp(`^<@${ME}> after:\\d{4}-\\d{2}-\\d{2}$`));
    assert.match(queries[1] ?? "", new RegExp(`^from:<@${ME}> after:`));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /slack\/message \| needs you \| #ops · ana: @khai are you on call\? \| mention/);
    assert.match(needs, /slack\/thread \| needs you \| Ken answered: yes, ship it \| answered \| ENG-42/);
    assert.match(
      await hub("items", "--source", "slack"),
      /slack\/message \| #web · me: Shipped the fix, can you look\? \| sent/,
    );
    assert.match(await hub("brief"), /can you look\? \| https:\S+\n {4}> Shipped the fix, can you look\?\n/);
    assert.match(await hub("waits"), /no open waits/);
    const auth = JSON.parse(calls.find((c) => c[0] === "http")?.[3] ?? "{}");
    assert.equal(auth.Authorization, "Bearer xoxp-1");
    assert.match(
      await hub("sources"),
      /slack-acme \| last sync .* \| cursor \d{10}\.\d{6} \| warning: missing reactions:read: names, DMs, group mentions or reactions are left out/,
    );
  });

  test("a reply in a waited thread is one row: the thread item, not also a message item", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    const other = ts(3000);
    await hub("wait", "ENG-42", "ken", permalink(thread));
    const asked = Math.floor(Date.now() / 1000);
    const reply = `${asked + 30}.000200`;
    const aside = `${asked + 40}.000300`;
    const early = `${asked + 20}.000400`;
    await fetch(`${server.url}/api/v1/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            source: "slack",
            kind: "message",
            url: `${permalink(early)}?thread_ts=${thread}&cid=C01`,
            title: "#web · ken: one sec",
            needs_me: true,
            state: "reply",
          },
        ],
      }),
    });
    const mine = (t: string) => ({
      ts: ts(50, t === thread ? "000500" : "000600"),
      text: "can you confirm?",
      permalink: `${permalink(ts(50, t === thread ? "000500" : "000600"))}?thread_ts=${t}&cid=C01`,
      user: ME,
      username: "khai",
      channel: { id: "C01", name: "web" },
    });
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/search.messages") {
        const q = u.searchParams.get("query") ?? "";
        return ok({ messages: { matches: q.startsWith("from:") ? [mine(thread), mine(other)] : [] } });
      }
      if (u.pathname === "/api/users.info") return ok({ user: { id: "U3", profile: { display_name: "Ken" } } });
      if (u.pathname === "/api/users.list") return ok({ members: [{ id: "U3", profile: { display_name: "Ken" } }] });
      if (u.pathname === "/api/usergroups.list") return ok({ usergroups: [] });
      if (u.pathname === "/api/conversations.replies") {
        const t = u.searchParams.get("ts");
        if (t === thread)
          return ok({
            messages: [
              { ts: thread, text: "q", user: ME },
              { ts: reply, text: "the key is shared with keeper", user: "U3" },
            ],
          });
        if (t === other)
          return ok({
            messages: [
              { ts: other, text: "q2", user: ME },
              { ts: aside, text: "done", user: "U3" },
            ],
          });
        return ok({ messages: [] });
      }
      return { status: 404, body: "" };
    };
    await hub("fetch", "slack-acme");
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(
      needs,
      /slack\/thread \| needs you \| Ken answered: the key is shared with keeper \| answered \| ENG-42/,
    );
    assert.doesNotMatch(needs, new RegExp(`p${reply.replace(".", "")}`));
    assert.doesNotMatch(needs, /one sec/);
    assert.match(
      needs,
      new RegExp(`slack/message \\| needs you \\| .*done \\| reply \\| ${permalink(aside).replace(/[.?]/g, "\\$&")}`),
    );
    assert.match(await hub("items", "--all", "--source", "slack"), /one sec \| in thread/);
  });

  test("an answered wait's thread row stops needing you once you reply in the thread after the answer", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    await hub("wait", "ENG-42", "ken", permalink(thread));
    const asked = Math.floor(Date.now() / 1000);
    const mine = (t: string) => ({
      ts: t,
      text: "thanks",
      permalink: `${permalink(t)}?thread_ts=${thread}&cid=C01`,
      user: ME,
      username: "khai",
      channel: { id: "C01", name: "web" },
    });
    let sent = [mine(ts(50, "000500"))];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/search.messages") {
        const q = u.searchParams.get("query") ?? "";
        return ok({ messages: { matches: q.startsWith("from:") ? sent : [] } });
      }
      if (u.pathname === "/api/users.info") return ok({ user: { id: "U3", profile: { display_name: "Ken" } } });
      if (u.pathname === "/api/users.list") return ok({ members: [{ id: "U3", profile: { display_name: "Ken" } }] });
      if (u.pathname === "/api/usergroups.list") return ok({ usergroups: [] });
      if (u.pathname === "/api/conversations.replies")
        return ok({
          messages: [
            { ts: thread, text: "q", user: ME },
            { ts: `${asked + 30}.000200`, text: "yes, ship it", user: "U3" },
          ],
        });
      return { status: 404, body: "" };
    };
    await hub("fetch", "slack-acme");
    await hub("fetch", "slack-acme");
    assert.match(await hub("items", "--needs-me", "--source", "slack"), /slack\/thread \| needs you \| Ken answered/);

    sent = [...sent, mine(`${asked + 120}.000700`)];
    await hub("fetch", "slack-acme");
    assert.doesNotMatch(await hub("items", "--needs-me", "--source", "slack"), /Ken answered/);
    assert.match(await hub("items", "--source", "slack"), /slack\/thread \| Ken answered: yes, ship it \| replied/);
  });

  test("a sync checks only the waits of its own workspace and keeps the workspace's team id", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    await hub("wait", "ENG-42", "ken", "https://other.slack.com/archives/C09/p1763350000123456");
    const asked: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/search.messages") return ok({ messages: { matches: [] } });
      if (u.pathname === "/api/conversations.replies") {
        asked.push(u.searchParams.get("channel") ?? "");
        return { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
      }
      return { status: 404, body: "" };
    };
    assert.doesNotMatch(await hub("fetch", "slack-acme"), /channel_not_found/);
    assert.deepEqual(asked, []);
    assert.match(await hub("waits"), /ken/);
    const db = new DatabaseSync(dbFile);
    assert.equal(teamOf(db, "acme.slack.com"), "T0ACME");
    db.close();
  });

  test("hub slack add makes a workspace its own source with its own key, and remove takes it away", async () => {
    assert.match(await hub("slack", "add", "beta"), /source slack-beta is on and reads the key slack-beta/);
    assert.match(await hub("config", "slackWorkspaces"), /\["acme","beta"\]/);
    assert.match(await hub("config", "fetch"), /"slack-beta":true/);
    await assert.rejects(hub("slack", "add", "Beta!"), /lowercase letters, digits and -/);
    await assert.rejects(hub("source", "add", "slack-x", "--every", "5m", "--", "x"), /slack-\* are taken/);
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes('<span class="set-label">Slack beta</span>'));
    assert.match(settings, /-a slack-beta -w/);
    assert.match(await hub("slack", "remove", "beta"), /removed/);
    assert.match(await hub("config", "slackWorkspaces"), /\["acme"\]/);
    assert.doesNotMatch(await hub("config", "fetch"), /slack-beta/);
    await assert.rejects(hub("slack", "remove", "beta"), /no Slack workspace beta \(acme\)/);
  });

  test("a workspace syncs with its own key, its own channels and its own waits", async () => {
    await hub("slack", "add", "beta");
    await hub("config", "fetch", '{"github":false,"slack-acme":true,"slack-beta":true}');
    answers.security = twoKeys;
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value, updated_at) VALUES (?, ?, ?)").run(
      "slackAlertChannels",
      JSON.stringify([
        { id: "C07", name: "alerts", team: "T0ACME" },
        { id: "C70", name: "alerts", team: "T0BETA" },
      ]),
      new Date().toISOString(),
    );
    db.close();
    await hub("wait", "ENG-42", "ken", permalink(ts(3600)));
    await hub("wait", "ENG-42", "ana", `https://beta.slack.com/archives/C70/p${ts(1800).replace(".", "")}`);
    const queries: string[] = [];
    const asked: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (!fromBeta()) return { status: 200, body: JSON.stringify({ ok: false, error: "invalid_auth" }) };
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...BETA });
      if (u.pathname === "/api/conversations.info") return ok({ channel: { id: "C70", name: "alerts" } });
      if (u.pathname === "/api/search.messages") {
        const q = u.searchParams.get("query") ?? "";
        queries.push(q);
        const alert = {
          ts: ts(60),
          text: "disk",
          permalink: `https://beta.slack.com/archives/C70/p${ts(60).replace(".", "")}`,
          user: "U2",
          username: "ana",
          channel: { id: "C70", name: "alerts" },
        };
        return ok({ messages: { matches: q.startsWith("in:#alerts") ? [alert] : [] } });
      }
      if (u.pathname === "/api/conversations.replies") {
        asked.push(u.searchParams.get("channel") ?? "");
        return ok({ messages: [] });
      }
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack-beta"), /^slack-beta: items: 1 new/);
    assert.equal(queries.filter((q) => q.startsWith("in:#alerts")).length, 1);
    assert.deepEqual(asked, ["C70"]);
    assert.match(await hub("items", "--source", "slack"), /slack\/alert \| needs you \| #alerts · ana: disk/);
    const sources = await hub("sources");
    assert.match(sources, /slack-beta \| last sync .* \| cursor \d{10}\.\d{6}/);
    assert.doesNotMatch(sources, /^slack \|/m);
    const after = new DatabaseSync(dbFile);
    assert.equal(teamOf(after, "beta.slack.com"), "T0BETA");
    after.close();
  });

  test("a channel typed in Settings is stored with the workspace that has it", async () => {
    await hub("slack", "add", "beta");
    answers.security = twoKeys;
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const beta = fromBeta();
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...(beta ? BETA : WORKSPACE) });
      if (u.pathname === "/api/conversations.list")
        return ok({ channels: beta ? [{ id: "C70", name: "ops" }] : [{ id: "C07", name: "alerts" }] });
      return { status: 404, body: "" };
    };
    await hub("config", "slackAlertChannels", '["#alerts", "#ops"]');
    assert.match(
      await hub("config", "slackAlertChannels"),
      /\[\{"id":"C07","name":"alerts","team":"T0ACME"\},\{"id":"C70","name":"ops","team":"T0BETA"\}\]/,
    );
    await assert.rejects(hub("config", "slackAlertChannels", '["#nope"]'), /no Slack channel #nope/);
  });

  test("a channel name in two workspaces asks which one; workspace:#name picks it", async () => {
    await hub("slack", "add", "beta");
    answers.security = twoKeys;
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const beta = fromBeta();
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...(beta ? BETA : WORKSPACE) });
      if (u.pathname === "/api/conversations.list")
        return ok({ channels: [beta ? { id: "C70", name: "general" } : { id: "C01", name: "general" }] });
      return { status: 404, body: "" };
    };
    await assert.rejects(
      hub("config", "slackAlertChannels", '["#general"]'),
      /#general is in acme and beta: write acme:#general or beta:#general/,
    );
    await hub("config", "slackAlertChannels", '["beta:#general"]');
    assert.match(
      await hub("config", "slackAlertChannels"),
      /^slackAlertChannels = \[\{"id":"C70","name":"general","team":"T0BETA"\}\]$/,
    );
    await assert.rejects(
      hub("config", "slackAlertChannels", '["gamma:#general"]'),
      /no Slack channel gamma:#general \(no workspace gamma\)/,
    );
    await hub("config", "slackAlertChannels", '["acme:#general", "beta:#general"]');
    assert.match(
      await hub("config", "slackAlertChannels"),
      /\[\{"id":"C01","name":"general","team":"T0ACME"\},\{"id":"C70","name":"general","team":"T0BETA"\}\]/,
    );
  });

  test("a wait on a Slack user closes on their reply; someone else's reply shows and keeps it open", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    await hub("wait", "ENG-42", "maciej", permalink(thread));
    const asked = Math.floor(Date.now() / 1000);
    const side = { ts: `${asked + 30}.000200`, text: "I think Maciej knows", user: "U5" };
    const answer = { ts: `${asked + 60}.000300`, text: "yes, ship it", user: "U4" };
    let replies = [side];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    const people: Record<string, string> = { U4: "Maciej Nowak", U5: "Dmitry" };
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/search.messages") return ok({ messages: { matches: [] } });
      if (u.pathname === "/api/users.list")
        return ok({
          members: [
            { id: "U4", real_name: "Maciej Nowak" },
            { id: "U5", real_name: "Dmitry" },
            { id: "U6", real_name: "Maciej Old", deleted: true },
          ],
        });
      if (u.pathname === "/api/users.info") {
        const id = u.searchParams.get("user") ?? "";
        return ok({ user: { id, profile: { display_name: people[id] ?? "" } } });
      }
      if (u.pathname === "/api/conversations.replies")
        return ok({ messages: [{ ts: thread, text: "q", user: ME }, ...replies] });
      if (u.pathname === "/api/reactions.get") return ok({ message: { user: ME, reactions: [] } });
      return { status: 404, body: "" };
    };
    assert.doesNotMatch(await hub("fetch", "slack-acme"), /closed/);
    assert.match(
      await hub("items", "--needs-me", "--source", "slack"),
      /slack\/thread \| needs you \| Dmitry replied: I think Maciej knows \| replied \| ENG-42/,
    );
    assert.match(await hub("waits"), /maciej/);
    replies = [side, answer];
    assert.match(await hub("fetch", "slack-acme"), /closed #1/);
    assert.match(
      await hub("items", "--needs-me", "--source", "slack"),
      /slack\/thread \| needs you \| Maciej Nowak answered: yes, ship it \| answered \| ENG-42/,
    );
    assert.match(await hub("waits"), /no open waits/);
  });

  test("a reopened wait closes only on a reply after the reopen, and its old reaction no longer answers it", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const thread = ts(3600);
    await hub("wait", "ENG-42", "product", permalink(thread));
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE wait SET asked_at = ?").run(new Date((now - 600) * 1000).toISOString());
    db.close();
    const first = { ts: ts(300), text: "maybe", user: "U3" };
    let replies = [first];
    const oldests: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/search.messages") return ok({ messages: { matches: [] } });
      if (u.pathname === "/api/users.list") return ok({ members: [] });
      if (u.pathname === "/api/users.info") return ok({ user: { id: "U3", profile: { display_name: "Ken" } } });
      if (u.pathname === "/api/reactions.get")
        return ok({ message: { user: ME, reactions: [{ name: "+1", users: ["U3"] }] } });
      if (u.pathname !== "/api/conversations.replies") return { status: 404, body: "" };
      oldests.push(u.searchParams.get("oldest") ?? "");
      const oldest = Number(u.searchParams.get("oldest"));
      return ok({ messages: [{ ts: thread, text: "q", user: ME }, ...replies.filter((m) => Number(m.ts) > oldest)] });
    };
    assert.match(await hub("fetch", "slack-acme"), /closed #1/);
    await hub("wait", "reopen", "1");
    const reopened = Date.now() / 1000;
    assert.doesNotMatch(await hub("fetch", "slack-acme"), /closed/);
    assert.ok(Number(oldests.at(-1)) >= Math.floor(reopened) - 1);
    assert.match(await hub("waits"), /product/);
    replies = [first, { ts: `${Math.floor(Date.now() / 1000) + 60}.000300`, text: "yes, ship it", user: "U3" }];
    assert.match(await hub("fetch", "slack-acme"), /closed #1/);
    assert.match(await hub("items", "--needs-me", "--source", "slack"), /Ken answered: yes, ship it \| answered/);
  });

  test("with every scope, ids read as names, DMs are named, a ✅ from me closes a mention and a reaction answers a wait", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const asked = ts(600);
    await hub("wait", "ENG-42", "Ken", `https://acme.slack.com/archives/C01/p${asked.replace(".", "")}`);
    const dm = ts(100);
    const group = ts(110);
    const done = ts(120);
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
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
        const id = p.get("user") ?? "";
        const image_48 = `https://avatars.slack-edge.com/${id}_48.png`;
        return ok({ user: { id, profile: { display_name: names[id] ?? "", image_48 } } });
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
    assert.match(await hub("fetch", "slack-acme"), /items: 5 new/);
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /DM · Ana Sato: @Khai see the doc & #releases for @oncall, @here \| reacted :eyes:/);
    assert.match(needs, /group DM @ana, @ken · Ken: lunch\? \| mention/);
    assert.match(needs, /Ken reacted :\+1: \| answered \| ENG-42/);
    assert.doesNotMatch(needs, /deploy\?/);
    assert.match(await hub("items", "--source", "slack"), /#ops · Ken: @Khai deploy\? \| reacted :white_check_mark:/);
    assert.match(await hub("items", "--source", "slack"), /DM @Ana Sato · me: on it \| sent/);
    const db = new DatabaseSync(dbFile);
    const avatars = db.prepare("SELECT author, avatar FROM item WHERE source = 'slack' ORDER BY id").all();
    db.close();
    assert.ok(avatars.some((r) => r.author === "Ana Sato" && r.avatar === "https://avatars.slack-edge.com/U2_48.png"));
    assert.ok(avatars.some((r) => r.author === "me" && r.avatar === null));
    assert.match(await hub("waits"), /no open waits/);
    assert.doesNotMatch(await hub("sources"), /warning/);
  });

  test("messages in alert channels are alerts that need you until my ✅, even a mention, and my thread reply keeps them open", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    await hub("config", "slackAlertChannels", '["#alerts-prod","oncall"]');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
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
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
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
    assert.match(await hub("fetch", "slack-acme"), /items: 4 new/);
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

  test("channels typed by name are stored with their id, follow a rename, and ignored ones bring nothing", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const names: Record<string, string> = { C07: "alerts-prod", C09: "random", C10: "eng" };
    const queries: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    const mention = (t: string, id: string) => ({
      ts: t,
      text: `<@${ME}> look`,
      permalink: `https://acme.slack.com/archives/${id}/p${t.replace(".", "")}`,
      user: "U2",
      username: "ana",
      channel: { id, name: names[id] },
    });
    const [inRandom, inEng, alert] = [ts(300), ts(200), ts(100)];
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
      if (u.pathname === "/api/conversations.list") {
        return ok({ channels: Object.entries(names).map(([id, name]) => ({ id, name })) });
      }
      if (u.pathname === "/api/conversations.info") {
        const id = p.get("channel") ?? "";
        return ok({ channel: { id, name: names[id] } });
      }
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      if (u.pathname !== "/api/search.messages") return { status: 404, body: "" };
      const q = p.get("query") ?? "";
      queries.push(q);
      if (q.startsWith(`<@${ME}>`))
        return ok({ messages: { matches: [mention(inRandom, "C09"), mention(inEng, "C10")] } });
      if (q.startsWith("in:#alerts-new"))
        return ok({ messages: { matches: [{ ...mention(alert, "C07"), text: "disk" }] } });
      return ok({ messages: { matches: [] } });
    };

    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value, updated_at) VALUES (?, ?, ?)").run(
      "slackIgnoreChannels",
      '["#random"]',
      new Date().toISOString(),
    );
    db.close();
    assert.match(await hub("config", "slackIgnoreChannels"), /\[\{"id":"","name":"random"\}\]/);
    await hub("config", "slackAlertChannels", '["#alerts-prod"]');
    await hub("config", "slackIgnoreChannels", '["random"]');
    assert.match(await hub("config", "slackAlertChannels"), /\[\{"id":"C07","name":"alerts-prod","team":"T0ACME"\}\]/);
    assert.match(await hub("config", "slackIgnoreChannels"), /\[\{"id":"C09","name":"random","team":"T0ACME"\}\]/);
    await assert.rejects(hub("config", "slackIgnoreChannels", '["random","nope"]'), /no Slack channel #nope/);
    await assert.rejects(hub("config", "slackAlertChannels", '["Alerts Prod"]'), /not a Slack channel name or id/);

    names.C07 = "alerts-new";
    names.C09 = "watercooler";
    assert.match(await hub("fetch", "slack-acme"), /items: 2 new/);
    assert.match(await hub("config", "slackAlertChannels"), /\[\{"id":"C07","name":"alerts-new","team":"T0ACME"\}\]/);
    assert.match(await hub("config", "slackIgnoreChannels"), /\[\{"id":"C09","name":"watercooler","team":"T0ACME"\}\]/);
    assert.ok(queries.some((q) => q.startsWith("in:#alerts-new after:")));
    const list = await hub("items", "--source", "slack");
    assert.match(list, /slack\/alert \| needs you \| #alerts-new · ana: disk/);
    assert.match(list, /#eng · ana: @U0ME look/);
    assert.doesNotMatch(list, /#watercooler|#random/);
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes('data-config-input="slackAlertChannels" data-list value="#alerts-new"'));
    assert.ok(settings.includes('<span class="chip tone-grey">#watercooler · C09</span>'));
  });

  test("a channel is given by id or name, trimmed; an id is looked up first, then as a name; a failed lookup is refused", async () => {
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const names: Record<string, string> = { C10: "eng", C99: "c42", C07: "alerts-prod" };
    httpAnswer = (url) => {
      const u = new URL(url);
      const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/conversations.list") {
        return ok({ channels: Object.entries(names).map(([id, name]) => ({ id, name })) });
      }
      if (u.pathname === "/api/conversations.info") {
        const id = u.searchParams.get("channel") ?? "";
        if (names[id] === undefined)
          return { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
        return ok({ channel: { id, name: names[id] } });
      }
      return { status: 404, body: "" };
    };
    await hub("config", "slackAlertChannels", '[" C10 ", "#alerts-prod ", "C42"]');
    assert.match(
      await hub("config", "slackAlertChannels"),
      /\[\{"id":"C10","name":"eng","team":"T0ACME"\},\{"id":"C07","name":"alerts-prod","team":"T0ACME"\},\{"id":"C99","name":"c42","team":"T0ACME"\}\]/,
    );
    const settings = await (await fetch(`${server.url}/settings`)).text();
    assert.ok(settings.includes('value="#eng, #alerts-prod, #c42"'));
    assert.ok(settings.includes('<span class="chip tone-grey">#eng · C10</span>'));
    await assert.rejects(
      hub("config", "slackIgnoreChannels", '["C55"]'),
      /could not look up C55 in Slack: failed conversations\.info channel_not_found/,
    );
  });

  test("a listed channel the fetch cannot find is named in the source warning", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    const db = new DatabaseSync(dbFile);
    db.prepare("INSERT OR REPLACE INTO config(key, value, updated_at) VALUES (?, ?, ?)").run(
      "slackWatchChannels",
      JSON.stringify([{ id: "C55", name: "" }]),
      new Date().toISOString(),
    );
    db.close();
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, ...WORKSPACE });
      if (u.pathname === "/api/conversations.list") return ok({ channels: [] });
      if (u.pathname === "/api/conversations.info")
        return { status: 200, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
      if (u.pathname === "/api/search.messages") return ok({ messages: { matches: [] } });
      return { status: 404, body: "" };
    };
    await hub("fetch", "slack-acme");
    assert.match(await hub("sources"), /slack-acme \| .*warning: .*no channel C55 \(slackWatchChannels\)/);
  });

  test("every message in a watch channel needs me, with or without a mention, except my own", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    await hub("config", "slackWatchChannels", '[{"id":"C10","name":"eng"}]');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const [plain, mentioned, mine] = [ts(300), ts(200), ts(100)];
    const said = (t: string, text: string, user = "U2") => ({
      ts: t,
      text,
      permalink: `https://acme.slack.com/archives/C10/p${t.replace(".", "")}`,
      user,
      username: user === ME ? "khai" : "ana",
      channel: { id: "C10", name: "eng" },
    });
    const queries: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      if (u.pathname !== "/api/search.messages") return { status: 404, body: "" };
      const q = u.searchParams.get("query") ?? "";
      queries.push(q);
      const ping = said(mentioned, `<@${ME}> can you check?`);
      if (q.startsWith(`<@${ME}>`)) return ok({ messages: { matches: [ping] } });
      if (q.startsWith("in:#eng")) {
        return ok({ messages: { matches: [said(plain, "build is slow today"), ping, said(mine, "on it", ME)] } });
      }
      return ok({ messages: { matches: [] } });
    };
    assert.match(await hub("fetch", "slack-acme"), /items: 2 new/);
    assert.ok(queries.some((q) => /^in:#eng after:\d{4}-\d{2}-\d{2}$/.test(q)));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /slack\/message \| needs you \| #eng · ana: build is slow today \| channel/);
    assert.match(needs, /slack\/message \| needs you \| #eng · ana: @U0ME can you check\? \| mention/);
    assert.doesNotMatch(needs, /on it/);
  });

  test("a bot message with no text is named by its block or attachment text, else (no text)", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    await hub("config", "slackAlertChannels", '["#tech_platform"]');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const channel = { id: "C09", name: "tech_platform" };
    const at = (t: string) => `https://acme.slack.com/archives/C09/p${t.replace(".", "")}`;
    const [blocks, second, bare] = [ts(300), ts(200), ts(100)];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      if (u.pathname !== "/api/search.messages") return { status: 404, body: "" };
      if (!(u.searchParams.get("query") ?? "").startsWith("in:#tech_platform"))
        return ok({ messages: { matches: [] } });
      const message = (t: string, extra: object) => ({
        ts: t,
        text: "",
        permalink: at(t),
        username: "Linear",
        channel,
        ...extra,
      });
      return ok({
        messages: {
          matches: [
            message(blocks, {
              blocks: [
                { type: "section", text: { type: "mrkdwn", text: "ENG-9 moved to *Done*" } },
                { type: "context", elements: [{ type: "mrkdwn", text: "by Ana" }] },
              ],
            }),
            message(second, { attachments: [{ color: "#000" }, { text: "ENG-10 created" }] }),
            message(bare, { files: [{ name: "a.png" }] }),
          ],
        },
      });
    };
    assert.match(await hub("fetch", "slack-acme"), /items: 3 new/);
    const list = await hub("items", "--source", "slack");
    assert.match(list, /#tech_platform · Linear: ENG-9 moved to \*Done\* by Ana \|/);
    assert.match(list, /#tech_platform · Linear: ENG-10 created \|/);
    assert.match(list, /#tech_platform · Linear: \(no text\) \|/);
  });

  test("my later reply in a mention's thread takes it off my list, in this fetch or a later one", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
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
      if (u.pathname === "/api/auth.test")
        return { status: 200, body: JSON.stringify({ ok: true, user_id: ME, ...WORKSPACE }) };
      if (u.pathname === "/api/search.messages") {
        const matches = (u.searchParams.get("query") ?? "").startsWith("from:") ? sent : mentions;
        return { status: 200, body: JSON.stringify({ ok: true, messages: { matches } }) };
      }
      if (u.pathname === "/api/reactions.get") return { status: 200, body: JSON.stringify({ ok: true, message: {} }) };
      return { status: 404, body: "" };
    };
    await hub("fetch", "slack-acme");
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.doesNotMatch(needs, /on call\?/);
    assert.match(needs, /#ops · ana: @U0ME can you review\? \| mention/);
    assert.match(await hub("items", "--source", "slack"), /#ops · ana: @U0ME are you on call\? \| replied/);

    sent = [reply(ts(5), other, "approved")];
    mentions = [];
    assert.match(await hub("fetch", "slack-acme"), /items: 1 new, 1 changed/);
    assert.doesNotMatch(await hub("items", "--needs-me", "--source", "slack"), /can you review\?/);
    assert.match(await hub("items", "--source", "slack"), /can you review\? \| replied/);
  });

  test("DMs and replies in threads I posted in need me without a mention, until my later reply", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
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
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
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
    assert.match(await hub("fetch", "slack-acme"), /items: 6 new/);
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
    assert.match(await hub("fetch", "slack-acme"), /items: 1 new, 1 changed/);
    const later = await hub("items", "--needs-me", "--source", "slack");
    assert.doesNotMatch(later, /thanks, merged/);
    assert.match(later, /DM · Ana: can we talk\? \| dm/);
    assert.match(await hub("items", "--source", "slack"), /#ops · Bo: thanks, merged \| replied/);
  });

  test("a mention of a group I am in needs me only in a group channel, named by the group, and a direct mention wins on the same message", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    await hub("config", "slackGroupChannels", '[{"id":"C01","name":"ops"}]');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const both = ts(100);
    const group = ts(90);
    const other = ts(80);
    const elsewhere = ts(70);
    const said = (t: string, text: string) => ({
      ts: t,
      text,
      permalink: permalink(t),
      user: "U2",
      username: "ana",
      channel: { id: "C01", name: "ops" },
    });
    const queries: string[] = [];
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
      if (u.pathname === "/api/usergroups.list") {
        assert.equal(p.get("include_users"), "true");
        return ok({
          usergroups: [
            { id: "S1", handle: "backend", users: ["U2", ME] },
            { id: "S2", handle: "design", users: ["U2"] },
          ],
        });
      }
      if (u.pathname === "/api/search.messages") {
        const q = p.get("query") ?? "";
        queries.push(q);
        const matches = q.startsWith(`<@${ME}>`)
          ? [said(both, `<@${ME}> <!subteam^S1> who owns the queue?`)]
          : q.startsWith("<!subteam^S1>")
            ? [
                said(both, `<@${ME}> <!subteam^S1> who owns the queue?`),
                said(group, "<!subteam^S1> deploy freeze at 5"),
                {
                  ...said(elsewhere, "<!subteam^S1> lunch?"),
                  permalink: `https://acme.slack.com/archives/C02/p${elsewhere.replace(".", "")}`,
                  channel: { id: "C02", name: "random" },
                },
              ]
            : q.startsWith("<!subteam^S2>")
              ? [said(other, "<!subteam^S2> new icons")]
              : [];
        return ok({ messages: { matches } });
      }
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack-acme"), /items: 2 new/);
    assert.ok(queries.some((q) => /^<!subteam\^S1> after:\d{4}-\d{2}-\d{2}$/.test(q)));
    assert.ok(!queries.some((q) => q.startsWith("<!subteam^S2>")));
    const needs = await hub("items", "--needs-me", "--source", "slack");
    assert.match(needs, /#ops · ana: @U0ME @backend who owns the queue\? \| mention \|/);
    assert.match(needs, /#ops · ana: @backend deploy freeze at 5 \| mention @backend/);
    assert.doesNotMatch(needs, /new icons/);
    assert.doesNotMatch(needs, /lunch/);

    await hub("config", "slackGroupChannels", "[]");
    queries.length = 0;
    await hub("fetch", "slack-acme");
    assert.ok(queries.length > 0);
    assert.ok(!queries.some((q) => q.startsWith("<!subteam^")));
  });

  test("a scope Slack refuses leaves its details out and becomes a warning, not an error", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    await hub("config", "slackGroupChannels", '[{"id":"C01","name":"ops"}]');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const at = ts(100);
    const refused = (needed: string) => ({
      status: 200,
      body: JSON.stringify({ ok: false, error: "missing_scope", needed }),
    });
    httpAnswer = (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/auth.test")
        return { status: 200, body: JSON.stringify({ ok: true, user_id: ME, ...WORKSPACE }) };
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
      if (u.pathname === "/api/usergroups.list") return refused("usergroups:read");
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack-acme"), /items: 1 new/);
    assert.match(await hub("items", "--needs-me", "--source", "slack"), /DM · U2: @U9 ping \| mention/);
    assert.match(
      await hub("sources"),
      /warning: missing im:read, reactions:read, usergroups:read, users:read: names, DMs, group mentions or reactions are left out/,
    );
    const page = await (await fetch(`${server.url}/settings?part=1`)).text();
    assert.match(page, /<span class="src src-warn" title="[^"]*missing im:read[^"]*"><i><\/i>Slack acme<\/span>/);
    assert.match(page, /tone-text-amber">missing im:read, reactions:read, usergroups:read, users:read/);
    assert.match(page, /--allow &#39;GET \/api\/reactions\.get&#39;/);
  });

  test("a DM whose sender lookup fails is held with the cursor and checked again next sync", async () => {
    await hub("config", "fetch", '{"github":false,"slack-acme":true}');
    answers.security = (args) =>
      args.includes("slack-acme") ? { code: 0, stdout: "xoxp-1\n", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    const link = (channel: string, t: string) => `https://acme.slack.com/archives/${channel}/p${t.replace(".", "")}`;
    const dm = (t: string, user: string, text: string, channel: string) => ({
      ts: t,
      text,
      user,
      channel: { id: channel, is_im: true },
      permalink: link(channel, t),
    });
    const toMe = [
      dm(ts(100), "U2", "can we talk?", "D01"),
      dm(ts(90), "U7", "incident declared", "D03"),
      dm(ts(80), "U7", "incident resolved", "D03"),
    ];
    let lookup = (_id: string) => ({ status: 429, body: JSON.stringify({ ok: false, error: "ratelimited" }) });
    const ok = (body: unknown) => ({ status: 200, body: JSON.stringify({ ok: true, ...(body as object) }) });
    httpAnswer = (url) => {
      const u = new URL(url);
      const p = u.searchParams;
      if (u.pathname === "/api/auth.test") return ok({ user_id: ME, user: "khai", ...WORKSPACE });
      if (u.pathname === "/api/search.messages")
        return ok({ messages: { matches: (p.get("query") ?? "").startsWith("to:") ? toMe : [] } });
      if (u.pathname === "/api/users.info") return lookup(p.get("user") ?? "");
      if (u.pathname === "/api/conversations.info") return ok({ channel: { id: p.get("channel"), is_im: true } });
      if (u.pathname === "/api/reactions.get") return ok({ message: { reactions: [] } });
      if (u.pathname === "/api/usergroups.list") return ok({ usergroups: [] });
      return { status: 404, body: "" };
    };
    assert.match(await hub("fetch", "slack-acme"), /nothing new/);
    const sources = await hub("sources");
    assert.match(sources, /warning: failed users\.info slack\.com answered 429; 3 DMs from unchecked senders wait/);
    assert.doesNotMatch(sources, /missing users:read/);
    const cursor = /slack-acme \| last sync .* \| cursor (\d+(?:\.\d+)?)/.exec(sources)?.[1];
    assert.ok(cursor !== undefined && Number(cursor) < Number(ts(100)));

    lookup = (id) =>
      ok({ user: { id, is_bot: id === "U7", profile: { display_name: id === "U2" ? "Ana" : "incident" } } });
    assert.match(await hub("fetch", "slack-acme"), /items: 1 new/);
    const all = await hub("items", "--source", "slack");
    assert.match(all, /DM · Ana: can we talk\? \| dm/);
    assert.doesNotMatch(all, /incident/);
    assert.doesNotMatch(await hub("sources"), /warning/);
  });

  test("a Slack error answer is the source error", async () => {
    answers.security = () => ({ code: 0, stdout: "xoxp-1\n", stderr: "" });
    httpAnswer = () => ({ status: 200, body: JSON.stringify({ ok: false, error: "missing_scope" }) });
    assert.match(await hub("fetch", "slack-acme"), /^slack-acme: slack auth.test: missing_scope$/);
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
    assert.match(
      await fails("source", "add", "github", "--every", "5m", "--", "x"),
      /github, linear, slack and slack-\* are taken/,
    );
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
