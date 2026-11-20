export type Link = (url: string, text: string) => string;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*\*([^*]+)\*\*|~~([^~]+)~~|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])|(?<![\w_])_([^_\s](?:[^_]*[^_\s])?)_(?![\w_])/g;

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

function inline(raw: string, link: Link): string {
  let html = "";
  let last = 0;
  for (const m of raw.matchAll(INLINE)) {
    html += esc(raw.slice(last, m.index));
    if (m[1] !== undefined) html += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined && m[3] !== undefined) html += link(m[3], m[2]);
    else if (m[4] !== undefined) html += link(m[4], m[4]);
    else if (m[5] !== undefined) html += `<strong>${esc(m[5])}</strong>`;
    else if (m[6] !== undefined) html += `<s>${esc(m[6])}</s>`;
    else if (m[7] !== undefined || m[8] !== undefined) html += `<em>${esc(m[7] ?? m[8])}</em>`;
    last = m.index + m[0].length;
  }
  return html + esc(raw.slice(last));
}

type Segment = { code: boolean; text: string };

const BLOCK_MARK = /^(#{1,6}\s+|>\s?|[-*]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let fence: string[] | null = null;
  const closeFence = () => {
    if (fence !== null && fence.length > 0) out.push({ code: true, text: fence.join(" ") });
    fence = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      if (fence === null) fence = [];
      else closeFence();
      continue;
    }
    if (line === "") continue;
    if (fence !== null) fence.push(line);
    else out.push({ code: false, text: line.replace(BLOCK_MARK, "") });
  }
  closeFence();
  return out;
}

export function renderLine(text: string, link: Link, max = Number.POSITIVE_INFINITY): string {
  const out: string[] = [];
  let room = max;
  for (const s of segments(text)) {
    if (room <= 0) break;
    const shown = s.text.length > room ? `${s.text.slice(0, Math.max(room - 3, 0))}...` : s.text;
    room -= s.text.length + 1;
    out.push(s.code ? `<code>${esc(shown)}</code>` : inline(shown, link));
  }
  return out.join(" ");
}

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const PIPE = /(?<!\\)\|/;

function cells(row: string): string[] {
  let body = row.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll("\\|", "|"));
}

function alignment(cell: string): string {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return ` style="text-align:center"`;
  if (right) return ` style="text-align:right"`;
  if (left) return ` style="text-align:left"`;
  return "";
}

function table(head: string, delimiter: string, rows: string[], link: Link): string | null {
  const names = cells(head);
  const aligns = cells(delimiter).map(alignment);
  if (aligns.length !== names.length) return null;
  const row = (values: string[], tag: "th" | "td") =>
    `<tr>${names.map((_, n) => `<${tag}${aligns[n]}>${inline(values[n] ?? "", link)}</${tag}>`).join("")}</tr>`;
  const body = rows.length === 0 ? "" : `<tbody>${rows.map((r) => row(cells(r), "td")).join("")}</tbody>`;
  return `<div class="md-table"><table><thead>${row(names, "th")}</thead>${body}</table></div>`;
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line.replaceAll("\t", "    "))?.[0] ?? "").length;
}

export function renderMarkdown(text: string, link: Link, callout: string | null = null): string {
  const out: string[] = [];
  const lists: { kind: "ul" | "ol"; indent: number }[] = [];
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  let inCallout = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const popList = () => {
    const top = lists.pop();
    if (top !== undefined) out.push(`</li></${top.kind}>`);
  };
  const closeList = () => {
    while (lists.length > 0) popList();
  };
  const listItem = (kind: "ul" | "ol", indent: number, li: string) => {
    flushParagraph();
    while ((lists.at(-1)?.indent ?? -1) > indent) popList();
    const top = lists.at(-1);
    if (top !== undefined && top.indent === indent && top.kind !== kind) popList();
    if (lists.at(-1)?.indent === indent) out.push("</li>");
    else {
      out.push(`<${kind}>`);
      lists.push({ kind, indent });
    }
    out.push(li);
  };
  const closeCallout = () => {
    if (inCallout) out.push("</div>");
    inCallout = false;
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fence !== null) {
      if (line.trim().startsWith("```")) {
        out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushParagraph();
      closeList();
      fence = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      closeCallout();
      const level = Math.min((heading[1] ?? "#").length + 2, 6);
      const title = (heading[2] ?? "").trim();
      if (callout !== null && title.toLowerCase() === callout.toLowerCase()) {
        out.push(`<div class="md-callout">`);
        inCallout = true;
        continue;
      }
      out.push(`<h${level}>${inline(title, link)}</h${level}>`);
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (PIPE.test(line) && DELIMITER.test(next) && PIPE.test(`${line}${next}`)) {
      let end = i + 2;
      while (end < lines.length && (lines[end] ?? "").trim() !== "" && PIPE.test(lines[end] ?? "")) end++;
      const html = table(line, next, lines.slice(i + 2, end), link);
      if (html !== null) {
        flushParagraph();
        closeList();
        out.push(html);
        i = end - 1;
        continue;
      }
    }
    const task = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      const done = task[2] !== " ";
      listItem(
        "ul",
        indentOf(line),
        `<li class="md-task${done ? " done" : ""}"><span class="box">${done ? "✓" : ""}</span>${inline(task[3] ?? "", link)}`,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      listItem(bullet ? "ul" : "ol", indentOf(line), `<li>${inline((bullet ?? numbered)?.[1] ?? "", link)}`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    closeList();
    const quote = /^>\s?(.*)$/.exec(line);
    paragraph.push(quote ? `<span class="md-quote">${inline(quote[1] ?? "", link)}</span>` : inline(line, link));
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join("\n"))}</code></pre>`);
  flushParagraph();
  closeList();
  closeCallout();
  return out.join("");
}
