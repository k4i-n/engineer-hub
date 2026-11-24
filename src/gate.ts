import { readFileSync } from "node:fs";
import { cut } from "./util.ts";

export type StopInput = {
  hook_event_name?: unknown;
  stop_hook_active?: unknown;
  transcript_path?: unknown;
  agent_transcript_path?: unknown;
};

type ToolUse = { id: string; name: string; command: string | null };
type Transcript = { uses: ToolUse[]; results: Map<string, string> };

const SHOWN = 3;
const WRITE_TOOL =
  /hub__(log|ticket_set|ticket_new|link|step_add|step_done|draft_save|draft_later|posted|match|day_set|plan_(?:add|edit|move|done|undo|drop)|note_save|wait_add|wait_close|wait_pinged|item_attach|item_put)$/;
const WRITE_COMMAND =
  /(^|[\s;&|(/])hub\s+(log|set|ticket-new|link|step\s+(add|done)|draft|draft-later|posted|match|day\s+set|plan\s+(add|edit|move|done|undo|drop)|note|wait(?!\s+reopen\b)|item\s+(attach|put))(?=[\s;&|)]|$)/m;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

function transcriptPath(input: StopInput): string | null {
  const path = input.hook_event_name === "SubagentStop" ? input.agent_transcript_path : input.transcript_path;
  return typeof path === "string" && path !== "" ? path : null;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function read(jsonl: string): Transcript {
  const uses: ToolUse[] = [];
  const results = new Map<string, string>();
  for (const line of jsonl.split("\n")) {
    let entry: { type?: unknown; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (!Array.isArray(entry?.message?.content)) continue;
    for (const part of entry.message.content as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: { command?: unknown };
      tool_use_id?: unknown;
      content?: unknown;
    }[]) {
      if (entry.type === "user" && part?.type === "tool_result" && typeof part.tool_use_id === "string") {
        results.set(part.tool_use_id, resultText(part.content));
        continue;
      }
      if (entry.type !== "assistant" || part?.type !== "tool_use" || typeof part.name !== "string") continue;
      const command = part.input?.command;
      uses.push({
        id: typeof part.id === "string" ? part.id : "",
        name: part.name,
        command: typeof command === "string" ? command : null,
      });
    }
  }
  return { uses, results };
}

export function prUrls(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])];
}

export function withoutHeredocs(command: string): string {
  return command.replace(HEREDOC, "<<$1$2$1$3");
}

export function gate(
  input: StopInput,
  recordActions: string[],
  linked: (url: string) => boolean = () => false,
): string {
  if (input.stop_hook_active === true || recordActions.length === 0) return "";
  const path = transcriptPath(input);
  if (path === null) return "";
  const actions = recordActions.map((pattern) => new RegExp(pattern));
  const { uses, results } = read(readFileSync(path, "utf8"));
  let pending: ToolUse[] = [];
  for (const use of uses) {
    if (WRITE_TOOL.test(use.name)) {
      pending = [];
      continue;
    }
    if (use.name !== "Bash" || use.command === null) continue;
    const command = withoutHeredocs(use.command);
    if (actions.some((action) => action.test(command))) pending.push(use);
    if (WRITE_COMMAND.test(command)) pending = [];
  }
  pending = pending.filter((use) => !prUrls(results.get(use.id) ?? "").some(linked));
  if (pending.length === 0) return "";
  const shown = pending.slice(-SHOWN).map((use) => `- ${cut((use.command ?? "").split("\n")[0] ?? "", 120)}`);
  const reason = [
    "Nothing was recorded in hub after:",
    ...shown,
    "Record them before stopping: log or link on the ticket, then ticket_set next. If they belong to no ticket, add them to the day plan with plan_add.",
  ].join("\n");
  return JSON.stringify({ decision: "block", reason });
}
