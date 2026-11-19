export type Link = (url: string, text: string) => string;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*\*([^*]+)\*\*/g;

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

export function renderMarkdown(text: string, link: Link, callout: string | null = null): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  let inCallout = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list !== null) out.push(`</${list}>`);
    list = null;
  };
  const openList = (kind: "ul" | "ol") => {
    if (list === kind) return;
    closeList();
    out.push(`<${kind}>`);
    list = kind;
  };
  const closeCallout = () => {
    if (inCallout) out.push("</div>");
    inCallout = false;
  };

  for (const line of text.split("\n")) {
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
    const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      flushParagraph();
      openList("ul");
      const done = task[1] !== " ";
      out.push(
        `<li class="md-task${done ? " done" : ""}"><span class="box">${done ? "✓" : ""}</span>${inline(task[2] ?? "", link)}</li>`,
      );
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      openList(bullet ? "ul" : "ol");
      out.push(`<li>${inline((bullet ?? numbered)?.[1] ?? "", link)}</li>`);
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
