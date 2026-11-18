#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { brief } from "./brief.ts";
import type { Ctx, Result } from "./commands.ts";
import * as commands from "./commands.ts";
import { dbPath, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { applyImport, collectImport, countPlan, formatSummary } from "./importer.ts";
import * as items from "./items.ts";
import * as sources from "./sources.ts";
import * as steps from "./steps.ts";
import { HubError } from "./util.ts";
import * as waits from "./waits.ts";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
};

const USAGE = `usage: hub <command> [args] [--json] [--db <path>]
read:   ticket <id> | board [regex] | next | gates | changed --since <YYYY-MM-DD|yesterday|today>
        search <query> [-n 10] | events <id> [-n 20] [--full] | notes <id> | note-show <id> <title>
        drafts [id] | draft-show <id> <label> | day [date] | lint | config [key]
        items [--needs-me] [--source <s>] [--ticket <id>] [--all] | waits [--due] | sources | brief
        steps <id>
write:  set <id> <field> <value> | log <id> <text> [--kind log] [--source agent] [--ref <url>]
        note <id> <title> (--file <path> | --stdin) [--kind detail]
        draft <id> <label> (--file <path> | --stdin) [--channel <c>]
        match <id> <label> --ref <url> (--file | --stdin) | match <id> <label> (yes | no)
        posted <id> <label> [--at <when>] [--channel <c>] [--answer <text>] [--ref <url>] [--file | --stdin]
        link <id> <url> [--kind <k>] [--title <t>]
        item put --stdin | item close <item>... | item snooze <item> [--for 1d] | item attach <item> <id>
        wait <id> <who> <url> [--ping-after 1d] | wait close <wait | url>
        source <name> [--cursor <c>] [--error <text>]
        step add <id> <title> | step done <id> <n> [--evidence <url>]
        day set <date> (--file <path> | --stdin) | ticket-new <id> <title> [--dir todo]
        move <id> <dir> | config <key> <json>
import: import --root <dir> [--apply]`;

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
  due: { type: "boolean" },
  cursor: { type: "string" },
  error: { type: "string" },
  evidence: { type: "string" },
  for: { type: "string" },
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
  due?: boolean;
  cursor?: string;
  error?: string;
  evidence?: string;
  for?: string;
  dir?: string;
  since?: string;
  n?: string;
};

type Handler = (ctx: Ctx, args: string[], values: Values, io: Io) => Result;

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

const COMMANDS: Record<string, Handler> = {
  ticket: (ctx, a) => commands.ticket(ctx, arg(a, 0, "ticket <id>")),
  board: (ctx, a) => commands.board(ctx, a[0]),
  next: (ctx) => commands.next(ctx),
  gates: (ctx) => commands.gates(ctx),
  changed: (ctx, _a, v) => commands.changed(ctx, v.since),
  search: (ctx, a, v) => commands.search(ctx, a.join(" "), count(v.n, 10)),
  events: (ctx, a, v) => commands.events(ctx, arg(a, 0, "events <id>"), count(v.n, 20), v.full === true),
  notes: (ctx, a) => commands.notes(ctx, arg(a, 0, "notes <id>")),
  "note-show": (ctx, a) =>
    commands.noteShow(ctx, arg(a, 0, "note-show <id> <title>"), arg(a, 1, "note-show <id> <title>")),
  drafts: (ctx, a) => commands.drafts(ctx, a[0]),
  "draft-show": (ctx, a) =>
    commands.draftShow(ctx, arg(a, 0, "draft-show <id> <label>"), arg(a, 1, "draft-show <id> <label>")),
  items: (ctx, _a, v) =>
    items.items(ctx, {
      needsMe: v["needs-me"] === true,
      source: v.source ?? null,
      ticket: v.ticket ?? null,
      all: v.all === true,
    }),
  day: (ctx, a, v, io) => {
    if (a[0] !== "set") return commands.day(ctx, a[0]);
    return commands.daySet(ctx, arg(a, 1, "day set <date> (--file <path> | --stdin)"), body(v, io));
  },
  lint: (ctx) => commands.lint(ctx),
  config: (ctx, a) => commands.config(ctx, a[0], a[1]),
  set: (ctx, a) => {
    const usage = "set <id> <field> <value>";
    return commands.set(ctx, arg(a, 0, usage), arg(a, 1, usage), arg(a, 2, usage));
  },
  log: (ctx, a, v) =>
    commands.log(ctx, arg(a, 0, "log <id> <text>"), a.slice(1).join(" "), {
      kind: v.kind ?? "log",
      source: v.source ?? "agent",
      ref: v.ref ?? null,
    }),
  note: (ctx, a, v, io) => {
    const usage = "note <id> <title> (--file <path> | --stdin)";
    return commands.note(ctx, arg(a, 0, usage), arg(a, 1, usage), body(v, io), v.kind ?? "detail");
  },
  draft: (ctx, a, v, io) => {
    const usage = "draft <id> <label> (--file <path> | --stdin)";
    return commands.draft(ctx, arg(a, 0, usage), arg(a, 1, usage), body(v, io), v.channel ?? null);
  },
  posted: (ctx, a, v, io) => {
    const usage = "posted <id> <label>";
    const sent = v.file !== undefined || v.stdin ? body(v, io) : null;
    return commands.posted(ctx, arg(a, 0, usage), arg(a, 1, usage), {
      at: v.at ?? null,
      channel: v.channel ?? null,
      answer: v.answer ?? null,
      sentText: sent,
      sentRef: v.ref ?? null,
    });
  },
  link: (ctx, a, v) => {
    const usage = "link <id> <url>";
    return items.link(ctx, arg(a, 0, usage), arg(a, 1, usage), { kind: v.kind ?? null, title: v.title ?? null });
  },
  item: (ctx, a, v, io) => {
    const usage = "item put --stdin | item close <item>... | item snooze <item> [--for 1d] | item attach <item> <id>";
    const sub = arg(a, 0, usage);
    if (sub === "put") return items.put(ctx, body(v, io));
    if (sub === "close") return items.close(ctx, a.slice(1));
    if (sub === "snooze") return items.snooze(ctx, arg(a, 1, usage), v.for ?? "1d");
    if (sub === "attach") return items.attach(ctx, arg(a, 1, usage), arg(a, 2, usage));
    throw new HubError(`usage: hub ${usage}`);
  },
  wait: (ctx, a, v) => {
    if (a[0] === "close") return waits.closeWait(ctx, arg(a, 1, "wait close <wait | url>"));
    const usage = "wait <id> <who> <url> [--ping-after 1d]";
    return waits.wait(ctx, arg(a, 0, usage), arg(a, 1, usage), arg(a, 2, usage), v["ping-after"] ?? null);
  },
  waits: (ctx, _a, v) => waits.waits(ctx, v.due === true),
  source: (ctx, a, v) =>
    sources.synced(ctx, arg(a, 0, "source <name> [--cursor <c>] [--error <text>]"), {
      cursor: v.cursor ?? null,
      error: v.error ?? null,
    }),
  sources: (ctx) => sources.sources(ctx),
  brief: (ctx) => brief(ctx),
  steps: (ctx, a) => steps.steps(ctx, arg(a, 0, "steps <id>")),
  step: (ctx, a, v) => {
    const usage = "step add <id> <title> | step done <id> <n> [--evidence <url>]";
    const sub = arg(a, 0, usage);
    if (sub === "add") return steps.add(ctx, arg(a, 1, usage), a.slice(2).join(" ") || arg(a, 2, usage));
    if (sub === "done") return steps.done(ctx, arg(a, 1, usage), arg(a, 2, usage), v.evidence ?? null);
    throw new HubError(`usage: hub ${usage}`);
  },
  match: (ctx, a, v, io) => {
    const usage = "match <id> <label> --ref <url> (--file | --stdin) | match <id> <label> (yes | no)";
    const [id, label, answer] = [arg(a, 0, usage), arg(a, 1, usage), a[2]];
    if (answer !== undefined) return commands.resolveMatch(ctx, id, label, answer);
    if (v.ref === undefined) throw new HubError("give the sent message's permalink with --ref <url>");
    return commands.match(ctx, id, label, body(v, io), v.ref);
  },
  "ticket-new": (ctx, a, v) => {
    const usage = "ticket-new <id> <title>";
    return commands.ticketNew(ctx, arg(a, 0, usage), a.slice(1).join(" ") || arg(a, 1, usage), v.dir ?? "todo");
  },
  move: (ctx, a) => commands.move(ctx, arg(a, 0, "move <id> <dir>"), arg(a, 1, "move <id> <dir>")),
  import: (ctx, _a, v) => {
    const plan = collectImport(ctx.db, root(v), ctx.config, ctx.now);
    const changes = v.apply ? applyImport(ctx.db, plan, ctx.now) : null;
    return { text: formatSummary(plan, changes), json: { counts: countPlan(plan), report: plan.report, changes } };
  },
};

function open(command: string, values: Values, io: Io): DatabaseSync {
  const path = dbPath(values.db, io.env);
  const dryRun = command === "import" && !values.apply;
  return openDb(dryRun && !existsSync(path) ? ":memory:" : path);
}

export function run(argv: string[], io: Io): number {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = parsed.positionals;
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (command === undefined || handler === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  let db: DatabaseSync | undefined;
  try {
    db = open(command, parsed.values, io);
    const result = handler({ db, config: loadConfig(db), now: io.now() }, args, parsed.values, io);
    io.stdout(parsed.values.json ? JSON.stringify(result.json) : result.text);
    return result.exitCode ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(error instanceof HubError ? message : `error: ${message.split("\n")[0]}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    readStdin: () => readFileSync(0, "utf8"),
    env: process.env,
    now: () => new Date(),
  });
}
