const token = document.querySelector('meta[name="hub-token"]').content;
const app = document.getElementById("app");
const toasts = document.querySelector(".toasts");
const UNDO = { "item-done": "item-reopen", "item-snooze": "item-reopen", "wait-close": "wait-reopen" };
const DONE_TEXT = {
  "item-done": "Done",
  "item-snooze": "Snoozed for a day",
  "item-reopen": "Back in the list",
  "wait-close": "Answered",
  "wait-pinged": "Pinged, reminder in a day",
  "wait-reopen": "Back in the list",
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

function afterRender(first) {
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
async function refresh() {
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
    const filter = app.querySelector("[data-filter]");
    const filterValue = filter?.value ?? "";
    const filterFocused = document.activeElement === filter;
    const focusKey = document.activeElement?.closest?.("[data-key]")?.dataset.key;
    app.innerHTML = html;
    for (const d of app.querySelectorAll("details[data-key]")) if (open.has(d.dataset.key)) d.open = true;
    for (const e of app.querySelectorAll("[data-keep-scroll][data-key]")) e.scrollTop = scroll.get(e.dataset.key) ?? 0;
    const newFilter = app.querySelector("[data-filter]");
    if (newFilter) {
      newFilter.value = filterValue;
      applyFilter(newFilter);
      if (filterFocused) newFilter.focus();
    }
    if (focusKey && !filterFocused)
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

async function post(act, data) {
  const r = await fetch(`/api/${act}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-token": token },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error((await r.text()) || `${r.status}`);
  return r;
}

async function act(button) {
  const data = { ...button.dataset };
  const name = data.act;
  button.classList.add("busy");
  try {
    await post(name, data);
    if (name === "sync") return;
    const undo = UNDO[name];
    lastUndo = undo ? () => post(undo, { id: data.id }).then(() => toast(DONE_TEXT[undo])) : null;
    toast(DONE_TEXT[name] ?? "Saved", { undo: lastUndo ?? undefined });
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
  b.textContent = `Syncing ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(tick, 1000);

function applyFilter(input) {
  const q = input.value.trim().toLowerCase();
  for (const li of app.querySelectorAll(".ticket-list > li")) li.hidden = q !== "" && !li.dataset.search.includes(q);
}

function open(href, newTab) {
  if (!href) return;
  if (href.startsWith("/")) location.href = href;
  else if (/^https?:/.test(href) && newTab) window.open(href, "_blank", "noopener");
  else location.href = href;
}

function rows() {
  return [...app.querySelectorAll(".needs-list > li[data-key], .ticket-list > li[data-key]:not([hidden])")];
}

function select(li) {
  for (const s of app.querySelectorAll(".sel")) s.classList.remove("sel");
  selected = li?.dataset.key ?? null;
  if (!li) return;
  li.classList.add("sel");
  li.scrollIntoView({ block: "nearest" });
}

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
    toast("Saved");
  } catch (error) {
    toast(error.message, { bad: true });
    if (el) el.classList.add("invalid");
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (b && !b.disabled) {
    if (b.dataset.copy !== undefined) {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast("Copied");
      return;
    }
    if (b.dataset.config) {
      saveConfig(b.dataset.config, b.dataset.value, b);
      return;
    }
    if (b.dataset.act) act(b);
    return;
  }
  if (e.target.closest("a, input, textarea, summary")) return;
  const ticket = e.target.closest(".ticket[data-href]");
  if (ticket) open(ticket.dataset.href);
});

document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-config-input]");
  if (!el) return;
  const value = el.dataset.json !== undefined ? el.value.trim() : JSON.stringify(el.value.trim());
  saveConfig(el.dataset.configInput, value, el);
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-filter]")) applyFilter(e.target);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
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
  else if ((e.key === "e" || e.key === "s") && li) {
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
    const f = app.querySelector("[data-filter]");
    if (!f) return;
    f.focus();
  } else if (e.key === ",") location.href = "/settings";
  else if (e.key === "Escape") {
    if (location.pathname !== "/") location.href = "/";
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
