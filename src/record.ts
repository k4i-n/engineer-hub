import type { Ctx } from "./commands.ts";
import { all } from "./db.ts";
import { prUrls, withoutHeredocs } from "./gate.ts";
import { itemByRef, link } from "./items.ts";

export type PostToolInput = {
  tool_name?: unknown;
  tool_input?: { command?: unknown };
  tool_response?: { stdout?: unknown; stderr?: unknown };
  cwd?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function record(ctx: Ctx, input: PostToolInput, branchOf: (cwd: string) => string | null): string {
  const command = text(input.tool_input?.command);
  if (input.tool_name !== "Bash" || command === "") return "";
  const actions = ctx.config.recordActions.map((pattern) => new RegExp(pattern));
  if (!actions.some((action) => action.test(withoutHeredocs(command)))) return "";
  const urls = prUrls(`${text(input.tool_response?.stdout)}\n${text(input.tool_response?.stderr)}`).filter(
    (url) => (itemByRef(ctx.db, url)?.ticket_id ?? null) === null,
  );
  const cwd = text(input.cwd);
  if (urls.length === 0 || cwd === "") return "";
  const branch = branchOf(cwd);
  if (branch === null || branch === "") return "";
  const tickets = all<{ id: string }>(ctx.db, "SELECT id FROM ticket WHERE branch = ?", branch);
  if (tickets.length !== 1) return "";
  const id = tickets[0]?.id ?? "";
  for (const url of urls) link(ctx, id, url, { kind: "pr", title: null });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `hub linked ${urls.join(", ")} to ${id}; set its next if it changed.`,
    },
  });
}
