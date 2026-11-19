import { readFileSync } from "node:fs";
import { cut } from "./util.ts";

export type StopInput = {
  hook_event_name?: unknown;
  stop_hook_active?: unknown;
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
};

type ToolUse = { name: string; command: string | null };

const SHOWN = 3;
const WRITE_TOOL =
  /hub__(log|ticket_set|ticket_new|link|step_add|step_done|draft_save|draft_later|posted|match|day_set|note_save|wait_add|wait_close|wait_pinged|item_attach|item_put)$/;
const WRITE_COMMAND =
  /(^|[\s;&|(/])hub\s+(log|set|ticket-new|link|step\s+(add|done)|draft|draft-later|posted|match|day\s+set|note|wait(?!\s+reopen\b)|item\s+(attach|put))(?=[\s;&|)]|$)/m;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

function transcriptPath(input: StopInput): string | null {
  const path = input.hook_event_name === "SubagentStop" ? input.agent_transcript_path : input.transcript_path;
  return typeof path === "string" && path !== "" ? path : null;
}

function toolUses(jsonl: string): ToolUse[] {
  const uses: ToolUse[] = [];
  for (const line of jsonl.split("\n")) {
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content)) continue;
    for (const part of entry.message.content as { type?: unknown; name?: unknown; input?: { command?: unknown } }[]) {
      if (part?.type !== "tool_use" || typeof part.name !== "string") continue;
      const command = part.input?.command;
      uses.push({ name: part.name, command: typeof command === "string" ? command : null });
    }
  }
  return uses;
}

function withoutHeredocs(command: string): string {
  return command.replace(HEREDOC, "<<$1$2$1$3");
}

export function gate(input: StopInput, recordActions: string[]): string {
  if (input.stop_hook_active === true || recordActions.length === 0) return "";
  const path = transcriptPath(input);
  if (path === null) return "";
  const actions = recordActions.map((pattern) => new RegExp(pattern));
  let pending: string[] = [];
  for (const use of toolUses(readFileSync(path, "utf8"))) {
    if (WRITE_TOOL.test(use.name)) {
      pending = [];
      continue;
    }
    if (use.name !== "Bash" || use.command === null) continue;
    const command = withoutHeredocs(use.command);
    if (actions.some((action) => action.test(command))) pending.push(use.command);
    if (WRITE_COMMAND.test(command)) pending = [];
  }
  if (pending.length === 0) return "";
  const shown = pending.slice(-SHOWN).map((command) => `- ${cut(command.split("\n")[0] ?? "", 120)}`);
  const reason = [
    "Nothing was recorded in hub after:",
    ...shown,
    "Record them before stopping: log or link on the ticket, then ticket_set next. If they belong to no ticket, log them on the day plan with day_set.",
  ].join("\n");
  return JSON.stringify({ decision: "block", reason });
}
