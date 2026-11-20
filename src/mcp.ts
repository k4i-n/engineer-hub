import {
  type Args,
  checkFields,
  type Fields,
  type Hooks,
  PATH_ABOUT,
  params,
  ROUTES,
  type Route,
  schema,
} from "./api.ts";
import type { Ctx } from "./commands.ts";
import { HubError } from "./util.ts";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const NOT_TOOLS = [
  "away_test",
  "find",
  "pin",
  "config",
  "config_set",
  "sync",
  "sync_status",
  "gate",
  "gate_reopen",
  "draft_send_at",
  "wait_unpinged",
  "import",
  "item_ignore",
  "item_unignore",
  "restore",
  "source_remove",
  "source_set",
  "ticket_delete",
  "ticket_merge",
];
const HUMAN_FIELDS: Record<string, string[]> = { match: ["answer"] };

const INSTRUCTIONS =
  "engineer-hub keeps the engineer's tickets, steps, drafts, waits and items from sources. Cold start: brief, then board or ticket. Write as you work: log what changed, ticket_set next (and gate when a human must decide), link every PR, thread or doc. State fields are one line each. Never answer a gate or a draft match for the human.";

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
export type RpcReply = { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } };

function fieldsOf(route: Route): Fields {
  const path: Fields = Object.fromEntries(
    params(route.path).map((name) => [name, { type: "string", required: true, about: PATH_ABOUT[name] ?? name }]),
  );
  const own = { ...(route.query ?? {}), ...(route.body ?? {}) };
  for (const name of HUMAN_FIELDS[route.name] ?? []) delete own[name];
  return { ...path, ...own };
}

export const TOOLS = ROUTES.filter((r) => !NOT_TOOLS.includes(r.name));

function annotations(route: Route): Record<string, boolean> {
  if (route.method === "GET") return { readOnlyHint: true, openWorldHint: false };
  const replaces = route.method === "PUT" || route.method === "PATCH";
  return { readOnlyHint: false, destructiveHint: replaces, idempotentHint: replaces, openWorldHint: false };
}

export function toolList(): unknown {
  return {
    tools: TOOLS.map((r) => ({
      name: r.name,
      description: r.about,
      inputSchema: schema(fieldsOf(r)),
      annotations: annotations(r),
    })),
  };
}

async function callTool(ctx: Ctx, hooks: Hooks, raw: unknown): Promise<unknown> {
  const p = (typeof raw === "object" && raw !== null ? raw : {}) as { name?: unknown; arguments?: unknown };
  const route = TOOLS.find((r) => r.name === p.name);
  if (route === undefined) throw new RpcError(-32602, `no tool ${String(p.name)}`);
  const given = p.arguments ?? {};
  try {
    if (typeof given !== "object" || given === null || Array.isArray(given))
      throw new HubError("arguments must be an object");
    const args = checkFields(fieldsOf(route), { ...(given as Args) }, "argument");
    const result = await route.run(ctx, args, hooks);
    return { content: [{ type: "text", text: result.text || JSON.stringify(result.json) }], isError: false };
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

export async function handleRpc(message: unknown, ctx: () => Ctx, hooks: Hooks): Promise<RpcReply | null> {
  const m = (typeof message === "object" && message !== null && !Array.isArray(message) ? message : {}) as Rpc;
  const id = m.id ?? null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "not a JSON-RPC 2.0 request" } };
  }
  if (m.id === undefined) return null;
  try {
    return { jsonrpc: "2.0", id, result: await dispatch(m.method, m.params, ctx, hooks) };
  } catch (error) {
    if (!(error instanceof RpcError)) throw error;
    return { jsonrpc: "2.0", id, error: { code: error.code, message: error.message } };
  }
}

async function dispatch(method: string, raw: unknown, ctx: () => Ctx, hooks: Hooks): Promise<unknown> {
  if (method === "initialize") {
    const asked = (raw as { protocolVersion?: unknown } | undefined)?.protocolVersion;
    const version = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "engineer-hub", version: hooks.version },
      instructions: INSTRUCTIONS,
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return toolList();
  if (method === "tools/call") return await callTool(ctx(), hooks, raw);
  throw new RpcError(-32601, `no method ${method}`);
}
