import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { findWay, type KeySpec, keyedCall, type Ran, type System } from "../src/keys.ts";

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
      calls.push(["http", String(init.method), url]);
      return {
        status: 200,
        text: async () => `{"ok":true,"echo":"${(init.headers as Record<string, string>).Authorization}"}`,
      };
    },
  };
}

beforeEach(() => {
  calls = [];
  answers = {};
});

describe("keys", () => {
  const spec: KeySpec = {
    source: "linear",
    host: "api.linear.app",
    header: "Authorization: {key}",
    allow: ["POST /graphql"],
  };

  test("a sealcall route named after the source wins; the key never reaches hub", async () => {
    answers.sealcall = (args, input) => {
      if (args[0] === "routes") return { code: 0, stdout: "linear  api.linear.app  POST /graphql\n", stderr: "" };
      return { code: 0, stdout: `{"data":${input}}`, stderr: "HTTP 200\n" };
    };
    const way = await findWay(fake(), "linear");
    assert.deepEqual(way, { kind: "sealcall", route: "linear" });
    assert.equal(await keyedCall(fake(), way, spec, "POST", "/graphql", { q: 1 }), '{"data":{"q":1}}');
    assert.deepEqual(calls.at(-1), [
      "sealcall",
      "call",
      "linear",
      "POST",
      "/graphql",
      "--data",
      "-",
      "-H",
      "Content-Type: application/json",
    ]);
    answers.sealcall = (args) =>
      args[0] === "routes"
        ? { code: 0, stdout: "linear  x  y\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "HTTP 401\n" };
    await assert.rejects(keyedCall(fake(), way, spec, "POST", "/graphql", {}), /api.linear.app answered 401/);
  });

  test("otherwise hub's own Keychain item, or the env key off macOS, and the key is redacted", async () => {
    answers.security = () => ({ code: 0, stdout: "lin_api_secret\n", stderr: "" });
    const way = await findWay(fake(), "linear");
    assert.deepEqual(way, { kind: "hub", key: "lin_api_secret" });
    assert.ok(calls.some((c) => c.join(" ") === "security find-generic-password -s engineer-hub -a linear -w"));
    const text = await keyedCall(fake(), way, spec, "POST", "/graphql", {});
    assert.equal(text, '{"ok":true,"echo":"<redacted>"}');
    assert.match(calls.at(-1)?.[2] ?? "", /^https:\/\/api\.linear\.app\/graphql$/);
    delete answers.security;
    assert.deepEqual(await findWay(fake("linux", { HUB_LINEAR_KEY: "k" }), "linear"), { kind: "hub", key: "k" });
    assert.deepEqual(await findWay(fake("linux"), "linear"), { kind: "missing" });
  });
});
