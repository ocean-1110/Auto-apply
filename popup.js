import {
  DEFAULT_PROFILE_ID,
  getResumeProfiles,
  deleteCustomProfile
} from "./profiles.js";
import { getAllTemplates, DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { extractSpreadsheetId, buildSheetRowTsv, updateJobStatusInSpreadsheet } from "./sheets.js";
import { formatAtsTooltip } from "./ats-score.js";
import { getPresetForProfile } from "./sheet-presets.js";
import {
  saveOutputDirectoryHandle,
  getOutputDirectoryName,
  flushPendingOutputToSelectedDirectory,
  getLastSaveMeta,
  browseLastSavedJobDirectory,
  readJobUploadDocsFromDirectory,
  sanitizeJobFolderName
} from "./fs-output.js";
import { isLinkedInSource, isDiceSource, isJobrightSource, parseImportedJobsCsvText } from "./csv-jobs.js";
import {
  AUTO_CAPTURE_ENABLED_KEY,
  LAST_CAPTURE_STATUS_KEY,
  buildCaptureSummary,
  normalizeJobLink
} from "./capture-jobs.js";
import { getQaCount } from "./qa-store.js";
import { appendApplicationEvent } from "./application-log.js";
import { getPendingQaCount } from "./pending-qa.js";
import { setGeneratedDocsForJob } from "./upload-assets.js";

const UI_MODE = new URLSearchParams(location.search).get("mode") === "sidebar" ? "sidebar" : "window";
document.body.classList.add(UI_MODE === "sidebar" ? "ui-sidebar" : "ui-window");
document.documentElement.classList.add(UI_MODE === "sidebar" ? "ui-sidebar" : "ui-window");
if (UI_MODE === "sidebar") {
  document.body.classList.add("ocean-in-panel");
  const rail = document.getElementById("sidebarActionRail");
  const actions = document.getElementById("primaryActions");
  if (rail && actions) {
    rail.hidden = false;
    rail.appendChild(actions);
  }
}

const statusEl = document.getElementById("status");
const atsScoreBadgeEl = document.getElementById("atsScoreBadge");
const atsScoreValueEl = document.getElementById("atsScoreValue");
const atsScoreTooltipEl = document.getElementById("atsScoreTooltip");
const profileSelectEl = document.getElementById("profileSelect");
const templateSelectEl = document.getElementById("templateSelect");
const deleteProfileBtn = document.getElementById("deleteProfile");
const openPreviewBtn = document.getElementById("openPreview");
const openDashboardBtn = document.getElementById("openDashboard");
const subpageOverlayEl = document.getElementById("subpageOverlay");
const subpageFrameEl = document.getElementById("subpageFrame");
const subpageTitleEl = document.getElementById("subpageTitle");
const subpageBackBtn = document.getElementById("subpageBackBtn");
const jobTitleEl = document.getElementById("jobTitle");
const companyNameEl = document.getElementById("companyName");
const jdLinkEl = document.getElementById("jdLink");
const jdTextEl = document.getElementById("jdText");
const outputDirLabelEl = document.getElementById("outputDirLabel");
const selectOutputDirBtn = document.getElementById("selectOutputDir");
const aiQaSectionEl = document.getElementById("aiQaSection");
const copySheetRowBtn = document.getElementById("copySheetRow");
const pasteJdBtn = document.getElementById("pasteJd");
const scrapePageBtn = document.getElementById("scrapePageBtn");
const resumeOnlyToggleEl = document.getElementById("resumeOnlyToggle");
const previewModeToggleEl = document.getElementById("previewModeToggle");
const sidebarModeToggleEl = document.getElementById("sidebarModeToggle");
const generateResumeBtn = document.getElementById("generateResume");
const autofillBtn = document.getElementById("autofillBtn");
const qaBankSectionEl = document.getElementById("qaBankSection");
const qaBankNoteEl = document.getElementById("qaBankNote");
const qaOpenEditorBtn = document.getElementById("qaOpenEditorBtn");
const qaLearnToggleEl = document.getElementById("qaLearnToggle");
const manualQuestionEl = document.getElementById("manualQuestion");
const manualAnswerEl = document.getElementById("manualAnswer");
const generateAiAnswerBtn = document.getElementById("generateAiAnswerBtn");
const copyAiAnswerBtn = document.getElementById("copyAiAnswerBtn");
const resetBtn = document.getElementById("reset");
const editProfileBtn = document.getElementById("editProfile");
const addProfileBtn = document.getElementById("addProfile");
const closePanelBtn = document.getElementById("closePanel");
const saveBannerEl = document.getElementById("saveBanner");
const saveBannerPathEl = document.getElementById("saveBannerPath");
const permBannerEl = document.getElementById("permBanner");
const permBannerPathEl = document.getElementById("permBannerPath");
const grantFolderAccessBtn = document.getElementById("grantFolderAccess");
const openSavedFolderBtn = document.getElementById("openSavedFolder");
const genProgressEl = document.getElementById("genProgress");
const genProgressStateEl = document.getElementById("genProgressState");
const genProgressDetailEl = document.getElementById("genProgressDetail");
const stopGenerateBtn = document.getElementById("stopGenerateBtn");

// Imported CSV jobs UI
const jobsSidebarEl = document.getElementById("jobsSidebar");
const modeManualBtn = document.getElementById("modeManual");
const modeImportedBtn = document.getElementById("modeImported");
const csvFileInputEl = document.getElementById("csvFileInput");
const importCsvBtn = document.getElementById("importCsvBtn");
const importStatusEl = document.getElementById("importStatus");
const autoCaptureToggleEl = document.getElementById("autoCaptureToggle");
const captureNowBtn = document.getElementById("captureNowBtn");
const captureStatusEl = document.getElementById("captureStatus");
const importedJobsListEl = document.getElementById("importedJobsList");
const jobsWorkStatusEl = document.getElementById("jobsWorkStatus");
const jobsWorkStateEl = document.getElementById("jobsWorkState");
const jobsWorkDetailEl = document.getElementById("jobsWorkDetail");
const filterAllJobsBtn = document.getElementById("filterAllJobs");
const filterDiceJobsBtn = document.getElementById("filterDiceJobs");
const filterJobrightJobsBtn = document.getElementById("filterJobrightJobs");
const filterLinkedInJobsBtn = document.getElementById("filterLinkedInJobs");
const filterOtherJobsBtn = document.getElementById("filterOtherJobs");
const selectAllJobsEl = document.getElementById("selectAllJobs");
const batchSelectionNoteEl = document.getElementById("batchSelectionNote");
const batchRemoveBtn = document.getElementById("batchRemoveBtn");
const checkAvailabilityBtn = document.getElementById("checkAvailabilityBtn");
const batchGenerateBtn = document.getElementById("batchGenerateBtn");
const batchApplyBtn = document.getElementById("batchApplyBtn");
const confirmModalEl = document.getElementById("confirmModal");
const confirmModalTitleEl = document.getElementById("confirmModalTitle");
const confirmModalMessageEl = document.getElementById("confirmModalMessage");
const confirmModalOkEl = document.getElementById("confirmModalOk");
const confirmModalCancelEl = document.getElementById("confirmModalCancel");
const sidebarImportEl = jobsSidebarEl?.querySelector(".sidebar-import") || null;

let confirmModalResolve = null;

let profilesCache = [];
let templatesCache = [];
let wasGenerationRunning = false;
/** True after Generate click until SW sets generation_running (avoids poll wiping the status UI). */
let generationStartPending = false;

// Extra job metadata captured by the page scraper (sheet history columns).
let scrapedJobMeta = null;

let awaitingFolderPermission = false;
let permissionRetryArmed = false;

let importedJobsById = {};
let importedJobsOrder = [];
let importedJobsSelectedId = null;
let importedJobsVersion = 0;
let importedJobsFilter = "all";
const importedJobsChecked = new Set();
let capturePollRunning = false;
let panelPollTimer = null;
let extensionContextDead = false;
let autofillLabelPollTick = 0;

function isExtensionContextValid() {
  try {
    return Boolean(chrome?.runtime?.id);
  } catch {
    return false;
  }
}

function isContextInvalidatedError(err) {
  const msg = String(err?.message || err || "");
  return /extension context invalidated/i.test(msg);
}

/** Stop background polls and tell the user to reopen after a Reload. */
function handleExtensionContextInvalidated() {
  if (extensionContextDead) return;
  extensionContextDead = true;
  if (panelPollTimer != null) {
    clearInterval(panelPollTimer);
    panelPollTimer = null;
  }
  try {
    setStatus(
      "Extension was reloaded. Close this panel and open it again (Alt+J).",
      "error"
    );
  } catch {
    /* UI may already be dead */
  }
}

function setStatus(message, kind = "") {
  const text = String(message || "").trim();
  statusEl.classList.remove("is-running", "is-done", "is-error");

  if (kind === "running") {
    statusEl.hidden = false;
    statusEl.textContent = text || "Working...";
    statusEl.classList.add("is-running");
    return;
  }

  // Actionable UI guidance must stay visible (validation used to look like a no-op).
  const looksLikeActionNeeded =
    /^(enter|paste|select|check|fill|open|click|choose|set|add|connect|unlock)\b/i.test(text) ||
    /\bfirst\b|\bbefore\b|\bcannot\b|\bneed(s)?\b|\bmust\b|\brequired\b/i.test(text);

  const looksLikeError =
    kind === "error" ||
    (/fail|error|could not|missing|invalid|canceled|cancelled/i.test(text) &&
      text &&
      !/^ready\.?$/i.test(text));

  if (looksLikeError || (text && looksLikeActionNeeded)) {
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.classList.add("is-error");
    return;
  }

  // Idle / Ready / Done / success chatter — hide; save banner + ATS color show outcome.
  statusEl.hidden = true;
  statusEl.textContent = "";
}

function renderAtsBadge(report) {
  if (!atsScoreBadgeEl || !atsScoreValueEl) return;
  const score = Number(report?.finalScore ?? report?.score);
  if (!Number.isFinite(score)) {
    atsScoreBadgeEl.hidden = true;
    return;
  }
  atsScoreBadgeEl.hidden = false;
  atsScoreValueEl.textContent = `${Math.round(score)}%`;
  atsScoreBadgeEl.title = "Final ATS score after generation/rewrite";
  atsScoreBadgeEl.classList.remove("is-high", "is-mid", "is-low");
  atsScoreBadgeEl.classList.add(score >= 85 ? "is-high" : score >= 75 ? "is-mid" : "is-low");
  if (atsScoreTooltipEl) atsScoreTooltipEl.textContent = formatAtsTooltip(report);
}

function renderAtsForCurrentJob(fallbackReport) {
  const job = importedJobsSelectedId ? importedJobsById[importedJobsSelectedId] : null;
  if (job?.atsReport || Number.isFinite(Number(job?.atsScore))) {
    renderAtsBadge(job.atsReport || { score: job.atsScore, finalScore: job.atsScore });
    return;
  }
  renderAtsBadge(fallbackReport);
}

async function refreshAtsBadge() {
  const data = await chrome.storage.local.get("last_ats_report");
  renderAtsForCurrentJob(data.last_ats_report);
}

async function getSheetSettings() {
  const data = await chrome.storage.local.get([
    "spreadsheet_url",
    "sheets_sheet_name",
    "sheets_web_app_url",
    "track_application_status"
  ]);
  return {
    spreadsheetUrl: String(data.spreadsheet_url || "").trim(),
    sheetName: String(data.sheets_sheet_name || "").trim(),
    sheetsWebAppUrl: String(data.sheets_web_app_url || "").trim(),
    trackApplicationStatus: Boolean(data.track_application_status)
  };
}

function sheetSettingsValidationError(settings) {
  const { spreadsheetUrl, sheetName, sheetsWebAppUrl } = settings;
  if (!spreadsheetUrl && !sheetsWebAppUrl && !sheetName) return "";
  if (!extractSpreadsheetId(spreadsheetUrl)) {
    return "Open Edit profile and enter a valid Google Spreadsheet link.";
  }
  if (!sheetsWebAppUrl) {
    return "Open Edit profile and paste the Apps Script Web App URL, or clear the spreadsheet link.";
  }
  if (!sheetName && !/[?#&]gid=\d+/i.test(spreadsheetUrl)) {
    return "Open Edit profile: use a sheet URL with gid=..., or enter the Sheet tab name.";
  }
  return "";
}

async function applySheetPresetForProfile(profileId) {
  const preset = await getPresetForProfile(profileId);
  if (!preset) return;
  await chrome.storage.local.set({
    spreadsheet_url: preset.spreadsheetUrl || "",
    sheets_sheet_name: preset.sheetName || "",
    sheets_web_app_url: preset.webAppUrl || "",
    track_application_status: Boolean(preset.trackApplicationStatus)
  });
}

function updateJobsWorkStatus({ running, statusText = "" } = {}) {
  if (!jobsWorkStatusEl) return;
  const text = String(statusText || "").trim();
  if (running) {
    jobsWorkStatusEl.hidden = false;
    if (jobsWorkStateEl) jobsWorkStateEl.textContent = "Working";
    if (jobsWorkDetailEl) jobsWorkDetailEl.textContent = text || "Working...";
    return;
  }
  jobsWorkStatusEl.hidden = true;
  if (jobsWorkStateEl) jobsWorkStateEl.textContent = "Working";
  if (jobsWorkDetailEl) jobsWorkDetailEl.textContent = "";
}

function updateGenerationProgress({ running, statusText, clearIdleStatus = false }) {
  if (!genProgressEl) return;

  const text = String(statusText || "").trim();
  if (stopGenerateBtn) stopGenerateBtn.hidden = !running;
  // Single progress surface: genProgress (with Stop). Keep the jobs-list banner in sync
  // only when genProgress is unavailable; otherwise they duplicate the same line.
  updateJobsWorkStatus({ running: false });

  if (running) {
    genProgressEl.hidden = false;
    genProgressEl.classList.remove("is-done", "is-error");
    if (genProgressStateEl) genProgressStateEl.textContent = "In progress";
    if (genProgressDetailEl) genProgressDetailEl.textContent = text || "Working...";
    // Do not also mirror into #status — that duplicated the same message.
    if (statusEl) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      statusEl.classList.remove("is-running", "is-done", "is-error");
    }
    return;
  }

  // Hide progress after the run finishes — save banner + ATS color carry the outcome.
  genProgressEl.hidden = true;
  genProgressEl.classList.remove("is-done", "is-error");
  if (stopGenerateBtn) stopGenerateBtn.hidden = true;

  if (/fail/i.test(text) || /\bcancel/i.test(text)) {
    setStatus(text, "error");
    return;
  }

  // Idle polls must not wipe validation / guidance messages.
  if (!clearIdleStatus) return;

  // Only clear a running-style line after a successful finish.
  if (!statusEl || statusEl.hidden || statusEl.classList.contains("is-error")) return;
  setStatus("", "done");
}

function populateTemplateSelect(selectedId) {
  templateSelectEl.innerHTML = "";
  for (const template of templatesCache) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.label;
    option.title = template.description || "";
    templateSelectEl.appendChild(option);
  }
  const validIds = new Set(templatesCache.map((t) => t.id));
  templateSelectEl.value = validIds.has(selectedId) ? selectedId : DEFAULT_TEMPLATE_ID;
}

function templateIdForProfile(profileId) {
  const profile = profilesCache.find((p) => p.id === profileId);
  return profile?.templateId || DEFAULT_TEMPLATE_ID;
}

function syncDeleteButton() {
  const selected = profilesCache.find((p) => p.id === profileSelectEl.value);
  const canDelete = Boolean(selected && !selected.builtin);
  deleteProfileBtn.hidden = !canDelete;
}

function populateProfileSelect(selectedId) {
  profileSelectEl.innerHTML = "";
  for (const profile of profilesCache) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.builtin ? profile.label : `${profile.label} (custom)`;
    profileSelectEl.appendChild(option);
  }
  const validIds = new Set(profilesCache.map((p) => p.id));
  profileSelectEl.value = validIds.has(selectedId) ? selectedId : DEFAULT_PROFILE_ID;
  syncDeleteButton();
}

async function refreshProfiles(selectedId) {
  profilesCache = await getResumeProfiles();
  const preferred =
    selectedId ||
    (await chrome.storage.local.get("selected_profile_id")).selected_profile_id ||
    DEFAULT_PROFILE_ID;
  populateProfileSelect(preferred);
}

async function saveSelectedTemplate(templateId) {
  await chrome.storage.local.set({ selected_template_id: templateId });
}

async function refreshTemplates(selectedId) {
  templatesCache = getAllTemplates();
  const preferred =
    selectedId ||
    (await chrome.storage.local.get("selected_template_id")).selected_template_id ||
    DEFAULT_TEMPLATE_ID;
  populateTemplateSelect(preferred);
}

async function saveSelectedProfile(profileId) {
  await chrome.storage.local.set({ selected_profile_id: profileId });
}

async function applyProfileTemplateDefault(profileId) {
  const templateId = templateIdForProfile(profileId);
  templateSelectEl.value = templateId;
  await saveSelectedTemplate(templateId);
}

async function persistJobFields() {
  await chrome.storage.local.set({
    last_job_title: jobTitleEl.value,
    last_company_name: companyNameEl.value,
    last_jd_link: jdLinkEl.value,
    last_jd_text: jdTextEl.value
  });
}

async function refreshOutputDirLabel() {
  const name = await getOutputDirectoryName();
  outputDirLabelEl.value = name || "";
  outputDirLabelEl.placeholder = name ? name : "No folder selected";
}

async function selectOutputDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus("Folder picker is not supported in this Chrome build.");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: "resume-bot-output",
      mode: "readwrite",
      startIn: "documents"
    });
    const name = await saveOutputDirectoryHandle(handle);
    outputDirLabelEl.value = name;
    setStatus(`Output folder set: ${name}`);
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setStatus("Folder selection canceled.");
      return;
    }
    setStatus(`Could not select folder: ${String(err.message || err)}`);
  }
}

function showSaveBanner(pathLabel) {
  if (!saveBannerEl || !saveBannerPathEl) return;
  saveBannerPathEl.textContent = pathLabel || "Files saved successfully.";
  saveBannerEl.hidden = false;
}

function hideSaveBanner() {
  if (saveBannerEl) saveBannerEl.hidden = true;
}

function resumeFolderNameForJob(job) {
  const raw = String(job?.resumeFolder || job?.folderName || "").trim();
  if (!raw) return "";
  const last = raw.split(/[/\\]/).map((p) => p.trim()).filter(Boolean).pop() || "";
  return sanitizeJobFolderName(last);
}

async function pathLabelForImportedJob(job) {
  const folder = resumeFolderNameForJob(job);
  if (!folder) return "";
  const root = (await getOutputDirectoryName()) || "";
  return root ? `${root} / ${folder}` : folder;
}

async function refreshSaveBannerForCurrentJob() {
  const job = importedJobsSelectedId ? importedJobsById[importedJobsSelectedId] : null;
  if (job) {
    const label = await pathLabelForImportedJob(job);
    if (label) {
      showSaveBanner(label);
    } else if (job.hasGeneratedResume || resumeFolderNameForJob(job) || Number(job.atsScore) > 0) {
      const folder = resumeFolderNameForJob(job);
      showSaveBanner(folder ? `Saved: ${folder}` : "Resume ready for this job");
    } else {
      hideSaveBanner();
    }
    renderAtsForCurrentJob(null);
    const score = jobFinalAtsScore(job);
    if (score != null) {
      const report =
        job.atsReport && typeof job.atsReport === "object"
          ? job.atsReport
          : { score, finalScore: score, source: "stored" };
      chrome.storage.local.set({ last_ats_report: report }).catch(() => {});
    }
    return;
  }
  const meta = await getLastSaveMeta();
  if (meta?.pathLabel) showSaveBanner(meta.pathLabel);
  else hideSaveBanner();
}

function wireAccordion(el, storageKey) {
  if (!el) return;
  el.addEventListener("toggle", () => {
    chrome.storage.local.set({ [storageKey]: el.open }).catch(() => {});
  });
}

function setSidebarMode(mode) {
  const sidebarImportHidden = mode !== "imported";
  if (sidebarImportEl) sidebarImportEl.hidden = sidebarImportHidden;
  if (importedJobsListEl) importedJobsListEl.hidden = sidebarImportHidden;

  if (modeManualBtn) modeManualBtn.classList.toggle("is-active", mode === "manual");
  if (modeImportedBtn) modeImportedBtn.classList.toggle("is-active", mode === "imported");
}

function displayImportedJobStatus(job) {
  const s = String(job?.status || "").trim();
  switch (s) {
    case "imported":
      return "Imported";
    case "opening":
      return "Opening URL";
    case "generating":
      return "Generating resume";
    case "generated":
      return "Resume ready";
    case "opening_form":
      return "Opening application form";
    case "filling":
      return "Filling form";
    case "ready_for_review":
      return "Ready for review";
    case "needs_review":
      return "Needs review";
    case "completed":
      return "Applied";
    case "unavailable":
      return "No longer available";
    case "check_failed":
      return "Check failed";
    case "failed":
      return "Failed";
    default:
      return s ? s : "—";
  }
}

function displayJobSource(job) {
  const source = String(job?.source || "").trim();
  if (!source) return "Other";
  if (isDiceSource(source)) return "Dice";
  if (isJobrightSource(source)) return "Jobright";
  if (isLinkedInSource(source)) return "LinkedIn";
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function jobFinalAtsScore(job) {
  const fromField = Number(job?.atsScore);
  if (Number.isFinite(fromField) && fromField > 0) return Math.round(fromField);
  const fromReport = Number(job?.atsReport?.finalScore ?? job?.atsReport?.score);
  if (Number.isFinite(fromReport) && fromReport > 0) return Math.round(fromReport);
  return null;
}

function shortError(job) {
  const d = String(job?.statusDetail || job?.error || "").trim();
  return d ? d.slice(0, 220) : "";
}

async function refreshImportedJobsFromStorage() {
  const data = await chrome.storage.local.get([
    "imported_jobs_by_id",
    "imported_jobs_order",
    "imported_jobs_selected_id",
    "imported_jobs_version",
    "imported_jobs_checked_ids"
  ]);
  importedJobsById = data.imported_jobs_by_id || {};
  importedJobsOrder = data.imported_jobs_order || [];
  importedJobsSelectedId = data.imported_jobs_selected_id || null;
  importedJobsVersion = Number(data.imported_jobs_version || 0);
  importedJobsChecked.clear();
  const storedChecked = data.imported_jobs_checked_ids;
  if (Array.isArray(storedChecked)) {
    for (const id of storedChecked) {
      if (importedJobsById[id]) importedJobsChecked.add(String(id));
    }
  } else {
    // First load / no preference yet — check every job by default.
    for (const id of importedJobsOrder) {
      const status = importedJobsById[id]?.status;
      if (status !== "unavailable" && status !== "completed") importedJobsChecked.add(String(id));
    }
    persistCheckedJobs();
  }
  let stripped = false;
  for (const id of [...importedJobsChecked]) {
    const status = importedJobsById[id]?.status;
    if (status === "completed" || status === "unavailable") {
      importedJobsChecked.delete(id);
      stripped = true;
    }
  }
  if (stripped) persistCheckedJobs();

  renderImportedJobs();
}

function setImportedJobsFilter(filter, { persist = true } = {}) {
  const allowed = ["all", "dice", "jobright", "linkedin", "others"];
  importedJobsFilter = allowed.includes(filter) ? filter : "all";
  filterAllJobsBtn?.classList.toggle("is-active", importedJobsFilter === "all");
  filterDiceJobsBtn?.classList.toggle("is-active", importedJobsFilter === "dice");
  filterJobrightJobsBtn?.classList.toggle("is-active", importedJobsFilter === "jobright");
  filterLinkedInJobsBtn?.classList.toggle("is-active", importedJobsFilter === "linkedin");
  filterOtherJobsBtn?.classList.toggle("is-active", importedJobsFilter === "others");
  if (persist) {
    chrome.storage.local.set({ imported_jobs_filter: importedJobsFilter }).catch(() => {});
  }
  renderImportedJobs();
}

function importedJobMatchesFilter(job) {
  const source = String(job?.source || "").trim().toLowerCase();
  if (importedJobsFilter === "dice") return isDiceSource(source);
  if (importedJobsFilter === "jobright") return isJobrightSource(source);
  if (importedJobsFilter === "linkedin") return isLinkedInSource(source);
  if (importedJobsFilter === "others") {
    return !isLinkedInSource(source) && !isDiceSource(source) && !isJobrightSource(source);
  }
  return true;
}

function formatCaptureStatus(status, running = false) {
  return buildCaptureSummary(status, { running });
}

async function refreshCaptureStatus() {
  if (!captureStatusEl) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "get_capture_status" });
    const data = await chrome.storage.local.get([AUTO_CAPTURE_ENABLED_KEY, LAST_CAPTURE_STATUS_KEY]);
    if (autoCaptureToggleEl) {
      autoCaptureToggleEl.checked = data[AUTO_CAPTURE_ENABLED_KEY] !== false;
    }
    captureStatusEl.textContent = formatCaptureStatus(
      res?.status || data[LAST_CAPTURE_STATUS_KEY] || null,
      Boolean(res?.running)
    );
  } catch {
    captureStatusEl.textContent = "Reload the extension panel after updating.";
  }
}

async function runJobCaptureNow() {
  if (captureNowBtn) captureNowBtn.disabled = true;
  if (captureStatusEl) captureStatusEl.textContent = "Capturing Dice + Jobright jobs…";
  setStatus("Running job capture…", "running");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "run_job_capture",
      trigger: "manual"
    });
    await refreshCaptureStatus();
    await refreshImportedJobsFromStorage();
    if (result?.added > 0) setSidebarMode("imported");
    const msg = result?.summary || formatCaptureStatus(result, false);
    const when = result?.at ? ` · ${new Date(result.at).toLocaleString()}` : "";
    setStatus(
      result?.ok ? `Capture complete: ${msg}${when}` : `Capture failed: ${result?.error || msg}`,
      result?.ok ? "done" : "error"
    );
    if (importStatusEl) importStatusEl.textContent = `${msg}${when}`;
    if (captureStatusEl) captureStatusEl.textContent = `${msg}${when}`;
  } catch (err) {
    const errMsg = String(err?.message || err);
    setStatus(`Capture failed: ${errMsg}`, "error");
    if (captureStatusEl) captureStatusEl.textContent = errMsg;
  } finally {
    if (captureNowBtn) captureNowBtn.disabled = false;
  }
}

function persistCheckedJobs() {
  chrome.storage.local
    .set({ imported_jobs_checked_ids: [...importedJobsChecked] })
    .catch(() => {});
}

function visibleImportedJobIds() {
  return importedJobsOrder.filter((jobId) => {
    const job = importedJobsById[jobId];
    return job && importedJobMatchesFilter(job);
  });
}

function batchableImportedJobIds() {
  return visibleImportedJobIds().filter((id) => {
    const status = String(importedJobsById[id]?.status || "");
    return status !== "completed" && status !== "unavailable";
  });
}

function jobReadyForBatchApply(job) {
  if (!job) return false;
  const status = String(job.status || "");
  if (status === "completed" || status === "unavailable") return false;
  if (["opening", "generating", "opening_form", "filling"].includes(status)) return false;
  // Need a job URL; resume will be generated during batch apply if missing.
  return Boolean(String(job.jdLink || job.url || "").trim());
}

function updateBatchBar() {
  const visible = batchableImportedJobIds();
  const selectedVisible = visible.filter((id) => importedJobsChecked.has(id));
  const applyReady = selectedVisible.filter((id) => jobReadyForBatchApply(importedJobsById[id]));
  if (batchSelectionNoteEl) {
    batchSelectionNoteEl.textContent = `${selectedVisible.length} selected`;
  }
  if (selectAllJobsEl) {
    selectAllJobsEl.checked = visible.length > 0 && selectedVisible.length === visible.length;
    selectAllJobsEl.indeterminate =
      selectedVisible.length > 0 && selectedVisible.length < visible.length;
  }
  if (batchGenerateBtn) {
    batchGenerateBtn.disabled = selectedVisible.length === 0;
  }
  if (batchApplyBtn) {
    batchApplyBtn.disabled = applyReady.length === 0;
  }
  if (batchRemoveBtn) {
    batchRemoveBtn.disabled = selectedVisible.length === 0;
  }
  if (checkAvailabilityBtn) {
    checkAvailabilityBtn.disabled = selectedVisible.length === 0;
  }
}

function renderImportedJobs() {
  if (!importedJobsListEl) return;
  importedJobsListEl.innerHTML = "";

  if (!importedJobsOrder.length) {
    importedJobsListEl.innerHTML =
      '<p class="import-status" style="margin:0">No pending jobs. Use Capture now, Import CSV, or wait for auto-capture.</p>';
    updateBatchBar();
    return;
  }

  const frag = document.createDocumentFragment();
  let visibleCount = 0;

  for (const jobId of importedJobsOrder) {
    const job = importedJobsById[jobId];
    if (!job || !importedJobMatchesFilter(job)) continue;
    visibleCount += 1;

    const card = document.createElement("details");
    card.className = "job-card";
    card.dataset.jobId = jobId;
    const isUnavailable = job.status === "unavailable";
    const isCheckFailed = job.status === "check_failed";
    const isApplyFailed = job.status === "failed";
    const isCompleted = job.status === "completed";
    if (isUnavailable) card.classList.add("is-unavailable");
    if (isCheckFailed) card.classList.add("is-check-failed");
    if (isApplyFailed) card.classList.add("is-failed");
    if (isCompleted) card.classList.add("is-applied");
    // Keep blocked/compact cards collapsed unless the user explicitly opens them.
    if (jobId === importedJobsSelectedId && !isUnavailable && !isCompleted) {
      card.open = true;
    }

    const summary = document.createElement("summary");
    summary.className = "job-summary";

    const title = document.createElement("span");
    title.className = "job-summary-title";
    title.textContent = String(job.jobTitle || jobId || "Untitled");
    summary.appendChild(title);

    const sub = document.createElement("div");
    sub.className = "job-summary-sub";
    const company = String(job.companyName || "").trim() || "Unknown company";
    const site = displayJobSource(job);
    const ats = jobFinalAtsScore(job);
    const subLeft = document.createElement("span");
    subLeft.className = "job-summary-sub-text";
    subLeft.textContent = `${company}  ·  ${site}`;
    subLeft.title = `${company} | ${site}`;
    sub.appendChild(subLeft);
    if (ats != null) {
      const atsChip = document.createElement("span");
      atsChip.className = "job-ats-chip";
      atsChip.classList.add(ats >= 85 ? "is-high" : ats >= 80 ? "is-mid" : "is-low");
      atsChip.textContent = `ATS ${ats}%`;
      atsChip.title = "Final ATS score after generation/rewrite";
      sub.appendChild(atsChip);
    }
    summary.appendChild(sub);

    const toolbar = document.createElement("div");
    toolbar.className = "job-summary-toolbar";

    const status = document.createElement("span");
    status.className = "job-summary-status";
    status.textContent = displayImportedJobStatus(job);
    toolbar.appendChild(status);

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "job-check";
    check.title = isCompleted ? "Already applied" : "Select for batch resume build";
    check.checked = !isCompleted && importedJobsChecked.has(jobId);
    check.disabled = isCompleted;
    check.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    check.addEventListener("change", (e) => {
      e.stopPropagation();
      if (check.checked) importedJobsChecked.add(jobId);
      else importedJobsChecked.delete(jobId);
      persistCheckedJobs();
      updateBatchBar();
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "job-remove";
    removeBtn.title = "Remove this job from the list";
    removeBtn.setAttribute("aria-label", "Remove job");
    removeBtn.innerHTML =
      '<svg class="job-remove-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path d="M9 3h6l1 2h4v2H4V5h4l1-2z" fill="currentColor" opacity="0.9"/>' +
      '<path d="M6 8h12l-.8 12.2A2 2 0 0 1 15.2 22H8.8a2 2 0 0 1-2-1.8L6 8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path d="M10 11v7M14 11v7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
      "</svg>";
    removeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await removeImportedJob(jobId);
    });

    const isInProgress = ["opening", "generating", "opening_form", "filling"].includes(String(job.status));
    removeBtn.disabled = false;

    if (isUnavailable) {
      const warnBadge = document.createElement("span");
      warnBadge.className = "job-unavailable-badge";
      warnBadge.textContent = "Unavailable — delete";
      warnBadge.title = String(job.statusDetail || "This job is no longer available");
      toolbar.appendChild(warnBadge);

      const unblockBtn = document.createElement("button");
      unblockBtn.type = "button";
      unblockBtn.className = "secondary job-summary-action";
      unblockBtn.textContent = "Unblock";
      unblockBtn.title = "Restore this job so you can apply again";
      unblockBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await unblockImportedJob(jobId);
      });
      toolbar.appendChild(unblockBtn);
      const markAppliedBtn = document.createElement("button");
      markAppliedBtn.type = "button";
      markAppliedBtn.className = "secondary job-summary-action";
      markAppliedBtn.textContent = "Applied";
      markAppliedBtn.title = "Mark as applied";
      markAppliedBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await markImportedJobCompleted(jobId);
      });
      toolbar.appendChild(markAppliedBtn);
      toolbar.appendChild(check);
      toolbar.appendChild(removeBtn);
      summary.appendChild(toolbar);

      card.appendChild(summary);
      frag.appendChild(card);
      continue;
    }

    const applySummaryBtn = document.createElement("button");
    applySummaryBtn.type = "button";
    applySummaryBtn.className = "job-summary-action";
    if (isCompleted) {
      applySummaryBtn.textContent = "Done";
      applySummaryBtn.disabled = true;
    } else if (isInProgress) {
      applySummaryBtn.textContent = "Working";
      applySummaryBtn.disabled = true;
    } else {
      applySummaryBtn.textContent = ["failed", "needs_review", "ready_for_review", "check_failed"].includes(
        String(job.status)
      )
        ? "Retry"
        : "Apply";
      applySummaryBtn.disabled = false;
      applySummaryBtn.title = "Apply (Alt+Enter when this job is selected)";
      applySummaryBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await applyImportedJob(jobId);
      });
    }

    toolbar.appendChild(applySummaryBtn);
    if (isCompleted) {
      const appliedBadge = document.createElement("span");
      appliedBadge.className = "job-applied-badge";
      appliedBadge.textContent = "Applied";
      appliedBadge.title = String(job.statusDetail || "Application submitted");
      toolbar.appendChild(appliedBadge);
    }
    if (isCheckFailed) {
      const warnBadge = document.createElement("span");
      warnBadge.className = "job-check-failed-badge";
      warnBadge.textContent = "Check failed";
      warnBadge.title = String(job.statusDetail || "Availability could not be verified — check later");
      toolbar.appendChild(warnBadge);
    }
    toolbar.appendChild(check);
    toolbar.appendChild(removeBtn);
    summary.appendChild(toolbar);

    card.appendChild(summary);

    const details = document.createElement("div");
    details.className = "job-card-details";

    const skills = document.createElement("p");
    skills.className = "job-meta";
    const skillsPreview = String(job.keySkills || "").trim().slice(0, 180);
    skills.textContent = skillsPreview
      ? `Key skills: ${skillsPreview}${String(job.keySkills || "").length > 180 ? "…" : ""}`
      : "";
    if (skills.textContent) details.appendChild(skills);

    const actions = document.createElement("div");
    actions.className = "job-actions";

    const seeBtn = document.createElement("button");
    seeBtn.type = "button";
    seeBtn.className = "job-action-icon";
    seeBtn.title = "See job — open the job page";
    seeBtn.setAttribute("aria-label", "See job");
    seeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3z"/><path fill="currentColor" d="M5 5h6v2H7v10h10v-4h2v6H5V5z"/></svg>';
    const jobUrl = String(job.jdLink || job.url || "").trim();
    seeBtn.disabled = !jobUrl;
    seeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await openImportedJobPage(jobId);
    });
    actions.appendChild(seeBtn);

    const completeBtn = document.createElement("button");
    completeBtn.type = "button";
    completeBtn.className = "job-action-icon is-success";
    completeBtn.title = "Mark as applied";
    completeBtn.setAttribute("aria-label", "Mark as applied");
    completeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8-8 1.4 1.4-9.4 9.4z"/></svg>';
    completeBtn.disabled = false;
    completeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await markImportedJobCompleted(jobId);
    });
    actions.appendChild(completeBtn);

    const blockBtn = document.createElement("button");
    blockBtn.type = "button";
    blockBtn.className = "job-action-icon is-danger";
    if (isUnavailable) {
      blockBtn.title = "Unblock — restore this job";
      blockBtn.setAttribute("aria-label", "Unblock");
      blockBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z"/></svg>';
      blockBtn.disabled = false;
      blockBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await unblockImportedJob(jobId);
      });
    } else {
      blockBtn.title = "Block — mark unavailable";
      blockBtn.setAttribute("aria-label", "Block");
      blockBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 0 1 6.3 12.9L7.1 5.7A7.96 7.96 0 0 1 12 4zM5.7 7.1 16.9 18.3A8 8 0 0 1 5.7 7.1z"/></svg>';
      blockBtn.disabled = false;
      blockBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await setImportedJobUnavailable(jobId, { detail: "Blocked by user." });
      });
    }
    actions.appendChild(blockBtn);

    details.appendChild(actions);

    const err = shortError(job);
    if ((job.status === "failed" || job.status === "check_failed") && err) {
      const errP = document.createElement("p");
      errP.className = job.status === "check_failed" ? "job-error is-warn" : "job-error";
      errP.textContent = err;
      details.appendChild(errP);
    }

    const openSelected = (event) => {
      event?.stopPropagation?.();
      importedJobsSelectedId = jobId;
      chrome.storage.local.set({ imported_jobs_selected_id: jobId }).catch(() => {});
      if (jobTitleEl) jobTitleEl.value = job.jobTitle || "";
      if (companyNameEl) companyNameEl.value = job.companyName || "";
      if (jdLinkEl) jdLinkEl.value = job.jdLink || "";
      if (jdTextEl) jdTextEl.value = job.jdText || "";
      persistJobFields().catch(() => {});
      refreshSaveBannerForCurrentJob().catch(() => {});
      renderAtsForCurrentJob(null);
    };

    summary.addEventListener("click", (e) => {
      // Allow the details element to open/close, but still copy values.
      // If the click was on a button (handled above), ignore.
      const target = e.target;
      if (target && target.tagName && ["button", "input"].includes(target.tagName.toLowerCase())) return;
      openSelected(e);
    });

    card.appendChild(details);
    frag.appendChild(card);
  }

  if (!visibleCount) {
    importedJobsListEl.innerHTML =
      '<p class="import-status" style="margin:0">No pending jobs match this filter.</p>';
    updateBatchBar();
    return;
  }

  importedJobsListEl.appendChild(frag);
  updateBatchBar();
  refreshSaveBannerForCurrentJob().catch(() => {});
}

async function removeImportedJob(jobId) {
  const job = importedJobsById[jobId];
  if (!job) return;
  const now = Date.now();
  const byId = { ...importedJobsById };
  delete byId[jobId];
  const order = importedJobsOrder.filter((id) => id !== jobId);
  importedJobsChecked.delete(jobId);
  if (importedJobsSelectedId === jobId) importedJobsSelectedId = null;

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: importedJobsSelectedId,
    imported_jobs_checked_ids: [...importedJobsChecked],
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsVersion = now;
  renderImportedJobs();
  setStatus(`Removed: ${job.jobTitle || jobId}`);
}

function closeConfirmModal(result = false) {
  if (!confirmModalEl) return;
  confirmModalEl.hidden = true;
  const resolve = confirmModalResolve;
  confirmModalResolve = null;
  if (resolve) resolve(Boolean(result));
}

function openConfirmModal({ title, message, confirmLabel = "Remove" } = {}) {
  if (!confirmModalEl) return Promise.resolve(false);
  if (confirmModalTitleEl) confirmModalTitleEl.textContent = title || "Confirm";
  if (confirmModalMessageEl) confirmModalMessageEl.textContent = message || "";
  if (confirmModalOkEl) confirmModalOkEl.textContent = confirmLabel;
  confirmModalEl.hidden = false;
  confirmModalOkEl?.focus();
  return new Promise((resolve) => {
    confirmModalResolve = resolve;
  });
}

async function removeSelectedImportedJobs() {
  const jobIds = visibleImportedJobIds().filter((id) => importedJobsChecked.has(id));
  if (!jobIds.length) {
    setStatus("Check one or more jobs, then click Remove selected.");
    return;
  }

  const count = jobIds.length;
  const confirmed = await openConfirmModal({
    title: "Remove selected jobs?",
    message:
      count === 1
        ? "Remove 1 selected job from the list? This cannot be undone."
        : `Remove ${count} selected jobs from the list? This cannot be undone.`,
    confirmLabel: count === 1 ? "Remove job" : `Remove ${count} jobs`
  });
  if (!confirmed) return;

  const removable = jobIds.filter((id) => Boolean(importedJobsById[id]));
  if (!removable.length) {
    setStatus("No matching jobs to remove.");
    return;
  }

  const now = Date.now();
  const removeSet = new Set(removable);
  const byId = { ...importedJobsById };
  for (const id of removable) {
    delete byId[id];
    importedJobsChecked.delete(id);
  }
  const order = importedJobsOrder.filter((id) => !removeSet.has(id));
  if (importedJobsSelectedId && removeSet.has(importedJobsSelectedId)) {
    importedJobsSelectedId = null;
  }

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: importedJobsSelectedId,
    imported_jobs_checked_ids: [...importedJobsChecked],
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsVersion = now;
  renderImportedJobs();
  setStatus(`Removed ${removable.length} job${removable.length === 1 ? "" : "s"} from the list.`);
}

async function batchGenerateSelectedJobs() {
  const jobIds = visibleImportedJobIds().filter((id) => importedJobsChecked.has(id));
  if (!jobIds.length) {
    setStatus("Check one or more jobs, then click Batch resume build.", "error");
    return;
  }

  const collected = await collectBatchGenerateSettings();
  if (!collected) return;

  const runnable = jobIds.filter((id) => {
    const job = importedJobsById[id];
    if (!job || job.status === "unavailable" || job.status === "completed") return false;
    // Need a JD to generate; closed-check still runs in SW when a URL exists.
    return Boolean(String(job.jdText || "").trim() || String(job.jdLink || job.url || "").trim());
  });
  if (!runnable.length) {
    setStatus("Selected jobs need a job URL or stored JD text.", "error");
    return;
  }

  generationStartPending = true;
  updateGenerationProgress({
    running: true,
    statusText: `Starting batch resume build for ${runnable.length} job(s)...`
  });
  setBusy(true);
  const res = await chrome.runtime.sendMessage({
    type: "batch_generate_jobs",
    profileId: collected.profileId,
    jobIds: runnable,
    jobMeta: collected.jobMeta
  });
  if (!res?.ok) {
    generationStartPending = false;
    wasGenerationRunning = false;
    updateGenerationProgress({
      running: false,
      statusText: `Batch resume build failed to start: ${String(res?.error || "unknown error")}`
    });
    setBusy(false);
  }
}

async function batchApplySelectedJobs() {
  const jobIds = visibleImportedJobIds().filter(
    (id) => importedJobsChecked.has(id) && jobReadyForBatchApply(importedJobsById[id])
  );
  if (!jobIds.length) {
    setStatus(
      "Check one or more jobs with a job URL, then click Batch Apply.",
      "error"
    );
    return;
  }

  const collected = await collectBatchGenerateSettings();
  if (!collected) return;

  const diceCount = jobIds.filter((id) => isDiceSource(importedJobsById[id]?.source)).length;
  generationStartPending = true;
  updateGenerationProgress({
    running: true,
    statusText: `Starting batch apply for ${jobIds.length} job(s)${
      diceCount ? ` (${diceCount} Dice)` : ""
    }...`
  });
  setBusy(true);

  const res = await chrome.runtime.sendMessage({
    type: "batch_apply_jobs",
    profileId: collected.profileId,
    jobIds,
    jobMeta: collected.jobMeta,
    pauseMs: 3000
  });
  if (!res?.ok) {
    generationStartPending = false;
    wasGenerationRunning = false;
    updateGenerationProgress({
      running: false,
      statusText: `Batch apply failed to start: ${String(res?.error || "unknown error")}`
    });
    setBusy(false);
  }
}

async function checkSelectedJobsAvailability() {
  const jobIds = visibleImportedJobIds().filter((id) => importedJobsChecked.has(id));
  if (!jobIds.length) {
    setStatus("Check one or more jobs, then click Check availability.", "error");
    return;
  }

  const runnable = jobIds.filter((id) => {
    const job = importedJobsById[id];
    if (!job) return false;
    const status = String(job.status || "");
    if (["opening", "generating", "opening_form", "filling", "completed"].includes(status)) return false;
    return Boolean(String(job.jdLink || job.url || "").trim());
  });
  if (!runnable.length) {
    setStatus("Selected jobs need a job URL (and must not be in progress).", "error");
    return;
  }

  generationStartPending = true;
  updateGenerationProgress({
    running: true,
    statusText: `Checking availability for ${runnable.length} job(s)...`
  });
  setBusy(true);

  try {
    const res = await chrome.runtime.sendMessage({
      type: "check_jobs_availability",
      jobIds: runnable
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to start availability check.");
    }
  } catch (err) {
    generationStartPending = false;
    wasGenerationRunning = false;
    updateGenerationProgress({
      running: false,
      statusText: `Availability check failed: ${String(err.message || err)}`
    });
    setBusy(false);
  }
}

async function replaceImportedJobs(jobs) {
  const now = Date.now();
  const byId = {};
  const order = [];
  const existingSet = new Set();
  let duplicateIds = 0;

  for (const job of jobs) {
    const id = String(job.id || "").trim();
    if (!id) continue;

    if (existingSet.has(id)) {
      duplicateIds += 1;
      continue;
    }
    existingSet.add(id);
    order.push(id);
    byId[id] = {
      ...job,
      status: "imported",
      attempts: 0,
      statusDetail: "",
      createdAt: now,
      updatedAt: now
    };
  }

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: null,
    imported_jobs_checked_ids: order.slice(),
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsSelectedId = null;
  importedJobsChecked.clear();
  for (const id of order) importedJobsChecked.add(id);
  importedJobsVersion = now;

  renderImportedJobs();

  return { imported: order.length, duplicateIds };
}

async function openImportedJobPage(jobId) {
  const job = importedJobsById[jobId];
  const url = String(job?.jdLink || job?.url || "").trim();
  if (!url) {
    setStatus("This job has no URL to open.");
    return;
  }

  // Reuse a tab already showing this job (so a later "Apply" won't reopen it).
  const target = normalizeJobLink(url).toLowerCase();
  let existing = null;
  try {
    const tabs = await chrome.tabs.query({});
    existing = tabs.find(
      (t) => t.url && normalizeJobLink(t.url).toLowerCase() === target
    );
  } catch {
    /* tabs query best-effort */
  }

  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true }).catch(() => {});
    if (existing.windowId != null) {
      chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    }
    setStatus(`Showing job tab: ${job.jobTitle || jobId}`);
  } else {
    await chrome.tabs.create({ url, active: true }).catch(() => {});
    setStatus(`Opened job: ${job.jobTitle || jobId}`);
  }

  importedJobsSelectedId = jobId;
  chrome.storage.local.set({ imported_jobs_selected_id: jobId }).catch(() => {});
}

async function applyImportedJob(jobId) {
  const job = importedJobsById[jobId];
  if (!job) {
    setStatus("Job not found in imported list.");
    return;
  }

  // Copy job data into the existing manual editor fields.
  jobTitleEl.value = job.jobTitle || "";
  companyNameEl.value = job.companyName || "";
  jdLinkEl.value = job.jdLink || "";
  jdTextEl.value = job.jdText || "";

  // Let the existing validator collect jobMeta + persist last_* fields.
  const collected = await collectJobMetaOrShowError();
  if (!collected) return;

  // Carry the CSV history columns into the sheet-append payload.
  collected.jobMeta.workArrangement = job.workArrangement || "";
  collected.jobMeta.employmentType = job.employmentType || "";
  collected.jobMeta.salaryMin = job.salaryMin || "";
  collected.jobMeta.salaryMax = job.salaryMax || "";
  collected.jobMeta.datePosted = job.datePosted || "";

  await chrome.storage.local.set({ imported_jobs_selected_id: jobId });
  setStatus(`Starting application: ${job.jobTitle || jobId}`);

  const res = await chrome.runtime.sendMessage({
    type: "apply_imported_job",
    importedJobId: jobId,
    profileId: collected.profileId,
    jobMeta: collected.jobMeta
  });

  if (!res?.ok) {
    setStatus(`Apply failed to start: ${String(res?.error || "unknown error")}`);
  }
}

async function patchImportedJobLocally(jobId, patch) {
  const now = Date.now();
  const data = await chrome.storage.local.get(["imported_jobs_by_id"]);
  const byId = data.imported_jobs_by_id || {};
  const job = byId[jobId];
  if (!job) return null;

  byId[jobId] = { ...job, ...patch, updatedAt: now };

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsVersion = now;
  renderImportedJobs();
  return byId[jobId];
}

async function markImportedJobCompleted(jobId) {
  const profileId = profileSelectEl?.value || "";
  const job = await patchImportedJobLocally(jobId, {
    status: "completed",
    statusDetail: "Completed by user.",
    completedAt: Date.now(),
    ...(profileId ? { profileId } : null)
  });
  importedJobsChecked.delete(jobId);
  persistCheckedJobs();
  if (!job) return;
  await appendApplicationEvent({
    profileId: job.profileId || profileId,
    importedJobId: jobId,
    jobTitle: job.jobTitle || "",
    companyName: job.companyName || "",
    jdLink: job.jdLink || job.url || "",
    status: "completed",
    source: job.source || "",
    detail: "Completed by user."
  });

  let sheetNote = "";
  const sheet = await getSheetSettings();
  if (sheet.trackApplicationStatus) {
    const jdLink = String(job.jdLink || job.url || "").trim();
    if (sheet.spreadsheetUrl && sheet.sheetsWebAppUrl && jdLink) {
      try {
        await updateJobStatusInSpreadsheet({
          spreadsheetUrl: sheet.spreadsheetUrl,
          webAppUrl: sheet.sheetsWebAppUrl,
          sheetName: sheet.sheetName,
          jdLink,
          applicationStatus: "Applied"
        });
        sheetNote = " Sheet status → Applied.";
      } catch (err) {
        sheetNote = ` Sheet status update failed: ${String(err?.message || err)}`;
      }
    }
  }

  setStatus(`Marked completed: ${job.jobTitle || jobId}.${sheetNote}`);
}

async function setImportedJobUnavailable(jobId, { detail = "Marked no longer available." } = {}) {
  if (importedJobsSelectedId === jobId) {
    importedJobsSelectedId = null;
    await chrome.storage.local.set({ imported_jobs_selected_id: null });
  }
  const job = await patchImportedJobLocally(jobId, {
    status: "unavailable",
    statusDetail: detail
  });
  if (job) setStatus(`Blocked: ${job.jobTitle || jobId}`);
}

async function unblockImportedJob(jobId) {
  const job = await patchImportedJobLocally(jobId, {
    status: "imported",
    statusDetail: ""
  });
  if (job) setStatus(`Unblocked: ${job.jobTitle || jobId}`);
}

async function refreshSaveBannerFromStorage() {
  await refreshSaveBannerForCurrentJob();
}

async function openSavedFolder() {
  setStatus("Opening saved folder in File Explorer...", "running");
  try {
    const selectedJob = importedJobsSelectedId ? importedJobsById[importedJobsSelectedId] : null;
    const selectedFolder = resumeFolderNameForJob(selectedJob);
    const meta = await getLastSaveMeta();
    if (!selectedFolder && !meta) {
      setStatus("Nothing saved yet.", "error");
      return;
    }

    // Prefer Explorer reveal via chrome.downloads.show when we already have an id.
    if (!selectedFolder && meta?.downloadId != null && meta.method === "downloads") {
      const res = await chrome.runtime.sendMessage({
        type: "open_saved_folder",
        meta
      });
      if (!res?.ok) {
        throw new Error(res?.error || "Could not open folder.");
      }
      setStatus(`Opened folder: ${meta.pathLabel}`, "done");
      return;
    }

    // FS saves: open a dialog rooted at the selected job folder (no re-download).
    const result = await browseLastSavedJobDirectory(selectedFolder);
    if (result?.aborted) {
      setStatus("Folder browser closed.");
      return;
    }
    const folderLabel = result?.folderName ? ` (${result.folderName})` : "";
    if (result?.method === "file-picker" && Array.isArray(result.files) && result.files.length) {
      setStatus(`Opened ${result.files.join(", ")} from the saved folder${folderLabel}.`, "done");
      return;
    }
    setStatus(`Opened the saved folder${folderLabel}.`, "done");
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setStatus("Folder browser closed.");
      return;
    }
    setStatus(`Open folder failed: ${String(err.message || err)}`, "error");
  }
}

function showPermissionBanner(folderName) {
  if (!permBannerEl) return;
  if (permBannerPathEl) {
    permBannerPathEl.textContent = folderName
      ? `Waiting to write ${folderName}`
      : "Waiting to write the generated files";
  }
  permBannerEl.hidden = false;
}

function hidePermissionBanner() {
  if (permBannerEl) permBannerEl.hidden = true;
}

/**
 * Chrome refuses requestPermission() without a user gesture. Rather than making
 * the user hunt for a button, retry the write on the next click or key press
 * anywhere in the panel.
 */
function armPermissionRetryOnNextGesture() {
  if (permissionRetryArmed) return;
  permissionRetryArmed = true;

  const handler = () => {
    document.removeEventListener("pointerdown", handler, true);
    document.removeEventListener("keydown", handler, true);
    permissionRetryArmed = false;
    tryFlushPendingOutput({ interactive: true }).catch(() => {});
  };

  document.addEventListener("pointerdown", handler, true);
  document.addEventListener("keydown", handler, true);
}

async function tryFlushPendingOutput({ interactive = false } = {}) {
  try {
    const result = await flushPendingOutputToSelectedDirectory({ interactive });
    if (result?.ok) {
      awaitingFolderPermission = false;
      hidePermissionBanner();
      const pathLabel = result.pathLabel || "selected folder";
      setStatus(`Done — saved files to ${pathLabel}`, "done");
      showSaveBanner(pathLabel);
      await refreshSaveBannerForCurrentJob();
      await chrome.storage.local.set({
        generation_status: `Done — saved files to ${pathLabel}`
      });
      chrome.runtime
        .sendMessage({ type: "show_save_notification", pathLabel })
        .catch(() => {});
      return result;
    }

    if (result?.needsPermission) {
      awaitingFolderPermission = true;
      showPermissionBanner(result.folderName);
      armPermissionRetryOnNextGesture();
      setStatus("Click anywhere in this panel to unlock the output folder and finish saving.");
      return result;
    }

    return result;
  } catch (err) {
    setStatus(`Save to folder failed: ${String(err.message || err)}`);
    return { ok: false, error: String(err.message || err) };
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "selected_profile_id",
    "selected_template_id",
    "last_job_title",
    "last_company_name",
    "last_jd_link",
    "last_jd_text",
    "generation_status",
    "generation_running",
    "pending_fs_write",
    "ui_ai_qa_section_open",
    "ui_qa_bank_section_open",
    "qa_learn_enabled",
    "imported_jobs_filter",
    "scraped_job_meta",
    "generate_resume_only",
    "preview_mode_enabled",
    "ui_panel_mode",
    "last_ats_report"
  ]);
  scrapedJobMeta = data.scraped_job_meta || null;

  await refreshProfiles(data.selected_profile_id || DEFAULT_PROFILE_ID);
  await refreshTemplates(data.selected_template_id || templateIdForProfile(profileSelectEl.value));
  jobTitleEl.value = data.last_job_title || "";
  companyNameEl.value = data.last_company_name || "";
  jdLinkEl.value = data.last_jd_link || "";
  jdTextEl.value = data.last_jd_text || "";
  await applySheetPresetForProfile(profileSelectEl.value);
  await refreshAtsBadge();

  if (aiQaSectionEl) aiQaSectionEl.open = Boolean(data.ui_ai_qa_section_open);
  if (qaBankSectionEl) qaBankSectionEl.open = Boolean(data.ui_qa_bank_section_open);
  if (qaLearnToggleEl) qaLearnToggleEl.checked = data.qa_learn_enabled !== false;
  if (previewModeToggleEl) {
    previewModeToggleEl.checked = data.preview_mode_enabled === true;
  }
  if (sidebarModeToggleEl) {
    sidebarModeToggleEl.checked = data.ui_panel_mode === "sidebar" || UI_MODE === "sidebar";
  }
  if (resumeOnlyToggleEl) {
    // Default unchecked (false) — only check when user previously enabled it.
    resumeOnlyToggleEl.checked = data.generate_resume_only === true;
  }
  updateGenerateButtonLabel();
  setImportedJobsFilter(data.imported_jobs_filter || "all", { persist: false });
  refreshQaBank().catch(() => {});
  refreshCaptureStatus().catch(() => {});
  refreshAutofillButtonLabel().catch(() => {});

  await refreshOutputDirLabel();
  setStatus(data.generation_status || "");
  setBusy(Boolean(data.generation_running));
  await refreshImportedJobsFromStorage().catch(() => {});
  await refreshSaveBannerFromStorage();

  if (data.pending_fs_write) {
    await tryFlushPendingOutput();
  }
}

async function readClipboardText() {
  const text = await navigator.clipboard.readText();
  return text.trim();
}

async function pasteJdFromClipboard() {
  setStatus("Reading JD from clipboard...");
  try {
    const jd = await readClipboardText();
    if (!jd) {
      setStatus("Clipboard is empty.");
      return;
    }
    jdTextEl.value = jd;
    await persistJobFields();
    setStatus("JD pasted from clipboard.");
  } catch {
    setStatus("Clipboard read failed. Paste JD into the text field manually.");
  }
}

async function waitForGenerationComplete(timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await chrome.storage.local.get(["generation_running", "generation_status"]);
    if (!data.generation_running) {
      return String(data.generation_status || "Ready.");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Generation timed out.");
}

async function startGenerationAndWait() {
  const collected = await collectJobMetaOrShowError();
  if (!collected) return { ok: false };

  generationStartPending = true;
  updateGenerationProgress({
    running: true,
    statusText: "Starting resume generation..."
  });
  setBusy(true);

  const res = await chrome.runtime.sendMessage({
    type: "generate_resume",
    profileId: collected.profileId,
    jobMeta: collected.jobMeta
  });
  if (!res?.ok) {
    generationStartPending = false;
    throw new Error(res?.error || "Failed to start generation.");
  }

  updateGenerationProgress({
    running: true,
    statusText: "Calling OpenAI for resume JSON..."
  });

  const statusText = await waitForGenerationComplete();
  generationStartPending = false;
  wasGenerationRunning = false;
  updateGenerationProgress({ running: false, statusText, clearIdleStatus: true });
  setBusy(false);

  if (/failed|error/i.test(statusText)) {
    throw new Error(statusText);
  }
  return { ok: true, status: statusText };
}

async function scrapeCurrentJobPage() {
  setStatus("Scraping the open job page...", "running");
  setBusy(true);
  if (scrapePageBtn) scrapePageBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "scrape_current_page" });
    if (!res?.ok) {
      throw new Error(res?.error || "Could not scrape this page.");
    }

    const d = res.jobData || {};
    jobTitleEl.value = d.jobTitle || "";
    companyNameEl.value = d.companyName || "";
    if (d.jdLink) jdLinkEl.value = d.jdLink;
    if (d.jdText) jdTextEl.value = d.jdText;

    scrapedJobMeta = {
      workArrangement: d.workArrangement || "",
      employmentType: d.employmentType || "",
      salaryMin: d.salaryMin || "",
      salaryMax: d.salaryMax || "",
      datePosted: d.datePosted || ""
    };

    await persistJobFields();
    await chrome.storage.local.set({ scraped_job_meta: scrapedJobMeta });

    if (!d.companyName) {
      setStatus(
        `Scraped ${d.jobTitle || "job"}, but company name was missing — enter the company before generating.`,
        "error"
      );
      companyNameEl.focus();
      return;
    }

    const site = res.site ? ` (${res.site})` : "";
    setStatus(
      `Scraped${site}: ${d.jobTitle || "job"} @ ${d.companyName}. Generating resume…`,
      "running"
    );

    const gen = await startGenerationAndWait();
    if (!gen.ok) return;

    setStatus("Resume saved. Running Autofill…", "running");
    setBusy(true);
    await runAutofillOnCurrentPage({ quiet: true });

    setStatus(
      `Done: scraped${site}, generated ${
        isResumeOnlyEnabled() ? "resume" : "resume & cover letter"
      }, and ran Autofill.`,
      "done"
    );
  } catch (err) {
    setStatus(`Scrape flow failed: ${String(err.message || err)}`, "error");
  } finally {
    setBusy(false);
    if (scrapePageBtn) scrapePageBtn.disabled = false;
  }
}

async function collectBatchGenerateSettings() {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  const templateId = templateSelectEl.value || DEFAULT_TEMPLATE_ID;
  const sheet = await getSheetSettings();
  const sheetError = sheetSettingsValidationError(sheet);
  if (sheetError) {
    setStatus(sheetError, "error");
    return null;
  }

  const outputFolderName = (await getOutputDirectoryName()) || "";
  if (!outputFolderName) {
    setStatus(
      "Select an output folder first (Select folder), then run batch resume build.",
      "error"
    );
    selectOutputDirBtn?.focus();
    return null;
  }

  await chrome.storage.local.set({
    selected_profile_id: profileId,
    selected_template_id: templateId,
    generate_resume_only: isResumeOnlyEnabled()
  });

  return {
    profileId,
    jobMeta: {
      outputDir: outputFolderName,
      spreadsheetUrl: sheet.spreadsheetUrl,
      sheetName: sheet.sheetName,
      sheetsWebAppUrl: sheet.sheetsWebAppUrl,
      templateId,
      trackApplicationStatus: sheet.trackApplicationStatus
    }
  };
}

async function copySheetRow() {
  const jobTitle = (jobTitleEl.value || "").trim();
  const companyName = (companyNameEl.value || "").trim();
  const jdLink = (jdLinkEl.value || "").trim();

  if (!jobTitle && !companyName && !jdLink) {
    setStatus("Fill job title, company, and/or JD link before copying.");
    return;
  }

  const selJob =
    (importedJobsSelectedId && importedJobsById[importedJobsSelectedId]) ||
    scrapedJobMeta ||
    {};
  const tsv = buildSheetRowTsv({
    jobTitle,
    companyName,
    jdLink,
    includeDate: true,
    workArrangement: selJob.workArrangement || "",
    employmentType: selJob.employmentType || "",
    salaryMin: selJob.salaryMin || "",
    salaryMax: selJob.salaryMax || "",
    datePosted: selJob.datePosted || ""
  });
  try {
    await navigator.clipboard.writeText(tsv);
    setStatus("Sheet row copied. Click the first cell of an empty row in Sheets, then paste (Ctrl+V).");
  } catch {
    setStatus("Clipboard write failed. Try again after focusing the popup.");
  }
}

async function collectJobMetaOrShowError() {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  const templateId = templateSelectEl.value || DEFAULT_TEMPLATE_ID;
  const jobTitle = (jobTitleEl.value || "").trim();
  const companyName = (companyNameEl.value || "").trim();
  const jdLink = (jdLinkEl.value || "").trim();
  const jd = (jdTextEl.value || "").trim();
  const sheet = await getSheetSettings();

  if (!jobTitle) {
    setStatus("Enter a job title first.", "error");
    jobTitleEl.focus();
    return null;
  }
  if (!companyName) {
    setStatus("Enter a company name first.", "error");
    companyNameEl.focus();
    return null;
  }
  if (!jd) {
    setStatus("Paste a job description into the JD field first.", "error");
    jdTextEl.focus();
    return null;
  }

  const sheetError = sheetSettingsValidationError(sheet);
  if (sheetError) {
    setStatus(sheetError, "error");
    return null;
  }

  const outputFolderName = (await getOutputDirectoryName()) || "";
  if (!outputFolderName) {
    setStatus("Select an output folder first (Select folder), then generate.", "error");
    selectOutputDirBtn?.focus();
    return null;
  }

  await chrome.storage.local.set({
    selected_profile_id: profileId,
    selected_template_id: templateId,
    last_job_title: jobTitle,
    last_company_name: companyName,
    last_jd_link: jdLink,
    last_jd_text: jd,
    generate_resume_only: isResumeOnlyEnabled()
  });

  return {
    profileId,
    jobMeta: {
      jobTitle,
      companyName,
      jdLink,
      jdText: jd,
      outputDir: outputFolderName,
      spreadsheetUrl: sheet.spreadsheetUrl,
      sheetName: sheet.sheetName,
      sheetsWebAppUrl: sheet.sheetsWebAppUrl,
      templateId,
      workArrangement: scrapedJobMeta?.workArrangement || "",
      employmentType: scrapedJobMeta?.employmentType || "",
      salaryMin: scrapedJobMeta?.salaryMin || "",
      salaryMax: scrapedJobMeta?.salaryMax || "",
      datePosted: scrapedJobMeta?.datePosted || "",
      importedJobId: importedJobsSelectedId || "",
      resumeOnly: isResumeOnlyEnabled(),
      previewMode: isPreviewModeEnabled(),
      trackApplicationStatus: sheet.trackApplicationStatus
    }
  };
}

function setBusy(busy) {
  if (generateResumeBtn) generateResumeBtn.disabled = busy;
  if (autofillBtn) autofillBtn.disabled = busy;
  if (generateAiAnswerBtn) generateAiAnswerBtn.disabled = busy;
  if (batchGenerateBtn && busy) batchGenerateBtn.disabled = true;
  if (batchApplyBtn && busy) batchApplyBtn.disabled = true;
  if (batchRemoveBtn && busy) batchRemoveBtn.disabled = true;
  if (checkAvailabilityBtn && busy) checkAvailabilityBtn.disabled = true;
  if (!busy) updateBatchBar();
}

function setCopyAnswerEnabled(enabled) {
  if (copyAiAnswerBtn) copyAiAnswerBtn.disabled = !enabled;
}

function isResumeOnlyEnabled() {
  return Boolean(resumeOnlyToggleEl?.checked);
}

function updateGenerateButtonLabel() {
  if (!generateResumeBtn) return;
  const hint = generateResumeBtn.querySelector(".shortcut-hint");
  const hintHtml = hint ? ` <kbd class="shortcut-hint">${hint.textContent}</kbd>` : "";
  if (isResumeOnlyEnabled()) {
    generateResumeBtn.innerHTML = `Generate resume only${hintHtml}`;
    generateResumeBtn.title = "Alt+Shift+G — Generate resume only (no cover letter)";
  } else {
    generateResumeBtn.innerHTML = `Generate resume &amp; cover letter${hintHtml}`;
    generateResumeBtn.title = "Alt+Shift+G — Generate resume & cover letter";
  }
}

async function persistResumeOnlySetting() {
  await chrome.storage.local.set({ generate_resume_only: isResumeOnlyEnabled() });
  updateGenerateButtonLabel();
}

function isPreviewModeEnabled() {
  return Boolean(previewModeToggleEl?.checked);
}

async function persistPreviewModeSetting() {
  await chrome.storage.local.set({ preview_mode_enabled: isPreviewModeEnabled() });
  setStatus(
    isPreviewModeEnabled()
      ? "Preview mode on — generate opens Preview; Save PDFs when ready."
      : "Preview mode off — generate saves PDFs immediately."
  );
}

async function generateResumeAndCoverLetter() {
  const collected = await collectJobMetaOrShowError();
  if (!collected) return;

  generationStartPending = true;
  updateGenerationProgress({
    running: true,
    statusText: "Starting resume generation..."
  });
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "generate_resume",
      profileId: collected.profileId,
      jobMeta: collected.jobMeta
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to start generation.");
    }
    updateGenerationProgress({
      running: true,
      statusText: "Calling OpenAI for resume JSON..."
    });
  } catch (err) {
    generationStartPending = false;
    wasGenerationRunning = false;
    updateGenerationProgress({
      running: false,
      statusText: `Generation failed: ${String(err.message || err)}`,
      clearIdleStatus: false
    });
    setBusy(false);
  }
}

// ---- Q&A bank UI ----------------------------------------------------------

async function refreshQaBank() {
  if (!qaBankNoteEl) return;
  try {
    const profileId = profileSelectEl?.value || "";
    const [profileCount, sharedCount, pendingCount] = await Promise.all([
      getQaCount(profileId),
      getQaCount(""),
      getPendingQaCount(profileId)
    ]);
    const parts = [];
    if (profileCount) parts.push(`${profileCount} this profile`);
    if (sharedCount) parts.push(`${sharedCount} shared`);
    if (pendingCount) parts.push(`${pendingCount} to register`);
    qaBankNoteEl.textContent = parts.length ? parts.join(" · ") : "0 saved";
  } catch {
    qaBankNoteEl.textContent = "Q&A";
  }
}

function closeSubpage() {
  if (!subpageOverlayEl || subpageOverlayEl.hidden) return;
  const wasProfile = subpageFrameEl?.dataset.kind === "profile";
  subpageOverlayEl.hidden = true;
  document.body.classList.remove("subpage-open");
  if (subpageFrameEl) {
    subpageFrameEl.removeAttribute("src");
    delete subpageFrameEl.dataset.kind;
  }
  if (wasProfile) {
    refreshProfiles(profileSelectEl?.value || DEFAULT_PROFILE_ID).catch(() => {});
    refreshQaBank().catch(() => {});
  }
}

function openSubpage(href, { title, kind, silent = false } = {}) {
  if (!isExtensionContextValid()) {
    handleExtensionContextInvalidated();
    return;
  }
  if (!subpageOverlayEl || !subpageFrameEl) {
    setStatus("Could not open page in the panel.", "error");
    return;
  }
  if (subpageTitleEl) subpageTitleEl.textContent = title || "Ocean";
  subpageFrameEl.dataset.kind = kind || "";
  if (subpageFrameEl.getAttribute("src") === href) {
    subpageFrameEl.removeAttribute("src");
  }
  subpageFrameEl.src = href;
  subpageOverlayEl.hidden = false;
  document.body.classList.add("subpage-open");
  if (!silent) setStatus(`Opened ${title || "page"}.`, "done");
}

async function openPreview({ silent = false } = {}) {
  openSubpage(chrome.runtime.getURL("preview.html"), {
    title: "Preview",
    kind: "preview",
    silent
  });
}

async function openDashboard() {
  const url = new URL(chrome.runtime.getURL("dashboard.html"));
  const profileId = profileSelectEl?.value || "";
  if (profileId) url.searchParams.set("profileId", profileId);
  openSubpage(url.toString(), { title: "Dashboard", kind: "dashboard" });
}

async function openQaEditor() {
  const url = new URL(chrome.runtime.getURL("qa-editor.html"));
  const profileId = profileSelectEl?.value || "";
  if (profileId) url.searchParams.set("profileId", profileId);
  openSubpage(url.toString(), { title: "Q&A Editor", kind: "qa" });
}

let autofillInProgress = false;

async function applyAutofillButtonState(button = null) {
  if (!autofillBtn) return;
  const label = String(button?.label || "Autofill").trim() || "Autofill";
  const title =
    String(button?.title || "").trim() ||
    "Fill this step first. On a one-page form the button becomes Submit after filling.";
  const hint = '<kbd class="shortcut-hint">Alt+Shift+E</kbd>';
  autofillBtn.innerHTML = `${label} ${hint}`;
  autofillBtn.title = title;
  autofillBtn.dataset.actionLabel = label;
}

async function refreshAutofillButtonLabel() {
  if (!autofillBtn || autofillBtn.disabled) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "probe_autofill_action" });
    if (res?.button) await applyAutofillButtonState(res.button);
  } catch {
    /* best-effort */
  }
}

async function runAutofillOnCurrentPage({ quiet = false } = {}) {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  if (!profileId) {
    setStatus("Select a profile first.", "error");
    return;
  }

  const preferredAction =
    String(autofillBtn?.dataset?.actionLabel || "").toLowerCase() === "submit" ? "submit" : "";

  autofillInProgress = true;
  if (!quiet) {
    setStatus(preferredAction === "submit" ? "Clicking Submit..." : "Autofill: filling this step...", "running");
    updateJobsWorkStatus({
      running: true,
      statusText: preferredAction === "submit" ? "Clicking Submit..." : "Autofill: filling this step..."
    });
  }
  setBusy(true);
  try {
    await chrome.storage.local.set({ selected_profile_id: profileId });
    const res = await chrome.runtime.sendMessage({
      type: "autofill_current_page",
      profileId,
      clickAction: true,
      preferredAction
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Autofill failed.");
    }
    if (res.button) await applyAutofillButtonState(res.button);
    if (!quiet) {
      setStatus(res.status || "Autofill done.");
    }
    await refreshQaBank();
    return res;
  } catch (err) {
    if (!quiet) {
      setStatus(`Autofill failed: ${String(err.message || err)}`, "error");
    }
    throw err;
  } finally {
    autofillInProgress = false;
    if (!quiet) updateJobsWorkStatus({ running: false });
    setBusy(false);
    refreshAutofillButtonLabel().catch(() => {});
  }
}

async function generateManualAiAnswer() {
  const question = String(manualQuestionEl?.value || "").trim();
  if (!question) {
    setStatus("Paste a form question first.");
    return;
  }

  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  if (!profileId) {
    setStatus("Select a profile first.");
    return;
  }

  // Persist JD fields so the service worker uses the latest text.
  await persistJobFields().catch(() => {});

  if (manualAnswerEl) manualAnswerEl.value = "";
  setCopyAnswerEnabled(false);
  setStatus("Generating brief humanized answer...");
  setBusy(true);
  try {
    await chrome.storage.local.set({ selected_profile_id: profileId });
    const res = await chrome.runtime.sendMessage({
      type: "answer_application_question",
      profileId,
      question
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to generate answer.");
    }
    const answer = String(res.answer || "").trim();
    if (!answer) {
      throw new Error("OpenAI returned an empty answer.");
    }
    if (manualAnswerEl) manualAnswerEl.value = answer;
    setCopyAnswerEnabled(true);
    setStatus("AI answer ready — copy it into the form.");
  } catch (err) {
    setStatus(`AI answer failed: ${String(err.message || err)}`);
  } finally {
    setBusy(false);
  }
}

async function copyManualAiAnswer() {
  const answer = String(manualAnswerEl?.value || "").trim();
  if (!answer) {
    setStatus("No answer to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(answer);
    setStatus("Answer copied to clipboard.");
  } catch (err) {
    setStatus(`Copy failed: ${String(err.message || err)}`);
  }
}

/**
 * Clears the per-job fields so the next bid starts from scratch. Settings that
 * are not job specific (profile, template, output folder, sheet URLs) are kept.
 */
async function clearJobFields() {
  for (const el of [jobTitleEl, companyNameEl, jdLinkEl, jdTextEl, manualQuestionEl, manualAnswerEl]) {
    if (el) el.value = "";
  }
  setCopyAnswerEnabled(false);
  hideSaveBanner();
  hidePermissionBanner();
  if (genProgressEl) genProgressEl.hidden = true;

  scrapedJobMeta = null;
  await chrome.storage.local.set({
    last_job_title: "",
    last_company_name: "",
    last_jd_link: "",
    last_jd_text: ""
  });
  await chrome.storage.local.remove(["last_save_ready", "last_save_meta", "scraped_job_meta"]);
}

async function resetWorkflow() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "reset_generation_state" });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to reset.");
    }
    await clearJobFields();
    wasGenerationRunning = false;
    generationStartPending = false;
    renderAtsBadge(null);
    setStatus("Cleared. Ready for the next job.");
    setBusy(false);
    jobTitleEl?.focus();
  } catch (err) {
    setStatus(`Reset failed: ${String(err.message || err)}`);
  }
}

async function openProfileEditor({ mode = "edit", profileId = null } = {}) {
  const url = new URL(chrome.runtime.getURL("profile-editor.html"));
  url.searchParams.set("mode", mode);
  if (mode === "edit" && profileId) {
    url.searchParams.set("profileId", profileId);
  }
  openSubpage(url.toString(), {
    title: mode === "new" ? "Add profile" : "Edit profile",
    kind: "profile"
  });
}

async function editSelectedProfile() {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  if (!profileId) {
    setStatus("Select a profile first.", "error");
    return;
  }
  await openProfileEditor({ mode: "edit", profileId });
}

async function addNewProfile() {
  await openProfileEditor({ mode: "new" });
}

async function removeSelectedProfile() {
  const profileId = profileSelectEl.value;
  const selected = profilesCache.find((p) => p.id === profileId);
  if (!selected || selected.builtin) {
    setStatus("Built-in profiles cannot be deleted.");
    return;
  }

  const ok = window.confirm(`Delete profile "${selected.label}"?`);
  if (!ok) return;

  try {
    await deleteCustomProfile(profileId);
    await chrome.storage.local.set({ selected_profile_id: DEFAULT_PROFILE_ID });
    await refreshProfiles(DEFAULT_PROFILE_ID);
    setStatus(`Deleted profile: ${selected.label}`);
  } catch (err) {
    setStatus(String(err.message || err));
  }
}

profileSelectEl.addEventListener("change", () => {
  syncDeleteButton();
  saveSelectedProfile(profileSelectEl.value).catch(() => {});
  applyProfileTemplateDefault(profileSelectEl.value).catch(() => {});
  applySheetPresetForProfile(profileSelectEl.value).catch((err) =>
    setStatus(String(err?.message || err))
  );
  refreshQaBank().catch(() => {});
});

templateSelectEl.addEventListener("change", () => {
  saveSelectedTemplate(templateSelectEl.value).catch(() => {});
});

for (const el of [jobTitleEl, companyNameEl, jdLinkEl, jdTextEl].filter(Boolean)) {
  el.addEventListener("change", () => {
    persistJobFields().catch(() => {});
  });
}

wireAccordion(aiQaSectionEl, "ui_ai_qa_section_open");
wireAccordion(qaBankSectionEl, "ui_qa_bank_section_open");

selectOutputDirBtn.addEventListener("click", () => {
  selectOutputDirectory().catch((err) => setStatus(String(err.message || err)));
});

pasteJdBtn.addEventListener("click", pasteJdFromClipboard);
scrapePageBtn?.addEventListener("click", () => {
  scrapeCurrentJobPage().catch((err) => setStatus(String(err.message || err)));
});
copySheetRowBtn.addEventListener("click", copySheetRow);
generateResumeBtn.addEventListener("click", generateResumeAndCoverLetter);
stopGenerateBtn?.addEventListener("click", () => {
  chrome.runtime
    .sendMessage({ type: "cancel_generation" })
    .then(() => {
      setStatus("Stopping generation…", "running");
      if (genProgressDetailEl) genProgressDetailEl.textContent = "Stopping…";
    })
    .catch((err) => setStatus(String(err?.message || err), "error"));
});

sidebarModeToggleEl?.addEventListener("change", () => {
  const wantSidebar = Boolean(sidebarModeToggleEl.checked);
  (async () => {
    await chrome.storage.local.set({ ui_panel_mode: wantSidebar ? "sidebar" : "window" });
    if (wantSidebar) {
      if (UI_MODE === "sidebar") return;
      const current = await chrome.windows.getCurrent().catch(() => null);
      const normals = await chrome.windows.getAll({ windowTypes: ["normal"] });
      let windowId =
        normals.find((w) => w.id !== current?.id)?.id || normals[0]?.id || null;
      if (windowId == null) {
        const res = await chrome.runtime.sendMessage({ type: "open_side_panel" });
        windowId = res?.windowId ?? null;
      }
      if (windowId == null) {
        throw new Error("Open a browser tab first, then enable Sidebar.");
      }
      await chrome.sidePanel.setOptions({
        path: "popup.html?mode=sidebar",
        enabled: true
      });
      await chrome.sidePanel.open({ windowId });
      await chrome.runtime.sendMessage({ type: "close_panel_window" }).catch(() => {});
      if (current?.type === "popup" && current.id != null) {
        await chrome.windows.remove(current.id).catch(() => {});
      } else {
        window.close();
      }
      return;
    }
    if (UI_MODE === "window") return;
    const res = await chrome.runtime.sendMessage({ type: "open_panel_window" });
    if (!res?.ok) throw new Error(res?.error || "Could not open window.");
  })().catch((err) => {
    if (sidebarModeToggleEl) sidebarModeToggleEl.checked = UI_MODE === "sidebar";
    setStatus(String(err?.message || err), "error");
  });
});

// Sidebar mode switching
modeManualBtn?.addEventListener("click", () => setSidebarMode("manual"));
modeImportedBtn?.addEventListener("click", () => setSidebarMode("imported"));
filterAllJobsBtn?.addEventListener("click", () => setImportedJobsFilter("all"));
filterDiceJobsBtn?.addEventListener("click", () => setImportedJobsFilter("dice"));
filterJobrightJobsBtn?.addEventListener("click", () => setImportedJobsFilter("jobright"));
filterLinkedInJobsBtn?.addEventListener("click", () => setImportedJobsFilter("linkedin"));
filterOtherJobsBtn?.addEventListener("click", () => setImportedJobsFilter("others"));
selectAllJobsEl?.addEventListener("change", () => {
  const visible = batchableImportedJobIds();
  if (selectAllJobsEl.checked) {
    for (const id of visible) importedJobsChecked.add(id);
  } else {
    for (const id of visible) importedJobsChecked.delete(id);
  }
  persistCheckedJobs();
  renderImportedJobs();
});
batchGenerateBtn?.addEventListener("click", () => {
  batchGenerateSelectedJobs().catch((err) => setStatus(String(err.message || err), "error"));
});
batchApplyBtn?.addEventListener("click", () => {
  batchApplySelectedJobs().catch((err) => setStatus(String(err.message || err), "error"));
});
checkAvailabilityBtn?.addEventListener("click", () => {
  checkSelectedJobsAvailability().catch((err) => setStatus(String(err.message || err), "error"));
});
batchRemoveBtn?.addEventListener("click", () => {
  removeSelectedImportedJobs().catch((err) => setStatus(String(err.message || err), "error"));
});
confirmModalOkEl?.addEventListener("click", () => closeConfirmModal(true));
confirmModalEl?.querySelectorAll("[data-confirm-dismiss]").forEach((el) => {
  el.addEventListener("click", () => closeConfirmModal(false));
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (confirmModalEl && !confirmModalEl.hidden) {
    e.preventDefault();
    closeConfirmModal(false);
    return;
  }
  if (subpageOverlayEl && !subpageOverlayEl.hidden) {
    e.preventDefault();
    closeSubpage();
  }
});

autoCaptureToggleEl?.addEventListener("change", () => {
  const enabled = Boolean(autoCaptureToggleEl.checked);
  chrome.runtime
    .sendMessage({ type: "set_auto_capture", enabled })
    .catch(() => {});
  if (captureStatusEl) {
    captureStatusEl.textContent = enabled
      ? "Auto-capture enabled (every 4 hours while Chrome is open)."
      : "Auto-capture disabled.";
  }
});

captureNowBtn?.addEventListener("click", () => {
  runJobCaptureNow().catch((err) => setStatus(String(err.message || err)));
});

importCsvBtn?.addEventListener("click", () => {
  csvFileInputEl?.click?.();
});

csvFileInputEl?.addEventListener("change", async () => {
  const file = csvFileInputEl.files && csvFileInputEl.files[0] ? csvFileInputEl.files[0] : null;
  if (!file) return;

  setStatus(`Importing CSV: ${file.name} ...`);
  importStatusEl && (importStatusEl.textContent = "");

  try {
    const text = await file.text();
    const parsed = parseImportedJobsCsvText(text);

    if (parsed.errors?.length) {
      const msg = parsed.errors[0]?.message || "CSV could not be parsed.";
      setStatus(`CSV import failed: ${msg}`);
      if (importStatusEl) importStatusEl.textContent = msg;
      return;
    }

    if (!parsed.jobs.length) {
      const msg =
        `No jobs loaded from CSV (${parsed.format || "unknown"} format). ` +
        `${parsed.skipped} row(s) missing URL/title/company` +
        (parsed.format === "capture" ? " or description" : "") +
        `, ${parsed.duplicateUrls || 0} duplicate URL(s).`;
      setStatus(`CSV import failed: ${msg}`);
      if (importStatusEl) importStatusEl.textContent = msg;
      return;
    }

    const replaceRes = await replaceImportedJobs(parsed.jobs);

    const summary =
      `Loaded ${replaceRes.imported} job(s) from ${parsed.format || "CSV"} export. ` +
      `Ignored ${parsed.skipped} invalid row(s), ${(parsed.duplicateUrls || 0) + replaceRes.duplicateIds} duplicate(s).`;
    setStatus(`CSV import complete. ${summary}`);
    if (importStatusEl) importStatusEl.textContent = summary;

    setSidebarMode("imported");
  } catch (err) {
    const msg = String(err?.message || err);
    setStatus(`CSV import failed: ${msg}`);
    if (importStatusEl) importStatusEl.textContent = msg;
  } finally {
    // Allow selecting the same file again.
    csvFileInputEl.value = "";
  }
});

autofillBtn.addEventListener("click", () => {
  runAutofillOnCurrentPage().catch((err) => setStatus(String(err.message || err), "error"));
});
openPreviewBtn?.addEventListener("click", () => {
  openPreview().catch((err) => setStatus(String(err.message || err)));
});
openDashboardBtn?.addEventListener("click", () => {
  openDashboard().catch((err) => setStatus(String(err.message || err)));
});
subpageBackBtn?.addEventListener("click", () => closeSubpage());
window.addEventListener("message", (event) => {
  if (event.origin !== `chrome-extension://${chrome.runtime.id}`) return;
  if (event.data?.type === "ocean-close-subpage") closeSubpage();
});
qaOpenEditorBtn?.addEventListener("click", () => {
  openQaEditor().catch((err) => setStatus(String(err.message || err)));
});
qaLearnToggleEl?.addEventListener("change", () => {
  const enabled = Boolean(qaLearnToggleEl.checked);
  chrome.storage.local.set({ qa_learn_enabled: enabled }).catch(() => {});
  setStatus(enabled ? "Learn mode on — typed answers will be saved." : "Learn mode off.");
});
qaBankSectionEl?.addEventListener("toggle", () => {
  if (qaBankSectionEl.open) refreshQaBank().catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (extensionContextDead || !isExtensionContextValid()) return;
  if (area === "local" && (changes.qa_bank_version || changes.pending_qa_version)) {
    refreshQaBank().catch((err) => {
      if (isContextInvalidatedError(err)) handleExtensionContextInvalidated();
    });
  }
});
generateAiAnswerBtn?.addEventListener("click", () => {
  generateManualAiAnswer().catch((err) => setStatus(String(err.message || err)));
});
copyAiAnswerBtn?.addEventListener("click", () => {
  copyManualAiAnswer().catch((err) => setStatus(String(err.message || err)));
});
resetBtn.addEventListener("click", resetWorkflow);
editProfileBtn.addEventListener("click", () => {
  editSelectedProfile().catch((err) => setStatus(String(err.message || err)));
});
addProfileBtn.addEventListener("click", () => {
  addNewProfile().catch((err) => setStatus(String(err.message || err)));
});
deleteProfileBtn.addEventListener("click", removeSelectedProfile);
closePanelBtn?.addEventListener("click", () => {
  window.close();
});
openSavedFolderBtn?.addEventListener("click", () => {
  openSavedFolder().catch((err) => setStatus(String(err.message || err)));
});
grantFolderAccessBtn?.addEventListener("click", () => {
  tryFlushPendingOutput({ interactive: true }).catch((err) =>
    setStatus(String(err.message || err))
  );
});

// Profile edits happen in the overlay iframe; refresh the list when storage changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (extensionContextDead || !isExtensionContextValid()) return;
  if (area !== "local") return;
  if (!changes.custom_profiles && !changes.selected_profile_id) return;

  (async () => {
    const stored = await chrome.storage.local.get("selected_profile_id");
    const preferred = stored.selected_profile_id || profileSelectEl.value;
    if (!changes.custom_profiles && preferred === profileSelectEl.value) return;

    const before = new Set(profilesCache.map((p) => p.id));

    await refreshProfiles(preferred);

    const added = profilesCache.find((p) => !before.has(p.id));
    if (added) {
      setStatus(`Profile added: ${added.label}`, "done");
    }
  })().catch((err) => {
    if (isContextInvalidatedError(err)) handleExtensionContextInvalidated();
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (extensionContextDead || !isExtensionContextValid()) return undefined;
  if (message?.type === "flush_pending_output") {
    tryFlushPendingOutput()
      .then((result) => sendResponse(result || { ok: false }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message?.type === "load_job_upload_docs") {
    (async () => {
      try {
        const docs = await readJobUploadDocsFromDirectory(message.folderName || "", {
          interactive: true
        });
        if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) {
          sendResponse({
            ok: false,
            error: `No resume/cover letter PDFs found in folder "${message.folderName || ""}".`
          });
          return;
        }
        if (message.jobId) {
          const rootName = (await getOutputDirectoryName()) || "";
          const pathLabel =
            rootName && docs.folderName ? `${rootName} / ${docs.folderName}` : docs.folderName || rootName;
          await setGeneratedDocsForJob(message.jobId, { ...docs, pathLabel });
        }
        const rootName = (await getOutputDirectoryName()) || "";
        sendResponse({
          ok: true,
          docs: {
            folderName: docs.folderName || "",
            pathLabel:
              rootName && docs.folderName ? `${rootName} / ${docs.folderName}` : docs.folderName || rootName,
            resume: docs.resume || null,
            coverLetter: docs.coverLetter || null
          }
        });
      } catch (err) {
        if (err?.code === "NEEDS_PERMISSION") {
          sendResponse({
            ok: false,
            needsPermission: true,
            error: String(err.message || err)
          });
          return;
        }
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "open_saved_folder_fs") {
    browseLastSavedJobDirectory()
      .then((result) => sendResponse(result || { ok: true }))
      .catch((err) => {
        if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
          sendResponse({ ok: true, aborted: true });
          return;
        }
        sendResponse({ ok: false, error: String(err.message || err) });
      });
    return true;
  }

  if (message?.type === "panel_command") {
    const cmd = message.command;
    (async () => {
      try {
        if (cmd === "scrape_and_apply") {
          await scrapeCurrentJobPage();
        } else if (cmd === "generate_docs") {
          await generateResumeAndCoverLetter();
        } else if (cmd === "easy_apply") {
          await runAutofillOnCurrentPage();
        }
        sendResponse({ ok: true });
      } catch (err) {
        setStatus(String(err?.message || err), "error");
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return undefined;
});

document.addEventListener("keydown", (e) => {
  const key = String(e.key || "").toLowerCase();
  // Ctrl/Cmd+Enter still generates from the panel.
  if ((e.ctrlKey || e.metaKey) && key === "enter") {
    e.preventDefault();
    generateResumeAndCoverLetter().catch(() => {});
    return;
  }
  // Alt+Enter on a selected job card runs the same action as its Apply button.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && key === "enter") {
    if (confirmModalEl && !confirmModalEl.hidden) return;
    if (subpageOverlayEl && !subpageOverlayEl.hidden) return;
    const jobId = importedJobsSelectedId;
    const job = jobId ? importedJobsById[jobId] : null;
    if (!job || job.status === "completed" || job.status === "unavailable") return;
    if (["opening", "generating", "opening_form", "filling"].includes(String(job.status))) return;
    e.preventDefault();
    applyImportedJob(jobId).catch((err) => setStatus(String(err.message || err), "error"));
  }
});

resumeOnlyToggleEl?.addEventListener("change", () => {
  persistResumeOnlySetting().catch(() => {});
});
previewModeToggleEl?.addEventListener("change", () => {
  persistPreviewModeSetting().catch(() => {});
});

loadSettings().catch((err) => setStatus(`Init failed: ${String(err.message || err)}`, "error"));
setSidebarMode("manual");
refreshImportedJobsFromStorage().catch(() => {});

panelPollTimer = setInterval(async () => {
  if (extensionContextDead) return;
  if (!isExtensionContextValid()) {
    handleExtensionContextInvalidated();
    return;
  }
  try {
    const data = await chrome.storage.local.get([
      "generation_status",
      "generation_running",
      "pending_fs_write",
      "last_save_ready",
      "last_save_meta",
      "imported_jobs_by_id",
      "imported_jobs_order",
      "imported_jobs_selected_id",
      "imported_jobs_version",
      "last_ats_report",
      "last_resume_json",
      "ui_open_preview"
    ]);

    if (data.ui_open_preview) {
      await chrome.storage.local.remove("ui_open_preview");
      openPreview({ silent: true }).catch(() => {});
    }

    const running = Boolean(data.generation_running);
    const statusText =
      typeof data.generation_status === "string" ? data.generation_status : "";

    if (running) {
      generationStartPending = false;
      wasGenerationRunning = true;
      updateGenerationProgress({ running: true, statusText });
      setBusy(true);
      if (atsScoreBadgeEl) atsScoreBadgeEl.hidden = true;
    } else if (generationStartPending) {
      // Keep the local "Starting..." UI until the service worker flips the flag.
      updateGenerationProgress({
        running: true,
        statusText: statusText || "Starting resume generation..."
      });
      setBusy(true);
      if (atsScoreBadgeEl) atsScoreBadgeEl.hidden = true;
    } else if (autofillInProgress) {
      updateJobsWorkStatus({
        running: true,
        statusText: statusText || "Autofill: working..."
      });
    } else if (wasGenerationRunning) {
      wasGenerationRunning = false;
      updateGenerationProgress({
        running: false,
        statusText,
        clearIdleStatus: true
      });
      setBusy(false);
      renderAtsForCurrentJob(data.last_ats_report);
    } else {
      setBusy(false);
      renderAtsForCurrentJob(data.last_ats_report);
    }

    // While a gesture is pending, the click/keydown handler drives the retry.
    if (data.pending_fs_write && !awaitingFolderPermission) {
      await tryFlushPendingOutput();
    }
    if (data.last_save_ready) {
      await chrome.storage.local.remove("last_save_ready");
      await refreshSaveBannerForCurrentJob();
    }

    const nextSelected = data.imported_jobs_selected_id || null;
    const nextVersion = Number(data.imported_jobs_version || 0);
    if (nextVersion && nextVersion !== importedJobsVersion) {
      importedJobsById = data.imported_jobs_by_id || {};
      importedJobsOrder = data.imported_jobs_order || [];
      importedJobsSelectedId = nextSelected;
      importedJobsVersion = nextVersion;
      for (const id of [...importedJobsChecked]) {
        if (!importedJobsById[id]) importedJobsChecked.delete(id);
      }
      renderImportedJobs();
    } else if (nextSelected !== importedJobsSelectedId) {
      importedJobsSelectedId = nextSelected;
      if (data.imported_jobs_by_id) importedJobsById = data.imported_jobs_by_id;
      refreshSaveBannerForCurrentJob().catch(() => {});
    }

    if (!capturePollRunning) {
      capturePollRunning = true;
      refreshCaptureStatus()
        .catch((err) => {
          if (isContextInvalidatedError(err)) handleExtensionContextInvalidated();
        })
        .finally(() => {
          capturePollRunning = false;
        });
    }
    autofillLabelPollTick += 1;
    if (autofillLabelPollTick % 3 === 0) {
      refreshAutofillButtonLabel().catch(() => {});
    }
  } catch (err) {
    if (isContextInvalidatedError(err) || !isExtensionContextValid()) {
      handleExtensionContextInvalidated();
    }
  }
}, 600);
