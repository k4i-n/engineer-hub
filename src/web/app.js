const token = document.querySelector('meta[name="hub-token"]').content;
const app = document.getElementById("app");
const toasts = document.querySelector(".toasts");
const UNDO = {
  "item-done": "item-reopen",
  "item-snooze": "item-reopen",
  "wait-close": "wait-reopen",
  "item-ignore": "item-unignore",
};
const LATER_TOAST = {
  "item-snooze": { "1h": "Snoozed for an hour", "4h": "Snoozed for 4 hours", tomorrow: "Snoozed until tomorrow" },
  "wait-pinged": { "1h": "Reminder in an hour", "4h": "Reminder in 4 hours", tomorrow: "Reminder tomorrow" },
  "draft-later": { "1h": "Send in an hour", "4h": "Send in 4 hours", tomorrow: "Send tomorrow" },
};
const DONE_TEXT = {
  backup: "Backed up",
  "item-done": "Done",
  "item-reopen": "Back in the list",
  "wait-close": "Answered",
  "wait-reopen": "Back in the list",
  "item-ignore": "Ignored",
  "item-unignore": "Shown again",
  "repo-unignore": "Shown again",
  sent: "Marked sent",
  match: "Saved",
  gate: "Answered",
};

let seen = null;
let selected = null;
let lastUndo = null;

function needKeys() {
  return new Set([...app.querySelectorAll(".needs-list > li[data-key]:not(.is-dim)")].map((li) => li.dataset.key));
}

function badge(count) {
  document.title =
    count > 0 ? `(${count}) ${document.title.replace(/^\(\d+\) /, "")}` : document.title.replace(/^\(\d+\) /, "");
  const svg =
    count > 0
      ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/><circle cx="23" cy="9" r="9" fill="#dc2626"/><text x="23" y="13" font-size="12" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${count > 9 ? "9+" : count}</text></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4f46e5"/></svg>`;
  document.querySelector('link[rel="icon"]').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function beep() {
  try {
    const audio = new AudioContext();
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

function announce(fresh) {
  if (fresh.length === 0) return;
  if (document.body.dataset.sound === "true") beep();
  if (document.body.dataset.notify !== "true" || !document.hidden || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  for (const li of fresh.slice(0, 3)) {
    const verb = li.querySelector(".verb")?.textContent ?? "";
    const title = li.querySelector(".need-title")?.textContent ?? "";
    const n = new Notification(`${verb} · hub`, { body: title, tag: li.dataset.key });
    n.onclick = () => window.focus();
  }
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
let inPlace = new Set();
let openNow = new Set();

function foldGroups() {
  const closed = new Set(stored("hub.closedGroups", []));
  for (const g of app.querySelectorAll("details.ngroup")) g.open = !closed.has(g.dataset.group);
}

function foldCleared() {
  const kept = new Set();
  for (const g of app.querySelectorAll("details.ngroup")) {
    const list = g.querySelector(":scope > ul.needs-list");
    const cleared = [...list.querySelectorAll(":scope > li.is-dim")].filter((li) => !inPlace.has(li.dataset.key));
    for (const li of list.querySelectorAll(":scope > li")) if (!cleared.includes(li)) kept.add(li.dataset.key);
    if (cleared.length === 0) continue;
    const fold = document.createElement("details");
    fold.className = "cleared";
    fold.dataset.key = `cleared-${g.dataset.group}`;
    fold.open = openNow.has(fold.dataset.key);
    fold.innerHTML = `<summary>Done & snoozed ${cleared.length}</summary><ul class="rows needs-list"></ul>`;
    fold.querySelector("ul").append(...cleared);
    g.append(fold);
  }
  inPlace = kept;
}

function foldToday() {
  const expanded = stored("hub.todayExpanded", false);
  for (const ul of app.querySelectorAll('[data-key="today"] ul, [data-key="today"] ol')) {
    const items = [...ul.children];
    if (items.length <= TODAY_SHOWN) continue;
    for (const li of items.slice(TODAY_SHOWN)) li.hidden = !expanded;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "more-btn";
    b.dataset.todayToggle = "";
    b.textContent = expanded ? "Show less" : `${items.length - TODAY_SHOWN} more`;
    ul.after(b);
  }
}

function afterRender(first) {
  applyTab();
  foldGroups();
  foldCleared();
  foldToday();
  const keys = needKeys();
  const section = app.querySelector("[data-needs-count]");
  badge(section ? Number(section.dataset.needsCount) : 0);
  if (seen !== null && !first) {
    const fresh = [...app.querySelectorAll(".needs-list > li[data-key]:not(.is-dim)")].filter(
      (li) => !seen.has(li.dataset.key),
    );
    for (const li of fresh) li.classList.add("fresh");
    announce(fresh);
  }
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
    openNow = open;
    const scroll = new Map(
      [...app.querySelectorAll("[data-keep-scroll][data-key]")].map((e) => [e.dataset.key, e.scrollTop]),
    );
    const box = app.querySelector("[data-search-box]");
    const query = box?.value ?? "";
    const boxFocused = document.activeElement === box;
    const caret = box?.selectionStart ?? null;
    const focusKey = document.activeElement?.closest?.("[data-key]")?.dataset.key;
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
    afterRender(false);
  } finally {
    busy = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

function toast(text, opts = {}) {
  const el = document.createElement("div");
  el.className = `toast${opts.bad ? " bad" : ""}`;
  el.textContent = text;
  if (opts.undo) {
    const b = document.createElement("button");
    b.textContent = "Undo";
    b.onclick = () => {
      el.remove();
      opts.undo();
    };
    el.append(b);
  }
  toasts.append(el);
  setTimeout(() => el.remove(), opts.bad ? 7000 : 5000);
}

function closeMenus(except) {
  for (const d of app.querySelectorAll("details.menu[open]")) if (d !== except) d.open = false;
}

const e = encodeURIComponent;
const later = (d) => (d.for ? { for: d.for } : {});
const ROUTES = {
  sent: (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/posted`, {}],
  "draft-later": (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/later`, later(d)],
  match: (d) => ["POST", `/tickets/${e(d.ticket)}/drafts/${e(d.label)}/match`, { answer: d.answer }],
  gate: (d) => ["POST", `/tickets/${e(d.ticket)}/gate`, { answer: d.answer }],
  pin: (d) => ["PUT", `/pins/${e(d.row)}`, { on: d.on === "1" }],
  "item-done": (d) => ["POST", `/items/${e(d.id)}/close`, {}],
  "item-snooze": (d) => ["POST", `/items/${e(d.id)}/snooze`, later(d)],
  "item-reopen": (d) => ["POST", `/items/${e(d.id)}/reopen`, {}],
  "item-ignore": (d) => ["POST", `/items/${e(d.id)}/ignore`, d.repo ? { repo: true } : {}],
  "item-unignore": (d) => ["POST", `/items/${e(d.id)}/unignore`, d.repo ? { repo: true } : {}],
  "repo-unignore": (d) => ["POST", "/ignores/unignore", { kind: d.kind, repo: d.repo }],
  "wait-close": (d) => ["POST", `/waits/${e(d.id)}/close`, {}],
  "wait-pinged": (d) => ["POST", `/waits/${e(d.id)}/pinged`, later(d)],
  "wait-reopen": (d) => ["POST", `/waits/${e(d.id)}/reopen`, {}],
  config: (d) => ["PUT", `/config/${e(d.key)}`, { value: JSON.parse(d.value) }],
  sync: () => ["POST", "/sync", {}],
  backup: () => ["POST", "/backups", {}],
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

async function act(button) {
  const data = { ...button.dataset };
  const name = data.act;
  closeMenus();
  button.classList.add("busy");
  try {
    await post(name, data);
    if (name === "sync") return;
    const undo = UNDO[name];
    lastUndo = undo ? () => post(undo, { id: data.id, repo: data.repo }).then(() => toast(DONE_TEXT[undo])) : null;
    const text =
      name === "pin" ? (data.on === "1" ? "Pinned" : "Unpinned") : (LATER_TOAST[name]?.[data.for] ?? DONE_TEXT[name]);
    toast(text ?? "Saved", {
      undo: lastUndo ?? undefined,
    });
  } catch (error) {
    toast(error.message, { bad: true });
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

let ticketTab = "ongoing";
try {
  ticketTab = localStorage.getItem("hub.ticketTab") ?? "ongoing";
} catch {}

function applyTab() {
  for (const b of app.querySelectorAll("[data-tab]")) {
    const on = b.dataset.tab === ticketTab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  }
  for (const ul of app.querySelectorAll("[data-tab-panel]")) ul.hidden = ul.dataset.tabPanel !== ticketTab;
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
    if (hit?.href) open(hit.getAttribute("href"), true);
  } else if (e.key === "Escape") {
    if (e.target.value !== "") {
      e.target.value = "";
      runSearch("");
    } else e.target.blur();
  }
}

function open(href, newTab) {
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

function selectFromHash() {
  const key = decodeURIComponent(location.hash.slice(1));
  if (!key.startsWith("item-")) return;
  const li = app.querySelector(`.needs-list > li[data-key="${CSS.escape(key)}"]`);
  if (!li) return;
  for (let d = li.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  hideResults();
  select(li);
}

window.addEventListener("hashchange", selectFromHash);
selectFromHash();

async function saveConfig(key, value, el) {
  try {
    await post("config", { key, value });
    if (key === "theme") {
      const theme = JSON.parse(value);
      if (theme === "system") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.dataset.theme = theme;
    }
    if (key === "notifyNew" || key === "notifySound")
      document.body.dataset[key === "notifyNew" ? "notify" : "sound"] = value;
    if (key === "notifyNew" && value === "true" && "Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch (error) {
    toast(error.message, { bad: true });
    if (el) el.classList.add("invalid");
  }
}

document.addEventListener("click", async (e) => {
  closeMenus(e.target.closest("details.menu"));
  if (!e.target.closest(".search")) hideResults();
  const b = e.target.closest("button");
  if (b?.dataset.todayToggle !== undefined) {
    store("hub.todayExpanded", !stored("hub.todayExpanded", false));
    refresh();
    return;
  }
  if (b?.dataset.tab) {
    ticketTab = b.dataset.tab;
    try {
      localStorage.setItem("hub.ticketTab", ticketTab);
    } catch {}
    applyTab();
    return;
  }
  if (b && !b.disabled) {
    if (b.dataset.open !== undefined) {
      closeMenus();
      open(b.dataset.open, true);
      return;
    }
    if (b.dataset.copy !== undefined) {
      closeMenus();
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Copied");
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
  if (ticket) open(ticket.dataset.href);
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
    toast(error.message, { bad: true });
    refresh();
  }
}

async function saveLayout() {
  try {
    await post("config", { key: "layout", value: JSON.stringify(layoutFromDom()) });
  } catch (error) {
    toast(error.message, { bad: true });
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

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-config-input]");
  if (!el) return;
  const value = el.dataset.json !== undefined ? el.value.trim() : JSON.stringify(el.value.trim());
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
  else if ((e.key === "Enter" || e.key === "o") && li) open(li.dataset.href, true);
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
setInterval(refresh, 60000);
afterRender(true);
