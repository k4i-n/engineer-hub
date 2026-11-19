import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type Io, run } from "../src/cli.ts";
import type { System } from "../src/service.ts";

let home = "";
let calls: string[][] = [];
let printed = "";

function fakeSystem(platform: NodeJS.Platform = "darwin"): System {
  return {
    platform,
    home,
    uid: 501,
    launchctl: (args) => {
      calls.push(args);
      if (args[0] === "print")
        return printed === "" ? { code: 113, out: "Could not find service" } : { code: 0, out: printed };
      return { code: 0, out: "" };
    },
  };
}

async function hub(argv: string[], sys = fakeSystem()): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    readStdin: () => "",
    env: { HOME: home, HUB_DB: join(home, ".hub", "hub.db"), PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    now: () => new Date(),
    system: sys,
  };
  const code = await run(argv, io);
  return { code, out, err };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hub-service-"));
  calls = [];
  printed = "";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("install writes a LaunchAgent that serves the database at login and keeps it running", async () => {
  const r = await hub(["service", "install", "--port", "7431"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /http:\/\/127\.0\.0\.1:7431, log .*\.hub\/serve\.log$/);
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "engineer-hub.plist"), "utf8");
  assert.match(plist, /<string>serve<\/string>\s*<string>--db<\/string>\s*<string>[^<]*\.hub\/hub\.db<\/string>/);
  assert.match(plist, /<string>--port<\/string>\s*<string>7431<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>\s*<key>KeepAlive<\/key>\s*<true\/>/);
  assert.deepEqual(calls, [
    ["bootout", "gui/501/engineer-hub"],
    ["bootstrap", "gui/501", join(home, "Library", "LaunchAgents", "engineer-hub.plist")],
  ]);
});

test("status reports running with its pid, and exits 1 when not installed", async () => {
  const missing = await hub(["service", "status"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, "hub service is not installed: hub service install");
  printed = "gui/501/engineer-hub = {\n\tstate = running\n\tpid = 4242\n}";
  const shown = await hub(["service", "status", "--json"]);
  assert.equal(shown.code, 0);
  assert.deepEqual(JSON.parse(shown.out), {
    installed: true,
    running: true,
    state: "running",
    pid: 4242,
    plist: join(home, "Library", "LaunchAgents", "engineer-hub.plist"),
  });
});

test("uninstall stops the job and removes the LaunchAgent", async () => {
  await hub(["service", "install"]);
  const r = await hub(["service", "uninstall"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", "engineer-hub.plist")), false);
  assert.deepEqual(calls.at(-1), ["bootout", "gui/501/engineer-hub"]);
});

test("off macOS the service command says to use your own supervisor", async () => {
  const r = await hub(["service", "install"], fakeSystem("linux"));
  assert.equal(r.code, 1);
  assert.match(r.err, /macOS only: run hub serve under your own supervisor/);
  assert.equal((await hub(["service", "restart"])).code, 1);
});
