import { spawn } from "node:child_process";
import { HubError } from "./util.ts";

export type Ran = { code: number; stdout: string; stderr: string; timedOut?: true };
export type Run = (
  program: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string },
) => Promise<Ran>;
export type Http = (url: string, init: RequestInit) => Promise<{ status: number; text: () => Promise<string> }>;
export type System = { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; run: Run; http: Http };

export type KeySpec = { source: string; host: string; header: string; allow: string[] };
export type Way = { kind: "sealcall"; route: string } | { kind: "hub"; key: string } | { kind: "missing" };

const RUN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 8_000_000;
export const KEYCHAIN_SERVICE = "engineer-hub";

export const run: Run = (program, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(program, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? RUN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
    });
    child.stdin.end(options.input ?? "");
  });

export function system(env: NodeJS.ProcessEnv): System {
  return { platform: process.platform, env, run, http: (url, init) => fetch(url, init) };
}

function envName(source: string): string {
  return `HUB_${source.toUpperCase().replaceAll("-", "_")}_KEY`;
}

export function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

export async function findWay(sys: System, source: string): Promise<Way> {
  const routes = await sys.run("sealcall", ["routes"]);
  if (routes.code === 0 && routes.stdout.split("\n").some((line) => line.split(/\s+/)[0] === source)) {
    return { kind: "sealcall", route: source };
  }
  if (sys.platform === "darwin") {
    const item = await sys.run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", source, "-w"]);
    if (item.code === 0 && item.stdout.trim() !== "") return { kind: "hub", key: item.stdout.trim() };
  }
  const key = sys.env[envName(source)];
  return key ? { kind: "hub", key } : { kind: "missing" };
}

export function storeCommands(spec: KeySpec, platform: NodeJS.Platform): { hub: string; sealcall: string } {
  const allow = spec.allow.map((a) => ` --allow '${a}'`).join("");
  return {
    hub:
      platform === "darwin"
        ? `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${spec.source} -w`
        : `export ${envName(spec.source)}=<key>`,
    sealcall: `sealcall add ${spec.source} --host ${spec.host} --header '${spec.header}'${allow}`,
  };
}

export function wayText(way: Way): string {
  if (way.kind === "sealcall") return `sealcall route ${way.route}`;
  if (way.kind === "hub") return "hub's own key";
  return "no key";
}

export class HttpError extends HubError {
  readonly status: number;
  constructor(host: string, status: number) {
    super(`${host} answered ${status}`);
    this.status = status;
  }
}

export async function keyedCall(
  sys: System,
  way: Way,
  spec: KeySpec,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<string> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (way.kind === "missing") throw new HubError(`no key for ${spec.source}`);
  if (way.kind === "sealcall") {
    const json = data === undefined ? [] : ["--data", "-", "-H", "Content-Type: application/json"];
    const r = await sys.run(
      "sealcall",
      ["call", way.route, method, path, ...json],
      data === undefined ? {} : { input: data },
    );
    const status = /HTTP (\d{3})/.exec(r.stderr)?.[1];
    if (r.code !== 0)
      throw status ? new HttpError(spec.host, Number(status)) : new HubError(lastLine(r.stderr) || "sealcall failed");
    return r.stdout;
  }
  const [name, template] = spec.header.split(/:\s*/, 2) as [string, string];
  const headers: Record<string, string> = { [name]: template.replace("{key}", way.key) };
  if (data !== undefined) headers["content-type"] = "application/json";
  const init: RequestInit = { method, headers };
  if (data !== undefined) init.body = data;
  const r = await sys.http(`https://${spec.host}${path}`, init);
  const text = await r.text();
  if (r.status >= 400) throw new HttpError(spec.host, r.status);
  return text.replaceAll(way.key, "<redacted>");
}
