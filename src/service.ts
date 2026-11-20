import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Result } from "./commands.ts";
import { esc } from "./markdown.ts";
import { HubError } from "./util.ts";

export const LABEL = "engineer-hub";

export type System = {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  launchctl: (args: string[]) => { code: number; out: string };
  sleep: (ms: number) => void;
};

export type ServiceSpec = { node: string; cli: string; dbFile: string; port: number; path: string };

export function system(env: NodeJS.ProcessEnv): System {
  return {
    platform: process.platform,
    home: env.HOME ?? "",
    uid: process.getuid?.() ?? 0,
    launchctl: (args) => {
      const run = spawnSync("launchctl", args, { encoding: "utf8" });
      return { code: run.status ?? 1, out: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
    },
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  };
}

export function plistPath(sys: System): string {
  return join(sys.home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export function logPath(dbFile: string): string {
  return join(dirname(dbFile), "serve.log");
}

function strings(values: string[]): string {
  return values.map((v) => `    <string>${esc(v)}</string>`).join("\n");
}

export function plist(spec: ServiceSpec): string {
  const log = esc(logPath(spec.dbFile));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([spec.node, spec.cli, "serve", "--db", spec.dbFile, "--port", String(spec.port)])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(spec.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function launchd(sys: System): string {
  if (sys.platform !== "darwin") {
    throw new HubError("hub service uses launchd and runs on macOS only: run hub serve under your own supervisor");
  }
  return `gui/${sys.uid}`;
}

export function install(sys: System, spec: ServiceSpec): Result {
  const domain = launchd(sys);
  const file = plistPath(sys);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, plist(spec));
  sys.launchctl(["bootout", `${domain}/${LABEL}`]);
  // bootout returns before the old job exits; bootstrapping the same label meanwhile fails with error 5.
  for (let tries = 0; tries < 50 && sys.launchctl(["print", `${domain}/${LABEL}`]).code === 0; tries++) sys.sleep(100);
  const loaded = sys.launchctl(["bootstrap", domain, file]);
  if (loaded.code !== 0) throw new HubError(`launchctl bootstrap failed: ${loaded.out}`);
  const url = `http://127.0.0.1:${spec.port}`;
  return {
    text: `hub runs at login and restarts if it stops: ${url}, log ${logPath(spec.dbFile)}`,
    json: { label: LABEL, plist: file, url, log: logPath(spec.dbFile) },
  };
}

export function status(sys: System): Result {
  const domain = launchd(sys);
  const file = plistPath(sys);
  const shown = sys.launchctl(["print", `${domain}/${LABEL}`]);
  if (shown.code !== 0) {
    const text = existsSync(file)
      ? "hub service is installed but not loaded: hub service install"
      : "hub service is not installed: hub service install";
    return { text, json: { installed: existsSync(file), running: false }, exitCode: 1 };
  }
  const state = /^\s*state = (.+)$/m.exec(shown.out)?.[1] ?? "unknown";
  const pid = /^\s*pid = (\d+)$/m.exec(shown.out)?.[1];
  const running = state === "running";
  return {
    text: `${state}${pid === undefined ? "" : ` (pid ${pid})`} | ${file}`,
    json: { installed: true, running, state, pid: pid === undefined ? null : Number(pid), plist: file },
    exitCode: running ? 0 : 1,
  };
}

export function uninstall(sys: System): Result {
  const domain = launchd(sys);
  const file = plistPath(sys);
  const stopped = sys.launchctl(["bootout", `${domain}/${LABEL}`]);
  if (!existsSync(file) && stopped.code !== 0) throw new HubError("hub service is not installed");
  rmSync(file, { force: true });
  return { text: "hub service removed: hub no longer starts at login", json: { removed: file } };
}
