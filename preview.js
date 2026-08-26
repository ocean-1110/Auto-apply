import { getAllTemplates, DEFAULT_TEMPLATE_ID, resumeJsonToHtml } from "./templates/index.js";
import { buildCoverLetterHtml } from "./cover-letter-html.js";
import { closeHostWindow } from "./close-host.js";

const els = {
  templateSelect: document.getElementById("templateSelect"),
  refreshBtn: document.getElementById("refreshBtn"),
  printBtn: document.getElementById("printBtn"),
  saveBtn: document.getElementById("saveBtn"),
  closeBtn: document.getElementById("closeBtn"),
  tabResume: document.getElementById("tabResume"),
  tabCover: document.getElementById("tabCover"),
  emptyState: document.getElementById("emptyState"),
  genBanner: document.getElementById("genBanner"),
  pendingBanner: document.getElementById("pendingBanner"),
  revisePanel: document.getElementById("revisePanel"),
  revisePrompt: document.getElementById("revisePrompt"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  reviseStatus: document.getElementById("reviseStatus"),
  previewFrame: document.getElementById("previewFrame"),
  jobHint: document.getElementById("jobHint")
};

let view = "resume";
let resumeData = null;
let coverText = "";
let jobMeta = {};
let generating = false;
let previewMode = false;
let pendingSave = false;
let busy = false;

function fillTemplates(selectedId) {
  const templates = getAllTemplates();
  els.templateSelect.innerHTML = "";
  for (const t of templates) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.label;
    els.templateSelect.appendChild(opt);
  }
  const ids = new Set(templates.map((t) => t.id));
  els.templateSelect.value = ids.has(selectedId) ? selectedId : DEFAULT_TEMPLATE_ID;
}

function blankDoc(message) {
  return `<!doctype html><html><body style="font:15px/1.5 Outfit,Segoe UI,sans-serif;color:#5b6b86;padding:32px">${message}</body></html>`;
}

function setReviseStatus(text, { error = false } = {}) {
  if (!els.reviseStatus) return;
  const msg = String(text || "").trim();
  els.reviseStatus.hidden = !msg;
  els.reviseStatus.textContent = msg;
  els.reviseStatus.style.color = error ? "#9b2c2c" : "";
}

function updateChrome() {
  const hasResume = Boolean(resumeData && typeof resumeData === "object");
  const showTools = (previewMode || pendingSave) && hasResume;
  if (els.revisePanel) els.revisePanel.hidden = !showTools;
  if (els.pendingBanner) els.pendingBanner.hidden = !(previewMode && pendingSave && hasResume);
  if (els.saveBtn) {
    els.saveBtn.hidden = !((previewMode || pendingSave) && hasResume);
    els.saveBtn.disabled = busy || generating || !hasResume;
    els.saveBtn.textContent = pendingSave ? "Save PDFs" : "Save PDFs again";
  }
  if (els.regenerateBtn) els.regenerateBtn.disabled = busy || generating || !hasResume;
  if (els.revisePrompt) els.revisePrompt.disabled = busy || generating;
}

function render() {
  if (els.genBanner) {
    els.genBanner.hidden = !generating;
  }
  updateChrome();

  if (view === "cover") {
    els.tabCover.classList.add("is-active");
    els.tabResume.classList.remove("is-active");
    if (!String(coverText || "").trim()) {
      els.emptyState.hidden = false;
      els.emptyState.textContent =
        'No cover letter yet. Generate with "generate only resume" turned off, or Save will create one.';
      els.previewFrame.srcdoc = blankDoc("No cover letter generated for this job.");
      return;
    }
    els.emptyState.hidden = true;
    els.previewFrame.srcdoc = buildCoverLetterHtml(coverText, {
      name: resumeData?.name,
      headline: resumeData?.headline,
      location: resumeData?.location,
      email: resumeData?.email,
      phone: resumeData?.phone,
      linkedin: resumeData?.linkedin
    });
    return;
  }

  els.tabResume.classList.add("is-active");
  els.tabCover.classList.remove("is-active");
  if (!resumeData || typeof resumeData !== "object") {
    els.emptyState.hidden = false;
    els.emptyState.textContent = "No resume yet. Generate from the extension panel, then refresh.";
    els.previewFrame.srcdoc = blankDoc("Nothing to preview yet.");
    return;
  }
  els.emptyState.hidden = true;
  els.previewFrame.srcdoc = resumeJsonToHtml(resumeData, els.templateSelect.value);
}

async function load() {
  const stored = await chrome.storage.local.get([
    "last_resume_json",
    "last_cover_letter_response",
    "selected_template_id",
    "last_job_title",
    "last_company_name",
    "generation_running",
    "preview_mode_enabled",
    "preview_pending_save",
    "preview_pending_meta"
  ]);
  generating = Boolean(stored.generation_running);
  previewMode = stored.preview_mode_enabled === true;
  pendingSave = stored.preview_pending_save === true;
  resumeData =
    stored.last_resume_json && typeof stored.last_resume_json === "object"
      ? stored.last_resume_json
      : null;
  coverText = String(stored.last_cover_letter_response || "");
  const pendingMeta =
    stored.preview_pending_meta && typeof stored.preview_pending_meta === "object"
      ? stored.preview_pending_meta
      : {};
  jobMeta = {
    jobTitle: pendingMeta.jobTitle || stored.last_job_title || "",
    companyName: pendingMeta.companyName || stored.last_company_name || ""
  };
  const hintParts = [jobMeta.jobTitle, jobMeta.companyName].filter(Boolean);
  const modeNote = previewMode ? "Preview mode on — edit with a prompt, then Save PDFs." : "";
  els.jobHint.textContent = hintParts.length
    ? `${hintParts.join(" · ")}${modeNote ? ` · ${modeNote}` : ""}`
    : modeNote || "Switch templates to compare layouts without regenerating.";
  fillTemplates(stored.selected_template_id || DEFAULT_TEMPLATE_ID);
  render();
}

async function regenerateFromPrompt() {
  const prompt = String(els.revisePrompt?.value || "").trim();
  if (!prompt) {
    setReviseStatus("Enter instructions for how to update the resume.", { error: true });
    els.revisePrompt?.focus();
    return;
  }
  if (!resumeData) {
    setReviseStatus("No resume to update yet.", { error: true });
    return;
  }

  busy = true;
  updateChrome();
  setReviseStatus("Sending resume + JD + prompt to GPT…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "preview_regenerate_resume",
      prompt,
      templateId: els.templateSelect?.value || ""
    });
    if (!res?.ok) throw new Error(res?.error || "Regenerate failed.");
    if (res.resume && typeof res.resume === "object") {
      resumeData = res.resume;
    }
    pendingSave = true;
    setReviseStatus(res.status || "Resume updated. Review the preview, then Save PDFs.");
    view = "resume";
    render();
  } catch (err) {
    setReviseStatus(String(err?.message || err), { error: true });
  } finally {
    busy = false;
    updateChrome();
  }
}

async function saveDocuments() {
  if (!resumeData) {
    setReviseStatus("No resume to save.", { error: true });
    return;
  }
  busy = true;
  updateChrome();
  setReviseStatus("Rendering and saving PDFs…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "preview_save_documents",
      templateId: els.templateSelect?.value || ""
    });
    if (!res?.ok) throw new Error(res?.error || "Save failed.");
    pendingSave = false;
    if (typeof res.coverLetter === "string") coverText = res.coverLetter;
    setReviseStatus(res.status || "Saved to the output folder.");
    render();
  } catch (err) {
    setReviseStatus(String(err?.message || err), { error: true });
  } finally {
    busy = false;
    updateChrome();
  }
}

els.tabResume.addEventListener("click", () => {
  view = "resume";
  render();
});
els.tabCover.addEventListener("click", () => {
  view = "cover";
  render();
});
els.templateSelect.addEventListener("change", () => {
  chrome.storage.local.set({ selected_template_id: els.templateSelect.value }).catch(() => {});
  render();
});
els.refreshBtn.addEventListener("click", () => {
  load().catch(() => {});
});
els.printBtn.addEventListener("click", () => {
  els.previewFrame.contentWindow?.print();
});
els.saveBtn?.addEventListener("click", () => {
  saveDocuments().catch(() => {});
});
els.regenerateBtn?.addEventListener("click", () => {
  regenerateFromPrompt().catch(() => {});
});
els.closeBtn.addEventListener("click", () => closeHostWindow());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.last_resume_json ||
    changes.last_cover_letter_response ||
    changes.selected_template_id ||
    changes.last_job_title ||
    changes.last_company_name ||
    changes.generation_running ||
    changes.preview_mode_enabled ||
    changes.preview_pending_save ||
    changes.preview_pending_meta
  ) {
    load().catch(() => {});
  }
});

load().catch((err) => {
  els.emptyState.hidden = false;
  els.emptyState.textContent = String(err?.message || err);
});
