import assert from "node:assert/strict";
import { test } from "node:test";
import { renderLine, renderMarkdown } from "../src/markdown.ts";

const link = (url: string, text: string) => `<a href="${url}">${text}</a>`;

test("headings, tasks, lists, inline code, bold and links render; the callout heading wraps its block", () => {
  const html = renderMarkdown(
    "# Plan\n\n## RESUME\nReview **#212** first\n\n## Today\n- [ ] review `web#212`\n- [x] ping Ken\n1. one\n\nsee https://github.com/acme/web/pull/212.",
    link,
    "RESUME",
  );
  assert.equal(
    html,
    '<h3>Plan</h3><div class="md-callout"><p>Review <strong>#212</strong> first</p></div><h4>Today</h4>' +
      '<ul><li class="md-task"><span class="box"></span>review <code>web#212</code></li>' +
      '<li class="md-task done"><span class="box">✓</span>ping Ken</li></ul><ol><li>one</li></ol>' +
      '<p>see <a href="https://github.com/acme/web/pull/212">https://github.com/acme/web/pull/212</a>.</p>',
  );
});

test("html in the text is escaped and only http links become links", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) "q"', link);
  assert.equal(html, "<p>&lt;img src=x onerror=alert(1)&gt; [x](javascript:alert(1)) &quot;q&quot;</p>");
});

test("a fenced block is kept as is", () => {
  assert.equal(renderMarkdown("```\n<b>x</b>\n- y\n```", link), "<pre><code>&lt;b&gt;x&lt;/b&gt;\n- y</code></pre>");
});

test("one line keeps inline markdown, shows a fenced block as inline code and drops block markers", () => {
  assert.equal(
    renderLine("## Pick **one**\n- run `make db`\n```sql\nselect 1\nfrom t\n```\nsee https://x.dev/a", link),
    'Pick <strong>one</strong> run <code>make db</code> <code>select 1 from t</code> see <a href="https://x.dev/a">https://x.dev/a</a>',
  );
});

test("one line cuts at the limit and escapes html", () => {
  assert.equal(renderLine("<b>abcdefghij</b>\n```\nx\n```", link, 10), "&lt;b&gt;abcd...");
});
