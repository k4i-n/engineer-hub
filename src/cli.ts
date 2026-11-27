#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Args, COMMAND_KEYS, params, ROUTES } from "./api.ts";
import type { Ctx, Result } from "./commands.ts";
import * as commands from "./commands.ts";
import { DEFAULTS, dbPath, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { filesRoot } from "./files.ts";
import { gate, type StopInput } from "./gate.ts";
import { itemByRef } from "./items.ts";
import { type PostToolInput, record } from "./record.ts";
import { addScript, removeScript, setScript } from "./scripts.ts";
import { serve } from "./serve.ts";
import * as service from "./service.ts";
import { tokenPath } from "./token.ts";
import { HubError } from "./util.ts";
import { addWorkspace, removeWorkspace } from "./workspaces.ts";

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
        drafts [id] | draft-show <id> <label> | day [date] [--full] | lint | config [key]
        items [--needs-me] [--source <s>] [--ticket <id>] [--all] | waits [--due] | sources | brief
        steps <id> | files <id>
write:  set <id> <field> <value> | log <id> <text> [--kind log] [--source agent] [--ref <url>]
        note <id> <title> (--file <path> | --stdin) [--kind detail] | note-rm <id> <title> | note-mv <id> <title> <new title>
        draft <id | item url> <label> (--file <path> | --stdin) [--channel <c>] [--send-at <when>] [--item <url>]
        [--verdict approve|request_changes|comment] [--comments <json file of [{path, line, body}]>] [--internal]
        draft-rm <id> <label> (unsent only) | draft-mv <id> <label> <new label>
        draft-later <id> <label> [--for 1h|tomorrow|tomorrow 12:00]
        match <id> <label> --ref <url> (--file | --stdin) | match <id> <label> (yes | no)
        posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file | --stdin] | unposted <id> <label>
        link <id> <url> [--kind <k>] [--title <t>]
        item put --stdin | item close <item>... | item snooze <item> [--for 1d|tomorrow] | item reopen <item> | item attach <item> <id> | item detach <item>
        item ignore <item> | item unignore <item> | item ask <item> <question> | item answer <item> (yes | no) | item unanswer <item>
        wait <id> <who> <url> [--ping-after 1d] | wait close <wait | url> | wait pinged <wait> [--for 1d|tomorrow] | wait reopen <wait>
        wait edit <wait> [--who <w>] [--ping-after 1d]
        source <name> [--cursor <c>] [--error <text>] | fetch [source]
        source add <name> --every 5m -- <program> [args] | source remove <name>
        source set <name> [--on | --off] [--every 5m] [--section <title>]
        slack add <workspace> | slack remove <workspace>
        moved --as <session id> [--start] | moved --hook (reads a Claude Code hook's JSON on stdin)
        record-gate --hook (Stop hook: blocks a session that ran a recordActions command and wrote nothing to hub after)
        record --hook (PostToolUse hook: links the PR a recordActions command printed to the one ticket on the current branch)
        step add <id> <title> [--at <n>] | step start <id> <n> | step done <id> <n> [--evidence <url>]
        step edit <id> <n> <title> | step undo <id> <n> | step rm <id> <n>
        day set <date> (--file <path> | --stdin) [--rev <rev>] | ticket-new <id> <title> [--dir todo]
        plan add <text> [--ref "<kind>:<id> ..."] [--time HH:MM] [--at <n>] [--date <d>]
        plan edit <n> [text] [--ref <refs>] [--time HH:MM] | plan move <n> <to> | plan done <n> | plan undo <n>
        plan drop <n> <why> (each plan command takes --date <d>, default today)
        move <id> <dir> | rename <id> <new id> | merge <id> <into id> | ticket-delete <id>
        order <id> <place | -> | gate <id> (yes | no)
        file add <id> <src> [--as <path>] [--move] | file rm <id> <path>
        config <key> <json>
backup: backup | backups | restore <name>
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
  rev: { type: "string" },
  file: { type: "string" },
  channel: { type: "string" },
  item: { type: "string" },
  verdict: { type: "string" },
  comments: { type: "string" },
  at: { type: "string" },
  answer: { type: "string" },
  title: { type: "string" },
  "needs-me": { type: "boolean" },
  internal: { type: "boolean" },
  all: { type: "boolean" },
  ticket: { type: "string" },
  "ping-after": { type: "string" },
  "send-at": { type: "string" },
  every: { type: "string" },
  on: { type: "boolean" },
  off: { type: "boolean" },
  section: { type: "string" },
  as: { type: "string" },
  start: { type: "boolean" },
  move: { type: "boolean" },
  hook: { type: "boolean" },
  due: { type: "boolean" },
  cursor: { type: "string" },
  error: { type: "string" },
  evidence: { type: "string" },
  for: { type: "string" },
  who: { type: "string" },
  port: { type: "string" },
  dir: { type: "string" },
  since: { type: "string" },
  time: { type: "string" },
  date: { type: "string" },
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
  rev?: string;
  file?: string;
  channel?: string;
  item?: string;
  verdict?: string;
  comments?: string;
  at?: string;
  answer?: string;
  title?: string;
  "needs-me"?: boolean;
  internal?: boolean;
  all?: boolean;
  ticket?: string;
  "ping-after"?: string;
  "send-at"?: string;
  every?: string;
  on?: boolean;
  off?: boolean;
  section?: string;
  as?: string;
  start?: boolean;
  move?: boolean;
  hook?: boolean;
  due?: boolean;
  cursor?: string;
  error?: string;
  evidence?: string;
  for?: string;
  who?: string;
  port?: string;
  dir?: string;
  since?: string;
  time?: string;
  date?: string;
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

function jsonFile(path: string): unknown {
  if (!existsSync(path)) throw new HubError(`--comments ${path} does not exist`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new HubError(`--comments ${path} is not JSON`);
  }
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
    if (a[0] !== "set") return c("day", { ...(a[0] === undefined ? {} : { date: a[0] }), full: v.full === true });
    return c("day_set", {
      date: arg(a, 1, "day set <date> (--file <path> | --stdin) [--rev <rev>]"),
      body: body(v, io),
      ...(v.rev === undefined ? {} : { rev: v.rev }),
    });
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
      ...(v.item === undefined ? {} : { item: v.item }),
      ...(v.verdict === undefined ? {} : { verdict: v.verdict }),
      ...(v.comments === undefined ? {} : { comments: jsonFile(v.comments) }),
      ...(v.internal === undefined ? {} : { internal: true }),
    });
  },
  "note-rm": (a) =>
    c("note_remove", { id: arg(a, 0, "note-rm <id> <title>"), title: arg(a, 1, "note-rm <id> <title>") }),
  "note-mv": (a) => {
    const usage = "note-mv <id> <title> <new title>";
    return c("note_rename", { id: arg(a, 0, usage), title: arg(a, 1, usage), to: arg(a, 2, usage) });
  },
  "draft-rm": (a) =>
    c("draft_remove", { id: arg(a, 0, "draft-rm <id> <label>"), label: arg(a, 1, "draft-rm <id> <label>") }),
  "draft-mv": (a) => {
    const usage = "draft-mv <id> <label> <new label>";
    return c("draft_rename", { id: arg(a, 0, usage), label: arg(a, 1, usage), to: arg(a, 2, usage) });
  },
  "draft-later": (a, v) => {
    const usage = "draft-later <id> <label> [--for 1h|tomorrow|tomorrow 12:00]";
    return c("draft_later", { id: arg(a, 0, usage), label: arg(a, 1, usage), for: v.for });
  },
  unposted: (a) => c("unposted", { id: arg(a, 0, "unposted <id> <label>"), label: arg(a, 1, "unposted <id> <label>") }),
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
      "item put --stdin | item close <item>... | item snooze <item> [--for 1d|tomorrow] | item reopen <item> | item attach <item> <id> | item detach <item> | item ignore <item> | item unignore <item> | item ask <item> <question> | item answer <item> (yes | no) | item unanswer <item>";
    const sub = arg(a, 0, usage);
    if (sub === "put") return c("item_put", { items: lines(body(v, io)) });
    if (sub === "close") return c("item_close", { key: arg(a, 1, usage), more: a.slice(2) });
    if (sub === "snooze") return c("item_snooze", { key: arg(a, 1, usage), for: v.for });
    if (sub === "reopen") return c("item_reopen", { key: arg(a, 1, usage) });
    if (sub === "attach") return c("item_attach", { key: arg(a, 1, usage), ticket: arg(a, 2, usage) });
    if (sub === "detach") return c("item_detach", { key: arg(a, 1, usage) });
    if (sub === "ignore") return c("item_ignore", { key: arg(a, 1, usage) });
    if (sub === "unignore") return c("item_unignore", { key: arg(a, 1, usage) });
    if (sub === "ask") return c("item_ask", { key: arg(a, 1, usage), question: a.slice(2).join(" ") });
    if (sub === "answer") return c("item_answer", { key: arg(a, 1, usage), answer: arg(a, 2, usage) });
    if (sub === "unanswer") return c("item_unanswer", { key: arg(a, 1, usage) });
    throw new HubError(`usage: hub ${usage}`);
  },
  wait: (a, v) => {
    if (a[0] === "close") return c("wait_close", { wait: arg(a, 1, "wait close <wait | url>") });
    if (a[0] === "pinged")
      return c("wait_pinged", { wait: arg(a, 1, "wait pinged <wait> [--for 1d|tomorrow]"), for: v.for });
    if (a[0] === "reopen") return c("wait_reopen", { wait: arg(a, 1, "wait reopen <wait>") });
    if (a[0] === "edit") {
      return c("wait_edit", {
        wait: arg(a, 1, "wait edit <wait> [--who <w>] [--ping-after 1d]"),
        who: v.who,
        ping_after: v["ping-after"],
      });
    }
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
  slack: () => {
    throw new HubError("usage: hub slack add <workspace> | hub slack remove <workspace>");
  },
  backup: () => c("backup"),
  backups: () => c("backups"),
  restore: (a) => c("restore", { name: arg(a, 0, "restore <backup name>") }),
  fetch: (a) => c("fetch", a[0] === undefined ? {} : { source: a[0] }),
  moved: (_a, v) => {
    if (v.as === undefined) throw new HubError("usage: hub moved --as <session id> [--start]");
    return c("moved", { agent: v.as, start: v.start === true });
  },
  brief: () => c("brief"),
  steps: (a) => c("steps", { id: arg(a, 0, "steps <id>") }),
  files: (a) => c("files", { id: arg(a, 0, "files <id>") }),
  file: (a, v) => {
    const usage = "file add <id> <src> [--as <path>] [--move] | file rm <id> <path>";
    const sub = arg(a, 0, usage);
    if (sub === "add") {
      return c("file_add", { id: arg(a, 1, usage), src: resolve(arg(a, 2, usage)), as: v.as, move: v.move === true });
    }
    if (sub === "rm") return c("file_remove", { id: arg(a, 1, usage), path: arg(a, 2, usage) });
    throw new HubError(`usage: hub ${usage}`);
  },
  step: (a, v) => {
    const usage =
      "step add <id> <title> [--at <n>] | step start <id> <n> | step done <id> <n> [--evidence <url>] | step edit <id> <n> <title> | step undo <id> <n> | step rm <id> <n>";
    const sub = arg(a, 0, usage);
    if (sub === "add") {
      const title = a.slice(2).join(" ") || arg(a, 2, usage);
      return c("step_add", { id: arg(a, 1, usage), title, ...(v.at === undefined ? {} : { at: Number(v.at) }) });
    }
    if (sub === "start") return c("step_start", { id: arg(a, 1, usage), n: arg(a, 2, usage) });
    if (sub === "done") return c("step_done", { id: arg(a, 1, usage), n: arg(a, 2, usage), evidence: v.evidence });
    if (sub === "edit") {
      return c("step_edit", {
        id: arg(a, 1, usage),
        n: arg(a, 2, usage),
        title: a.slice(3).join(" ") || arg(a, 3, usage),
      });
    }
    if (sub === "undo") return c("step_undo", { id: arg(a, 1, usage), n: arg(a, 2, usage) });
    if (sub === "rm") return c("step_remove", { id: arg(a, 1, usage), n: arg(a, 2, usage) });
    throw new HubError(`usage: hub ${usage}`);
  },
  plan: (a, v) => {
    const usage =
      "plan add <text> [--ref <refs>] [--time HH:MM] [--at <n>] | plan edit <n> [text] [--ref <refs>] [--time HH:MM] | plan move <n> <to> | plan done <n> | plan undo <n> | plan drop <n> <why>";
    const sub = arg(a, 0, usage);
    const date = v.date === undefined ? {} : { date: v.date };
    const line = () => arg(a, 1, usage);
    if (sub === "add") {
      return c("plan_add", {
        text: a.slice(1).join(" ") || arg(a, 1, usage),
        ...(v.ref === undefined ? {} : { ref: v.ref }),
        ...(v.time === undefined ? {} : { time: v.time }),
        ...(v.at === undefined ? {} : { at: Number(v.at) }),
        ...date,
      });
    }
    if (sub === "edit") {
      const text = a.slice(2).join(" ");
      return c("plan_edit", {
        line: line(),
        ...(text === "" ? {} : { text }),
        ...(v.ref === undefined ? {} : { ref: v.ref }),
        ...(v.time === undefined ? {} : { time: v.time }),
        ...date,
      });
    }
    if (sub === "move") return c("plan_move", { line: line(), to: Number(arg(a, 2, usage)), ...date });
    if (sub === "done") return c("plan_done", { line: line(), ...date });
    if (sub === "undo") return c("plan_undo", { line: line(), ...date });
    if (sub === "drop") return c("plan_drop", { line: line(), why: a.slice(2).join(" ") || arg(a, 2, usage), ...date });
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
  rename: (a) => c("ticket_rename", { id: arg(a, 0, "rename <id> <new id>"), to: arg(a, 1, "rename <id> <new id>") }),
  "ticket-delete": (a) => c("ticket_delete", { id: arg(a, 0, "ticket-delete <id>") }),
  merge: (a) => c("ticket_merge", { id: arg(a, 0, "merge <id> <into id>"), into: arg(a, 1, "merge <id> <into id>") }),
  order: (a) => {
    const usage = "order <id> <place | -> (1 is the top of its folder, - takes it out)";
    const value = arg(a, 1, usage);
    const place = value === "-" ? 0 : Number(value);
    if (value !== "-" && !(Number.isInteger(place) && place >= 1)) throw new HubError(`usage: hub ${usage}`);
    return c("ticket_order", { id: arg(a, 0, usage), place });
  },
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

function local(values: Values, io: Io, work: (ctx: Ctx) => Result): Result {
  const path = dbPath(values.db, io.env);
  const db = openDb(path);
  try {
    return work({ db, config: loadConfig(db), now: io.now(), files: filesRoot(path) });
  } finally {
    db.close();
  }
}

function localWrite(command: string, args: string[], values: Values, io: Io): Result | null {
  const [first, second, third] = args;
  if (command === "config" && first !== undefined && second !== undefined && COMMAND_KEYS.includes(first)) {
    return local(values, io, (ctx) => commands.config(ctx, first, second));
  }
  if (command === "source" && first === "add") {
    const usage = "usage: hub source add <name> --every 5m -- <program> [args]";
    if (second === undefined || values.every === undefined) throw new HubError(usage);
    return local(values, io, (ctx) => addScript(ctx, second, values.every as string, args.slice(2)));
  }
  if (command === "source" && first === "set") {
    const usage = "usage: hub source set <name> [--on | --off] [--every 5m] [--section <title>]";
    if (second === undefined || third !== undefined || (values.on === true && values.off === true)) {
      throw new HubError(usage);
    }
    const on = values.on === true ? true : values.off === true ? false : null;
    const every = values.every ?? null;
    const section = values.section ?? null;
    if (on === null && every === null && section === null) throw new HubError(usage);
    return local(values, io, (ctx) => setScript(ctx, second, { on, every, section }));
  }
  if (command === "slack" && (first === "add" || first === "remove")) {
    if (second === undefined || third !== undefined) throw new HubError(`usage: hub slack ${first} <workspace>`);
    return local(values, io, (ctx) => (first === "add" ? addWorkspace(ctx, second) : removeWorkspace(ctx, second)));
  }
  if (command === "source" && first === "remove") {
    if (second === undefined || third !== undefined) throw new HubError("usage: hub source remove <name>");
    return local(values, io, (ctx) => removeScript(ctx, second));
  }
  return null;
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

async function hook(values: Values, io: Io): Promise<number> {
  try {
    const input = JSON.parse(io.readStdin()) as { session_id?: unknown; hook_event_name?: unknown };
    if (typeof input.session_id !== "string") return 0;
    const call = c("moved", { agent: input.session_id, start: input.hook_event_name === "SessionStart" });
    const quiet: Io = {
      ...io,
      stdout: (text) => {
        if (text.trim() !== "") io.stdout(text);
      },
      stderr: () => {},
    };
    await request(call, values, quiet);
  } catch {}
  return 0;
}

function recordGate(values: Values, io: Io): number {
  try {
    const input = JSON.parse(io.readStdin()) as StopInput;
    const path = dbPath(values.db, io.env);
    if (!existsSync(path)) {
      const result = gate(input, DEFAULTS.recordActions);
      if (result !== "") io.stdout(result);
      return 0;
    }
    const db = openDb(path);
    try {
      const linked = (url: string) => (itemByRef(db, url)?.ticket_id ?? null) !== null;
      const result = gate(input, loadConfig(db).recordActions, linked);
      if (result !== "") io.stdout(result);
    } finally {
      db.close();
    }
  } catch {}
  return 0;
}

function branchOf(cwd: string): string | null {
  const git = spawnSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", timeout: 3000 });
  return git.status === 0 ? git.stdout.trim() : null;
}

function recordHook(values: Values, io: Io): number {
  try {
    const input = JSON.parse(io.readStdin()) as PostToolInput;
    const path = dbPath(values.db, io.env);
    if (!existsSync(path)) return 0;
    const db = openDb(path);
    try {
      const result = record({ db, config: loadConfig(db), now: io.now(), files: filesRoot(path) }, input, branchOf);
      if (result !== "") io.stdout(result);
    } finally {
      db.close();
    }
  } catch {}
  return 0;
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
  if (command === "moved" && parsed.values.hook) return hook(parsed.values, io);
  if (command === "record-gate" && parsed.values.hook) return recordGate(parsed.values, io);
  if (command === "record" && parsed.values.hook) return recordHook(parsed.values, io);
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (command === undefined || handler === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const written = localWrite(command, args, parsed.values, io);
    if (written !== null) {
      io.stdout(parsed.values.json ? JSON.stringify(written.json) : written.text);
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
