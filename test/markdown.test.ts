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

test("a table renders with alignment, escaped pipes, inline markdown in cells, short rows padded and long rows cut", () => {
  const html = renderMarkdown(
    "| Name | Count | Note |\n|:---|---:|:---:|\n| `a\\|b` | 2 | see [PR](https://x.dev/1) |\n| short |\n| x | y | z | extra |",
    link,
  );
  assert.equal(
    html,
    '<div class="md-table"><table><thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Count</th><th style="text-align:center">Note</th></tr></thead>' +
      '<tbody><tr><td style="text-align:left"><code>a|b</code></td><td style="text-align:right">2</td><td style="text-align:center">see <a href="https://x.dev/1">PR</a></td></tr>' +
      '<tr><td style="text-align:left">short</td><td style="text-align:right"></td><td style="text-align:center"></td></tr>' +
      '<tr><td style="text-align:left">x</td><td style="text-align:right">y</td><td style="text-align:center">z</td></tr></tbody></table></div>',
  );
});

test("a table ends at a blank line, needs a matching delimiter row and closes the paragraph before it", () => {
  assert.equal(
    renderMarkdown("Intro\na | b\n--- | ---\n1 | 2\n\nafter", link),
    '<p>Intro</p><div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div><p>after</p>',
  );
  assert.equal(renderMarkdown("a | b\n---", link), "<p>a | b<br>---</p>");
});

test("nested lists keep their levels", () => {
  assert.equal(
    renderMarkdown("- one\n  - one.a\n    1. deep\n  - one.b\n- two\n  - [x] done", link),
    "<ul><li>one<ul><li>one.a<ol><li>deep</li></ol></li><li>one.b</li></ul></li><li>two" +
      '<ul><li class="md-task done"><span class="box">✓</span>done</li></ul></li></ul>',
  );
});

test("italic and strikethrough render; underscores inside words and lone stars do not", () => {
  assert.equal(
    renderMarkdown("*a* and _b_ and ~~c~~ and **d**, snake_case_name, 2 * 3 * 4", link),
    "<p><em>a</em> and <em>b</em> and <s>c</s> and <strong>d</strong>, snake_case_name, 2 * 3 * 4</p>",
  );
});
