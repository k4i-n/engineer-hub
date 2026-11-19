import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import { github } from "../src/fetchers/github.ts";
import type { Ran, System } from "../src/keys.ts";
import { type Server, serve } from "../src/serve.ts";

let dir = "";
let dbFile = "";
let server: Server;
let calls: string[][] = [];
let answers: Record<string, (args: string[], input: string) => Ran> = {};

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
      return {
        status: 200,
        text: async () => `{"ok":true,"echo":"${(init.headers as Record<string, string>).Authorization}"}`,
      };
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
  server = await serve({
    dbPath: dbFile,
    port: 0,
    now: () => new Date(),
    env: {},
    fetchers: [github],
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
      fetchers: [github],
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
