import type { Ctx, Result } from "./commands.ts";
import { one, type SourceRow } from "./db.ts";
import * as items from "./items.ts";
import { type KeySpec, lastLine, type System, storeCommands } from "./keys.ts";
import * as sources from "./sources.ts";
import { afterDuration, HubError } from "./util.ts";
import * as waits from "./waits.ts";

export type Fetched = { items: unknown[]; cursor: string; answered?: string[] };
export type Check = { ok: boolean; how: string; fix: string[] };
export type Fetcher = {
  name: string;
  key: KeySpec | null;
  check: (sys: System) => Promise<Check>;
  fetch: (sys: System, ctx: Ctx, cursor: string | null) => Promise<Fetched>;
};
export type Status = { running: boolean; check: Check | null };

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
  sources.synced(ctx, name, { cursor: fetched.cursor, error: null });
  return parts.join("; ") || "nothing new";
}

export class Runner {
  readonly status = new Map<string, Status>();
  readonly fetchers: Fetcher[];
  private readonly sys: System;
  private readonly ctx: () => Ctx;

  constructor(fetchers: Fetcher[], sys: System, ctx: () => Ctx) {
    this.fetchers = fetchers;
    this.sys = sys;
    this.ctx = ctx;
    for (const f of fetchers) this.status.set(f.name, { running: false, check: null });
  }

  enabled(c: Ctx): Fetcher[] {
    return this.fetchers.filter((f) => c.config.fetch[f.name] === true);
  }

  due(c: Ctx): Fetcher[] {
    const every = Date.parse(afterDuration(new Date(0), c.config.fetchEvery, "fetchEvery"));
    return this.enabled(c).filter((f) => {
      if (this.status.get(f.name)?.running) return false;
      const last = one<SourceRow>(c.db, "SELECT * FROM source WHERE name = ?", f.name)?.last_sync;
      return last === undefined || c.now.getTime() - Date.parse(last) >= every;
    });
  }

  async tick(): Promise<void> {
    await Promise.all(this.due(this.ctx()).map((f) => this.runOne(f)));
  }

  async runOne(f: Fetcher): Promise<string> {
    const state = this.status.get(f.name) as Status;
    if (state.running) return `${f.name}: already running`;
    state.running = true;
    try {
      state.check = await f.check(this.sys);
      if (!state.check.ok) throw new HubError(state.check.how);
      const cursor = one<SourceRow>(this.ctx().db, "SELECT * FROM source WHERE name = ?", f.name)?.cursor ?? null;
      const fetched = await f.fetch(this.sys, this.ctx(), cursor);
      return `${f.name}: ${write(this.ctx(), f.name, fetched)}`;
    } catch (error) {
      const message = error instanceof Error ? lastLine(error.message) : String(error);
      sources.synced(this.ctx(), f.name, { cursor: null, error: message });
      return `${f.name}: ${message}`;
    } finally {
      state.running = false;
    }
  }

  async now(name: string | null): Promise<Result> {
    const c = this.ctx();
    const chosen = name === null ? this.enabled(c) : this.fetchers.filter((f) => f.name === name);
    if (chosen.length === 0) {
      throw new HubError(name === null ? "no source is on (hub config fetch)" : `no built-in source ${name}`);
    }
    const lines = await Promise.all(chosen.map((f) => this.runOne(f)));
    return { text: lines.join("\n"), json: lines };
  }

  fixes(name: string): string[] {
    const f = this.fetchers.find((x) => x.name === name);
    if (f?.key == null) return this.status.get(name)?.check?.fix ?? [];
    const c = storeCommands(f.key, this.sys.platform);
    return [c.hub, c.sealcall];
  }
}
