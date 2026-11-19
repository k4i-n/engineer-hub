import { brief } from "./brief.ts";
import type { Ctx, Result } from "./commands.ts";
import * as commands from "./commands.ts";
import { one, SETTABLE_FIELDS, transaction, type WaitRow } from "./db.ts";
import { applyImport, collectImport, countPlan, formatSummary } from "./importer.ts";
import * as items from "./items.ts";
import { moved } from "./moved.ts";
import * as pins from "./pins.ts";
import * as sources from "./sources.ts";
import * as steps from "./steps.ts";
import { HubError, nowIso, nowTs } from "./util.ts";
import * as waits from "./waits.ts";

export type FieldType = "string" | "integer" | "boolean" | "object" | "array" | "any";
export type Field = { type: FieldType; required?: boolean; about: string; of?: "string" | "object" };
export type Fields = Record<string, Field>;
export type Args = Record<string, unknown>;
export type Method = "GET" | "POST" | "PUT" | "PATCH";
export type Hooks = {
  version: string;
  syncStatus: () => unknown;
  startSync: () => { started: boolean; status: unknown };
  fetchNow: (source: string | null) => Promise<Result>;
};

export type Route = {
  name: string;
  method: Method;
  path: string;
  about: string;
  query?: Fields;
  body?: Fields;
  run: (ctx: Ctx, a: Args, hooks: Hooks) => Result | Promise<Result>;
  status?: (result: Result) => number;
};

export const MAX_COUNT = 200;

export const COMMAND_KEYS = ["syncCommand"];

function str(a: Args, key: string): string {
  return a[key] as string;
}

function opt(a: Args, key: string): string | null {
  const value = a[key];
  return value === undefined ? null : (value as string);
}

function count(a: Args, key: string, fallback: number): number {
  const value = a[key];
  if (value === undefined) return fallback;
  const n = value as number;
  if (n < 1 || n > MAX_COUNT) throw new HubError(`${key} takes 1 to ${MAX_COUNT}, not ${n}`);
  return n;
}

const ticket: Field = { type: "string", required: true, about: "ticket id, e.g. ENG-42" };
export const PATH_ABOUT: Record<string, string> = {
  id: "ticket id, e.g. ENG-42",
  title: "note title",
  label: "draft label",
  n: "step number",
  key: "item number or ref (url)",
  wait: "wait number, or the thread url to close every open wait on it",
  name: "source name",
  date: "YYYY-MM-DD",
  row: "dashboard row key",
};
const later: Field = { type: "string", about: "30m, 4h, 2d or tomorrow (default 1d)" };

const TICKET_FIELDS: Fields = Object.fromEntries([
  ...SETTABLE_FIELDS.map((f) => [f, { type: "string", about: `${f}, one line` } satisfies Field]),
  ["dir", { type: "string", about: "move to this folder (taskDirs or unfiled)" } satisfies Field],
]);

export const ROUTES: Route[] = [
  {
    name: "board",
    method: "GET",
    path: "/tickets",
    about: "Open tickets grouped by folder.",
    query: { q: { type: "string", about: "regex on id, title and path" } },
    run: (ctx, a) => commands.board(ctx, opt(a, "q") ?? undefined),
  },
  {
    name: "ticket",
    method: "GET",
    path: "/tickets/{id}",
    about: "One ticket: state, last events, drafts, links, notes.",
    run: (ctx, a) => commands.ticket(ctx, str(a, "id")),
  },
  {
    name: "ticket_new",
    method: "POST",
    path: "/tickets",
    about: "Create a ticket.",
    body: {
      id: ticket,
      title: { type: "string", required: true, about: "title" },
      dir: { type: "string", about: "folder (default todo)" },
    },
    run: (ctx, a) => commands.ticketNew(ctx, str(a, "id"), str(a, "title"), opt(a, "dir") ?? "todo"),
  },
  {
    name: "ticket_set",
    method: "PATCH",
    path: "/tickets/{id}",
    about: "Set state fields (one line each) and move the ticket, all or nothing.",
    body: TICKET_FIELDS,
    run: (ctx, a) => {
      const id = str(a, "id");
      const fields = SETTABLE_FIELDS.filter((f) => a[f] !== undefined);
      if (fields.length === 0 && a.dir === undefined)
        throw new HubError(`give at least one of ${Object.keys(TICKET_FIELDS).join(", ")}`);
      const done = transaction(ctx.db, () => [
        ...fields.map((f) => commands.set(ctx, id, f, str(a, f))),
        ...(a.dir === undefined ? [] : [commands.move(ctx, id, str(a, "dir"))]),
      ]);
      return { text: done.map((r) => r.text).join("\n"), json: commands.ticket(ctx, id).json };
    },
  },
  {
    name: "gate",
    method: "POST",
    path: "/tickets/{id}/gate",
    about: "Answer the ticket's approve? gate.",
    body: { answer: { type: "string", required: true, about: "yes or no" } },
    run: (ctx, a) => commands.answerGate(ctx, str(a, "id"), str(a, "answer")),
  },
  {
    name: "events",
    method: "GET",
    path: "/tickets/{id}/events",
    about: "A ticket's log, newest first.",
    query: { n: { type: "integer", about: "how many (default 20)" }, full: { type: "boolean", about: "whole text" } },
    run: (ctx, a) => commands.events(ctx, str(a, "id"), count(a, "n", 20), a.full === true),
  },
  {
    name: "log",
    method: "POST",
    path: "/tickets/{id}/events",
    about: "Add a log line: what changed, readings, decisions.",
    body: {
      text: { type: "string", required: true, about: "the line" },
      kind: { type: "string", about: "log, reading, decision, tracker, pr, slack, sync (default log)" },
      source: { type: "string", about: "agent, human, sync (default agent)" },
      ref: { type: "string", about: "url this line is about" },
    },
    run: (ctx, a) =>
      commands.log(ctx, str(a, "id"), str(a, "text"), {
        kind: opt(a, "kind") ?? "log",
        source: opt(a, "source") ?? "agent",
        ref: opt(a, "ref"),
      }),
  },
  {
    name: "notes",
    method: "GET",
    path: "/tickets/{id}/notes",
    about: "Note titles with kind and size.",
    run: (ctx, a) => commands.notes(ctx, str(a, "id")),
  },
  {
    name: "note",
    method: "GET",
    path: "/tickets/{id}/notes/{title}",
    about: "One note's markdown.",
    run: (ctx, a) => commands.noteShow(ctx, str(a, "id"), str(a, "title")),
  },
  {
    name: "note_save",
    method: "PUT",
    path: "/tickets/{id}/notes/{title}",
    about: "Write a note (replaces it).",
    body: {
      body: { type: "string", required: true, about: "markdown" },
      kind: { type: "string", about: "detail (default) or other" },
    },
    run: (ctx, a) => commands.note(ctx, str(a, "id"), str(a, "title"), str(a, "body"), opt(a, "kind") ?? "detail"),
  },
  {
    name: "drafts",
    method: "GET",
    path: "/drafts",
    about: "Open drafts, or every draft of one ticket.",
    query: { ticket: { type: "string", about: "ticket id" } },
    run: (ctx, a) => commands.drafts(ctx, opt(a, "ticket") ?? undefined),
  },
  {
    name: "draft",
    method: "GET",
    path: "/tickets/{id}/drafts/{label}",
    about: "One draft with the wording actually sent.",
    run: (ctx, a) => commands.draftShow(ctx, str(a, "id"), str(a, "label")),
  },
  {
    name: "draft_save",
    method: "PUT",
    path: "/tickets/{id}/drafts/{label}",
    about: "Write a draft for the human to post.",
    body: {
      body: { type: "string", required: true, about: "text" },
      channel: { type: "string", about: "where it goes" },
      send_at: {
        type: "string",
        about: "when the human should send it: 30m, 4h, tomorrow, 12:00, tomorrow 12:00 or YYYY-MM-DD HH:MM",
      },
    },
    run: (ctx, a) =>
      commands.draft(ctx, str(a, "id"), str(a, "label"), str(a, "body"), opt(a, "channel"), opt(a, "send_at")),
  },
  {
    name: "posted",
    method: "POST",
    path: "/tickets/{id}/drafts/{label}/posted",
    about: "Mark a draft sent, with the wording actually sent (the user often rewrites it) and its permalink.",
    body: {
      at: { type: "string", about: "when (default now)" },
      channel: { type: "string", about: "where" },
      answer: { type: "string", about: "the reply; marks it answered" },
      sent_text: { type: "string", about: "wording actually sent" },
      sent_ref: { type: "string", about: "permalink" },
    },
    run: (ctx, a) =>
      commands.posted(ctx, str(a, "id"), str(a, "label"), {
        at: opt(a, "at"),
        channel: opt(a, "channel"),
        answer: opt(a, "answer"),
        sentText: opt(a, "sent_text"),
        sentRef: opt(a, "sent_ref"),
      }),
  },
  {
    name: "draft_later",
    method: "POST",
    path: "/tickets/{id}/drafts/{label}/later",
    about: "Move a draft's send time later.",
    body: { for: { type: "string", about: "30m, 4h, tomorrow, 12:00 or tomorrow 12:00 (default tomorrow)" } },
    run: (ctx, a) => commands.draftLater(ctx, str(a, "id"), str(a, "label"), opt(a, "for") ?? "tomorrow"),
  },
  {
    name: "match",
    method: "POST",
    path: "/tickets/{id}/drafts/{label}/match",
    about:
      "Propose a sent message as this draft (sent_text and sent_ref) when unsure, or answer a proposal (answer). Match by meaning: same channel or thread, same person, same ask; never by exact text.",
    body: {
      sent_text: { type: "string", about: "the sent message" },
      sent_ref: { type: "string", about: "its permalink" },
      answer: { type: "string", about: "yes or no" },
    },
    run: (ctx, a) => {
      if (a.answer !== undefined) return commands.resolveMatch(ctx, str(a, "id"), str(a, "label"), str(a, "answer"));
      if (a.sent_text === undefined || a.sent_ref === undefined)
        throw new HubError("give sent_text and sent_ref, or answer");
      return commands.match(ctx, str(a, "id"), str(a, "label"), str(a, "sent_text"), str(a, "sent_ref"));
    },
  },
  {
    name: "link",
    method: "POST",
    path: "/tickets/{id}/links",
    about: "Link a PR, run, thread or doc to the ticket.",
    body: {
      url: { type: "string", required: true, about: "url" },
      kind: { type: "string", about: "pr, issue, thread, doc, run, other" },
      title: { type: "string", about: "title" },
    },
    run: (ctx, a) => items.link(ctx, str(a, "id"), str(a, "url"), { kind: opt(a, "kind"), title: opt(a, "title") }),
  },
  {
    name: "steps",
    method: "GET",
    path: "/tickets/{id}/steps",
    about: "A ticket's steps, done and next.",
    run: (ctx, a) => steps.steps(ctx, str(a, "id")),
  },
  {
    name: "step_add",
    method: "POST",
    path: "/tickets/{id}/steps",
    about: "Add a step at the end.",
    body: { title: { type: "string", required: true, about: "the step" } },
    run: (ctx, a) => steps.add(ctx, str(a, "id"), str(a, "title")),
  },
  {
    name: "step_done",
    method: "POST",
    path: "/tickets/{id}/steps/{n}/done",
    about: "Mark step n done.",
    body: { evidence: { type: "string", about: "url that shows it is done" } },
    run: (ctx, a) => steps.done(ctx, str(a, "id"), str(a, "n"), opt(a, "evidence")),
  },
  {
    name: "next",
    method: "GET",
    path: "/next",
    about: "Next action of every in-progress and todo ticket.",
    run: (ctx) => commands.next(ctx),
  },
  {
    name: "gates",
    method: "GET",
    path: "/gates",
    about: "Tickets waiting on an approve? or decide.",
    run: (ctx) => commands.gates(ctx),
  },
  {
    name: "changed",
    method: "GET",
    path: "/changes",
    about: "Tickets with events or edits since a date.",
    query: { since: { type: "string", about: "YYYY-MM-DD, yesterday or today" } },
    run: (ctx, a) => commands.changed(ctx, opt(a, "since") ?? undefined),
  },
  {
    name: "search",
    method: "GET",
    path: "/search",
    about: "Full text search over tickets, notes, log and drafts.",
    query: {
      q: { type: "string", required: true, about: "words" },
      n: { type: "integer", about: "how many (default 10)" },
    },
    run: (ctx, a) => commands.search(ctx, str(a, "q"), count(a, "n", 10)),
  },
  {
    name: "find",
    method: "GET",
    path: "/find",
    about: "Search everything for the dashboard's search box.",
    query: { q: { type: "string", required: true, about: "words" } },
    run: (ctx, a) => ({ text: "", json: commands.searchAll(ctx, str(a, "q"), 30) }),
  },
  {
    name: "lint",
    method: "GET",
    path: "/lint",
    about: "Open tickets missing Status, Next or Owner, or over a limit.",
    run: (ctx) => commands.lint(ctx),
  },
  {
    name: "day",
    method: "GET",
    path: "/day",
    about: "A day's plan resume (default today, else the latest).",
    query: { date: { type: "string", about: "YYYY-MM-DD" } },
    run: (ctx, a) => commands.day(ctx, opt(a, "date") ?? undefined),
  },
  {
    name: "day_set",
    method: "PUT",
    path: "/day/{date}",
    about: "Write the day's plan.",
    body: { body: { type: "string", required: true, about: "markdown" } },
    run: (ctx, a) => commands.daySet(ctx, str(a, "date"), str(a, "body")),
  },
  {
    name: "items",
    method: "GET",
    path: "/items",
    about: "Items from sources.",
    query: {
      needs_me: { type: "boolean", about: "only what needs the user" },
      source: { type: "string", about: "source name" },
      ticket: { type: "string", about: "ticket id" },
      all: { type: "boolean", about: "closed ones too" },
    },
    run: (ctx, a) =>
      items.items(ctx, {
        needsMe: a.needs_me === true,
        source: opt(a, "source"),
        ticket: opt(a, "ticket"),
        all: a.all === true,
      }),
  },
  {
    name: "item_put",
    method: "POST",
    path: "/items",
    about: "Add or update items (the same objects as hub item put).",
    body: {
      items: {
        type: "array",
        required: true,
        about: "item objects: source, kind, url or ref, title, state, author, ticket, needs_me",
      },
    },
    run: (ctx, a) => items.put(ctx, (a.items as unknown[]).map((i) => JSON.stringify(i)).join("\n")),
  },
  {
    name: "item_close",
    method: "POST",
    path: "/items/{key}/close",
    about: "Close an item, and any more given.",
    body: { more: { type: "array", of: "string", about: "more item numbers or refs to close in the same call" } },
    run: (ctx, a) => items.close(ctx, [str(a, "key"), ...((a.more as string[] | undefined) ?? [])]),
  },
  {
    name: "item_snooze",
    method: "POST",
    path: "/items/{key}/snooze",
    about: "Hide an item until later.",
    body: { for: later },
    run: (ctx, a) => items.snooze(ctx, str(a, "key"), opt(a, "for") ?? "1d"),
  },
  {
    name: "item_reopen",
    method: "POST",
    path: "/items/{key}/reopen",
    about: "Reopen a closed or snoozed item.",
    run: (ctx, a) => items.reopen(ctx, str(a, "key")),
  },
  {
    name: "item_attach",
    method: "POST",
    path: "/items/{key}/attach",
    about: "Attach an item to a ticket.",
    body: { ticket },
    run: (ctx, a) => items.attach(ctx, str(a, "key"), str(a, "ticket")),
  },
  {
    name: "waits",
    method: "GET",
    path: "/waits",
    about: "Open waits on other people.",
    query: { due: { type: "boolean", about: "only those past their ping time" } },
    run: (ctx, a) => waits.waits(ctx, a.due === true),
  },
  {
    name: "wait_add",
    method: "POST",
    path: "/waits",
    about: "Record that someone was asked something.",
    body: {
      ticket,
      who: { type: "string", required: true, about: "person" },
      url: { type: "string", required: true, about: "thread" },
      ping_after: { type: "string", about: "30m, 4h, 2d" },
    },
    run: (ctx, a) => waits.wait(ctx, str(a, "ticket"), str(a, "who"), str(a, "url"), opt(a, "ping_after")),
  },
  {
    name: "wait_close",
    method: "POST",
    path: "/waits/{wait}/close",
    about: "Close a wait: the person answered.",
    run: (ctx, a) => waits.closeWait(ctx, str(a, "wait")),
  },
  {
    name: "wait_pinged",
    method: "POST",
    path: "/waits/{wait}/pinged",
    about: "Pinged again; remind later.",
    body: { for: later },
    run: (ctx, a) => waits.pinged(ctx, str(a, "wait"), opt(a, "for") ?? "1d"),
  },
  {
    name: "wait_reopen",
    method: "POST",
    path: "/waits/{wait}/reopen",
    about: "Reopen a closed wait.",
    run: (ctx, a) => waits.reopenWait(ctx, str(a, "wait")),
  },
  {
    name: "sources",
    method: "GET",
    path: "/sources",
    about: "Each source's cursor, last sync and error.",
    run: (ctx) => sources.sources(ctx),
  },
  {
    name: "source_status",
    method: "PUT",
    path: "/sources/{name}",
    about: "Record a sync of a source: new cursor, or the error.",
    body: {
      cursor: { type: "string", about: "opaque cursor; omitted keeps the old one" },
      error: { type: "string", about: "what failed" },
    },
    run: (ctx, a) => sources.synced(ctx, str(a, "name"), { cursor: opt(a, "cursor"), error: opt(a, "error") }),
  },
  {
    name: "brief",
    method: "GET",
    path: "/brief",
    about:
      "The small context a sync needs: open drafts, waits, tracked threads, cursors, and what the human did on the dashboard since the last brief (which this call moves on).",
    run: (ctx) => brief(ctx),
  },
  {
    name: "config",
    method: "GET",
    path: "/config",
    about: "Effective config, or one key.",
    query: { key: { type: "string", about: "one key" } },
    run: (ctx, a) => commands.config(ctx, opt(a, "key") ?? undefined, undefined),
  },
  {
    name: "config_set",
    method: "PUT",
    path: "/config/{key}",
    about: "Set a config key. Keys that run commands are set from the terminal only.",
    body: { value: { type: "any", required: true, about: "JSON value of the key's type" } },
    run: (ctx, a) => {
      const k = str(a, "key");
      if (COMMAND_KEYS.includes(k)) throw new HubError(`${k} is set from the terminal: hub config ${k}`);
      return commands.config(ctx, k, JSON.stringify(a.value));
    },
  },
  {
    name: "pin",
    method: "PUT",
    path: "/pins/{row}",
    about: "Pin or unpin a dashboard row.",
    body: { on: { type: "boolean", required: true, about: "pinned" } },
    run: (ctx, a) => pins.setPin(ctx, str(a, "row"), a.on === true),
  },
  {
    name: "import",
    method: "POST",
    path: "/import",
    about: "Read a markdown ticket folder on this machine; apply writes it, else a dry run.",
    body: {
      root: { type: "string", required: true, about: "folder holding tasks/ and plan/" },
      apply: { type: "boolean", about: "write the database" },
    },
    run: (ctx, a) => {
      const plan = collectImport(ctx.db, str(a, "root"), ctx.config, ctx.now);
      const changes = a.apply === true ? applyImport(ctx.db, plan, ctx.now) : null;
      return { text: formatSummary(plan, changes), json: { counts: countPlan(plan), report: plan.report, changes } };
    },
  },
  {
    name: "fetch",
    method: "POST",
    path: "/fetch",
    about: "Fetch the built-in sources that are on (or one) now, without waiting for the timer.",
    body: { source: { type: "string", about: "github, linear or slack" } },
    run: (_ctx, a, hooks) => hooks.fetchNow(opt(a, "source")),
  },
  {
    name: "moved",
    method: "POST",
    path: "/moved",
    about:
      "What moved since this agent's last look (new or changed items that need the human, answered waits, pings due, the human's clicks), and move the look on. start gives a short count instead.",
    body: {
      agent: { type: "string", required: true, about: "the agent's session id" },
      start: { type: "boolean", about: "session start: counts only" },
    },
    run: (ctx, a) => moved(ctx, str(a, "agent"), a.start === true),
  },
  {
    name: "sync_status",
    method: "GET",
    path: "/sync",
    about: "The last or running Sync.",
    run: (_ctx, _a, hooks) => ({ text: "", json: hooks.syncStatus() }),
  },
  {
    name: "sync",
    method: "POST",
    path: "/sync",
    about: "Start a Sync (syncCommand) unless one is running.",
    run: (_ctx, _a, hooks) => {
      const r = hooks.startSync();
      return { text: r.started ? "sync started" : "a sync is running", json: r.status, exitCode: r.started ? 0 : 1 };
    },
    status: (result) => (result.exitCode === 1 ? 409 : 202),
  },
];

export function params(pattern: string): string[] {
  return [...pattern.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1] as string);
}

export function findRoute(method: string, path: string): { route: Route; args: Args } | "no-method" | undefined {
  const parts = path.split("/");
  let pathMatched = false;
  for (const route of ROUTES) {
    const want = route.path.split("/");
    if (want.length !== parts.length) continue;
    const args: Args = {};
    const ok = want.every((w, i) => {
      const got = parts[i] as string;
      if (!w.startsWith("{")) return w === got;
      if (got === "") return false;
      args[w.slice(1, -1)] = decodeURIComponent(got);
      return true;
    });
    if (!ok) continue;
    pathMatched = true;
    if (route.method === method) return { route, args };
  }
  return pathMatched ? "no-method" : undefined;
}

function typeOk(type: FieldType, value: unknown): boolean {
  if (type === "any") return true;
  if (type === "integer") return Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return typeof value === type;
}

export function checkFields(fields: Fields, input: Args, where: string): Args {
  for (const name of Object.keys(input)) {
    if (!(name in fields))
      throw new HubError(`unknown ${where} field ${name} (${Object.keys(fields).join(", ") || "none"})`);
  }
  for (const [name, f] of Object.entries(fields)) {
    const value = input[name];
    if (value === undefined || value === null) {
      if (f.required) throw new HubError(`missing ${name}`);
      delete input[name];
      continue;
    }
    if (!typeOk(f.type, value)) throw new HubError(`${name} must be ${f.type === "any" ? "JSON" : `a ${f.type}`}`);
    if (f.of === "string" && !(value as unknown[]).every((v) => typeof v === "string")) {
      throw new HubError(`${name} must be an array of strings`);
    }
  }
  return input;
}

export function queryArgs(fields: Fields, search: URLSearchParams): Args {
  const out: Args = {};
  for (const [name, raw] of search) {
    const f = fields[name];
    if (f === undefined)
      throw new HubError(`unknown query field ${name} (${Object.keys(fields).join(", ") || "none"})`);
    if (f.type === "boolean") out[name] = raw === "" || raw === "1" || raw === "true";
    else if (f.type === "integer") {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new HubError(`${name} must be an integer`);
      out[name] = n;
    } else out[name] = raw;
  }
  return checkFields(fields, out, "query");
}

export function schema(fields: Fields): unknown {
  const properties = Object.fromEntries(
    Object.entries(fields).map(([name, f]) => [
      name,
      f.type === "any"
        ? { description: f.about }
        : f.type === "array"
          ? { type: "array", items: { type: f.of ?? "object" }, description: f.about }
          : { type: f.type, description: f.about },
    ]),
  );
  const required = Object.entries(fields)
    .filter(([, f]) => f.required)
    .map(([name]) => name);
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

export function openapi(version: string): unknown {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const parameters = [
      ...params(r.path).map((name) => ({
        name,
        in: "path",
        required: true,
        description: PATH_ABOUT[name],
        schema: { type: "string" },
      })),
      ...Object.entries(r.query ?? {}).map(([name, f]) => ({
        name,
        in: "query",
        required: f.required === true,
        description: f.about,
        schema: { type: f.type },
      })),
    ];
    const op: Record<string, unknown> = {
      operationId: r.name,
      summary: r.about,
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        "200": { description: "JSON result; send Accept: text/plain for the CLI's text" },
        "400": { description: "refused: { error }" },
      },
    };
    if (r.method !== "GET") {
      op.requestBody = { required: true, content: { "application/json": { schema: schema(r.body ?? {}) } } };
    }
    paths[r.path] = { ...paths[r.path], [r.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: { title: "engineer-hub", version },
    servers: [{ url: "/api/v1" }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "the token file next to the database" },
      },
    },
    paths,
  };
}

type Note = { ticket: string | null; text: string };

function itemNote(ctx: Ctx, key: string, verb: string): Note {
  const i = items.findItem(ctx.db, key);
  return { ticket: i.ticket_id, text: `${verb}: ${i.kind} ${i.title ?? i.ref}` };
}

function waitNote(ctx: Ctx, key: string, verb: string): Note | null {
  const w = one<WaitRow>(
    ctx.db,
    /^\d+$/.test(key) ? "SELECT * FROM wait WHERE id = ?" : "SELECT * FROM wait WHERE url = ?",
    key,
  );
  return w === undefined ? null : { ticket: w.ticket_id, text: `${verb}: ${w.who} ${w.url}` };
}

const HUMAN_NOTES: Record<string, (ctx: Ctx, a: Args) => Note | null> = {
  item_close: (ctx, a) => itemNote(ctx, str(a, "key"), "done"),
  item_snooze: (ctx, a) => itemNote(ctx, str(a, "key"), `later (${opt(a, "for") ?? "1d"})`),
  item_reopen: (ctx, a) => itemNote(ctx, str(a, "key"), "back in the list"),
  wait_close: (ctx, a) => waitNote(ctx, str(a, "wait"), "answered"),
  wait_reopen: (ctx, a) => waitNote(ctx, str(a, "wait"), "waiting again"),
  posted: (_ctx, a) => ({ ticket: str(a, "id"), text: `sent draft "${str(a, "label")}"` }),
  draft_later: (_ctx, a) => ({
    ticket: str(a, "id"),
    text: `send draft "${str(a, "label")}" later (${opt(a, "for") ?? "tomorrow"})`,
  }),
  match: (_ctx, a) =>
    a.answer === undefined
      ? null
      : { ticket: str(a, "id"), text: `draft "${str(a, "label")}" match: ${str(a, "answer")}` },
};

export async function runRoute(ctx: Ctx, route: Route, args: Args, hooks: Hooks, human: boolean): Promise<Result> {
  const describe = human ? HUMAN_NOTES[route.name] : undefined;
  const note = describe === undefined ? null : describe(ctx, args);
  const result = await route.run(ctx, args, hooks);
  if (note !== null) {
    ctx.db
      .prepare(
        "INSERT INTO event(ticket_id, ts, kind, text, source, created_at) VALUES (?, ?, 'action', ?, 'human', ?)",
      )
      .run(note.ticket, nowTs(ctx.now, ctx.config.timezone), note.text, nowIso(ctx.now));
  }
  return result;
}
