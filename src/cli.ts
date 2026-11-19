#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Args, COMMAND_KEYS, params, ROUTES } from "./api.ts";
import type { Result } from "./commands.ts";
import * as commands from "./commands.ts";
import { dbPath, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { serve } from "./serve.ts";
import * as service from "./service.ts";
import { tokenPath } from "./token.ts";
import { HubError } from "./util.ts";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  system?: service.System;
};

const USAGE = `usage: hub <command> [args] [--json] [--db <path>]
read:   ticket <id> | board [regex] | next | gates | changed --since <YYYY-MM-DD|yesterday|today>
        search <query> [-n 10] | events <id> [-n 20] [--full] | notes <id> | note-show <id> <title>
        drafts [id] | draft-show <id> <label> | day [date] | lint | config [key]
        items [--needs-me] [--source <s>] [--ticket <id>] [--all] | waits [--due] | sources | brief
        steps <id>
write:  set <id> <field> <value> | log <id> <text> [--kind log] [--source agent] [--ref <url>]
        note <id> <title> (--file <path> | --stdin) [--kind detail]
        draft <id> <label> (--file <path> | --stdin) [--channel <c>] [--send-at <when>]
        draft-later <id> <label> [--for 1h|tomorrow|tomorrow 12:00]
        match <id> <label> --ref <url> (--file | --stdin) | match <id> <label> (yes | no)
        posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file | --stdin]
        link <id> <url> [--kind <k>] [--title <t>]
        item put --stdin | item close <item>... | item snooze <item> [--for 1d|tomorrow] | item reopen <item> | item attach <item> <id>
        wait <id> <who> <url> [--ping-after 1d] | wait close <wait | url> | wait pinged <wait> [--for 1d|tomorrow] | wait reopen <wait>
        source <name> [--cursor <c>] [--error <text>]
        step add <id> <title> | step done <id> <n> [--evidence <url>]
        day set <date> (--file <path> | --stdin) | ticket-new <id> <title> [--dir todo]
        move <id> <dir> | gate <id> (yes | no) | config <key> <json>
import: import --root <dir> [--apply]
serve:  serve [--port 7420] | service install [--port 7420] | service status | service uninstall
        mcp-headers (the Authorization header for an MCP client's headersHelper)`;

const OPTIONS = {
  json: { type: "boolean" },
  apply: { type: "boolean" },
  full: { type: "boolean" },
  stdin: { type: "boolean" },
  db: { type: "string" },
  root: { type: "string" },
  kind: { type: "string" },
  source: { type: "string" },
  ref: { type: "string" },
  file: { type: "string" },
  channel: { type: "string" },
  at: { type: "string" },
  answer: { type: "string" },
  title: { type: "string" },
  "needs-me": { type: "boolean" },
  all: { type: "boolean" },
  ticket: { type: "string" },
  "ping-after": { type: "string" },
  "send-at": { type: "string" },
  due: { type: "boolean" },
  cursor: { type: "string" },
  error: { type: "string" },
  evidence: { type: "string" },
  for: { type: "string" },
  port: { type: "string" },
  dir: { type: "string" },
  since: { type: "string" },
  n: { type: "string", short: "n" },
} as const;

type Values = {
  json?: boolean;
  apply?: boolean;
  full?: boolean;
  stdin?: boolean;
  db?: string;
  root?: string;
  kind?: string;
  source?: string;
  ref?: string;
  file?: string;
  channel?: string;
  at?: string;
  answer?: string;
  title?: string;
  "needs-me"?: boolean;
  all?: boolean;
  ticket?: string;
  "ping-after"?: string;
  "send-at"?: string;
  due?: boolean;
  cursor?: string;
  error?: string;
  evidence?: string;
  for?: string;
  port?: string;
  dir?: string;
  since?: string;
  n?: string;
};

type Call = { route: string; args: Args };
type Handler = (args: string[], values: Values, io: Io) => Call;

const c = (route: string, args: Args = {}): Call => ({ route, args });

function arg(args: string[], index: number, usage: string): string {
  const value = args[index];
  if (value === undefined) throw new HubError(`usage: hub ${usage}`);
  return value;
}

function count(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HubError(`-n takes a positive integer, not ${value}`);
  return n;
}

function body(values: Values, io: Io): string {
  if (values.file !== undefined) {
    if (!existsSync(values.file)) throw new HubError(`--file ${values.file} does not exist`);
    return readFileSync(values.file, "utf8");
  }
  if (values.stdin) return io.readStdin();
  throw new HubError("give the text with --file <path> or --stdin");
}

function root(values: Values): string {
  if (values.root === undefined) throw new HubError("give the markdown folder with --root <dir>");
  return values.root;
}

function lines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new HubError(`line ${index + 1}: not JSON`);
      }
    });
}

function configValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HubError(`config value must be JSON, e.g. '"Europe/Berlin"' or '["a","b"]'`);
  }
}

const COMMANDS: Record<string, Handler> = {
  ticket: (a) => c("ticket", { id: arg(a, 0, "ticket <id>") }),
  board: (a) => c("board", a[0] === undefined ? {} : { q: a[0] }),
  next: () => c("next"),
  gates: () => c("gates"),
  changed: (_a, v) => c("changed", v.since === undefined ? {} : { since: v.since }),
  search: (a, v) => c("search", { q: a.join(" "), n: count(v.n, 10) }),
  events: (a, v) => c("events", { id: arg(a, 0, "events <id>"), n: count(v.n, 20), full: v.full === true }),
  notes: (a) => c("notes", { id: arg(a, 0, "notes <id>") }),
  "note-show": (a) =>
    c("note", { id: arg(a, 0, "note-show <id> <title>"), title: arg(a, 1, "note-show <id> <title>") }),
  drafts: (a) => c("drafts", a[0] === undefined ? {} : { ticket: a[0] }),
  "draft-show": (a) =>
    c("draft", { id: arg(a, 0, "draft-show <id> <label>"), label: arg(a, 1, "draft-show <id> <label>") }),
  items: (_a, v) =>
    c("items", {
      needs_me: v["needs-me"] === true,
      all: v.all === true,
      ...(v.source === undefined ? {} : { source: v.source }),
      ...(v.ticket === undefined ? {} : { ticket: v.ticket }),
    }),
  day: (a, v, io) => {
    if (a[0] !== "set") return c("day", a[0] === undefined ? {} : { date: a[0] });
    return c("day_set", { date: arg(a, 1, "day set <date> (--file <path> | --stdin)"), body: body(v, io) });
  },
  lint: () => c("lint"),
  config: (a) => {
    if (a[0] === undefined) return c("config");
    if (a[1] === undefined) return c("config", { key: a[0] });
    return c("config_set", { key: a[0], value: configValue(a[1]) });
  },
  set: (a) => {
    const usage = "set <id> <field> <value>";
    return c("ticket_set", { id: arg(a, 0, usage), [arg(a, 1, usage)]: arg(a, 2, usage) });
  },
  log: (a, v) =>
    c("log", {
      id: arg(a, 0, "log <id> <text>"),
      text: a.slice(1).join(" "),
      kind: v.kind ?? "log",
      source: v.source ?? "agent",
      ...(v.ref === undefined ? {} : { ref: v.ref }),
    }),
  note: (a, v, io) => {
    const usage = "note <id> <title> (--file <path> | --stdin)";
    return c("note_save", {
      id: arg(a, 0, usage),
      title: arg(a, 1, usage),
      body: body(v, io),
      kind: v.kind ?? "detail",
    });
  },
  draft: (a, v, io) => {
    const usage = "draft <id> <label> (--file <path> | --stdin)";
    return c("draft_save", {
      id: arg(a, 0, usage),
      label: arg(a, 1, usage),
      body: body(v, io),
      ...(v.channel === undefined ? {} : { channel: v.channel }),
      ...(v["send-at"] === undefined ? {} : { send_at: v["send-at"] }),
    });
  },
  "draft-later": (a, v) => {
    const usage = "draft-later <id> <label> [--for 1h|tomorrow|tomorrow 12:00]";
    return c("draft_later", { id: arg(a, 0, usage), label: arg(a, 1, usage), for: v.for });
  },
  posted: (a, v, io) => {
    const usage = "posted <id> <label>";
    const sent = v.file !== undefined || v.stdin ? body(v, io) : undefined;
    return c("posted", {
      id: arg(a, 0, usage),
      label: arg(a, 1, usage),
      at: v.at,
      channel: v.channel,
      answer: v.answer,
      sent_text: sent,
      sent_ref: v.ref,
    });
  },
  link: (a, v) => {
    const usage = "link <id> <url>";
    return c("link", { id: arg(a, 0, usage), url: arg(a, 1, usage), kind: v.kind, title: v.title });
  },
  item: (a, v, io) => {
    const usage =
      "item put --stdin | item close <item>... | item snooze <item> [--for 1d|tomorrow] | item reopen <item> | item attach <item> <id>";
    const sub = arg(a, 0, usage);
    if (sub === "put") return c("item_put", { items: lines(body(v, io)) });
    if (sub === "close") return c("item_close", { key: arg(a, 1, usage), more: a.slice(2) });
    if (sub === "snooze") return c("item_snooze", { key: arg(a, 1, usage), for: v.for });
    if (sub === "reopen") return c("item_reopen", { key: arg(a, 1, usage) });
    if (sub === "attach") return c("item_attach", { key: arg(a, 1, usage), ticket: arg(a, 2, usage) });
    throw new HubError(`usage: hub ${usage}`);
  },
  wait: (a, v) => {
    if (a[0] === "close") return c("wait_close", { wait: arg(a, 1, "wait close <wait | url>") });
    if (a[0] === "pinged")
      return c("wait_pinged", { wait: arg(a, 1, "wait pinged <wait> [--for 1d|tomorrow]"), for: v.for });
    if (a[0] === "reopen") return c("wait_reopen", { wait: arg(a, 1, "wait reopen <wait>") });
    const usage = "wait <id> <who> <url> [--ping-after 1d]";
    return c("wait_add", {
      ticket: arg(a, 0, usage),
      who: arg(a, 1, usage),
      url: arg(a, 2, usage),
      ping_after: v["ping-after"],
    });
  },
  waits: (_a, v) => c("waits", { due: v.due === true }),
  source: (a, v) =>
    c("source_status", {
      name: arg(a, 0, "source <name> [--cursor <c>] [--error <text>]"),
      cursor: v.cursor,
      error: v.error,
    }),
  sources: () => c("sources"),
  brief: () => c("brief"),
  steps: (a) => c("steps", { id: arg(a, 0, "steps <id>") }),
  step: (a, v) => {
    const usage = "step add <id> <title> | step done <id> <n> [--evidence <url>]";
    const sub = arg(a, 0, usage);
    if (sub === "add") return c("step_add", { id: arg(a, 1, usage), title: a.slice(2).join(" ") || arg(a, 2, usage) });
    if (sub === "done") return c("step_done", { id: arg(a, 1, usage), n: arg(a, 2, usage), evidence: v.evidence });
    throw new HubError(`usage: hub ${usage}`);
  },
  match: (a, v, io) => {
    const usage = "match <id> <label> --ref <url> (--file | --stdin) | match <id> <label> (yes | no)";
    const [id, label, answer] = [arg(a, 0, usage), arg(a, 1, usage), a[2]];
    if (answer !== undefined) return c("match", { id, label, answer });
    if (v.ref === undefined) throw new HubError("give the sent message's permalink with --ref <url>");
    return c("match", { id, label, sent_text: body(v, io), sent_ref: v.ref });
  },
  "ticket-new": (a, v) => {
    const usage = "ticket-new <id> <title>";
    return c("ticket_new", {
      id: arg(a, 0, usage),
      title: a.slice(1).join(" ") || arg(a, 1, usage),
      dir: v.dir ?? "todo",
    });
  },
  gate: (a) => c("gate", { id: arg(a, 0, "gate <id> (yes | no)"), answer: arg(a, 1, "gate <id> (yes | no)") }),
  move: (a) => c("ticket_set", { id: arg(a, 0, "move <id> <dir>"), dir: arg(a, 1, "move <id> <dir>") }),
  import: (_a, v) => c("import", { root: root(v), apply: v.apply === true }),
};

function port(values: Values): number {
  const value = values.port === undefined ? 7420 : Number(values.port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new HubError(`--port takes a port number, not ${values.port}`);
  }
  return value;
}

function report(io: Io, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(error instanceof HubError ? message : `error: ${message.split("\n")[0]}`);
}

function startServer(values: Values, io: Io): number {
  const fail = (error: unknown) => {
    report(io, error);
    process.exitCode = 1;
  };
  try {
    serve({ dbPath: dbPath(values.db, io.env), port: port(values), now: io.now, env: io.env }).then(
      (server) => io.stdout(`hub on ${server.url}`),
      fail,
    );
  } catch (error) {
    report(io, error);
    return 1;
  }
  return 0;
}

function runService(args: string[], values: Values, io: Io): number {
  const sys = io.system ?? service.system(io.env);
  const sub = args[0];
  try {
    let result: Result;
    if (sub === "install") {
      result = service.install(sys, {
        node: process.execPath,
        cli: fileURLToPath(import.meta.url),
        dbFile: dbPath(values.db, io.env),
        port: port(values),
        path: io.env.PATH ?? "",
      });
    } else if (sub === "status") result = service.status(sys);
    else if (sub === "uninstall") result = service.uninstall(sys);
    else throw new HubError("usage: hub service install [--port 7420] | service status | service uninstall");
    io.stdout(values.json ? JSON.stringify(result.json) : result.text);
    return result.exitCode ?? 0;
  } catch (error) {
    report(io, error);
    return 1;
  }
}

const DEFAULT_URL = "http://127.0.0.1:7420";

function notRunning(base: string): HubError {
  return new HubError(`hub is not running at ${base}: hub service install, or hub serve`);
}

function readToken(file: string, base: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    throw notRunning(base);
  }
}

function localConfig(key: string, raw: string, values: Values, io: Io): Result {
  const db = openDb(dbPath(values.db, io.env));
  try {
    return commands.config({ db, config: loadConfig(db), now: io.now() }, key, raw);
  } finally {
    db.close();
  }
}

async function request(call: Call, values: Values, io: Io): Promise<number> {
  const route = ROUTES.find((r) => r.name === call.route);
  if (route === undefined) throw new Error(`no route ${call.route}`);
  const base = io.env.HUB_URL ?? DEFAULT_URL;
  const db = dbPath(values.db, io.env);
  const rest: Args = { ...call.args };
  let path = route.path;
  for (const name of params(route.path)) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(rest[name])));
    delete rest[name];
  }
  const url = new URL(`/api/v1${path}`, base);
  const init: RequestInit = {
    method: route.method,
    headers: {
      authorization: `Bearer ${readToken(tokenPath(db), base)}`,
      accept: values.json ? "application/json" : "text/plain",
      "content-type": "application/json",
      "x-hub-db": db,
    },
  };
  if (route.method === "GET") {
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== false) url.searchParams.set(k, String(v));
  } else init.body = JSON.stringify(rest);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw notRunning(base);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new HubError(message || `${response.status} from ${base}`);
  }
  io.stdout(text);
  return Number(response.headers.get("x-hub-exit") ?? "0");
}

function mcpHeaders(values: Values, io: Io): number {
  const base = io.env.HUB_URL ?? DEFAULT_URL;
  try {
    io.stdout(JSON.stringify({ Authorization: `Bearer ${readToken(tokenPath(dbPath(values.db, io.env)), base)}` }));
    return 0;
  } catch (error) {
    report(io, error);
    return 1;
  }
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = parsed.positionals;
  if (command === "serve") return startServer(parsed.values, io);
  if (command === "service") return runService(args, parsed.values, io);
  if (command === "mcp-headers") return mcpHeaders(parsed.values, io);
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (command === undefined || handler === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const key = args[1] === undefined ? undefined : args[0];
    if (command === "config" && key !== undefined && COMMAND_KEYS.includes(key)) {
      const result = localConfig(key, args[1] as string, parsed.values, io);
      io.stdout(parsed.values.json ? JSON.stringify(result.json) : result.text);
      return 0;
    }
    return await request(handler(args, parsed.values, io), parsed.values, io);
  } catch (error) {
    report(io, error);
    return 1;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readStdin: () => readFileSync(0, "utf8"),
    env: process.env,
    now: () => new Date(),
  }).then((code) => {
    process.exitCode = code;
  });
}
