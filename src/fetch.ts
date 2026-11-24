import { type Ctx, proposeReview, type Result, type Review, setTracker, type TrackerFields } from "./commands.ts";
import { loadConfig, SLACK_CHANNEL_KEYS, type SlackChannel, sameChannel, setConfig } from "./config.ts";
import { one, type SourceRow } from "./db.ts";
import * as items from "./items.ts";
import { type KeySpec, lastLine, type System, storeCommands } from "./keys.ts";
import { scriptFetcher, scripts } from "./scripts.ts";
import * as sources from "./sources.ts";
import { afterDuration, HubError } from "./util.ts";
import * as waits from "./waits.ts";

export type Fetched = {
  items: unknown[];
  cursor: string;
  answered?: string[];
  warning?: string | null;
  tracker?: TrackerFields[];
  reviews?: Review[];
  channels?: SlackChannel[];
};
export type Check = { ok: boolean; how: string; fix: string[] };
export type Fetcher = {
  name: string;
  key: KeySpec | null;
  every?: string;
  argv?: string[];
  on?: boolean;
  section?: string | null;
  check: (sys: System) => Promise<Check>;
  fetch: (sys: System, ctx: Ctx, cursor: string | null) => Promise<Fetched>;
};
export type Status = { running: boolean; check: Check | null };

export function isOn(c: Ctx, f: Fetcher): boolean {
  return f.on ?? c.config.fetch[f.name] === true;
}

export function write(ctx: Ctx, name: string, fetched: Fetched): string {
  const parts: string[] = [];
  if (fetched.items.length > 0) parts.push(items.put(ctx, fetched.items.map((i) => JSON.stringify(i)).join("\n")).text);
  for (const url of fetched.answered ?? []) {
    try {
      parts.push(waits.closeWait(ctx, url).text);
    } catch (error) {
      if (!(error instanceof HubError)) throw error;
    }
  }
  if (fetched.channels !== undefined) saveChannels(ctx, fetched.channels);
  const updated = (fetched.tracker ?? []).filter((t) => setTracker(ctx, t)).length;
  if (updated > 0) parts.push(`tickets: ${updated} updated`);
  const proposed = (fetched.reviews ?? []).map((r) => proposeReview(ctx, r));
  const sent = proposed.reduce((n, p) => n + p.sent, 0);
  const asked = proposed.reduce((n, p) => n + p.asked, 0);
  if (sent > 0) parts.push(`drafts: ${sent} sent`);
  if (asked > 0) parts.push(`drafts: ${asked} sent?`);
  sources.synced(ctx, name, { cursor: fetched.cursor, error: null, warning: fetched.warning ?? null });
  return parts.join("; ") || "nothing new";
}

function saveChannels(ctx: Ctx, found: SlackChannel[]): void {
  const current = loadConfig(ctx.db);
  for (const key of SLACK_CHANNEL_KEYS) {
    const next = current[key].map((c) => found.find((f) => sameChannel(f, c)) ?? c);
    if (JSON.stringify(next) !== JSON.stringify(current[key])) setConfig(ctx.db, key, JSON.stringify(next), ctx.now);
  }
}

export class Runner {
  readonly status = new Map<string, Status>();
  private readonly builtIns: Fetcher[];
  private readonly sys: System;
  private readonly ctx: () => Ctx;
  private readonly changed: () => void;

  constructor(builtIns: Fetcher[], sys: System, ctx: () => Ctx, changed: () => void = () => {}) {
    this.builtIns = builtIns;
    this.sys = sys;
    this.ctx = ctx;
    this.changed = changed;
  }

  fetchers(c: Ctx): Fetcher[] {
    return [...this.builtIns, ...scripts(c).map(scriptFetcher)];
  }

  state(name: string): Status {
    const known = this.status.get(name);
    if (known !== undefined) return known;
    const fresh: Status = { running: false, check: null };
    this.status.set(name, fresh);
    return fresh;
  }

  enabled(c: Ctx): Fetcher[] {
    return this.fetchers(c).filter((f) => isOn(c, f));
  }

  due(c: Ctx): Fetcher[] {
    return this.enabled(c).filter((f) => {
      if (this.state(f.name).running) return false;
      const every = Date.parse(afterDuration(new Date(0), f.every ?? c.config.fetchEvery, "every"));
      const last = one<SourceRow>(c.db, "SELECT * FROM source WHERE name = ?", f.name)?.last_sync;
      return last === undefined || c.now.getTime() - Date.parse(last) >= every;
    });
  }

  async tick(): Promise<void> {
    await Promise.all(this.due(this.ctx()).map((f) => this.runOne(f)));
  }

  async runOne(f: Fetcher): Promise<string> {
    const state = this.state(f.name);
    if (state.running) return `${f.name}: already running`;
    state.running = true;
    this.changed();
    try {
      state.check = await f.check(this.sys);
      if (!state.check.ok) throw new HubError(state.check.how);
      const cursor = one<SourceRow>(this.ctx().db, "SELECT * FROM source WHERE name = ?", f.name)?.cursor ?? null;
      const fetched = await f.fetch(this.sys, this.ctx(), cursor);
      return `${f.name}: ${write(this.ctx(), f.name, fetched)}`;
    } catch (error) {
      const message = error instanceof Error ? lastLine(error.message) : String(error);
      sources.synced(this.ctx(), f.name, { cursor: null, error: message, warning: null });
      return `${f.name}: ${message}`;
    } finally {
      state.running = false;
      this.changed();
    }
  }

  async now(name: string | null): Promise<Result> {
    const c = this.ctx();
    const chosen = name === null ? this.enabled(c) : this.fetchers(c).filter((f) => f.name === name);
    if (chosen.length === 0) {
      throw new HubError(name === null ? "no source is on (hub config fetch)" : `no source ${name} to fetch`);
    }
    const lines = await Promise.all(chosen.map((f) => this.runOne(f)));
    return { text: lines.join("\n"), json: lines };
  }

  fixes(f: Fetcher): string[] {
    if (f.argv !== undefined) return [];
    if (f.key === null) return this.status.get(f.name)?.check?.fix ?? [];
    const c = storeCommands(f.key, this.sys.platform);
    return [c.hub, c.sealcall];
  }
}
