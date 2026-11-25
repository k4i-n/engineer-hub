import type { Ctx, Result } from "./commands.ts";
import { setConfig, WORKSPACE } from "./config.ts";
import { HubError } from "./util.ts";

export function addWorkspace(ctx: Ctx, name: string): Result {
  if (!WORKSPACE.test(name)) {
    throw new HubError(`a Slack workspace name is lowercase letters, digits and -, e.g. acme, not ${name}`);
  }
  const source = `slack-${name}`;
  const list = ctx.config.slackWorkspaces;
  if (!list.includes(name)) setConfig(ctx.db, "slackWorkspaces", JSON.stringify([...list, name]), ctx.now);
  setConfig(ctx.db, "fetch", JSON.stringify({ ...ctx.config.fetch, [source]: true }), ctx.now);
  return {
    text: `Slack workspace ${name}: source ${source} is on and reads the key ${source} (Settings → Sources shows how to store it)`,
    json: { name, source },
  };
}

export function removeWorkspace(ctx: Ctx, name: string): Result {
  const list = ctx.config.slackWorkspaces;
  if (!list.includes(name)) {
    throw new HubError(`no Slack workspace ${name} (${list.length === 0 ? "none added" : list.join(", ")})`);
  }
  const source = `slack-${name}`;
  const { [source]: _, ...fetch } = ctx.config.fetch;
  setConfig(ctx.db, "slackWorkspaces", JSON.stringify(list.filter((w) => w !== name)), ctx.now);
  setConfig(ctx.db, "fetch", JSON.stringify(fetch), ctx.now);
  return {
    text: `Slack workspace ${name} removed; its key ${source} stays where you stored it`,
    json: { name, source },
  };
}
