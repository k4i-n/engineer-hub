const token = document.querySelector('meta[name="hub-token"]').content;
const app = document.getElementById("app");
const toasts = document.querySelector(".toasts");
const newsBox = document.querySelector(".news");
const flip = (on) => (on === "1" ? "0" : "1");
const UNDO = {
  "item-done": (d) => ["item-reopen", d],
  "item-snooze": (d) => ["item-reopen", d],
  "wait-close": (d) => ["wait-reopen", d],
  "item-ignore": (d) => ["item-unignore", d],
  "item-unignore": (d) => ["item-ignore", d],
  "item-detach": (d) => ["item-attach", d],
  pin: (d) => ["pin", { ...d, on: flip(d.on) }],
  "source-set": (d) => ["source-set", { ...d, on: flip(d.on) }],
  "step-undo": (d) => ["step-done", d],
  "ticket-title": (d) => ["ticket-title", { ...d, value: d.askValue }],
  "step-edit": (d) => ["step-edit", { ...d, value: d.askValue }],
  "note-rename": (d) => ["note-rename", { ...d, title: d.value, value: d.askValue }],
  "draft-rename": (d) => ["draft-rename", { ...d, label: d.value, value: d.askValue }],
  "ticket-rename": (d) => ["ticket-rename", { ...d, ticket: d.value, value: d.askValue }],
  sent: (d) => ["draft-unsent", d],
  gate: (d) => ["gate-reopen", d],
  match: (d) =>
    d.answer === "yes"
      ? [
          ["draft-unsent", d],
          ["match-propose", d],
        ]
      : [["match-propose", d]],
  "wait-pinged": (d, r) => ["wait-unpinged", { ...d, pingAfter: r.before?.ping_after, pingedAt: r.before?.pinged_at }],
  "draft-later": (d, r) => ["draft-send-at", { ...d, sendAt: r.before?.send_at }],
};
let seen = null;
const unflashed = new Set();
let selected = null;
let lastUndo = null;

function needKeys() {
  return new Set([...app.querySelectorAll(".needs-list > li[data-key]:not(.is-dim)")].map((li) => li.dataset.key));
}

const MARK =
  '<rect width="32" height="32" rx="8" fill="#4f46e5"/><g transform="scale(1.333)" fill="none" stroke="#fff" stroke-width="1.8"><path d="M12 9.4V6.8M14.24 13.31l2.71 1.58M9.76 13.31l-2.71 1.58"/><circle cx="12" cy="12" r="2.6" fill="#fff"/><circle cx="12" cy="5" r="1.8"/><circle cx="18.5" cy="15.8" r="1.8"/><circle cx="5.5" cy="15.8" r="1.8"/></g>';

function badge(count) {
  document.title =
    count > 0 ? `(${count}) ${document.title.replace(/^\(\d+\) /, "")}` : document.title.replace(/^\(\d+\) /, "");
  const dot =
    count > 0
      ? `<circle cx="24" cy="8" r="8" fill="#dc2626"/><text x="24" y="12" font-size="11" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${count > 9 ? "9+" : count}</text>`
      : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${MARK}${dot}</svg>`;
  document.querySelector('link[rel="icon"]').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let audio = null;

function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {}
}

function beep() {
  if (audio === null || audio.state !== "running") return;
  try {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.25);
  } catch {}
}

function describe(li) {
  return {
    key: li.dataset.key,
    tone: li.className.match(/tone-\w+/)?.[0] ?? "tone-grey",
    what: li.querySelector(".verb")?.textContent || li.closest(".ngroup")?.querySelector(".g-label")?.textContent || "",
    title: li.querySelector(".need-title")?.textContent ?? "",
  };
}

function announce(fresh) {
  if (fresh.length === 0) return;
  if (document.body.dataset.sound === "true") beep();
  showNews(fresh.map(describe));
  if (document.body.dataset.notify !== "true" || !("Notification" in window)) return;
  if (!document.hidden && document.hasFocus()) return;
  if (Notification.permission !== "granted") return;
  for (const row of news.slice(0, NEWS_SHOWN)) {
    const n = new Notification(`${row.what} · EngineerHub`, { body: row.title, tag: row.key });
    n.onclick = () => {
      window.focus();
      openNews(row.key);
    };
  }
}

const NEWS_SHOWN = 3;
const NEWS_MS = 12000;
const news = [];
let newsTimer = null;

function showNews(rows) {
  for (const row of rows) {
    const at = news.findIndex((n) => n.key === row.key);
    if (at >= 0) news.splice(at, 1);
    news.unshift(row);
  }
  renderNews();
  armNews();
}

function renderNews() {
  newsBox.hidden = news.length === 0;
  newsBox.replaceChildren(
    ...news.slice(0, NEWS_SHOWN).map((row) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `news-row ${row.tone}`;
      b.dataset.newsKey = row.key;
      const what = document.createElement("span");
      what.className = "verb";
      what.textContent = row.what;
      const title = document.createElement("span");
      title.className = "news-title";
      title.textContent = row.title;
      b.append(what, title);
      return b;
    }),
  );
  if (news.length > NEWS_SHOWN) {
    const more = document.createElement("span");
    more.className = "news-more";
    more.textContent = `+${news.length - NEWS_SHOWN}`;
    newsBox.append(more);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "news-close";
  close.dataset.newsClose = "";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  newsBox.append(close);
}

function armNews() {
  clearTimeout(newsTimer);
  if (news.length === 0 || document.hidden || !document.hasFocus() || newsBox.matches(":hover")) return;
  newsTimer = setTimeout(clearNews, NEWS_MS);
}

function clearNews() {
  clearTimeout(newsTimer);
  news.length = 0;
  renderNews();
}

function openNews(key) {
  clearNews();
  const li = app.querySelector(`.needs-list > li[data-key="${CSS.escape(key)}"]`);
  if (li) reveal(li);
}

function flash() {
  if (document.hidden || !document.hasFocus()) return;
  for (const key of unflashed) app.querySelector(`[data-key="${CSS.escape(key)}"]`)?.classList.add("fresh");
  unflashed.clear();
}

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

const TODAY_SHOWN = 3;
const LEAVE_MS = 4000;
const leaving = new Map();

function foldGroups() {
  const closed = new Set(stored("hub.closedGroups", []));
  for (const g of app.querySelectorAll("details.ngroup")) g.open = !closed.has(g.dataset.group);
}

function sectionKey(key) {
  const page = location.pathname.split("/")[1] || "home";
  return `${page}:${key}`;
}

function setFold(b, folded) {
  b.setAttribute("aria-expanded", String(!folded));
  b.closest("section").classList.toggle("is-folded", folded);
}

function foldSections() {
  const closed = new Set(stored("hub.closedSections", []));
  for (const b of app.querySelectorAll("button[data-fold]")) setFold(b, closed.has(sectionKey(b.dataset.fold)));
}

function markCleared() {
  for (const li of app.querySelectorAll("details.ngroup > ul.needs-list > li.is-dim")) li.dataset.tabPanel = "all";
}

function shownKeys() {
  return new Set([...app.querySelectorAll("li[data-key]")].filter((li) => !li.hidden).map((li) => li.dataset.key));
}

function leave(key) {
  leaving.set(
    key,
    setTimeout(() => {
      leaving.delete(key);
      applyTab();
    }, LEAVE_MS),
  );
}

function stay(key) {
  clearTimeout(leaving.get(key));
  leaving.delete(key);
}

function foldToday() {
  const expanded = stored("hub.todayExpanded", false);
  const bar = app.querySelector('[data-tabs="today"]');
  const all = bar !== null && currentTab(bar) === "all";
  for (const b of app.querySelectorAll('[data-key="today"] .more-btn')) b.remove();
  for (const ul of app.querySelectorAll('[data-key="today"] ul, [data-key="today"] ol')) {
    const items = [...ul.children];
    const shown = items.filter((li) => all || !li.classList.contains("done"));
    for (const li of items) li.hidden = !shown.includes(li);
    if (shown.length <= TODAY_SHOWN) continue;
    for (const li of shown.slice(TODAY_SHOWN)) li.hidden = !expanded;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "more-btn";
    b.dataset.todayToggle = "";
    b.textContent = expanded ? "Show less" : `${shown.length - TODAY_SHOWN} more`;
    ul.after(b);
  }
}

function afterRender(first, shown) {
  foldGroups();
  foldSections();
  markCleared();
  applyTab(shown);
  foldToday();
  const keys = needKeys();
  const section = app.querySelector("[data-needs-count]");
  badge(section ? Number(section.dataset.needsCount) : 0);
  if (seen !== null && !first) {
    const fresh = [...app.querySelectorAll(".needs-list > li[data-key]:not(.is-dim)")].filter(
      (li) => !li.hidden && !seen.has(li.dataset.key),
    );
    for (const li of fresh) unflashed.add(li.dataset.key);
    announce(fresh);
  }
  flash();
  if (section) seen = keys;
  if (selected) app.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.classList.add("sel");
  tick();
}

let busy = false;
let again = false;
let dragging = null;
let refreshAfterDrag = false;

async function refresh() {
  if (dragging) {
    refreshAfterDrag = true;
    return;
  }
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  try {
    const r = await fetch(`${location.pathname}?part=1`, { cache: "no-store" });
    if (!r.ok) return;
    const html = await r.text();
    const open = new Set([...app.querySelectorAll("details[open][data-key]")].map((d) => d.dataset.key));
    const scroll = new Map(
      [...app.querySelectorAll("[data-keep-scroll][data-key]")].map((e) => [e.dataset.key, e.scrollTop]),
    );
    const box = app.querySelector("[data-search-box]");
    const query = box?.value ?? "";
    const boxFocused = document.activeElement === box;
    const caret = box?.selectionStart ?? null;
    const focusKey = document.activeElement?.closest?.("[data-key]")?.dataset.key;
    const shown = shownKeys();
    app.innerHTML = html;
    for (const d of app.querySelectorAll("details[data-key]")) if (open.has(d.dataset.key)) d.open = true;
    for (const e of app.querySelectorAll("[data-keep-scroll][data-key]")) e.scrollTop = scroll.get(e.dataset.key) ?? 0;
    const newBox = app.querySelector("[data-search-box]");
    if (newBox && query !== "") {
      newBox.value = query;
      if (boxFocused) {
        newBox.focus();
        if (caret !== null) newBox.setSelectionRange(caret, caret);
        showResults(lastResults);
        runSearch(query, true);
      }
    }
    if (focusKey && !boxFocused)
      app.querySelector(`[data-key="${CSS.escape(focusKey)}"] button`)?.focus({ preventScroll: true });
    afterRender(false, shown);
  } finally {
    busy = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

function fail(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  toasts.append(el);
  setTimeout(() => el.remove(), 7000);
}

function closeMenus(except) {
  for (const d of app.querySelectorAll("details.menu[open]")) if (d !== except) d.open = false;
}

const e = encodeURIComponent;
const later = (d) => (d.for ? { for: d.for } : {});
const ROUTES = {
  sent: (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/posted`, {}],
  "draft-unsent": (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/unposted`, {}],
  "draft-send-at": (d) => [
    "POST",
    `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/send-at`,
    { send_at: d.sendAt ?? undefined },
  ],
  "match-propose": (d) => [
    "POST",
    `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/match`,
    { sent_text: d.text, sent_ref: d.ref },
  ],
  "gate-reopen": (d) => ["POST", `/tickets/${e(d.ticket)}/gate/reopen`, {}],
  "item-attach": (d) => ["POST", `/items/${e(d.id)}/attach`, { ticket: d.ticket }],
  "step-done": (d) => ["POST", `/tickets/${e(d.ticket)}/steps/${e(d.n)}/done`, {}],
  "wait-unpinged": (d) => [
    "POST",
    `/waits/${e(d.id)}/unpinged`,
    { ping_after: d.pingAfter ?? undefined, pinged_at: d.pingedAt ?? undefined },
  ],
  "draft-later": (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/later`, later(d)],
  match: (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/match`, { answer: d.answer }],
  gate: (d) => ["POST", `/tickets/${e(d.ticket)}/gate`, { answer: d.answer }],
  pin: (d) => ["PUT", `/pins/${e(d.row)}`, { on: d.on === "1" }],
  "item-done": (d) => ["POST", `/items/${e(d.id)}/close`, {}],
  "item-snooze": (d) => ["POST", `/items/${e(d.id)}/snooze`, later(d)],
  "item-reopen": (d) => ["POST", `/items/${e(d.id)}/reopen`, {}],
  "item-ignore": (d) => ["POST", `/items/${e(d.id)}/ignore`, {}],
  "item-unignore": (d) => ["POST", `/items/${e(d.id)}/unignore`, {}],
  "wait-close": (d) => ["POST", `/waits/${e(d.id)}/close`, {}],
  "wait-pinged": (d) => ["POST", `/waits/${e(d.id)}/pinged`, later(d)],
  "wait-reopen": (d) => ["POST", `/waits/${e(d.id)}/reopen`, {}],
  config: (d) => ["PUT", `/config/${e(d.key)}`, { value: JSON.parse(d.value) }],
  "ticket-title": (d) => ["PATCH", `/tickets/${e(d.ticket)}`, { title: d.value }],
  "ticket-rename": (d) => ["POST", `/tickets/${e(d.ticket)}/rename`, { to: d.value }],
  "ticket-merge": (d) => ["POST", `/tickets/${e(d.ticket)}/merge`, { into: d.value }],
  "ticket-delete": (d) => ["POST", `/tickets/${e(d.ticket)}/delete`, {}],
  "step-edit": (d) => ["PATCH", `/tickets/${e(d.ticket)}/steps/${e(d.n)}`, { title: d.value }],
  "step-undo": (d) => ["POST", `/tickets/${e(d.ticket)}/steps/${e(d.n)}/undo`, {}],
  "step-remove": (d) => ["POST", `/tickets/${e(d.ticket)}/steps/${e(d.n)}/remove`, {}],
  "note-rename": (d) => ["POST", `/tickets/${e(d.ticket)}/notes/${e(d.title)}/rename`, { to: d.value }],
  "note-remove": (d) => ["POST", `/tickets/${e(d.ticket)}/notes/${e(d.title)}/remove`, {}],
  "draft-rename": (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/rename`, { to: d.value }],
  "draft-remove": (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/remove`, {}],
  "item-detach": (d) => ["POST", `/items/${e(d.id)}/detach`, {}],
  "source-set": (d) => ["PATCH", `/sources/${e(d.name)}`, { on: d.on === "1" }],
  "source-fetch": (d) => ["POST", "/fetch", { source: d.name }],
  "source-remove": (d) => ["POST", `/sources/${e(d.name)}/remove`, {}],
  sync: (d) => ["POST", "/sync", { what: d.what }],
  backup: () => ["POST", "/backups", {}],
  "away-test": () => ["POST", "/away/test", {}],
};

async function api(method, path, body) {
  const r = await fetch(`/api/v1${path}`, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${token}`,
      "x-hub-actor": "human",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `${r.status}`);
  return r;
}

function post(act, data) {
  const [method, path, body] = ROUTES[act](data);
  return api(method, path, body);
}

function undoSteps(name, data, result) {
  const make = UNDO[name];
  if (!make) return null;
  const out = make(data, result ?? {});
  return Array.isArray(out[0]) ? out : [out];
}

function keep(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function offerUndo(steps) {
  lastUndo = steps ? () => runUndo(steps) : null;
}

async function runUndo(steps) {
  try {
    for (const [name, data] of steps) await post(name, data);
    const data = steps[steps.length - 1][1];
    if (data.go !== undefined) location.href = data.go.replace("{value}", encodeURIComponent(data.value ?? ""));
  } catch (error) {
    fail(error.message);
  }
}

function pendingUndo() {
  try {
    const raw = sessionStorage.getItem("hub.undo");
    sessionStorage.removeItem("hub.undo");
    const steps = raw ? JSON.parse(raw) : null;
    if (steps) offerUndo(steps);
  } catch {}
}

async function act(button) {
  const data = { ...button.dataset };
  const name = data.act;
  closeMenus();
  if (data.ask !== undefined) {
    const value = prompt(data.ask, data.askValue ?? "")?.trim();
    if (!value || value === data.askValue) return;
    data.value = value;
  }
  if (data.confirm !== undefined && !confirm(data.confirm)) return;
  button.classList.add("busy");
  try {
    const r = await post(name, data);
    const result = await r.json().catch(() => ({}));
    const steps = undoSteps(name, data, result);
    if (data.go !== undefined) {
      if (steps) keep("hub.undo", steps);
      location.href = data.go.replace("{value}", encodeURIComponent(data.value ?? ""));
      return;
    }
    if (name !== "sync") offerUndo(steps);
  } catch (error) {
    fail(error.message);
  } finally {
    button.classList.remove("busy");
  }
}

function tick() {
  const sync = app.querySelector(".sync[data-started]");
  const b = sync?.querySelector(".sync-btn");
  if (!sync || !b) return;
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(sync.dataset.started)) / 1000));
  const label = `Syncing ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  b.title = label;
  b.setAttribute("aria-label", label);
}
setInterval(tick, 1000);

function currentTab(bar) {
  const buttons = [...bar.querySelectorAll("[data-tab]")];
  const saved = stored(`hub.tab.${bar.dataset.tabs}`, null);
  return buttons.some((b) => b.dataset.tab === saved) ? saved : buttons[0]?.dataset.tab;
}

function applyTab(shown = new Set()) {
  for (const bar of app.querySelectorAll("[data-tabs]")) {
    const buttons = [...bar.querySelectorAll("[data-tab]")];
    const current = currentTab(bar);
    for (const b of buttons) {
      const on = b.dataset.tab === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    for (const el of bar.closest("section")?.querySelectorAll("[data-tab-panel]") ?? []) {
      const key = el.dataset.key;
      const out = !el.dataset.tabPanel.split(" ").includes(current);
      if (!out) stay(key);
      else if (shown.has(key) && !leaving.has(key)) leave(key);
      const stays = out && leaving.has(key);
      el.hidden = out && !stays;
      el.classList.toggle("leaving", stays);
    }
  }
}

let lastResults = [];
let activeHit = 0;
let searchTimer = null;
let searchSeq = 0;

function withQuery(text, query) {
  if (/[\uE000\uE001]/.test(text)) return text;
  const words = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (words.length === 0) return text;
  return text.replace(new RegExp(`(${words.join("|")})`, "giu"), "\uE000$1\uE001");
}

function marked(text) {
  const out = document.createDocumentFragment();
  for (const [i, part] of text.split(/[\uE000\uE001]/).entries()) {
    if (part === "") continue;
    if (i % 2 === 1) {
      const m = document.createElement("mark");
      m.textContent = part;
      out.append(m);
    } else out.append(part);
  }
  return out;
}

function showResults(results) {
  const pop = app.querySelector(".search-pop");
  if (!pop) return;
  lastResults = results;
  activeHit = Math.min(activeHit, Math.max(results.length - 1, 0));
  pop.replaceChildren();
  if (results.length === 0) {
    const none = document.createElement("div");
    none.className = "hit-none";
    none.textContent = "No matches";
    pop.append(none);
  }
  results.forEach((r, i) => {
    const a = document.createElement("a");
    a.className = `hit${i === activeHit ? " on" : ""}`;
    a.setAttribute("role", "option");
    if (r.href) a.href = r.href;
    const kind = document.createElement("span");
    kind.className = "hit-kind";
    kind.textContent = r.kind;
    const main = document.createElement("span");
    main.className = "hit-main";
    const title = document.createElement("span");
    title.className = "hit-title";
    title.append(marked(withQuery(r.title, app.querySelector("[data-search-box]")?.value ?? "")));
    main.append(title);
    if (r.sub) {
      const sub = document.createElement("span");
      sub.className = "hit-sub";
      sub.append(marked(r.sub));
      main.append(sub);
    }
    const tid = document.createElement("span");
    tid.className = "hit-tid";
    tid.textContent = r.ticket ?? "";
    a.append(kind, main, tid);
    const row = document.createElement("div");
    row.className = "hit-row";
    row.append(a);
    if (r.out) {
      const out = document.createElement("a");
      out.className = "hit-out";
      out.href = r.out;
      out.target = "_blank";
      out.rel = "noreferrer";
      out.title = "Open in a new tab";
      out.textContent = "↗";
      row.append(out);
    }
    pop.append(row);
  });
  pop.hidden = false;
}

function hideResults() {
  const pop = app.querySelector(".search-pop");
  if (pop) pop.hidden = true;
}

async function runSearch(q, keepActive = false) {
  const seq = ++searchSeq;
  if (q.trim() === "") {
    lastResults = [];
    hideResults();
    return;
  }
  const r = await api("GET", `/find?q=${encodeURIComponent(q)}`).catch(() => null);
  if (!r || seq !== searchSeq) return;
  if (!keepActive) activeHit = 0;
  showResults(await r.json());
}

function searchKey(e) {
  const hits = [...app.querySelectorAll(".search-pop .hit")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (hits.length === 0) return;
    activeHit = (activeHit + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
    hits.forEach((h, i) => {
      h.classList.toggle("on", i === activeHit);
    });
    hits[activeHit].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hit = hits[activeHit];
    if (hit?.href) openHref(hit.getAttribute("href"), true);
  } else if (e.key === "Escape") {
    if (e.target.value !== "") {
      e.target.value = "";
      runSearch("");
    } else e.target.blur();
  }
}

function openHref(href, newTab) {
  if (!href) return;
  if (href.startsWith("/")) location.href = href;
  else if (/^https?:/.test(href) && newTab) window.open(href, "_blank", "noopener");
  else location.href = href;
}

function rows() {
  return [...app.querySelectorAll(".needs-list > li[data-key], .ticket-list > li[data-key]")].filter((li) =>
    li.checkVisibility(),
  );
}

function select(li) {
  for (const s of app.querySelectorAll(".sel")) s.classList.remove("sel");
  selected = li?.dataset.key ?? null;
  if (!li) return;
  li.classList.add("sel");
  li.scrollIntoView({ block: "nearest" });
}

function reveal(li) {
  for (let d = li.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  hideResults();
  select(li);
}

function selectFromHash() {
  const key = decodeURIComponent(location.hash.slice(1));
  if (!key.startsWith("item-")) return;
  const li = app.querySelector(`.needs-list > li[data-key="${CSS.escape(key)}"]`);
  if (li) reveal(li);
}

window.addEventListener("hashchange", selectFromHash);
selectFromHash();
pendingUndo();

async function saveConfig(key, value, el) {
  if (key === "notifyNew" && value === "true" && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
  try {
    await post("config", { key, value });
    if (key === "theme") {
      const theme = JSON.parse(value);
      if (theme === "system") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.dataset.theme = theme;
    }
    if (key === "notifyNew" || key === "notifySound")
      document.body.dataset[key === "notifyNew" ? "notify" : "sound"] = value;
  } catch (error) {
    fail(error.message);
    if (el) el.classList.add("invalid");
  }
}

document.addEventListener("pointerdown", unlockAudio);
document.addEventListener("keydown", unlockAudio);

document.addEventListener("click", async (e) => {
  closeMenus(e.target.closest("details.menu"));
  if (!e.target.closest(".search")) hideResults();
  const b = e.target.closest("button");
  if (b?.dataset.todayToggle !== undefined) {
    store("hub.todayExpanded", !stored("hub.todayExpanded", false));
    refresh();
    return;
  }
  if (b?.dataset.fold !== undefined) {
    const closed = new Set(stored("hub.closedSections", []));
    const key = sectionKey(b.dataset.fold);
    const folded = !closed.has(key);
    if (folded) closed.add(key);
    else closed.delete(key);
    store("hub.closedSections", [...closed]);
    setFold(b, folded);
    return;
  }
  if (b?.dataset.tab) {
    e.preventDefault();
    store(`hub.tab.${b.closest("[data-tabs]")?.dataset.tabs}`, b.dataset.tab);
    applyTab();
    foldToday();
    return;
  }
  if (b && !b.disabled) {
    if (b.dataset.open !== undefined) {
      closeMenus();
      openHref(b.dataset.open, true);
      return;
    }
    if (b.dataset.copy !== undefined) {
      closeMenus();
      await navigator.clipboard.writeText(b.dataset.copy);
      return;
    }
    if (b.dataset.config) {
      saveConfig(b.dataset.config, b.dataset.value, b);
      return;
    }
    if (b.dataset.move) {
      closeMenus();
      moveBlock(b.closest(".block"), b.dataset.move);
      return;
    }
    if (b.dataset.act) act(b);
    return;
  }
  if (e.target.closest("a, input, textarea, summary")) return;
  const ticket = e.target.closest(".ticket[data-href]");
  if (ticket) openHref(ticket.dataset.href);
});

function layoutFromDom() {
  const ids = (col) => [...app.querySelectorAll(`.col[data-col="${col}"] > .block`)].map((b) => b.dataset.block);
  return { top: ids("top"), left: ids("left"), right: ids("right") };
}

async function saveOrder(row) {
  const rows = [...row.parentElement.querySelectorAll(".ticket[draggable]")].filter(
    (r) => r.dataset.dir === row.dataset.dir,
  );
  try {
    await api("PUT", `/tickets/${encodeURIComponent(row.dataset.id)}/order`, { place: rows.indexOf(row) + 1 });
  } catch (error) {
    fail(error.message);
    refresh();
  }
}

async function saveLayout() {
  try {
    await post("config", { key: "layout", value: JSON.stringify(layoutFromDom()) });
  } catch (error) {
    fail(error.message);
    refresh();
  }
}

function moveBlock(block, dir) {
  if (!block) return;
  const col = block.parentElement;
  const column = app.querySelector(`.col[data-col="${dir}"]`);
  if (column) {
    if (dir === "top") column.append(block);
    else column.prepend(block);
  } else {
    const shown = [...col.children].filter((b) => !b.hidden);
    const target = shown[shown.indexOf(block) + (dir === "up" ? -1 : 1)];
    if (!target) return;
    if (dir === "up") target.before(block);
    else target.after(block);
  }
  block.scrollIntoView({ block: "nearest" });
  saveLayout();
}

function clearDrop() {
  for (const el of app.querySelectorAll(".drop-before, .drop-after, .drop-end"))
    el.classList.remove("drop-before", "drop-after", "drop-end");
}

function dropTarget(e) {
  if (dragging.matches(".ticket")) {
    const row = e.target.closest?.(".ticket[draggable]");
    if (!row || row === dragging || row.dataset.dir !== dragging.dataset.dir) return null;
    const r = row.getBoundingClientRect();
    return { el: row, place: e.clientY < r.top + r.height / 2 ? "before" : "after" };
  }
  const block = e.target.closest?.(".block");
  if (block && block !== dragging) {
    const r = block.getBoundingClientRect();
    return { el: block, place: e.clientY < r.top + r.height / 2 ? "before" : "after" };
  }
  const col = e.target.closest?.(".col[data-col]");
  if (col && !block) return { el: col, place: "end" };
  return null;
}

document.addEventListener("dragstart", (e) => {
  const grip = e.target.closest?.(".grip");
  const row = grip ? null : e.target.closest?.(".ticket[draggable]");
  if (!grip && !row) return;
  closeMenus();
  dragging = grip ? grip.closest(".block") : row;
  if (grip) document.body.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", grip ? dragging.dataset.block : dragging.dataset.id);
  e.dataTransfer.setDragImage(dragging, 24, 24);
  requestAnimationFrame(() => dragging?.classList.add("dragging"));
});

document.addEventListener("dragover", (e) => {
  if (!dragging) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  clearDrop();
  t.el.classList.add(`drop-${t.place}`);
});

document.addEventListener("drop", (e) => {
  if (!dragging) return;
  const t = dropTarget(e);
  clearDrop();
  if (!t) return;
  e.preventDefault();
  if (t.place === "end") t.el.append(dragging);
  else if (t.place === "before") t.el.before(dragging);
  else t.el.after(dragging);
  if (dragging.matches(".ticket")) saveOrder(dragging);
  else saveLayout();
});

document.addEventListener("dragend", () => {
  dragging?.classList.remove("dragging");
  dragging = null;
  document.body.classList.remove("is-dragging");
  clearDrop();
  if (refreshAfterDrag) {
    refreshAfterDrag = false;
    refresh();
  }
});

document.addEventListener(
  "toggle",
  (e) => {
    const g = e.target;
    if (!(g instanceof HTMLDetailsElement) || !g.classList.contains("ngroup")) return;
    const closed = new Set(stored("hub.closedGroups", []));
    if (g.open) closed.delete(g.dataset.group);
    else closed.add(g.dataset.group);
    store("hub.closedGroups", [...closed]);
  },
  true,
);

document.addEventListener("change", async (e) => {
  const el = e.target.closest("input[data-source]");
  if (!el) return;
  try {
    await api("PATCH", `/sources/${encodeURIComponent(el.dataset.source)}`, { [el.dataset.field]: el.value.trim() });
  } catch (error) {
    fail(error.message);
    el.classList.add("invalid");
  }
});

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-config-input]");
  if (!el) return;
  const text = el.value.trim();
  const list = () => JSON.stringify(text.split(/[\s,]+/).filter((v) => v !== ""));
  const value = el.dataset.json !== undefined ? text : el.dataset.list !== undefined ? list() : JSON.stringify(text);
  saveConfig(el.dataset.configInput, value, el);
});

document.addEventListener("input", (e) => {
  if (!e.target.matches("[data-search-box]")) return;
  clearTimeout(searchTimer);
  const q = e.target.value;
  searchTimer = setTimeout(() => runSearch(q), 120);
});

document.addEventListener("focusin", (e) => {
  if (e.target.matches?.("[data-search-box]") && e.target.value.trim() !== "") showResults(lastResults);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.matches?.("[data-search-box]")) {
    searchKey(e);
    return;
  }
  const typing = e.target.closest("input, textarea");
  if (typing) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const list = rows();
  const current = list.findIndex((li) => li.dataset.key === selected);
  const li = list[current];
  if (e.key === "j" || e.key === "ArrowDown") select(list[Math.min(current + 1, list.length - 1)] ?? list[0]);
  else if (e.key === "k" || e.key === "ArrowUp") select(list[Math.max(current - 1, 0)]);
  else if ((e.key === "Enter" || e.key === "o") && li) openHref(li.dataset.href, true);
  else if (["e", "s", "y", "n", "p"].includes(e.key) && li) {
    const b = li.querySelector(`button[data-hotkey="${e.key}"]:not(:disabled)`);
    if (b) act(b);
  } else if (e.key === "u") {
    const b = li?.querySelector('button[data-hotkey="u"]');
    if (b) act(b);
    else if (lastUndo) {
      lastUndo();
      lastUndo = null;
    }
  } else if (e.key === "/") {
    const box = app.querySelector("[data-search-box]");
    if (!box) return;
    box.focus();
    box.select();
  } else if (e.key === ",") location.href = location.pathname === "/settings" ? "/" : "/settings";
  else if (e.key === "Escape") {
    if (app.querySelector("details.menu[open]")) closeMenus();
    else if (location.pathname !== "/") location.href = "/";
    else select(null);
  } else return;
  e.preventDefault();
});

const events = new EventSource("/events");
events.addEventListener("change", refresh);
events.addEventListener("open", () => {
  document.body.classList.remove("offline");
  refresh();
});
events.addEventListener("error", () => document.body.classList.add("offline"));
function lookBack() {
  flash();
  armNews();
}

document.addEventListener("visibilitychange", lookBack);
window.addEventListener("focus", lookBack);
window.addEventListener("blur", armNews);
newsBox.addEventListener("mouseenter", () => clearTimeout(newsTimer));
newsBox.addEventListener("mouseleave", armNews);
newsBox.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.newsKey !== undefined) openNews(b.dataset.newsKey);
  else clearNews();
});
setInterval(refresh, 60000);
afterRender(true);
