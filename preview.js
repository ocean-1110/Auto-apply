import { getAllTemplates, DEFAULT_TEMPLATE_ID, resumeJsonToHtml } from "./templates/index.js";
import { buildCoverLetterHtml } from "./cover-letter-html.js";
import { formatAtsTooltip } from "./ats-score.js";
import { closeHostWindow } from "./close-host.js";
import {
  browseLastSavedJobDirectory,
  getLastSaveMeta,
  sanitizeJobFolderName,
  unlockOutputDirectory
} from "./fs-output.js";

const els = {
  templateSelect: document.getElementById("templateSelect"),
  refreshBtn: document.getElementById("refreshBtn"),
  saveBtn: document.getElementById("saveBtn"),
  openFolderBtn: document.getElementById("openFolderBtn"),
  applyBtn: document.getElementById("applyBtn"),
  closeBtn: document.getElementById("closeBtn"),
  tabResume: document.getElementById("tabResume"),
  tabCover: document.getElementById("tabCover"),
  emptyState: document.getElementById("emptyState"),
  genBanner: document.getElementById("genBanner"),
  pendingBanner: document.getElementById("pendingBanner"),
  atsPreviewBadge: document.getElementById("atsPreviewBadge"),
  atsPreviewValue: document.getElementById("atsPreviewValue"),
  atsPreviewDetail: document.getElementById("atsPreviewDetail"),
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
let atsReport = null;
let generating = false;
let previewMode = false;
let pendingSave = false;
let savedFolderName = "";
let busy = false;
let applyContext = {
  jobId: "",
  profileId: "",
  status: "",
  jobMeta: {}
};

function folderNameFromPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const last =
    s
      .split(/[/\\]/)
      .map((p) => p.trim())
      .filter(Boolean)
      .pop() || "";
  return sanitizeJobFolderName(last);
}

function setBtnLabel(btn, text) {
  const label = btn?.querySelector(".btn-label");
  if (label) label.textContent = text;
  else if (btn) btn.textContent = text;
}

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
  els.reviseStatus.style.color = error ? "var(--rose)" : "";
}

function renderAtsPreview() {
  if (!els.atsPreviewBadge || !els.atsPreviewValue) return;
  const score = Number(atsReport?.finalScore ?? atsReport?.score);
  if (!Number.isFinite(score) || score <= 0) {
    els.atsPreviewBadge.hidden = true;
    if (els.atsPreviewDetail) els.atsPreviewDetail.hidden = true;
    return;
  }
  els.atsPreviewBadge.hidden = false;
  els.atsPreviewBadge.classList.remove("is-high", "is-mid", "is-low");
  els.atsPreviewBadge.classList.add(score >= 85 ? "is-high" : score >= 75 ? "is-mid" : "is-low");
  els.atsPreviewValue.textContent = `${Math.round(score)}%`;
  const bits = [];
  if (Number.isFinite(Number(atsReport?.rawScore)) && Number(atsReport.rawScore) !== score) {
    bits.push(`GPT raw ${Math.round(Number(atsReport.rawScore))}%`);
  }
  if (atsReport?.keywordCoverage != null) bits.push(`Keywords ${atsReport.keywordCoverage}%`);
  if (atsReport?.skillsCoverage != null) bits.push(`Skills ${atsReport.skillsCoverage}%`);
  if (atsReport?.missing?.length) {
    bits.push(`Missing: ${atsReport.missing.slice(0, 4).join(", ")}`);
  } else if (atsReport?.rationale) {
    bits.push(String(atsReport.rationale).slice(0, 160));
  }
  if (els.atsPreviewDetail) {
    const detail = bits.join(" · ") || formatAtsTooltip(atsReport);
    els.atsPreviewDetail.textContent = detail;
    els.atsPreviewDetail.hidden = !detail;
  }
  els.atsPreviewBadge.title = formatAtsTooltip(atsReport) || "Final ATS score";
}

function updateChrome() {
  const hasResume = Boolean(resumeData && typeof resumeData === "object");
  // Revise + Save are available whenever a resume is on screen. With preview
  // mode off the PDFs are already saved, and saving again overwrites them in
  // place, so there is no reason to hide the tools.
  const showTools = hasResume;
  if (els.revisePanel) els.revisePanel.hidden = !showTools;
  if (els.pendingBanner) els.pendingBanner.hidden = !(previewMode && pendingSave && hasResume);
  if (els.saveBtn) {
    els.saveBtn.hidden = !hasResume;
    els.saveBtn.disabled = busy || generating || !hasResume;
    setBtnLabel(els.saveBtn, pendingSave ? "Save" : "Resave");
    els.saveBtn.title = pendingSave
      ? "Render PDFs and save to the output folder"
      : "Re-render the PDFs and overwrite the ones already saved for this job";
  }
  if (els.openFolderBtn) {
    els.openFolderBtn.hidden = !(hasResume && !pendingSave);
    els.openFolderBtn.disabled = busy || generating;
    els.openFolderBtn.title = savedFolderName
      ? `Open saved folder (${savedFolderName})`
      : "Open the saved resume folder";
  }
  if (els.applyBtn) {
    const hasJob = Boolean(applyContext.jobId);
    els.applyBtn.hidden = !(hasResume && hasJob);
    const status = String(applyContext.status || "");
    const inProgress = ["opening", "generating", "opening_form", "filling"].includes(status);
    if (status === "completed") {
      setBtnLabel(els.applyBtn, "Done");
      els.applyBtn.disabled = true;
      els.applyBtn.title = "Already applied";
    } else if (inProgress || generating || busy) {
      setBtnLabel(els.applyBtn, "Working");
      els.applyBtn.disabled = true;
      els.applyBtn.title = "Application in progress";
    } else {
      const canSubmit = status === "ready_for_review";
      const retry = ["failed", "needs_review", "check_failed"].includes(status);
      setBtnLabel(els.applyBtn, canSubmit ? "Submit" : retry ? "Retry" : "Apply");
      els.applyBtn.disabled = !applyContext.profileId;
      els.applyBtn.classList?.toggle?.("is-submit", canSubmit);
      els.applyBtn.title = canSubmit
        ? "Submit the filled application on the open form tab"
        : retry
          ? "Retry apply (same as the job card)"
          : "Apply to this job (same as Apply on the job card)";
    }
  }
  if (els.regenerateBtn) els.regenerateBtn.disabled = busy || generating || !hasResume;
  if (els.revisePrompt) els.revisePrompt.disabled = busy || generating;
  renderAtsPreview();
}

function render() {
  if (els.genBanner) els.genBanner.hidden = !generating;
  updateChrome();

  if (view === "cover") {
    els.tabCover.classList.add("is-active");
    els.tabResume.classList.remove("is-active");
    els.tabCover.setAttribute("aria-selected", "true");
    els.tabResume.setAttribute("aria-selected", "false");
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
  els.tabResume.setAttribute("aria-selected", "true");
  els.tabCover.setAttribute("aria-selected", "false");
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
    "last_ats_report",
    "selected_template_id",
    "last_job_title",
    "last_company_name",
    "last_jd_link",
    "last_jd_text",
    "generation_running",
    "preview_mode_enabled",
    "preview_pending_save",
    "preview_pending_meta",
    "imported_jobs_selected_id",
    "imported_jobs_by_id",
    "selected_profile_id",
    "last_output_dir"
  ]);
  generating = Boolean(stored.generation_running);
  previewMode = stored.preview_mode_enabled === true;
  pendingSave = stored.preview_pending_save === true;
  resumeData =
    stored.last_resume_json && typeof stored.last_resume_json === "object"
      ? stored.last_resume_json
      : null;
  coverText = String(stored.last_cover_letter_response || "");
  atsReport =
    stored.last_ats_report && typeof stored.last_ats_report === "object"
      ? stored.last_ats_report
      : null;
  const pending =
    stored.preview_pending_meta && typeof stored.preview_pending_meta === "object"
      ? stored.preview_pending_meta
      : {};
  const jobs = stored.imported_jobs_by_id && typeof stored.imported_jobs_by_id === "object"
    ? stored.imported_jobs_by_id
    : {};
  const jobId = String(pending.importedJobId || stored.imported_jobs_selected_id || "").trim();
  const job = jobId ? jobs[jobId] : null;
  applyContext = {
    jobId,
    profileId: String(pending.profileId || stored.selected_profile_id || "").trim(),
    status: String(job?.status || ""),
    jobMeta: {
      jobTitle: pending.jobTitle || job?.jobTitle || stored.last_job_title || "",
      companyName: pending.companyName || job?.companyName || stored.last_company_name || "",
      jdLink: pending.jdLink || job?.jdLink || stored.last_jd_link || "",
      jdText: String(pending.jdText || job?.jdText || stored.last_jd_text || "").trim(),
      templateId: pending.templateId || stored.selected_template_id || "",
      spreadsheetUrl: pending.spreadsheetUrl || "",
      sheetName: pending.sheetName || "",
      sheetsWebAppUrl: pending.sheetsWebAppUrl || "",
      workArrangement: pending.workArrangement || job?.workArrangement || "",
      employmentType: pending.employmentType || job?.employmentType || "",
      salaryMin: pending.salaryMin || job?.salaryMin || "",
      salaryMax: pending.salaryMax || job?.salaryMax || "",
      datePosted: pending.datePosted || job?.datePosted || "",
      trackApplicationStatus: pending.trackApplicationStatus === true,
      importedJobId: jobId
    }
  };
  jobMeta = {
    jobTitle: applyContext.jobMeta.jobTitle,
    companyName: applyContext.jobMeta.companyName
  };
  savedFolderName =
    folderNameFromPath(job?.resumeFolder || job?.folderName || "") ||
    folderNameFromPath(stored.last_output_dir || "");
  const hintParts = [jobMeta.jobTitle, jobMeta.companyName].filter(Boolean);
  const modeNote = previewMode
    ? "Preview mode on — edit with a prompt, then Save PDFs."
    : "Revise with a prompt, then Resave to overwrite the saved PDFs.";
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
    if (res.resume && typeof res.resume === "object") resumeData = res.resume;
    if (res.atsReport && typeof res.atsReport === "object") atsReport = res.atsReport;
    pendingSave = true;
    const score = Number(atsReport?.finalScore ?? atsReport?.score);
    const scoreNote = Number.isFinite(score) && score > 0 ? ` ATS ${Math.round(score)}%.` : "";
    setReviseStatus(
      (res.status || "Resume updated. Review the preview, then Save PDFs.") + scoreNote
    );
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
  // Unlock folder on this click — before the long SW render — so silent save works.
  const unlocked = await unlockOutputDirectory({ interactive: true });
  if (!unlocked.ok) {
    setReviseStatus(
      unlocked.error ||
        "Unlock the output folder first (open the extension panel and click Grant / Select folder).",
      { error: true }
    );
    return;
  }
  busy = true;
  updateChrome();
  setReviseStatus("Rendering and saving PDFs…");
  try {
    const templateId = els.templateSelect?.value || "";
    // #region agent log
    fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
      body: JSON.stringify({
        sessionId: "df7ed5",
        runId: "pre-fix",
        hypothesisId: "B",
        location: "preview.js:saveDocuments",
        message: "preview save clicked",
        data: { templateId, view, hasResume: Boolean(resumeData) },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    const res = await chrome.runtime.sendMessage({
      type: "preview_save_documents",
      templateId
    });
    if (!res?.ok) throw new Error(res?.error || "Save failed.");
    pendingSave = false;
    if (res.folderName) savedFolderName = folderNameFromPath(res.folderName);
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

async function openSavedFolder() {
  busy = true;
  updateChrome();
  setReviseStatus("Opening saved folder…");
  try {
    const meta = await getLastSaveMeta();
    const preferredFolder = savedFolderName || "";

    if (!preferredFolder && !meta) {
      throw new Error("Nothing saved yet. Save PDFs first.");
    }

    if (!preferredFolder && meta?.downloadId != null && meta.method === "downloads") {
      const res = await chrome.runtime.sendMessage({
        type: "open_saved_folder",
        meta
      });
      if (!res?.ok) throw new Error(res?.error || "Could not open folder.");
      setReviseStatus(`Opened folder: ${meta.pathLabel}`);
      return;
    }

    const result = await browseLastSavedJobDirectory(preferredFolder);
    if (result?.aborted) {
      setReviseStatus("Folder browser closed.");
      return;
    }
    const folderLabel = result?.folderName ? ` (${result.folderName})` : "";
    if (result?.method === "file-picker" && Array.isArray(result.files) && result.files.length) {
      setReviseStatus(`Opened ${result.files.join(", ")} from the saved folder${folderLabel}.`);
      return;
    }
    setReviseStatus(`Opened the saved folder${folderLabel}.`);
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setReviseStatus("Folder browser closed.");
      return;
    }
    setReviseStatus(String(err?.message || err), { error: true });
  } finally {
    busy = false;
    updateChrome();
  }
}

async function applyFromPreview() {
  if (!applyContext.jobId) {
    setReviseStatus("This preview is not tied to a job in the list.", { error: true });
    return;
  }
  if (!applyContext.profileId) {
    setReviseStatus("Select a profile in the extension panel first.", { error: true });
    return;
  }
  busy = true;
  updateChrome();
  const canSubmit = String(applyContext.status || "") === "ready_for_review";
  setReviseStatus(
    canSubmit
      ? "Submitting — clicking Submit on the application page…"
      : "Starting apply — same as the job card Apply button…"
  );
  try {
    if (canSubmit) {
      const res = await chrome.runtime.sendMessage({
        type: "autofill_current_page",
        profileId: applyContext.profileId,
        preferredAction: "submit",
        importedJobId: applyContext.jobId
      });
      if (!res?.ok) throw new Error(res?.error || "Submit failed.");
      setReviseStatus(res.status || "Submitted.");
      applyContext.status = res.submitted || /submit/i.test(String(res.status || ""))
        ? "completed"
        : applyContext.status;
      updateChrome();
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "apply_imported_job",
      importedJobId: applyContext.jobId,
      profileId: applyContext.profileId,
      jobMeta: applyContext.jobMeta
    });
    if (!res?.ok) throw new Error(res?.error || "Apply failed to start.");
    setReviseStatus("Apply started. Watch the job card / status for progress.");
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
els.saveBtn?.addEventListener("click", () => {
  saveDocuments().catch(() => {});
});
els.openFolderBtn?.addEventListener("click", () => {
  openSavedFolder().catch(() => {});
});
els.applyBtn?.addEventListener("click", () => {
  applyFromPreview().catch(() => {});
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
    changes.last_ats_report ||
    changes.selected_template_id ||
    changes.last_job_title ||
    changes.last_company_name ||
    changes.generation_running ||
    changes.preview_mode_enabled ||
    changes.preview_pending_save ||
    changes.preview_pending_meta ||
    changes.last_output_dir ||
    changes.imported_jobs_by_id ||
    changes.imported_jobs_selected_id ||
    changes.selected_profile_id
  ) {
    load().catch(() => {});
  }
});

load().catch((err) => {
  els.emptyState.hidden = false;
  els.emptyState.textContent = String(err?.message || err);
});
