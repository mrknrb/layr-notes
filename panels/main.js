// Notes: a list and a Markdown editor. Each note is a record in the `notes` collection:
//   { title: string, body: string, pinned: boolean }
// Every tab of this plugin hears `notes:changed` and refreshes, so two open tabs stay in step.
import { renderMarkdown, escapeHtml } from "../vendor/markdown.js";

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  search: $("search"),
  list: $("list"),
  count: $("count"),
  editor: $("editor"),
  placeholder: $("placeholder"),
  placeholderText: $("placeholderText"),
  title: $("title"),
  body: $("body"),
  preview: $("preview"),
  panes: $("panes"),
  pin: $("pin"),
  del: $("delete"),
  saveState: $("saveState"),
};

const PAGE = 100; // records per db.list call
const MAX_NOTES = 5000; // stop loading beyond this (a notes app, not a database)

/** @type {Map<string, {id: string, title: string, body: string, pinned: boolean, updatedAt: number}>} */
const notes = new Map();
let selected = null; // id
let mode = "split";
let dirty = false;
let saveTimer = null;
let saving = Promise.resolve();

// ---------- helpers ----------

function toMs(t) {
  if (t == null) return Date.now();
  if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(t);
  return Number.isNaN(n) ? Date.now() : n;
}

function fromRecord(r) {
  const v = r.value || {};
  return {
    id: r.id,
    title: typeof v.title === "string" ? v.title : "",
    body: typeof v.body === "string" ? v.body : "",
    pinned: !!v.pinned,
    updatedAt: toMs(r.updatedAt ?? r.createdAt),
  };
}

const valueOf = (n) => ({ title: n.title, body: n.body, pinned: n.pinned });

function displayTitle(n) {
  if (n.title.trim()) return n.title.trim();
  const line = n.body.split("\n").find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, "").trim().slice(0, 80) : "";
}

function formatDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" });
}

/** Lowercase, accents removed: "Árvíztűrő" matches "arvizturo". */
function fold(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function highlight(text, terms) {
  let html = escapeHtml(text);
  if (!terms.length) return html;
  // Highlight on the folded text, mapped back by position (folding keeps one char per char for most scripts).
  const folded = fold(text);
  if (folded.length !== text.length) return html;
  const marks = new Array(text.length).fill(false);
  for (const t of terms) {
    let at = folded.indexOf(t);
    while (at >= 0) {
      for (let k = at; k < at + t.length; k++) marks[k] = true;
      at = folded.indexOf(t, at + t.length);
    }
  }
  html = "";
  let open = false;
  for (let k = 0; k < text.length; k++) {
    if (marks[k] && !open) (html += "<mark>"), (open = true);
    if (!marks[k] && open) (html += "</mark>"), (open = false);
    html += escapeHtml(text[k]);
  }
  return open ? html + "</mark>" : html;
}

function snippetFor(n, terms) {
  const flat = n.body.replace(/\s+/g, " ").replace(/[#*_`>]/g, "").trim();
  if (!terms.length) return flat.slice(0, 120);
  const at = fold(flat).indexOf(terms[0]);
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 30);
  return (start > 0 ? "…" : "") + flat.slice(start, start + 120);
}

// ---------- loading ----------

async function loadAll() {
  notes.clear();
  let before;
  for (;;) {
    const rows = await layr.db.list("notes", { limit: PAGE, before });
    for (const r of rows) notes.set(r.id, fromRecord(r));
    if (rows.length < PAGE || notes.size >= MAX_NOTES) break;
    before = rows[rows.length - 1].id;
  }
}

async function reloadOne(id) {
  const r = await layr.db.get("notes", id);
  if (r) notes.set(id, fromRecord(r));
  else notes.delete(id);
}

// ---------- list ----------

function renderList() {
  const terms = fold(els.search.value).split(/\s+/).filter(Boolean);
  const all = [...notes.values()];
  const shown = all
    .filter((n) => {
      if (!terms.length) return true;
      const hay = fold(n.title + "\n" + n.body);
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));

  const parts = [];
  const pinned = shown.filter((n) => n.pinned);
  const rest = shown.filter((n) => !n.pinned);
  const item = (n) => {
    const title = displayTitle(n);
    return `<li data-id="${n.id}" role="option" aria-selected="${n.id === selected}"
      class="${n.id === selected ? "active" : ""}">
      <div class="note-row">
        ${n.pinned ? '<svg class="pin-mark" viewBox="0 0 24 24" width="12" height="12"><path d="M16 3v2h-1v6l3 3v2h-5v5l-1 1-1-1v-5H6v-2l3-3V5H8V3z" fill="currentColor"/></svg>' : ""}
        <span class="note-title ${title ? "" : "untitled"}">${title ? highlight(title, terms) : "Untitled"}</span>
        <span class="note-date">${formatDate(n.updatedAt)}</span>
      </div>
      <div class="note-snippet">${highlight(snippetFor(n, terms), terms) || "&nbsp;"}</div>
    </li>`;
  };
  if (pinned.length && rest.length) {
    parts.push('<li class="list-group">Pinned</li>', ...pinned.map(item), '<li class="list-group">Notes</li>');
    parts.push(...rest.map(item));
  } else parts.push(...shown.map(item));

  if (!shown.length) {
    parts.push(
      `<li class="list-group" style="text-transform:none;letter-spacing:0;font-weight:500">
        ${terms.length ? "No note matches." : "No notes yet."}</li>`
    );
  }
  els.list.innerHTML = parts.join("");
  const total = notes.size;
  els.count.textContent = terms.length
    ? `${shown.length} of ${total} notes`
    : `${total} note${total === 1 ? "" : "s"}${total >= MAX_NOTES ? " (showing the newest)" : ""}`;
}

// ---------- editor ----------

function showEditor(on) {
  els.editor.hidden = !on;
  els.placeholder.hidden = on;
  els.app.classList.toggle("editing", on);
}

function renderPreview() {
  const n = notes.get(selected);
  if (!n) return;
  const html = renderMarkdown(n.body);
  els.preview.innerHTML = html || '<p class="empty">Nothing to preview yet.</p>';
}

function setMode(m) {
  mode = m;
  els.panes.className = `panes mode-${m}`;
  for (const b of document.querySelectorAll(".seg .layr-button")) b.classList.toggle("active", b.dataset.mode === m);
  if (m !== "edit") renderPreview();
  rememberView();
}

function select(id, { focus } = {}) {
  flush();
  const n = id && notes.get(id);
  selected = n ? id : null;
  if (!n) {
    showEditor(false);
    els.placeholderText.textContent = notes.size ? "Pick a note, or make a new one." : "No notes yet.";
    layr.panel.setTitle("Notes").catch(() => {});
  } else {
    showEditor(true);
    els.title.value = n.title;
    els.body.value = n.body;
    els.pin.classList.toggle("active", n.pinned);
    els.pin.title = n.pinned ? "Unpin" : "Pin to the top";
    resetDelete();
    setSaveState("");
    if (mode !== "edit") renderPreview();
    layr.panel.setTitle(displayTitle(n) || "Untitled note").catch(() => {});
    if (focus === "title") els.title.focus();
    else if (focus === "body") els.body.focus();
  }
  renderList();
  rememberView();
}

function rememberView() {
  layr.panel.setState({ selected, mode, search: els.search.value }).catch(() => {});
}

function setSaveState(text) {
  els.saveState.textContent = text;
}

function scheduleSave() {
  dirty = true;
  setSaveState("Editing…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600);
}

/** Writes the selected note if it changed. */
function flush() {
  clearTimeout(saveTimer);
  if (!dirty || !selected) return saving;
  dirty = false;
  const n = notes.get(selected);
  if (!n) return saving;
  n.updatedAt = Date.now();
  const id = n.id;
  const value = valueOf(n);
  setSaveState("Saving…");
  saving = saving
    .then(() => layr.db.update("notes", id, value))
    .then(() => {
      if (selected === id && !dirty) setSaveState("Saved");
      return layr.events.emit("notes:changed", { id, from: layr.info.instance });
    })
    .catch((err) => {
      dirty = true;
      setSaveState("Not saved");
      layr.ui.notify(`Couldn't save the note: ${err.message}`, "error");
    });
  return saving;
}

async function createNote() {
  flush();
  try {
    const value = { title: "", body: "", pinned: false };
    const { id } = await layr.db.insert("notes", value);
    notes.set(id, { id, ...value, updatedAt: Date.now() });
    els.search.value = "";
    if (mode === "preview") mode = "split";
    select(id, { focus: "title" });
    setMode(mode);
    layr.events.emit("notes:changed", { id, from: layr.info.instance }).catch(() => {});
  } catch (err) {
    layr.ui.notify(`Couldn't make a note: ${err.message}`, "error");
  }
}

let deleteTimer = null;
function resetDelete() {
  clearTimeout(deleteTimer);
  els.del.classList.remove("confirm");
  els.del.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z" fill="currentColor"/></svg>';
}

async function deleteSelected() {
  if (!selected) return;
  if (!els.del.classList.contains("confirm")) {
    els.del.classList.add("confirm");
    els.del.textContent = "Delete?";
    deleteTimer = setTimeout(resetDelete, 3000);
    return;
  }
  const id = selected;
  dirty = false;
  try {
    await layr.db.delete("notes", id);
    notes.delete(id);
    select(null);
    layr.events.emit("notes:changed", { id, from: layr.info.instance, deleted: true }).catch(() => {});
    layr.ui.notify("Note deleted", "info").catch(() => {});
  } catch (err) {
    layr.ui.notify(`Couldn't delete it: ${err.message}`, "error");
  }
}

// ---------- wiring ----------

function wire() {
  els.list.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(li.dataset.id);
  });
  els.list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const ids = [...els.list.querySelectorAll("li[data-id]")].map((li) => li.dataset.id);
    const at = ids.indexOf(selected);
    const next = ids[e.key === "ArrowDown" ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next) select(next);
    e.preventDefault();
  });
  els.list.tabIndex = 0;

  let searchTimer;
  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderList();
      rememberView();
    }, 80);
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      els.search.value = "";
      renderList();
    } else if (e.key === "Enter") {
      const first = els.list.querySelector("li[data-id]");
      if (first) select(first.dataset.id, { focus: "body" });
    }
  });

  $("new").onclick = createNote;
  $("new2").onclick = createNote;
  $("back").onclick = () => select(null);

  els.title.addEventListener("input", () => {
    const n = notes.get(selected);
    if (!n) return;
    n.title = els.title.value;
    layr.panel.setTitle(displayTitle(n) || "Untitled note").catch(() => {});
    scheduleSave();
    renderListSoon();
  });
  els.title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      els.body.focus();
    }
  });

  let previewTimer;
  els.body.addEventListener("input", () => {
    const n = notes.get(selected);
    if (!n) return;
    n.body = els.body.value;
    scheduleSave();
    renderListSoon();
    clearTimeout(previewTimer);
    if (mode !== "edit") previewTimer = setTimeout(renderPreview, 120);
  });
  els.body.addEventListener("keydown", (e) => {
    // Tab indents instead of leaving the editor.
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      document.execCommand("insertText", false, "    ");
    }
  });
  els.body.addEventListener("blur", flush);
  els.title.addEventListener("blur", flush);

  for (const b of document.querySelectorAll(".seg .layr-button")) b.onclick = () => setMode(b.dataset.mode);

  els.pin.onclick = () => {
    const n = notes.get(selected);
    if (!n) return;
    n.pinned = !n.pinned;
    els.pin.classList.toggle("active", n.pinned);
    els.pin.title = n.pinned ? "Unpin" : "Pin to the top";
    dirty = true;
    flush();
    renderList();
  };
  els.del.onclick = deleteSelected;

  // Links in the preview open in a layr web page tab when the browser plugin is there, else outside.
  els.preview.addEventListener("click", async (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!/^https?:/i.test(href)) return;
    e.preventDefault();
    try {
      await layr.panels.open("page", { url: href }, { plugin: "browser", where: "right" });
    } catch {
      window.open(href, "_blank", "noopener");
    }
  });

  // Ctrl+Alt+N makes a note here (the shell's command would open a new Notes tab).
  document.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyN") {
      e.preventDefault();
      createNote();
    } else if (e.ctrlKey && !e.altKey && k === "s") {
      e.preventDefault(); // it saves by itself; just save now
      flush();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.code === "KeyF") {
      e.preventDefault();
      if (els.app.classList.contains("editing") && innerWidth <= 620) select(null);
      els.search.focus();
      els.search.select();
    }
  });

  window.addEventListener("pagehide", () => flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

let listTimer;
function renderListSoon() {
  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 250);
}

async function onChanged(data) {
  if (!data || data.from === layr.info.instance) return;
  if (data.id) {
    if (data.id === selected && dirty) return; // we have newer edits; ours will win
    await reloadOne(data.id);
    if (data.id === selected) {
      const n = notes.get(selected);
      if (!n) select(null);
      else if (document.activeElement !== els.body && document.activeElement !== els.title) select(selected);
    }
  } else {
    await loadAll();
  }
  renderList();
}

async function main() {
  try {
    await layr.ready;
  } catch (err) {
    els.placeholderText.textContent = err.message;
    $("new2").hidden = true;
    return;
  }
  wire();
  layr.events.on("notes:changed", (d) => onChanged(d).catch(() => {}));
  layr.events.on("notes:refresh", () => loadAll().then(renderList));

  const state = layr.info.state || {};
  const params = layr.info.params || {};
  mode = ["edit", "split", "preview"].includes(state.mode) ? state.mode : innerWidth < 620 ? "edit" : "split";
  els.search.value = state.search || "";
  setMode(mode);

  try {
    await loadAll();
  } catch (err) {
    layr.ui.notify(`Couldn't load notes: ${err.message}`, "error");
  }
  if (params.new && !state.selected) {
    await createNote();
    return;
  }
  const first = params.id || state.selected;
  select(first && notes.has(first) ? first : null);
}

main();
