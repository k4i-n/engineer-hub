import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Ctx, Result } from "./commands.ts";
import * as commands from "./commands.ts";
import { loadConfig, setConfig } from "./config.ts";
import { one, openDb, SCHEMA_VERSION } from "./db.ts";
import * as items from "./items.ts";
import { HubError, nowIso } from "./util.ts";
import { indexBody, page, type SyncState, settingsBody, ticketBody } from "./views.ts";
import * as waits from "./waits.ts";

export type ServeOptions = { dbPath: string; port: number; now: () => Date; env: NodeJS.ProcessEnv };
export type Server = { url: string; token: string; close: () => Promise<void> };

const WATCH_MS = 250;
const KEEPALIVE_MS = 20_000;
const SYNC_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY = 16_384;
const OUTPUT_TAIL = 2_000;

type Body = Record<string, unknown>;

const STATIC: Record<string, { type: string; body: string }> = {
  "/app.css": { type: "text/css", body: readFileSync(new URL("./web/app.css", import.meta.url), "utf8") },
  "/app.js": { type: "text/javascript", body: readFileSync(new URL("./web/app.js", import.meta.url), "utf8") },
};

function field(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") throw new HubError(`missing ${key}`);
  return value;
}

const ACTIONS: Record<string, (ctx: Ctx, body: Body) => Result> = {
  sent: (ctx, b) =>
    commands.posted(ctx, field(b, "ticket"), field(b, "label"), {
      at: null,
      channel: null,
      answer: null,
      sentText: null,
      sentRef: null,
    }),
  match: (ctx, b) => commands.resolveMatch(ctx, field(b, "ticket"), field(b, "label"), field(b, "answer")),
  "item-done": (ctx, b) => items.close(ctx, [field(b, "id")]),
  "item-snooze": (ctx, b) => items.snooze(ctx, field(b, "id"), typeof b.for === "string" ? b.for : "1d"),
  "item-reopen": (ctx, b) => items.reopen(ctx, field(b, "id")),
  "wait-close": (ctx, b) => waits.closeWait(ctx, field(b, "id")),
  "wait-pinged": (ctx, b) => waits.pinged(ctx, field(b, "id"), "1d"),
  "wait-reopen": (ctx, b) => waits.reopenWait(ctx, field(b, "id")),
  gate: (ctx, b) => commands.answerGate(ctx, field(b, "ticket"), field(b, "answer")),
  config: (ctx, b) => {
    if (field(b, "key") === "syncCommand")
      throw new HubError("syncCommand is set from the terminal: hub config syncCommand");
    setConfig(ctx.db, field(b, "key"), field(b, "value"), ctx.now);
    return { text: "saved", json: { key: b.key } };
  },
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > MAX_BODY) reject(new HubError("request too large"));
    });
    req.on("end", () => {
      try {
        const value: unknown = raw === "" ? {} : JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
        resolve(value as Body);
      } catch {
        reject(new HubError("body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

export function serve(options: ServeOptions): Promise<Server> {
  const db = openDb(options.dbPath);
  const watch = openDb(options.dbPath);
  const token = randomBytes(24).toString("hex");
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
      env: { ...options.env, HUB_DB: options.dbPath },
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
    if (req.method === "GET" && url.pathname === "/api/status") {
      send(res, 200, "application/json", JSON.stringify(sync));
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
          body = settingsBody(c, sync, {
            path: options.dbPath,
            size: statSync(options.dbPath).size,
            schema: schema ?? SCHEMA_VERSION,
          });
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
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      if (req.headers["x-hub-token"] !== token) {
        send(res, 403, "text/plain", "bad token");
        return;
      }
      const name = url.pathname.slice(5);
      try {
        const body = await readBody(req);
        if (name === "sync") {
          const started = startSync();
          send(res, started ? 202 : 409, "application/json", JSON.stringify(sync));
          return;
        }
        const action = ACTIONS[name];
        if (action === undefined) {
          send(res, 404, "text/plain", `no action ${name}`);
          return;
        }
        send(res, 200, "application/json", JSON.stringify(action(ctx(), body).json));
      } catch (error) {
        if (!(error instanceof HubError)) throw error;
        send(res, 400, "text/plain", error.message);
      }
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
