import type { Config } from "./config.ts";

export type StateFields = {
  status?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  prs?: string;
  gate?: string;
  decide?: string;
  next?: string;
  owner?: string;
  updated?: string;
  tracker_url?: string;
  order?: number;
};

export type Tracker = {
  state?: string;
  priority?: string;
  assignee?: string;
  updated?: string;
  url?: string;
  attachments: string[];
  raw: string;
};

export type ParsedEvent = { ts: string; text: string };
export type ParsedNote = { title: string; body: string; kind: string; position: number };
export type ParsedDraft = { label: string; body: string; status: string; posted_at: string | null };

export type ParsedTicket = {
  title: string;
  titleFromFile: boolean;
  hasState: boolean;
  state: StateFields;
  events: ParsedEvent[];
  notes: ParsedNote[];
  drafts: ParsedDraft[];
  tracker: Tracker | null;
  otherHeadings: string[];
};

const STATE_COLUMNS: Record<string, Exclude<keyof StateFields, "order">> = {
  status: "status",
  repo: "repo",
  prs: "prs",
  gate: "gate",
  next: "next",
  owner: "owner",
  decide: "decide",
};

const LOG_ENTRY = /^- (\d{4}-\d{2}-\d{2})(?:[ :]+(\d{2}:[0-9x]{2})(?:-\d{2}:[0-9x]{2})?)?:?\s*(.*)$/;
const LOG_HEADING = /^### (\d{4}-\d{2}-\d{2})(?:[ :]+(\d{2}:[0-9x]{2})(?:-\d{2}:[0-9x]{2})?)?:?\s*(.*)$/;
const TITLE = /^# (.+?)\s+[-–—]\s+(.+)$/;
const DATE = /\d{4}-\d{2}-\d{2}/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function block(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start++;
  while (end > start && lines[end - 1]?.trim() === "") end--;
  return lines
    .slice(start, end)
    .map((l) => l.trimEnd())
    .join("\n");
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

export function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/\*\*([A-Za-z ]+):\*\*\s*(.*?)\s*(?=\|\s*\*\*[A-Za-z ]+:\*\*|$)/g)) {
      const name = match[1]?.trim().toLowerCase();
      if (name) fields[name] = match[2]?.trim() ?? "";
    }
  }
  return fields;
}

function markdownLinkUrl(value: string): string | undefined {
  const link = value.match(/\]\(([^)\s]+)\)/);
  if (link) return link[1];
  const bare = value.match(/https?:\/\/\S+/);
  return bare?.[0];
}

export function parseTracker(raw: string): Tracker {
  const fields = parseFields(raw);
  const tracker: Tracker = { attachments: [], raw };
  if (fields.state) tracker.state = fields.state;
  if (fields.priority) tracker.priority = fields.priority;
  if (fields.assignee) tracker.assignee = fields.assignee;
  if (fields.updated) tracker.updated = fields.updated;
  const url = fields.link ? markdownLinkUrl(fields.link) : undefined;
  if (url) tracker.url = url;
  if (fields.attachments) {
    tracker.attachments = [...fields.attachments.matchAll(/https?:\/\/[^\s)\]]+/g)].map((m) => m[0]);
  }
  return tracker;
}

function setState(state: StateFields, name: string, value: string): void {
  const key = name.toLowerCase();
  if (key === "repo") {
    const [repo = "", rest = ""] = value.split(" | Worktree: ");
    const [worktree = "", branch] = rest.split(" | Branch: ");
    state.repo = repo.trim();
    if (worktree) state.worktree = worktree.trim();
    if (branch) state.branch = branch.trim();
    return;
  }
  if (key === "owner") {
    const [owner = "", updated] = value.split(" | Updated: ");
    state.owner = owner.trim();
    if (updated) state.updated = updated.trim();
    return;
  }
  if (key === "order") {
    const place = Number(value.match(/\d+/)?.[0] ?? 0);
    if (place > 0) state.order = place;
    return;
  }
  const column = STATE_COLUMNS[key];
  if (column) {
    state[column] = value.trim();
    return;
  }
  if (value.trim()) state.tracker_url = value.trim();
}

function parseLog(lines: string[]): { events: ParsedEvent[]; preamble: string } {
  const events: ParsedEvent[] = [];
  const before: string[] = [];
  let current: { ts: string; lines: string[] } | null = null;
  const flush = () => {
    if (current) events.push({ ts: current.ts, text: block(current.lines) });
  };
  for (const line of lines) {
    const entry = line.match(LOG_ENTRY) ?? line.match(LOG_HEADING);
    if (entry) {
      flush();
      const ts = entry[2] ? `${entry[1]} ${entry[2]}` : (entry[1] ?? "");
      current = { ts, lines: [entry[3] ?? ""] };
      continue;
    }
    if (current) current.lines.push(line.trim());
    else before.push(line);
  }
  flush();
  return { events, preamble: block(before) };
}

function draftLabel(heading: string): string {
  return heading.replace(/\s*\(\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, "").trim();
}

function parseMessages(lines: string[]): ParsedDraft[] {
  const drafts: ParsedDraft[] = [];
  const before: string[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const body = block(current.lines);
    const first = body.split("\n")[0] ?? "";
    const posted = /POSTED|Posted/.test(current.heading) || /POSTED|Posted/.test(first);
    const postedAt = posted ? (current.heading.match(DATE)?.[0] ?? first.match(DATE)?.[0] ?? null) : null;
    drafts.push({ label: draftLabel(current.heading), body, status: posted ? "posted" : "draft", posted_at: postedAt });
  };
  for (const line of lines) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      flush();
      current = { heading: heading[1]?.trim() ?? "", lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else before.push(line);
  }
  flush();
  const unlabelled = block(stripComments(before.join("\n")).split("\n"));
  if (unlabelled) {
    drafts.unshift({ label: "Messages (unlabelled, migrated)", body: unlabelled, status: "draft", posted_at: null });
  }
  return drafts;
}

type Section = { heading: string | null; afterTracker: boolean; lines: string[] };

export function parseTicket(text: string, fallbackTitle: string, config: Config): ParsedTicket {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const [startMarker = "", endMarker = ""] = config.trackerSyncMarkers;
  const stateLine = new RegExp(`^(${config.stateFields.map(escapeRegex).join("|")}):\\s*(.*)$`);

  const titleMatch = lines[0]?.match(TITLE);
  const title = titleMatch?.[2]?.trim() ?? fallbackTitle;
  const bodyStart = lines[0]?.startsWith("# ") ? 1 : 0;

  const state: StateFields = {};
  let hasState = false;
  const sections: Section[] = [{ heading: null, afterTracker: false, lines: [] }];
  const trackerLines: string[] = [];
  let inTracker = false;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inTracker) {
      if (endMarker && line.includes(endMarker)) inTracker = false;
      else trackerLines.push(line);
      continue;
    }
    if (startMarker && line.includes(startMarker)) {
      inTracker = !(endMarker && line.includes(endMarker));
      sections.push({ heading: null, afterTracker: true, lines: [] });
      continue;
    }
    const heading = line.match(/^## (.+)$/);
    if (heading) {
      sections.push({ heading: heading[1]?.trim() ?? "", afterTracker: false, lines: [] });
      continue;
    }
    const section = sections[sections.length - 1];
    if (!section) continue;
    const inStateArea = (section.heading === null && !section.afterTracker) || section.heading === "State";
    const field = inStateArea && i < 40 ? line.match(stateLine) : null;
    if (field) {
      setState(state, field[1] ?? "", field[2] ?? "");
      hasState = true;
      continue;
    }
    section.lines.push(line);
  }

  const parsed: ParsedTicket = {
    title,
    titleFromFile: titleMatch?.[2] === undefined,
    hasState,
    state,
    events: [],
    notes: [],
    drafts: [],
    tracker: trackerLines.some((l) => l.trim()) ? parseTracker(block(trackerLines)) : null,
    otherHeadings: [],
  };

  let position = 0;
  const addNote = (title: string, body: string, kind: string) => {
    if (!body) return;
    let unique = title;
    for (let n = 2; parsed.notes.some((note) => note.title === unique); n++) unique = `${title} (${n})`;
    parsed.notes.push({ title: unique, body, kind, position: position++ });
  };

  for (const section of sections) {
    if (section.afterTracker) {
      addNote("After tracker block", block(section.lines), "other");
      continue;
    }
    if (section.heading === null || section.heading === "State") {
      const body = block(section.lines.filter((l) => !/^```/.test(l.trim())));
      addNote(section.heading === null ? "Preamble" : "State (unparsed)", body, "other");
      continue;
    }
    const heading = section.heading;
    if (heading === config.sections.body) addNote(heading, block(section.lines), "ticket_body");
    else if (heading === config.sections.detail) addNote(heading, block(section.lines), "detail");
    else if (heading === config.sections.log) {
      const log = parseLog(section.lines);
      parsed.events.push(...log.events);
      addNote("Log (unparsed, migrated)", log.preamble, "other");
    } else if (heading === config.sections.messages) parsed.drafts.push(...parseMessages(section.lines));
    else {
      parsed.otherHeadings.push(heading);
      addNote(heading, block(section.lines), "other");
    }
  }
  return parsed;
}

export function fileTitle(stem: string, id: string): string {
  const bare = stem.replace(/^P\d+-\d+-/, "");
  const rest = bare.toLowerCase().startsWith(id.toLowerCase()) ? bare.slice(id.length) : bare;
  return rest.replace(/[-_\s]+/g, " ").trim() || stem;
}

export function splitResume(text: string, heading: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}` || l.startsWith(`## ${heading} `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  return block(end === -1 ? rest : rest.slice(0, end)) || null;
}
