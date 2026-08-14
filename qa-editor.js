import { getResumeProfiles } from "./profiles.js";
import {
  QA_FIELD_TYPES,
  fieldTypeLabel,
  normalizeFieldType,
  getAllQa,
  saveQa,
  deleteQa,
  clearQa,
  exportQa,
  importQa
} from "./qa-store.js";

const SHARED_ID = "";
const ALL_ID = "__all__";

const els = {
  status: document.getElementById("status"),
  filterProfile: document.getElementById("filterProfile"),
  filterType: document.getElementById("filterType"),
  searchInput: document.getElementById("searchInput"),
  countHint: document.getElementById("countHint"),
  formTitle: document.getElementById("formTitle"),
  formQuestion: document.getElementById("formQuestion"),
  formAnswer: document.getElementById("formAnswer"),
  formFieldType: document.getElementById("formFieldType"),
  formScope: document.getElementById("formScope"),
  saveBtn: document.getElementById("saveBtn"),
  cancelEditBtn: document.getElementById("cancelEditBtn"),
  qaList: document.getElementById("qaList"),
  exportBtn: document.getElementById("exportBtn"),
  importBtn: document.getElementById("importBtn"),
  importInput: document.getElementById("importInput"),
  clearBtn: document.getElementById("clearBtn"),
  closeBtn: document.getElementById("closeBtn")
};

/** @type {{ id: string, label: string }[]} */
let profiles = [];
/** @type {object[]} */
let allRows = [];
let editingId = null;

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.style.color = isError ? "#fca5a5" : "#93c5fd";
}

function urlProfileId() {
  return new URLSearchParams(location.search).get("profileId") || "";
}

function fillSelect(selectEl, options) {
  selectEl.innerHTML = "";
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    selectEl.appendChild(option);
  }
}

function profileLabel(id) {
  if (!id) return "Shared (all profiles)";
  return profiles.find((p) => p.id === id)?.label || id;
}

function initSelects() {
  fillSelect(els.filterType, [
    { value: "", label: "All types" },
    ...QA_FIELD_TYPES
  ]);
  fillSelect(els.formFieldType, QA_FIELD_TYPES);

  const profileOptions = [
    { value: ALL_ID, label: "All profiles + shared" },
    { value: SHARED_ID, label: "Shared (all profiles)" },
    ...profiles.map((p) => ({ value: p.id, label: p.label }))
  ];
  fillSelect(els.filterProfile, profileOptions);

  const scopeOptions = [
    ...profiles.map((p) => ({ value: p.id, label: p.label })),
    { value: SHARED_ID, label: "Shared (all profiles)" }
  ];
  fillSelect(els.formScope, scopeOptions);

  const preferred = urlProfileId();
  if (preferred && profiles.some((p) => p.id === preferred)) {
    els.filterProfile.value = preferred;
    els.formScope.value = preferred;
  } else if (profiles[0]) {
    els.filterProfile.value = profiles[0].id;
    els.formScope.value = profiles[0].id;
  }
}

function filterProfileId() {
  return els.filterProfile.value;
}

function rowsForView() {
  const view = filterProfileId();
  const type = String(els.filterType.value || "").trim();
  const q = String(els.searchInput.value || "").trim().toLowerCase();
  return allRows.filter((row) => {
    if (view !== ALL_ID && (row.profileId || "") !== view) return false;
    if (type && normalizeFieldType(row.fieldType) !== type) return false;
    if (q) {
      const hay = `${row.question || ""} ${row.answer || ""} ${row.site || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function resetForm() {
  editingId = null;
  els.formTitle.textContent = "Add Q&A";
  els.saveBtn.textContent = "Save Q&A";
  els.cancelEditBtn.hidden = true;
  els.formQuestion.value = "";
  els.formAnswer.value = "";
  els.formFieldType.value = "text";
  const view = filterProfileId();
  if (view && view !== ALL_ID) els.formScope.value = view;
}

function startEdit(row) {
  editingId = row.id;
  els.formTitle.textContent = "Edit Q&A";
  els.saveBtn.textContent = "Update Q&A";
  els.cancelEditBtn.hidden = false;
  els.formQuestion.value = row.question || "";
  els.formAnswer.value = row.answer || "";
  els.formFieldType.value = normalizeFieldType(row.fieldType);
  els.formScope.value = row.profileId || SHARED_ID;
  els.formQuestion.focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderList() {
  const rows = rowsForView();
  const view = filterProfileId();
  const viewLabel =
    view === ALL_ID ? "all profiles" : profileLabel(view);
  els.countHint.textContent = `${rows.length} shown · ${allRows.length} total · viewing ${viewLabel}`;

  els.qaList.innerHTML = "";
  if (!rows.length) {
    els.qaList.innerHTML =
      '<p class="hint" style="margin:0">No saved answers in this view. Add one above, or apply a few jobs with Learn mode on.</p>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "qa-item";
    if (row.id === editingId) item.classList.add("is-editing");

    const q = document.createElement("p");
    q.className = "qa-item-q";
    q.textContent = row.question;
    item.appendChild(q);

    const a = document.createElement("p");
    a.className = "qa-item-a-preview";
    a.textContent = row.answer;
    item.appendChild(a);

    const meta = document.createElement("div");
    meta.className = "qa-item-meta";

    const typeTag = document.createElement("span");
    typeTag.className = "qa-source-tag";
    typeTag.textContent = fieldTypeLabel(row.fieldType);
    meta.appendChild(typeTag);

    const src = document.createElement("span");
    src.className = `qa-source-tag ${row.source === "user" ? "qa-source-user" : "qa-source-ai"}`;
    src.textContent = row.source === "user" ? "manual" : "ai";
    meta.appendChild(src);

    const scope = document.createElement("span");
    scope.textContent = profileLabel(row.profileId || "");
    meta.appendChild(scope);

    const used = document.createElement("span");
    used.textContent = `used ${Number(row.timesUsed || 0)}×`;
    meta.appendChild(used);

    if (row.site) {
      const site = document.createElement("span");
      site.textContent = row.site;
      meta.appendChild(site);
    }

    const actions = document.createElement("div");
    actions.className = "qa-item-actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary compact";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => startEdit(row));
    actions.appendChild(edit);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary danger compact";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!window.confirm("Delete this Q&A?")) return;
      await deleteQa(row.id);
      if (editingId === row.id) resetForm();
      await reload();
      setStatus("Q&A deleted.");
    });
    actions.appendChild(del);

    meta.appendChild(actions);
    item.appendChild(meta);
    frag.appendChild(item);
  }
  els.qaList.appendChild(frag);
}

async function reload() {
  allRows = await getAllQa(null);
  renderList();
}

async function saveForm() {
  const question = String(els.formQuestion.value || "").trim();
  const answer = String(els.formAnswer.value || "").trim();
  if (!question || !answer) {
    setStatus("Enter both a question and an answer.", true);
    return;
  }

  const existing = editingId ? allRows.find((r) => r.id === editingId) : null;
  const saved = await saveQa({
    profileId: els.formScope.value || SHARED_ID,
    question,
    answer,
    fieldType: els.formFieldType.value || "text",
    source: "user",
    site: existing?.site || ""
  });

  if (editingId && saved?.id && saved.id !== editingId) {
    await deleteQa(editingId);
  }

  resetForm();
  await reload();
  setStatus(existing ? "Q&A updated." : "Q&A saved.");
}

async function exportShown() {
  try {
    const view = filterProfileId();
    const rows = view === ALL_ID ? await exportQa(null) : await exportQa(view);
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const suffix = view === ALL_ID ? "all" : view || "shared";
    a.download = `qa-bank-${suffix}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${rows.length} Q&A ${rows.length === 1 ? "entry" : "entries"}.`);
  } catch (err) {
    setStatus(`Export failed: ${String(err.message || err)}`, true);
  }
}

async function importFromFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const count = await importQa(parsed);
    await reload();
    setStatus(`Imported ${count} Q&A ${count === 1 ? "entry" : "entries"}.`);
  } catch (err) {
    setStatus(`Import failed: ${String(err.message || err)}`, true);
  }
}

async function clearShown() {
  const view = filterProfileId();
  const label = view === ALL_ID ? "ALL profiles (entire bank)" : profileLabel(view);
  const ok = window.confirm(`Delete every Q&A shown for ${label}? This cannot be undone.`);
  if (!ok) return;
  if (view === ALL_ID) {
    await clearQa(null);
  } else {
    await clearQa(view);
  }
  resetForm();
  await reload();
  setStatus("Cleared.");
}

els.filterProfile.addEventListener("change", () => {
  const view = filterProfileId();
  if (view && view !== ALL_ID) els.formScope.value = view;
  renderList();
});
els.filterType.addEventListener("change", renderList);
els.searchInput.addEventListener("input", renderList);
els.saveBtn.addEventListener("click", () => {
  saveForm().catch((err) => setStatus(String(err.message || err), true));
});
els.cancelEditBtn.addEventListener("click", resetForm);
els.exportBtn.addEventListener("click", () => {
  exportShown().catch((err) => setStatus(String(err.message || err), true));
});
els.importBtn.addEventListener("click", () => els.importInput.click());
els.importInput.addEventListener("change", () => {
  const file = els.importInput.files?.[0];
  importFromFile(file).finally(() => {
    els.importInput.value = "";
  });
});
els.clearBtn.addEventListener("click", () => {
  clearShown().catch((err) => setStatus(String(err.message || err), true));
});
els.closeBtn.addEventListener("click", () => window.close());

let reloadTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.qa_bank_version) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reload().catch(() => {});
    }, 200);
  }
});

(async () => {
  try {
    profiles = await getResumeProfiles();
    initSelects();
    await reload();
  } catch (err) {
    setStatus(`Could not load Q&A bank: ${String(err.message || err)}`, true);
  }
})();
