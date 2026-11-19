import { type ChildProcess, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { type Args, checkFields, findRoute, openapi, queryArgs, runRoute } from "./api.ts";
import type { Ctx } from "./commands.ts";
import { loadConfig } from "./config.ts";
import { one, openDb, SCHEMA_VERSION, type SourceRow } from "./db.ts";
import { type Fetcher, Runner } from "./fetch.ts";
import { FETCHERS } from "./fetchers/index.ts";
import { type System, system } from "./keys.ts";
import { handleRpc } from "./mcp.ts";
import { loadToken, tokenPath } from "./token.ts";
import { afterDuration, HubError, nowIso } from "./util.ts";
import { type Fetching, indexBody, page, type SyncState, settingsBody, ticketBody } from "./views.ts";

export type ServeOptions = {
  dbPath: string;
  port: number;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  autoSyncCheckMs?: number;
  fetchCheckMs?: number;
  system?: System;
  fetchers?: Fetcher[];
};
export type Server = { url: string; token: string; close: () => Promise<void> };

const WATCH_MS = 250;
const KEEPALIVE_MS = 20_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 1_048_576;
const API = "/api/v1";
const OUTPUT_TAIL = 2_000;
const AUTO_SYNC_CHECK_MS = 60_000;
const FETCH_CHECK_MS = 15_000;

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;
const OPENAPI = JSON.stringify(openapi(VERSION));

const STATIC: Record<string, { type: string; body: string }> = {
  "/app.css": { type: "text/css", body: readFileSync(new URL("./web/app.css", import.meta.url), "utf8") },
  "/app.js": { type: "text/javascript", body: readFileSync(new URL("./web/app.js", import.meta.url), "utf8") },
};

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...extra,
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_BODY) reject(new HubError("request too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readBody(req: IncomingMessage): Promise<Args> {
  const raw = await readText(req);
  let value: unknown;
  try {
    value = raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new HubError("body must be a JSON object");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new HubError("body must be a JSON object");
  return value as Args;
}

function fetching(c: Ctx, runner: Runner): Fetching[] {
  return runner.fetchers(c).map((f) => {
    const row = one<SourceRow>(c.db, "SELECT * FROM source WHERE name = ?", f.name);
    const state = runner.status.get(f.name);
    return {
      name: f.name,
      on: f.argv !== undefined || c.config.fetch[f.name] === true,
      script: f.argv === undefined ? null : `${f.argv.join(" ")} · every ${f.every ?? ""}`,
      how: state?.check?.how ?? null,
      ok: state?.check?.ok ?? null,
      fixes: runner.fixes(f),
      last: row?.last_sync ?? null,
      error: row?.last_error ?? null,
    };
  });
}

export function serve(options: ServeOptions): Promise<Server> {
  const token = loadToken(tokenPath(options.dbPath));
  const db = openDb(options.dbPath);
  const watch = openDb(options.dbPath);
  const clients = new Set<ServerResponse>();
  let sync: SyncState = { status: "idle", at: null, detail: null };
  let child: ChildProcess | null = null;
  let port = options.port;

  const ctx = (): Ctx => ({ db, config: loadConfig(db), now: options.now() });
  const broadcast = () => {
    for (const client of clients) client.write("event: change\ndata: \n\n");
  };
  const dataVersion = () => (watch.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  let lastVersion = dataVersion();
  const watcher = setInterval(() => {
    const version = dataVersion();
    if (version === lastVersion) return;
    lastVersion = version;
    broadcast();
  }, WATCH_MS);
  const startedAt = options.now().getTime();
  const autoSync = setInterval(() => {
    const c = ctx();
    if (!c.config.autoSync || sync.status === "running") return;
    const every = Date.parse(afterDuration(new Date(0), c.config.syncEvery, "syncEvery"));
    const last = sync.at === null ? startedAt : Date.parse(sync.at);
    if (options.now().getTime() - last >= every) startSync();
  }, options.autoSyncCheckMs ?? AUTO_SYNC_CHECK_MS);
  autoSync.unref();
  const runner = new Runner(options.fetchers ?? FETCHERS, options.system ?? system(options.env), ctx);
  const fetchTimer = setInterval(() => {
    runner.tick().catch(() => {});
  }, options.fetchCheckMs ?? FETCH_CHECK_MS);
  fetchTimer.unref();
  const keepalive = setInterval(() => {
    for (const client of clients) client.write(": keepalive\n\n");
  }, KEEPALIVE_MS);

  function startSync(): boolean {
    if (sync.status === "running") return false;
    const [program, ...args] = ctx().config.syncCommand;
    if (program === undefined) throw new HubError("syncCommand is empty (hub config syncCommand)");
    let output = "";
    let done = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    const finish = (ok: boolean, detail: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child = null;
      sync = { status: ok ? "finished" : "failed", at: nowIso(options.now()), detail };
      broadcast();
    };
    const proc = spawn(program, args, {
      cwd: dirname(options.dbPath),
      env: { ...options.env, HUB_DB: options.dbPath, HUB_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    const timeout = setTimeout(() => proc.kill("SIGTERM"), SYNC_TIMEOUT_MS);
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    proc.on("error", (error) => finish(false, error.message));
    proc.on("close", (code) => {
      const last = output.trim().split("\n").at(-1) ?? "";
      finish(code === 0, code === 0 ? last : `exit ${code ?? "signal"}: ${last}`);
    });
    sync = { status: "running", at: nowIso(options.now()), detail: null };
    broadcast();
    return true;
  }

  function authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const json = (status: number, value: unknown, extra: Record<string, string> = {}) =>
      send(res, status, "application/json", JSON.stringify(value), extra);
    if (!authorized(req)) {
      json(401, { error: "missing or wrong token: send Authorization: Bearer <the token file next to the database>" });
      return;
    }
    const want = req.headers["x-hub-db"];
    if (typeof want === "string" && resolve(want) !== resolve(options.dbPath)) {
      json(409, {
        error: `hub at 127.0.0.1:${port} serves ${options.dbPath}, not ${want}: point HUB_DB or --db at it, or HUB_URL at the hub that serves ${want}`,
      });
      return;
    }
    const found = findRoute(req.method ?? "", url.pathname.slice(API.length));
    if (found === undefined) {
      json(404, { error: `no route ${url.pathname} (${API}/openapi.json lists them)` });
      return;
    }
    if (found === "no-method") {
      json(405, { error: `${req.method} is not allowed on ${url.pathname}` });
      return;
    }
    const { route, args } = found;
    try {
      let input: Args;
      if (route.method === "GET") input = queryArgs(route.query ?? {}, url.searchParams);
      else {
        if (url.search !== "") throw new HubError("send fields in the JSON body, not the query");
        input = checkFields(route.body ?? {}, await readBody(req), "body");
      }
      const result = await runRoute(ctx(), route, { ...input, ...args }, hooks, req.headers["x-hub-actor"] === "human");
      const status = route.status?.(result) ?? 200;
      const exit = { "x-hub-exit": String(result.exitCode ?? 0) };
      if (req.headers.accept === "text/plain") send(res, status, "text/plain", result.text, exit);
      else json(status, result.json, exit);
    } catch (error) {
      if (!(error instanceof HubError)) throw error;
      json(400, { error: error.message });
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const json = (status: number, value: unknown) => send(res, status, "application/json", JSON.stringify(value));
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      json(403, { error: "forbidden origin" });
      return;
    }
    if (!authorized(req)) {
      json(401, { error: "missing or wrong token: send Authorization: Bearer <the token file next to the database>" });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(await readText(req));
    } catch (error) {
      const text = error instanceof HubError ? error.message : "parse error";
      json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: text } });
      return;
    }
    const reply = await handleRpc(message, ctx, hooks);
    if (reply === null) res.writeHead(202).end();
    else json(200, reply);
  }

  const hooks = {
    version: VERSION,
    syncStatus: () => sync,
    startSync: () => ({ started: startSync(), status: sync }),
    fetchNow: (source: string | null) => runner.now(source),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      send(res, 403, "text/plain", "forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${host}`);
    const part = url.searchParams.has("part");

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const asset = STATIC[url.pathname];
    if (req.method === "GET" && asset !== undefined) {
      send(res, 200, asset.type, asset.body);
      return;
    }
    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/settings" || url.pathname.startsWith("/t/"))
    ) {
      const c = ctx();
      let body: string;
      let title = "hub";
      try {
        if (url.pathname === "/") body = indexBody(c, sync);
        else if (url.pathname === "/settings") {
          title = "Settings · hub";
          const schema = one<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'schema_version'")?.value;
          body = settingsBody(
            c,
            sync,
            {
              path: options.dbPath,
              size: statSync(options.dbPath).size,
              schema: schema ?? SCHEMA_VERSION,
            },
            fetching(c, runner),
          );
        } else {
          const id = decodeURIComponent(url.pathname.slice(3));
          title = `${id} · hub`;
          body = ticketBody(c, id, sync);
        }
      } catch (error) {
        if (!(error instanceof HubError)) throw error;
        send(res, 404, "text/plain", error.message);
        return;
      }
      send(res, 200, "text/html", part ? body : page(c, title, body, token));
      return;
    }
    if (url.pathname === `${API}/openapi.json` && req.method === "GET") {
      send(res, 200, "application/json", OPENAPI);
      return;
    }
    if (url.pathname === "/mcp") {
      await mcp(req, res);
      return;
    }
    if (url.pathname.startsWith(`${API}/`)) {
      await api(req, res, url);
      return;
    }
    send(res, 404, "text/plain", "not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, "text/plain", error instanceof Error ? error.message : String(error));
    });
  });

  const close = async () => {
    clearInterval(watcher);
    clearInterval(keepalive);
    clearInterval(autoSync);
    clearInterval(fetchTimer);
    child?.kill("SIGTERM");
    for (const client of clients) client.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    watch.close();
  };

  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      clearInterval(watcher);
      clearInterval(keepalive);
      clearInterval(autoSync);
      clearInterval(fetchTimer);
      db.close();
      watch.close();
      reject(error);
    });
    server.listen(options.port, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, token, close });
    });
  });
}
