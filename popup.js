import {
  DEFAULT_PROFILE_ID,
  getResumeProfiles,
  deleteCustomProfile
} from "./profiles.js";
import { getAllTemplates, DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { extractSpreadsheetId, buildSheetRowTsv, updateJobStatusInSpreadsheet, getExistingJobLinks, normalizeSheetJobLink } from "./sheets.js";
import { formatAtsTooltip } from "./ats-score.js";
import { getPresetForProfile } from "./sheet-presets.js";
import {
  saveOutputDirectoryHandle,
  getOutputDirectoryName,
  getOutputDirectoryAbsolutePath,
  setOutputDirectoryAbsolutePath,
  buildResumeFolderAbsolutePath,
  normalizeAbsoluteDirectoryPath,
  flushPendingOutputToSelectedDirectory,
  getLastSaveMeta,
  browseLastSavedJobDirectory,
  readJobUploadDocsFromDirectory,
  sanitizeJobFolderName,
  unlockOutputDirectory,
  getOutputDirectoryHandle,
  queryDirectoryPermission,
  probeDirectoryAccess
} from "./fs-output.js";
import { isLinkedInSource, isDiceSource, isJobrightSource, isGreenhouseSource, isWorkdaySource, isIndeedSource, parseImportedJobsCsvText, jobIdFromLink } from "./csv-jobs.js";
import {
  AUTO_CAPTURE_ENABLED_KEY,
  LAST_CAPTURE_STATUS_KEY,
  buildCaptureSummary,
  normalizeJobLink
} from "./capture-jobs.js";
import {
  readJobStatusMemory,
  applyRememberedStatus,
  lookupJobStatus,
  companyTitleKey,
  collectAppliedCompanyTitleKeys,
  rememberJobStatus,
  rememberJobStatuses
} from "./job-status-memory.js";
import { getQaCount } from "./qa-store.js";
import { getApplicationLog } from "./application-log.js";
import { appendApplicationEvent } from "./application-log.js";
import { getPendingQaCount } from "./pending-qa.js";
import { setGeneratedDocsForJob, getGeneratedDocsForJob } from "./upload-assets.js";

const UI_MODE = new URLSearchParams(location.search).get("mode") === "sidebar" ? "sidebar" : "window";
document.body.classList.add(UI_MODE === "sidebar" ? "ui-sidebar" : "ui-window");
document.documentElement.classList.add(UI_MODE === "sidebar" ? "ui-sidebar" : "ui-window");
if (UI_MODE === "sidebar") {
  document.body.classList.add("ocean-in-panel");
  const layout = document.querySelector(".layout");
  const profileCard = document.getElementById("profileToolbarCard");
  if (layout && profileCard) {
    layout.prepend(profileCard);
  }
  const rail = document.getElementById("sidebarActionRail");
  const actions = document.getElementById("primaryActions");
  if (rail && actions) {
    rail.hidden = false;
    rail.appendChild(actions);
  }
}

// A glanceable build stamp so a stale panel/window is obvious rather than
// silently showing old markup after a reload (recurring source of "the
// checkbox/template isn't there" reports that were actually a stale document).
try {
  const buildVersionEl = document.getElementById("buildVersion");
  if (buildVersionEl) buildVersionEl.textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  /* not running as an extension (e.g. static preview) */
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
const outputDirAbsPathEl = document.getElementById("outputDirAbsPath");
const resumeFilenamePatternEl = document.getElementById("resumeFilenamePattern");
const resumeFilenameExampleEl = document.getElementById("resumeFilenameExample");
const selectOutputDirBtn = document.getElementById("selectOutputDir");
const aiQaSectionEl = document.getElementById("aiQaSection");
const copySheetRowBtn = document.getElementById("copySheetRow");
const scrapePageBtn = document.getElementById("scrapePageBtn");
const scrapeAndApplyBtn = document.getElementById("scrapeAndApplyBtn");
const pasteJdBtn = document.getElementById("pasteJd");
const resumeOnlyToggleEl = document.getElementById("resumeOnlyToggle");
const atsRewriteToggleEl = document.getElementById("atsRewriteToggle");
const atsRewriteToggleLabelEl = document.getElementById("atsRewriteToggleLabel");
const previewModeToggleEl = document.getElementById("previewModeToggle");
const sidebarModeToggleEl = document.getElementById("sidebarModeToggle");
const generateResumeBtn = document.getElementById("generateResume");
const autofillBtn = document.getElementById("autofillBtn");
const qaBankSectionEl = document.getElementById("qaBankSection");
const qaBankNoteEl = document.getElementById("qaBankNote");
const qaOpenEditorBtn = document.getElementById("qaOpenEditorBtn");
const qaLearnToggleEl = document.getElementById("qaLearnToggle");
const aiFormPlanToggleEl = document.getElementById("aiFormPlanToggle");
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
const copyResumePathBtn = document.getElementById("copyResumePathBtn");
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
const filterGreenhouseJobsBtn = document.getElementById("filterGreenhouseJobs");
const filterWorkdayJobsBtn = document.getElementById("filterWorkdayJobs");
const filterIndeedJobsBtn = document.getElementById("filterIndeedJobs");
const filterJobrightJobsBtn = document.getElementById("filterJobrightJobs");
const filterLinkedInJobsBtn = document.getElementById("filterLinkedInJobs");
const filterOtherJobsBtn = document.getElementById("filterOtherJobs");
const jobListSearchEl = document.getElementById("jobListSearch");
const jobStatusFilterBtns = [...document.querySelectorAll(".job-status-filters .chip-btn")];
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
let importedJobsStatusFilter = "all";
let importedJobsSearchQuery = "";
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

/**
 * Last score seen in storage. Several callers render the badge without having
 * just read storage (the save-banner refresh, job-card clicks), and the job
 * record they read from the in-memory cache can still be a tick behind the
 * run that just finished — without this the badge blanked out right after a
 * generation completed.
 */
let lastAtsReport = null;

/**
 * True only while a generation is actually in flight. The poll owns it, and
 * every render path honours it, so a mid-run save-banner refresh can no longer
 * flash the previous job's score.
 */
let atsBadgeSuppressed = false;

function setAtsBadgeSuppressed(suppressed) {
  atsBadgeSuppressed = Boolean(suppressed);
  if (atsBadgeSuppressed && atsScoreBadgeEl) atsScoreBadgeEl.hidden = true;
}

function rememberAtsReport(report) {
  lastAtsReport = report && typeof report === "object" ? report : null;
  return lastAtsReport;
}

/**
 * The stored report for a job, but only when it really carries a score — a
 * failed scoring pass leaves an atsReport object behind with no number in it,
 * and treating that as authoritative used to hide the badge.
 */
function atsReportForJob(job) {
  const score = jobFinalAtsScore(job);
  if (score == null) return null;
  const report = job?.atsReport;
  if (report && typeof report === "object") {
    const reported = Number(report.finalScore ?? report.score);
    if (Number.isFinite(reported) && reported > 0) return report;
  }
  return { score, finalScore: score, source: "stored" };
}

function renderAtsForCurrentJob(fallbackReport) {
  if (atsBadgeSuppressed) return;
  const job = importedJobsSelectedId ? importedJobsById[importedJobsSelectedId] : null;
  renderAtsBadge(atsReportForJob(job) || fallbackReport || lastAtsReport);
}

async function refreshAtsBadge() {
  const data = await chrome.storage.local.get("last_ats_report");
  renderAtsForCurrentJob(rememberAtsReport(data.last_ats_report));
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

const RESUME_FILENAME_PATTERN_KEY = "resume_filename_pattern";
const DEFAULT_RESUME_FILENAME_PATTERN = "{name}_Resume";

function previewResumeFilename(pattern) {
  const person = "Steven_Avon";
  const first = "Steven";
  const last = "Avon";
  const company = String(companyNameEl?.value || "").trim() || "Acme";
  const title = String(jobTitleEl?.value || "").trim() || "Engineer";
  const date = new Date().toISOString().slice(0, 10);
  const tokens = {
    name: person,
    fullname: "Steven Avon",
    first,
    last,
    company: company.replace(/\s+/g, "_"),
    title: title.replace(/\s+/g, "_"),
    role: title.replace(/\s+/g, "_"),
    date
  };
  let out = String(pattern || "").trim() || DEFAULT_RESUME_FILENAME_PATTERN;
  out = out.replace(/\.(pdf|html)$/i, "");
  out = out.replace(/\{([a-z_]+)\}/gi, (_, key) => {
    const value = tokens[String(key || "").toLowerCase()];
    return value != null ? String(value) : "";
  });
  out = out.replace(/\s+/g, "_").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
  out = out.replace(/_+/g, "_").replace(/^_+|_+$/g, "") || "Resume";
  return `${out}.pdf`;
}

function updateResumeFilenameExample() {
  if (!resumeFilenameExampleEl) return;
  const pattern = resumeFilenamePatternEl?.value || DEFAULT_RESUME_FILENAME_PATTERN;
  resumeFilenameExampleEl.textContent = previewResumeFilename(pattern);
}

async function loadResumeFilenamePattern() {
  const data = await chrome.storage.local.get(RESUME_FILENAME_PATTERN_KEY);
  const raw = String(data[RESUME_FILENAME_PATTERN_KEY] || "").trim();
  if (resumeFilenamePatternEl) {
    resumeFilenamePatternEl.value = raw || DEFAULT_RESUME_FILENAME_PATTERN;
  }
  updateResumeFilenameExample();
}

async function persistResumeFilenamePattern() {
  if (!resumeFilenamePatternEl) return;
  let value = String(resumeFilenamePatternEl.value || "").trim();
  if (!value) value = DEFAULT_RESUME_FILENAME_PATTERN;
  resumeFilenamePatternEl.value = value;
  await chrome.storage.local.set({ [RESUME_FILENAME_PATTERN_KEY]: value });
  updateResumeFilenameExample();
}

async function refreshOutputDirLabel() {
  const name = await getOutputDirectoryName();
  outputDirLabelEl.value = name || "";
  outputDirLabelEl.placeholder = name ? name : "No folder selected";
  if (outputDirAbsPathEl) {
    const abs = await getOutputDirectoryAbsolutePath();
    outputDirAbsPathEl.value = abs || "";
    outputDirAbsPathEl.placeholder = name
      ? `Paste full path to "${name}" (e.g. D:\\Bid\\BR-AI\\${name})`
      : "e.g. D:\\Bid\\BR-AI\\09-01W";
  }
  await refreshCopyResumePathBtn();
}

async function persistOutputAbsolutePathFromInput() {
  if (!outputDirAbsPathEl) return "";
  const path = await setOutputDirectoryAbsolutePath(outputDirAbsPathEl.value);
  outputDirAbsPathEl.value = path;
  await refreshCopyResumePathBtn();
  return path;
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
    // Picker already grants access; reaffirm so later silent saves work this session.
    await unlockOutputDirectory({ interactive: true });
    outputDirLabelEl.value = name;
    awaitingFolderPermission = false;
    hidePermissionBanner();

    // Chrome only returns the leaf folder name — ask for the absolute path once.
    const prevAbs = await getOutputDirectoryAbsolutePath();
    let suggestion = prevAbs;
    if (!suggestion) {
      suggestion = `D:\\Bid\\BR-AI\\${name}`;
    } else {
      const leaf = suggestion.split(/[/\\]/).filter(Boolean).pop() || "";
      if (leaf.toLowerCase() !== String(name).toLowerCase()) {
        suggestion = `${suggestion.replace(/[\\/]+$/, "")}\\${name}`;
      }
    }
    const typed = window.prompt(
      `Chrome cannot read the full disk path.\n\nPaste the absolute path to the folder you just selected ("${name}"):`,
      suggestion
    );
    if (typed != null && String(typed).trim()) {
      const abs = await setOutputDirectoryAbsolutePath(typed);
      if (outputDirAbsPathEl) outputDirAbsPathEl.value = abs;
      setStatus(`Output folder set: ${abs || name}`);
    } else {
      setStatus(
        `Output folder set: ${name}. Paste its absolute path below so Copy path works in Explorer.`
      );
    }
    await refreshCopyResumePathBtn();
  } catch (err) {
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setStatus("Folder selection canceled.");
      return;
    }
    setStatus(`Could not select folder: ${String(err.message || err)}`);
  }
}

/**
 * Request folder write access while this click is still a user gesture.
 * Must be the FIRST await on Generate / Batch / Save — later awaits burn the gesture.
 */
async function unlockFolderForSession({ quiet = false } = {}) {
  const unlocked = await unlockOutputDirectory({ interactive: true });
  if (unlocked.ok) {
    awaitingFolderPermission = false;
    hidePermissionBanner();
    return true;
  }
  if (unlocked.status === "missing") {
    if (!quiet) {
      setStatus(unlocked.error || 'Click "Select folder" first.', "error");
    }
    return false;
  }
  awaitingFolderPermission = true;
  showPermissionBanner("");
  armPermissionRetryOnNextGesture();
  if (!quiet) {
    setStatus(
      unlocked.error ||
        "Click Unlock once. If Chrome asks, choose Allow on every visit so saves keep working.",
      "error"
    );
  }
  return false;
}

/**
 * Chrome often revokes File System Access while this panel is backgrounded during
 * a long generate. Detect that early so Unlock can run before PDFs are ready.
 */
async function refreshFolderPermissionBanner() {
  try {
    const handle = await getOutputDirectoryHandle();
    if (!handle) {
      hidePermissionBanner();
      return;
    }
    const state = await queryDirectoryPermission(handle);
    const usable = state === "granted" && (await probeDirectoryAccess(handle));
    if (usable) {
      awaitingFolderPermission = false;
      if (!((await chrome.storage.local.get("pending_fs_write")).pending_fs_write)) {
        hidePermissionBanner();
      }
      return;
    }
    awaitingFolderPermission = true;
    showPermissionBanner("");
    armPermissionRetryOnNextGesture();
  } catch {
    /* best-effort */
  }
}

function showSaveBanner(pathLabel) {
  if (!saveBannerEl || !saveBannerPathEl) return;
  const label = pathLabel || "Files saved successfully.";
  saveBannerPathEl.textContent = label;
  saveBannerPathEl.title = label;
  const textEl = saveBannerEl.querySelector(".save-banner-text");
  if (textEl) textEl.hidden = false;
  saveBannerEl.hidden = false;
}

function hideSaveBanner() {
  // Keep Preview / Copy path / Folder on the file card; only clear the path line.
  if (!saveBannerEl) return;
  if (saveBannerPathEl) {
    saveBannerPathEl.textContent = "";
    saveBannerPathEl.title = "";
  }
  const textEl = saveBannerEl.querySelector(".save-banner-text");
  if (textEl) textEl.hidden = true;
  saveBannerEl.hidden = false;
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
  return (await buildResumeFolderAbsolutePath(folder)) || folder;
}

function formatPathForClipboard(pathLabel) {
  const raw = String(pathLabel || "").trim();
  if (!raw) return "";
  // Already looks like an absolute Windows/UNC path — keep as-is.
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return normalizeAbsoluteDirectoryPath(raw);
  }
  return raw.replace(/\s*\/\s*/g, "\\").trim();
}

async function resolveResumeFolderPath() {
  const selectedJob = importedJobsSelectedId ? importedJobsById[importedJobsSelectedId] : null;
  if (selectedJob) {
    const folder = resumeFolderNameForJob(selectedJob);
    if (folder) {
      const abs = await buildResumeFolderAbsolutePath(folder);
      if (abs) return abs;
    }
    try {
      const docs = await getGeneratedDocsForJob(importedJobsSelectedId);
      const docsFolder = sanitizeJobFolderName(docs?.folderName || "");
      if (docsFolder && docsFolder !== "untitled") {
        return await buildResumeFolderAbsolutePath(docsFolder);
      }
    } catch {
      /* ignore */
    }
  }

  const meta = await getLastSaveMeta();
  const metaFolder = sanitizeJobFolderName(meta?.folderName || "");
  if (metaFolder && metaFolder !== "untitled") {
    return await buildResumeFolderAbsolutePath(metaFolder);
  }
  if (meta?.pathLabel) {
    // Prefer rebuilding from absolute root when pathLabel is relative-only.
    const rebuilt = await buildResumeFolderAbsolutePath(
      String(meta.pathLabel).split(/[/\\]/).filter(Boolean).pop() || ""
    );
    if (rebuilt && (await getOutputDirectoryAbsolutePath())) return rebuilt;
    return meta.pathLabel;
  }

  try {
    const data = await chrome.storage.local.get("last_upload_docs_meta");
    const uploadMeta = data.last_upload_docs_meta;
    const uploadFolder = sanitizeJobFolderName(uploadMeta?.folderName || "");
    if (uploadFolder && uploadFolder !== "untitled") {
      return await buildResumeFolderAbsolutePath(uploadFolder);
    }
  } catch {
    /* ignore */
  }

  const pending = await chrome.storage.local.get(["pending_fs_folder", "last_output_dir"]);
  const folder = String(pending.pending_fs_folder || pending.last_output_dir || "").trim();
  if (folder) {
    return await buildResumeFolderAbsolutePath(folder);
  }
  return "";
}

/**
 * Resolved clipboard text for the Copy path button, kept warm so the click
 * handler can copy without awaiting anything first (see copyResumeFolderPath).
 */
let cachedResumeFolderPath = "";

function isAbsoluteDiskPath(text) {
  const raw = String(text || "");
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
}

async function refreshCopyResumePathBtn() {
  if (!copyResumePathBtn) return;
  const path = await resolveResumeFolderPath();
  cachedResumeFolderPath = path ? formatPathForClipboard(path) : "";
  copyResumePathBtn.disabled = !cachedResumeFolderPath;
  copyResumePathBtn.title = cachedResumeFolderPath
    ? `Copy resume folder path: ${cachedResumeFolderPath}`
    : "Generate a resume first to copy its folder path";
}

/**
 * Copy synchronously via a hidden textarea.
 *
 * navigator.clipboard.writeText() needs the document focused AND a live user
 * gesture; in the side panel the panel often is not the focused document, and
 * any await before the call spends the gesture. execCommand has neither
 * requirement as long as we run inside the click handler itself.
 */
function copyTextSync(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function reportCopiedPath(text) {
  if (isAbsoluteDiskPath(text)) {
    setStatus(`Copied path: ${text}`, "done");
    return;
  }
  // Copied, but only the folder name — the absolute root was never configured.
  setStatus(
    `Copied "${text}", but that is not a full disk path. Set Absolute path under ` +
      "Scrape & save (e.g. D:\\Bid\\US BId\\09-01W) so Copy path returns the full folder.",
    "error"
  );
  outputDirAbsPathEl?.focus();
}

/**
 * Runs synchronously from the click so the clipboard write keeps the user
 * gesture. Falls back to resolving the path on demand when the cache is cold.
 */
function copyResumeFolderPath() {
  const cached = cachedResumeFolderPath;
  if (cached && copyTextSync(cached)) {
    reportCopiedPath(cached);
    refreshCopyResumePathBtn().catch(() => {});
    return;
  }

  (async () => {
    const path = cached || formatPathForClipboard(await resolveResumeFolderPath());
    if (!path) {
      setStatus("No resume folder yet — generate a resume first.", "error");
      return;
    }
    if (copyTextSync(path)) {
      reportCopiedPath(path);
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      reportCopiedPath(path);
    } catch (err) {
      setStatus(
        `Could not copy path (${String(err.message || err)}). Copy it manually: ${path}`,
        "error"
      );
    }
  })().catch((err) => setStatus(String(err.message || err), "error"));
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
    const jobReport = atsReportForJob(job);
    if (jobReport) rememberAtsReport(jobReport);
    renderAtsForCurrentJob();
    if (jobReport) {
      chrome.storage.local.set({ last_ats_report: jobReport }).catch(() => {});
    }
    await refreshCopyResumePathBtn();
    return;
  }
  const meta = await getLastSaveMeta();
  if (meta?.pathLabel) showSaveBanner(meta.pathLabel);
  else hideSaveBanner();
  await refreshCopyResumePathBtn();
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
  if (isGreenhouseSource(source)) return "Greenhouse";
  if (isWorkdaySource(source)) return "Workday";
  if (isIndeedSource(source)) return "Indeed";
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
    // First load / no preference yet — check every unfinished job by default.
    for (const id of importedJobsOrder) {
      const status = importedJobsById[id]?.status;
      if (status !== "unavailable" && status !== "completed") importedJobsChecked.add(String(id));
    }
    persistCheckedJobs();
  }

  renderImportedJobs();
}

function setImportedJobsFilter(filter, { persist = true } = {}) {
  const allowed = ["all", "dice", "greenhouse", "workday", "indeed", "jobright", "linkedin", "others"];
  importedJobsFilter = allowed.includes(filter) ? filter : "all";
  filterAllJobsBtn?.classList.toggle("is-active", importedJobsFilter === "all");
  filterDiceJobsBtn?.classList.toggle("is-active", importedJobsFilter === "dice");
  filterGreenhouseJobsBtn?.classList.toggle("is-active", importedJobsFilter === "greenhouse");
  filterWorkdayJobsBtn?.classList.toggle("is-active", importedJobsFilter === "workday");
  filterIndeedJobsBtn?.classList.toggle("is-active", importedJobsFilter === "indeed");
  filterJobrightJobsBtn?.classList.toggle("is-active", importedJobsFilter === "jobright");
  filterLinkedInJobsBtn?.classList.toggle("is-active", importedJobsFilter === "linkedin");
  filterOtherJobsBtn?.classList.toggle("is-active", importedJobsFilter === "others");
  if (persist) {
    chrome.storage.local.set({ imported_jobs_filter: importedJobsFilter }).catch(() => {});
  }
  renderImportedJobs();
}

function setImportedJobsStatusFilter(filter, { persist = true } = {}) {
  const allowed = [
    "all",
    "queued",
    "resume_ready",
    "ready",
    "review",
    "applied",
    "failed",
    "blocked",
    "progress"
  ];
  importedJobsStatusFilter = allowed.includes(filter) ? filter : "all";
  for (const btn of jobStatusFilterBtns) {
    btn.classList.toggle("is-active", btn.dataset.status === importedJobsStatusFilter);
  }
  if (persist) {
    chrome.storage.local
      .set({ imported_jobs_status_filter: importedJobsStatusFilter })
      .catch(() => {});
  }
  renderImportedJobs();
}

function jobHasResumeReady(job) {
  if (!job) return false;
  if (job.hasGeneratedResume) return true;
  if (resumeFolderNameForJob(job)) return true;
  if (Number(job.atsScore) > 0) return true;
  if (String(job.resumeFileName || "").trim()) return true;
  return false;
}

/** Sidebar status buckets used by the category chips. */
function importedJobStatusCategory(job) {
  const s = String(job?.status || "").trim();
  if (s === "completed") return "applied";
  if (s === "unavailable") return "blocked";
  if (s === "failed" || s === "check_failed") return "failed";
  if (s === "ready_for_review") return "ready";
  if (s === "needs_review") return "review";
  if (["opening", "generating", "opening_form", "filling"].includes(s)) return "progress";
  if (jobHasResumeReady(job)) return "resume_ready";
  return "queued";
}

function importedJobMatchesSearch(job) {
  const q = String(importedJobsSearchQuery || "").trim().toLowerCase();
  if (!q) return true;
  const title = String(job?.jobTitle || "").toLowerCase();
  const company = String(job?.companyName || "").toLowerCase();
  return title.includes(q) || company.includes(q);
}

function importedJobMatchesFilter(job) {
  if (!importedJobMatchesSearch(job)) return false;
  if (importedJobsStatusFilter !== "all" && importedJobStatusCategory(job) !== importedJobsStatusFilter) {
    return false;
  }
  const source = String(job?.source || "").trim().toLowerCase();
  if (importedJobsFilter === "dice") return isDiceSource(source);
  if (importedJobsFilter === "greenhouse") return isGreenhouseSource(source);
  if (importedJobsFilter === "workday") return isWorkdaySource(source);
  if (importedJobsFilter === "indeed") return isIndeedSource(source);
  if (importedJobsFilter === "jobright") return isJobrightSource(source);
  if (importedJobsFilter === "linkedin") return isLinkedInSource(source);
  if (importedJobsFilter === "others") {
    return (
      !isLinkedInSource(source) &&
      !isDiceSource(source) &&
      !isJobrightSource(source) &&
      !isGreenhouseSource(source) &&
      !isWorkdaySource(source) &&
      !isIndeedSource(source)
    );
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
  const visible = visibleImportedJobIds();
  const selectedVisible = visible.filter((id) => importedJobsChecked.has(id));
  const batchableSelected = selectedVisible.filter((id) => {
    const status = String(importedJobsById[id]?.status || "");
    return status !== "completed" && status !== "unavailable";
  });
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
    batchGenerateBtn.disabled = batchableSelected.length === 0;
  }
  if (batchApplyBtn) {
    batchApplyBtn.disabled = applyReady.length === 0;
  }
  if (batchRemoveBtn) {
    batchRemoveBtn.disabled = selectedVisible.length === 0;
  }
  if (checkAvailabilityBtn) {
    checkAvailabilityBtn.disabled = batchableSelected.length === 0;
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
    check.title = isCompleted
      ? "Select to remove this applied job from the list"
      : "Select for batch actions (Resumes / Apply / Remove)";
    check.checked = importedJobsChecked.has(jobId);
    check.disabled = false;
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
      const status = String(job.status || "");
      const canSubmit = status === "ready_for_review";
      const retry = ["failed", "needs_review", "check_failed"].includes(status);
      applySummaryBtn.textContent = canSubmit ? "Submit" : retry ? "Retry" : "Apply";
      applySummaryBtn.disabled = false;
      applySummaryBtn.classList.toggle("is-submit", canSubmit);
      applySummaryBtn.title = canSubmit
        ? "Submit the filled application on the open form tab"
        : "Apply (Alt+Enter when this job is selected)";
      applySummaryBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await applyImportedJob(jobId, { preferSubmit: canSubmit });
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
    if (
      (job.status === "failed" || job.status === "check_failed" || isUnavailable) &&
      err
    ) {
      const errP = document.createElement("p");
      errP.className =
        job.status === "check_failed" || isUnavailable ? "job-error is-warn" : "job-error";
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
    const hasSearchOrStatus =
      Boolean(String(importedJobsSearchQuery || "").trim()) || importedJobsStatusFilter !== "all";
    importedJobsListEl.innerHTML = hasSearchOrStatus
      ? '<p class="import-status" style="margin:0">No jobs match this search or status filter.</p>'
      : '<p class="import-status" style="margin:0">No pending jobs match this filter.</p>';
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
  await rememberJobStatus(job).catch(() => {});
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
  // Archive before dropping them, so re-importing these roles later shows their status.
  await rememberJobStatuses(removable.map((id) => byId[id]).filter(Boolean)).catch(() => {});
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
  // Unlock first — collectBatchGenerateSettings awaits storage and burns the gesture.
  if (!(await unlockFolderForSession())) return;

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

  if (!(await unlockFolderForSession())) return;

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
    pauseMs: 500
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

/**
 * Replace the job queue with a new CSV/sheet import.
 * The visible list becomes ONLY actionable new roles — skipped / duplicate /
 * already-applied / already-on-sheet rows are excluded from storage entirely.
 */
async function replaceImportedJobsFromCsv(jobs) {
  const now = Date.now();
  const stored = await chrome.storage.local.get([
    "imported_jobs_by_id",
    "spreadsheet_url",
    "sheets_web_app_url",
    "sheets_sheet_name"
  ]);
  const previousById =
    stored.imported_jobs_by_id && typeof stored.imported_jobs_by_id === "object"
      ? stored.imported_jobs_by_id
      : importedJobsById || {};

  // Archive whatever is currently queued so re-imports can detect prior outcomes.
  await rememberJobStatuses(Object.values(previousById)).catch(() => {});
  const statusMemory = await readJobStatusMemory();
  const appliedCompanyTitles = collectAppliedCompanyTitleKeys(
    statusMemory,
    Object.values(previousById)
  );

  const sheetLinks = new Set();
  const addLinkKeys = (url, into) => {
    const raw = String(url || "").trim();
    if (!raw) return;
    for (const key of [
      normalizeJobLink(raw).toLowerCase(),
      normalizeSheetJobLink(raw).toLowerCase()
    ]) {
      if (key) into.add(key);
    }
    try {
      const u = new URL(normalizeJobLink(raw) || raw);
      const bare = `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
      if (bare) into.add(bare);
    } catch {
      /* ignore */
    }
  };
  const linkIsKnown = (url, into) => {
    const probe = new Set();
    addLinkKeys(url, probe);
    for (const key of probe) {
      if (into.has(key)) return true;
    }
    return false;
  };

  const spreadsheetUrl = String(stored.spreadsheet_url || "").trim();
  const webAppUrl = String(stored.sheets_web_app_url || "").trim();
  const sheetName = String(stored.sheets_sheet_name || "").trim();
  if (spreadsheetUrl && webAppUrl) {
    try {
      const links = await getExistingJobLinks({ spreadsheetUrl, webAppUrl, sheetName });
      for (const link of links || []) addLinkKeys(link, sheetLinks);
    } catch {
      /* sheet lookup is best-effort for dedupe */
    }
  }

  // Also treat application-log "completed" URLs as already worked.
  try {
    const log = await getApplicationLog();
    for (const event of log || []) {
      if (String(event?.status || "") !== "completed") continue;
      addLinkKeys(event.jdLink, sheetLinks);
      const ct = companyTitleKey({
        companyName: event.companyName,
        jobTitle: event.jobTitle
      });
      if (ct) appliedCompanyTitles.add(ct);
    }
  } catch {
    /* best-effort */
  }

  const doneStatuses = new Set(["completed", "unavailable", "already_applied"]);
  const csvDoneStatusRe =
    /^(applied|completed|already\s*applied|closed|unavailable|no longer available|filled|expired|rejected|withdrawn)$/i;

  const byId = {};
  const order = [];
  const seenInFile = new Set();
  const seenCompanyTitlesInFile = new Set();
  const seenLinksInFile = new Set();
  let imported = 0;
  let skippedDone = 0;
  let skippedOnSheet = 0;
  let skippedCompanyTitle = 0;
  let skippedCsvStatus = 0;
  let duplicateIds = 0;

  for (const job of jobs) {
    const id = String(job.id || "").trim();
    if (!id) continue;
    if (seenInFile.has(id)) {
      duplicateIds += 1;
      continue;
    }
    seenInFile.add(id);

    const linkRaw = job.jdLink || job.url || "";
    const ctKey = companyTitleKey(job);
    const csvStatus = String(job.csvStatus || job.applicationStatus || "").trim();

    // Sheet/CSV already marked applied or closed — never put in the work queue.
    if (csvStatus && csvDoneStatusRe.test(csvStatus)) {
      skippedCsvStatus += 1;
      if (ctKey) appliedCompanyTitles.add(ctKey);
      addLinkKeys(linkRaw, sheetLinks);
      continue;
    }

    const remembered = lookupJobStatus(statusMemory, job);
    const rememberedStatus = String(remembered?.status || "").trim();
    if (doneStatuses.has(rememberedStatus)) {
      skippedDone += 1;
      if (ctKey) appliedCompanyTitles.add(ctKey);
      addLinkKeys(linkRaw, sheetLinks);
      continue;
    }
    if (linkRaw && linkIsKnown(linkRaw, sheetLinks)) {
      skippedOnSheet += 1;
      if (ctKey) appliedCompanyTitles.add(ctKey);
      continue;
    }
    // Same company + same title as an already-applied role → skip (other titles OK).
    if (ctKey && appliedCompanyTitles.has(ctKey)) {
      skippedCompanyTitle += 1;
      continue;
    }
    if (ctKey && seenCompanyTitlesInFile.has(ctKey)) {
      skippedCompanyTitle += 1;
      continue;
    }
    const linkKey = normalizeJobLink(linkRaw).toLowerCase();
    if (linkKey && seenLinksInFile.has(linkKey)) {
      duplicateIds += 1;
      continue;
    }

    const { csvStatus: _csvStatus, applicationStatus: _appStatus, ...jobFields } = job;
    byId[id] = {
      ...jobFields,
      status: "imported",
      attempts: 0,
      statusDetail: "",
      createdAt: now,
      updatedAt: now
    };
    order.push(id);
    if (ctKey) seenCompanyTitlesInFile.add(ctKey);
    if (linkKey) seenLinksInFile.add(linkKey);
    imported += 1;
  }

  // Work-queue only: never keep prior roles in storage after a sheet/CSV import.
  const checked = order.slice();
  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: null,
    imported_jobs_checked_ids: checked,
    imported_jobs_version: now,
    imported_jobs_status_filter: "all",
    imported_jobs_search: ""
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsSelectedId = null;
  importedJobsSearchQuery = "";
  if (jobListSearchEl) jobListSearchEl.value = "";
  importedJobsChecked.clear();
  for (const id of checked) importedJobsChecked.add(id);
  importedJobsVersion = now;
  setImportedJobsStatusFilter("all", { persist: false });
  renderImportedJobs();

  return {
    imported,
    skippedDone,
    skippedOnSheet,
    skippedCompanyTitle,
    skippedCsvStatus,
    duplicateIds,
    replaced: Object.keys(previousById).length
  };
}

/**
 * @deprecated Prefer replaceImportedJobsFromCsv for CSV Import.
 * Kept for scrape/capture paths that intentionally merge into the queue.
 */
async function mergeImportedJobs(jobs) {
  const now = Date.now();
  const statusMemory = await readJobStatusMemory();
  const stored = await chrome.storage.local.get([
    "imported_jobs_by_id",
    "imported_jobs_order",
    "imported_jobs_checked_ids"
  ]);
  const byId = { ...(stored.imported_jobs_by_id || importedJobsById || {}) };
  const order = Array.isArray(stored.imported_jobs_order)
    ? stored.imported_jobs_order.slice()
    : importedJobsOrder.slice();
  const seenInFile = new Set();
  let added = 0;
  let alreadyQueued = 0;
  let duplicateIds = 0;

  for (const job of jobs) {
    const id = String(job.id || "").trim();
    if (!id) continue;
    if (seenInFile.has(id)) {
      duplicateIds += 1;
      continue;
    }
    seenInFile.add(id);

    const existing = byId[id];
    if (existing) {
      alreadyQueued += 1;
      const next = { ...existing };
      if (!String(next.jdText || "").trim() && String(job.jdText || "").trim()) {
        next.jdText = job.jdText;
      }
      if (!String(next.jobTitle || "").trim() && job.jobTitle) next.jobTitle = job.jobTitle;
      if (!String(next.companyName || "").trim() && job.companyName) {
        next.companyName = job.companyName;
      }
      next.updatedAt = now;
      byId[id] = next;
      continue;
    }

    byId[id] = applyRememberedStatus(
      {
        ...job,
        status: "imported",
        attempts: 0,
        statusDetail: "",
        createdAt: now,
        updatedAt: now
      },
      statusMemory
    );
    order.unshift(id);
    added += 1;
    importedJobsChecked.add(id);
  }

  const checked = Array.isArray(stored.imported_jobs_checked_ids)
    ? stored.imported_jobs_checked_ids.map(String)
    : [...importedJobsChecked];
  const checkedSet = new Set(checked);
  const doneStatuses = new Set(["completed", "unavailable"]);
  for (const id of seenInFile) {
    if (byId[id] && !doneStatuses.has(String(byId[id].status || ""))) checkedSet.add(id);
  }

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: importedJobsSelectedId,
    imported_jobs_checked_ids: [...checkedSet],
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsChecked.clear();
  for (const id of checkedSet) {
    if (byId[id]) importedJobsChecked.add(id);
  }
  importedJobsVersion = now;

  renderImportedJobs();

  return { imported: added, alreadyQueued, duplicateIds };
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

async function applyImportedJob(jobId, { preferSubmit = false } = {}) {
  const job = importedJobsById[jobId];
  if (!job) {
    setStatus("Job not found in imported list.");
    return;
  }

  // Unlock first while the Apply click is still a user gesture.
  const unlocked = await unlockFolderForSession({ quiet: true });

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

  if (!unlocked) {
    // Still allow Apply if PDFs already exist; only block when we know we need a write.
    const docs = await getGeneratedDocsForJob(jobId).catch(() => null);
    if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) {
      setStatus(
        "Click Unlock once to allow saving resumes for this browser session, then Apply again.",
        "error"
      );
      return;
    }
  }

  const wantsSubmit = preferSubmit || String(job.status || "") === "ready_for_review";
  if (wantsSubmit) {
    setStatus(`Submitting application: ${job.jobTitle || jobId}`, "running");
    try {
      const res = await chrome.runtime.sendMessage({
        type: "autofill_current_page",
        profileId: collected.profileId,
        preferredAction: "submit",
        importedJobId: jobId
      });
      if (!res?.ok) {
        throw new Error(res?.error || "Submit failed.");
      }
      if (res.button) await applyAutofillButtonState(res.button);
      setStatus(res.status || "Submitted.");
      return res;
    } catch (err) {
      setStatus(`Submit failed: ${String(err?.message || err)}`, "error");
      return;
    }
  }

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
  await rememberJobStatus(byId[jobId]).catch(() => {});

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
      ? `Waiting to write ${folderName} — click Unlock (choose Allow on every visit if offered)`
      : "Chrome revoked folder access (common while generating). Click Unlock once — prefer Allow on every visit.";
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
    "ai_form_plan_enabled",
    "imported_jobs_filter",
    "imported_jobs_status_filter",
    "imported_jobs_search",
    "scraped_job_meta",
    "generate_resume_only",
    "preview_mode_enabled",
    "ats_rewrite_enabled",
    "ui_panel_mode",
    "last_ats_report",
    RESUME_FILENAME_PATTERN_KEY
  ]);
  scrapedJobMeta = data.scraped_job_meta || null;

  await refreshProfiles(data.selected_profile_id || DEFAULT_PROFILE_ID);
  await refreshTemplates(data.selected_template_id || templateIdForProfile(profileSelectEl.value));
  jobTitleEl.value = data.last_job_title || "";
  companyNameEl.value = data.last_company_name || "";
  jdLinkEl.value = data.last_jd_link || "";
  jdTextEl.value = data.last_jd_text || "";
  if (resumeFilenamePatternEl) {
    const pattern = String(data[RESUME_FILENAME_PATTERN_KEY] || "").trim();
    resumeFilenamePatternEl.value = pattern || DEFAULT_RESUME_FILENAME_PATTERN;
    updateResumeFilenameExample();
  }
  await applySheetPresetForProfile(profileSelectEl.value);
  await refreshAtsBadge();

  if (aiQaSectionEl) aiQaSectionEl.open = Boolean(data.ui_ai_qa_section_open);
  if (qaBankSectionEl) qaBankSectionEl.open = Boolean(data.ui_qa_bank_section_open);
  if (qaLearnToggleEl) qaLearnToggleEl.checked = data.qa_learn_enabled !== false;
  if (aiFormPlanToggleEl) aiFormPlanToggleEl.checked = data.ai_form_plan_enabled !== false;
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
  if (atsRewriteToggleEl) {
    // Default OFF — never rewrite in the background unless asked.
    atsRewriteToggleEl.checked = data.ats_rewrite_enabled === true;
    updateAtsRewriteToggleLabel();
  }
  updateGenerateButtonLabel();
  setImportedJobsFilter(data.imported_jobs_filter || "all", { persist: false });
  setImportedJobsStatusFilter(data.imported_jobs_status_filter || "all", { persist: false });
  importedJobsSearchQuery = String(data.imported_jobs_search || "");
  if (jobListSearchEl) jobListSearchEl.value = importedJobsSearchQuery;
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
  } else {
    await refreshFolderPermissionBanner();
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
  // Unlock first while the click gesture is still active.
  if (!(await unlockFolderForSession())) return { ok: false };

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

async function upsertScrapedJobIntoList(d, { site = "", tabUrl = "" } = {}) {
  const jdLink = String(d.jdLink || tabUrl || "").trim();
  if (!jdLink) return "";
  const id = jobIdFromLink(jdLink);
  if (!id) return "";
  const now = Date.now();
  let existing = importedJobsById[id];
  if (!existing) {
    // Not in the list right now — fall back to what we remember about this job,
    // so re-scraping a role you removed earlier shows its real status again.
    const restored = applyRememberedStatus({ id, jdLink }, await readJobStatusMemory());
    if (restored.status) existing = restored;
  }
  const keepStatus = existing?.status === "completed" || existing?.status === "unavailable";
  const job = {
    ...(existing || {}),
    id,
    jobTitle: d.jobTitle || existing?.jobTitle || "",
    companyName: d.companyName || existing?.companyName || "",
    jdLink,
    jdText: d.jdText || existing?.jdText || "",
    source: site || existing?.source || "",
    workArrangement: d.workArrangement || existing?.workArrangement || "",
    employmentType: d.employmentType || existing?.employmentType || "",
    salaryMin: d.salaryMin || existing?.salaryMin || "",
    salaryMax: d.salaryMax || existing?.salaryMax || "",
    datePosted: d.datePosted || existing?.datePosted || "",
    status: keepStatus ? existing.status : existing?.status || "imported",
    statusDetail: keepStatus
      ? existing.statusDetail || ""
      : "Scraped from the open tab.",
    updatedAt: now,
    createdAt: existing?.createdAt || now
  };
  const byId = { ...importedJobsById, [id]: job };
  const order = importedJobsOrder.includes(id) ? importedJobsOrder : [id, ...importedJobsOrder];
  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsSelectedId = id;
  importedJobsChecked.add(id);
  importedJobsVersion = now;
  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_order: order,
    imported_jobs_selected_id: id,
    imported_jobs_checked_ids: [...importedJobsChecked],
    imported_jobs_version: now
  });
  renderImportedJobs();
  return id;
}

/**
 * Scrape the open job tab.
 * @param {{ continueApply?: boolean }} [opts]
 *   continueApply false (default): add job details to the imported list only.
 *   continueApply true: generate resume then Auto Apply (Alt+Shift+S / Scrape & Apply).
 */
async function scrapeCurrentJobPage({ continueApply = false } = {}) {
  setStatus("Scraping the open job page...", "running");
  setBusy(true);
  if (scrapePageBtn) scrapePageBtn.disabled = true;
  if (scrapeAndApplyBtn) scrapeAndApplyBtn.disabled = true;
  try {
    const siteId = "auto";
    const res = await chrome.runtime.sendMessage({ type: "scrape_current_page", siteId });
    if (!res?.ok) {
      throw new Error(res?.error || "Could not scrape this page.");
    }

    const d = res.jobData || {};
    jobTitleEl.value = d.jobTitle || "";
    companyNameEl.value = d.companyName || "";
    if (d.jdLink) jdLinkEl.value = d.jdLink;
    else if (res.tabUrl) jdLinkEl.value = res.tabUrl;
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
    const scrapedSite = String(res.site || "").trim();
    const jobId = await upsertScrapedJobIntoList(d, {
      site: scrapedSite,
      tabUrl: res.tabUrl || ""
    });
    setSidebarMode("imported");

    const siteLabel = scrapedSite ? ` (${scrapedSite})` : "";
    if (!jobId) {
      setStatus(
        `Scraped${siteLabel}: ${d.jobTitle || "job"}, but there is no job URL to add to the list.`,
        "error"
      );
      return;
    }
    if (!d.companyName) {
      setStatus(
        `Added to job list${siteLabel}: ${d.jobTitle || "job"} — company missing; fill it before batch build.`,
        "error"
      );
      companyNameEl.focus();
      return;
    }

    // Default: queue only — batch resume build / Apply later from the job list.
    if (!continueApply) {
      setStatus(
        `Added to job list${siteLabel}: ${d.jobTitle || "job"} @ ${d.companyName}. Use Batch Resumes when ready.`
      );
      return;
    }

    setStatus(
      `Scraped${siteLabel}: ${d.jobTitle || "job"} @ ${d.companyName}. Generating resume…`,
      "running"
    );

    const gen = await startGenerationAndWait();
    if (!gen.ok) return;

    setStatus("Resume saved. Applying (same as the job-card Apply button)…", "running");
    setBusy(true);
    await applyImportedJob(jobId);
  } catch (err) {
    setStatus(`Scrape failed: ${String(err.message || err)}`, "error");
  } finally {
    setBusy(false);
    if (scrapePageBtn) scrapePageBtn.disabled = false;
    if (scrapeAndApplyBtn) scrapeAndApplyBtn.disabled = false;
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
    generate_resume_only: isResumeOnlyEnabled(),
    ats_rewrite_enabled: isAtsRewriteEnabled()
  });

  return {
    profileId,
    jobMeta: {
      outputDir: outputFolderName,
      spreadsheetUrl: sheet.spreadsheetUrl,
      sheetName: sheet.sheetName,
      sheetsWebAppUrl: sheet.sheetsWebAppUrl,
      templateId,
      trackApplicationStatus: sheet.trackApplicationStatus,
      // Pinned at click time so toggling mid-batch cannot change a running build.
      atsRewriteEnabled: isAtsRewriteEnabled()
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
    salaryMin: selJob.salaryMin || "",
    salaryMax: selJob.salaryMax || ""
  });
  try {
    await navigator.clipboard.writeText(tsv);
    setStatus(
      "Sheet row copied (No → Status). Click column A of an empty row in Sheets, then paste (Ctrl+V)."
    );
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
    generate_resume_only: isResumeOnlyEnabled(),
    ats_rewrite_enabled: isAtsRewriteEnabled()
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
      trackApplicationStatus: sheet.trackApplicationStatus,
      atsRewriteEnabled: isAtsRewriteEnabled()
    }
  };
}

function setBusy(busy) {
  if (generateResumeBtn) generateResumeBtn.disabled = busy;
  if (autofillBtn) autofillBtn.disabled = busy;
  if (generateAiAnswerBtn) generateAiAnswerBtn.disabled = busy;
  if (scrapePageBtn) scrapePageBtn.disabled = busy;
  if (scrapeAndApplyBtn) scrapeAndApplyBtn.disabled = busy;
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
  const resumeOnly = isResumeOnlyEnabled();
  const labelEl = generateResumeBtn.querySelector(".btn-label");
  if (labelEl) labelEl.textContent = resumeOnly ? "Resume" : "Generate";
  generateResumeBtn.title = resumeOnly
    ? "Generate resume only — no cover letter (Alt+Shift+G)"
    : "Generate resume & cover letter (Alt+Shift+G)";
}

async function persistResumeOnlySetting() {
  await chrome.storage.local.set({ generate_resume_only: isResumeOnlyEnabled() });
  updateGenerateButtonLabel();
}

/** Off (default) = score the resume but never rewrite it. */
function isAtsRewriteEnabled() {
  return atsRewriteToggleEl ? Boolean(atsRewriteToggleEl.checked) : false;
}

function updateAtsRewriteToggleLabel() {
  if (!atsRewriteToggleLabelEl) return;
  atsRewriteToggleLabelEl.textContent = isAtsRewriteEnabled() ? "Rewrite for ATS (80%)" : "Standard mode";
}

async function persistAtsRewriteSetting() {
  const enabled = isAtsRewriteEnabled();
  await chrome.storage.local.set({ ats_rewrite_enabled: enabled });
  updateAtsRewriteToggleLabel();
  setStatus(
    enabled
      ? "Rewrite for ATS on — resumes are rewritten until they score at least 80%."
      : "Rewrite for ATS off — resumes are scored but kept exactly as generated."
  );
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
  // Unlock FIRST while this click is still a user gesture. Awaiting job fields
  // first burns activation, and Chrome often revokes access mid-generate later.
  if (!(await unlockFolderForSession())) return;

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
    const total = Number(profileCount || 0) + Number(sharedCount || 0);
    const pending = Number(pendingCount || 0);
    qaBankNoteEl.textContent = pending ? `${total + pending}` : String(total);
    qaBankNoteEl.hidden = total === 0 && pending === 0;
    qaBankNoteEl.classList.toggle("is-pending", pending > 0);
    if (qaOpenEditorBtn) {
      const parts = [];
      if (profileCount) parts.push(`${profileCount} this profile`);
      if (sharedCount) parts.push(`${sharedCount} shared`);
      if (pending) parts.push(`${pending} to register`);
      qaOpenEditorBtn.title = parts.length
        ? `Open Q&A bank — ${parts.join(" · ")}`
        : "Open Q&A bank";
    }
  } catch {
    qaBankNoteEl.textContent = "";
    qaBankNoteEl.hidden = true;
  }
}

function closeSubpage() {
  if (!subpageOverlayEl || subpageOverlayEl.hidden) return;
  const wasProfile = subpageFrameEl?.dataset.kind === "profile";
  const wasQa = subpageFrameEl?.dataset.kind === "qa";
  subpageOverlayEl.hidden = true;
  document.body.classList.remove("subpage-open");
  if (subpageFrameEl) {
    subpageFrameEl.removeAttribute("src");
    delete subpageFrameEl.dataset.kind;
  }
  if (wasProfile) {
    refreshProfiles(profileSelectEl?.value || DEFAULT_PROFILE_ID).catch(() => {});
  }
  if (wasProfile || wasQa) {
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
  openSubpage(url.toString(), { title: "Q&A bank", kind: "qa" });
}

let autofillInProgress = false;

async function applyAutofillButtonState(button = null) {
  if (!autofillBtn) return;
  const actionType = String(button?.actionType || "").toLowerCase();
  const isSubmit =
    actionType === "submit" || String(button?.label || "").toLowerCase() === "submit";
  const title =
    String(button?.title || "").trim() ||
    "Apply: open/fill the application. Only Apply / Next / Submit buttons are clicked. (Alt+Shift+E)";
  const labelEl = autofillBtn.querySelector(".btn-label");
  const fillIcon = autofillBtn.querySelector(".btn-icon-fill");
  const sendIcon = autofillBtn.querySelector(".btn-icon-submit");
  if (labelEl) labelEl.textContent = isSubmit ? "Submit" : "Apply";
  if (fillIcon) fillIcon.hidden = isSubmit;
  if (sendIcon) sendIcon.hidden = !isSubmit;
  autofillBtn.classList.toggle("is-submit", isSubmit);
  autofillBtn.title = title;
  autofillBtn.dataset.actionLabel = isSubmit ? "submit" : "Apply";
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
  if (autofillInProgress) return;

  const preferredAction =
    String(autofillBtn?.dataset?.actionLabel || "").toLowerCase() === "submit" ? "submit" : "";

  autofillInProgress = true;
  if (!quiet) {
    setStatus(
      preferredAction === "submit"
        ? "Submit: clicking the page Submit button..."
        : "Apply: filling the form and continuing the application...",
      "running"
    );
    updateJobsWorkStatus({
      running: true,
      statusText:
        preferredAction === "submit"
          ? "Submit: clicking the page Submit button..."
          : "Apply: filling the form and continuing..."
    });
  }
  setBusy(true);
  try {
    await chrome.storage.local.set({ selected_profile_id: profileId });
    const selectedImportedId = String(importedJobsSelectedId || "").trim();
    const res = await chrome.runtime.sendMessage({
      type: "autofill_current_page",
      profileId,
      clickAction: true,
      preferredAction,
      importedJobId: selectedImportedId
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Apply failed.");
    }
    if (res.button) await applyAutofillButtonState(res.button);
    if (!quiet) {
      setStatus(res.status || "Apply done.");
    }
    await refreshQaBank();
    return res;
  } catch (err) {
    if (!quiet) {
      setStatus(`Apply failed: ${String(err.message || err)}`, "error");
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
    setAtsBadgeSuppressed(false);
    rememberAtsReport(null);
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
outputDirAbsPathEl?.addEventListener("change", () => {
  persistOutputAbsolutePathFromInput()
    .then((path) => {
      if (path) setStatus(`Absolute path saved: ${path}`);
    })
    .catch((err) => setStatus(String(err.message || err)));
});
outputDirAbsPathEl?.addEventListener("blur", () => {
  persistOutputAbsolutePathFromInput().catch(() => {});
});
resumeFilenamePatternEl?.addEventListener("input", () => {
  updateResumeFilenameExample();
});
resumeFilenamePatternEl?.addEventListener("change", () => {
  persistResumeFilenamePattern()
    .then(() => setStatus(`Resume filename pattern saved.`))
    .catch((err) => setStatus(String(err.message || err)));
});
resumeFilenamePatternEl?.addEventListener("blur", () => {
  persistResumeFilenamePattern().catch(() => {});
});
jobTitleEl?.addEventListener("input", () => updateResumeFilenameExample());
companyNameEl?.addEventListener("input", () => updateResumeFilenameExample());

pasteJdBtn?.addEventListener("click", pasteJdFromClipboard);
scrapePageBtn?.addEventListener("click", () => {
  scrapeCurrentJobPage({ continueApply: false }).catch((err) =>
    setStatus(String(err.message || err))
  );
});
scrapeAndApplyBtn?.addEventListener("click", () => {
  scrapeCurrentJobPage({ continueApply: true }).catch((err) =>
    setStatus(String(err.message || err))
  );
});
copySheetRowBtn.addEventListener("click", copySheetRow);
generateResumeBtn.addEventListener("click", generateResumeAndCoverLetter);
stopGenerateBtn?.addEventListener("click", () => {
  generationStartPending = false;
  autofillInProgress = false;
  chrome.runtime
    .sendMessage({ type: "cancel_generation" })
    .then(() => {
      updateGenerationProgress({
        running: false,
        statusText: "Cancelled by user.",
        clearIdleStatus: true
      });
      setBusy(false);
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
filterGreenhouseJobsBtn?.addEventListener("click", () => setImportedJobsFilter("greenhouse"));
filterWorkdayJobsBtn?.addEventListener("click", () => setImportedJobsFilter("workday"));
filterIndeedJobsBtn?.addEventListener("click", () => setImportedJobsFilter("indeed"));
filterJobrightJobsBtn?.addEventListener("click", () => setImportedJobsFilter("jobright"));
filterLinkedInJobsBtn?.addEventListener("click", () => setImportedJobsFilter("linkedin"));
filterOtherJobsBtn?.addEventListener("click", () => setImportedJobsFilter("others"));
for (const btn of jobStatusFilterBtns) {
  btn.addEventListener("click", () => setImportedJobsStatusFilter(btn.dataset.status || "all"));
}
let jobListSearchTimer = null;
jobListSearchEl?.addEventListener("input", () => {
  clearTimeout(jobListSearchTimer);
  jobListSearchTimer = setTimeout(() => {
    importedJobsSearchQuery = String(jobListSearchEl.value || "");
    chrome.storage.local
      .set({ imported_jobs_search: importedJobsSearchQuery })
      .catch(() => {});
    renderImportedJobs();
  }, 180);
});
selectAllJobsEl?.addEventListener("change", () => {
  const visible = visibleImportedJobIds();
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

    const mergeRes = await replaceImportedJobsFromCsv(parsed.jobs);

    const excluded =
      (mergeRes.skippedDone || 0) +
      (mergeRes.skippedOnSheet || 0) +
      (mergeRes.skippedCompanyTitle || 0) +
      (mergeRes.skippedCsvStatus || 0) +
      (mergeRes.duplicateIds || 0) +
      (parsed.duplicateUrls || 0) +
      (parsed.skipped || 0);
    const skipParts = [];
    if (mergeRes.skippedDone) skipParts.push(`${mergeRes.skippedDone} already applied/closed`);
    if (mergeRes.skippedCsvStatus) {
      skipParts.push(`${mergeRes.skippedCsvStatus} marked applied/closed in file`);
    }
    if (mergeRes.skippedOnSheet) skipParts.push(`${mergeRes.skippedOnSheet} already on sheet`);
    if (mergeRes.skippedCompanyTitle) {
      skipParts.push(`${mergeRes.skippedCompanyTitle} same company+title`);
    }
    if (mergeRes.duplicateIds || parsed.duplicateUrls) {
      skipParts.push(
        `${(parsed.duplicateUrls || 0) + (mergeRes.duplicateIds || 0)} duplicate(s) in file`
      );
    }
    if (parsed.skipped) skipParts.push(`${parsed.skipped} invalid row(s)`);
    const summary =
      `${mergeRes.imported} job(s) to work on` +
      (mergeRes.replaced ? ` (replaced previous list of ${mergeRes.replaced})` : "") +
      `.` +
      (excluded
        ? ` Excluded from list: ${skipParts.join(", ") || `${excluded} row(s)`}.`
        : "");
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
aiFormPlanToggleEl?.addEventListener("change", () => {
  const enabled = Boolean(aiFormPlanToggleEl.checked);
  chrome.storage.local.set({ ai_form_plan_enabled: enabled }).catch(() => {});
  setStatus(
    enabled
      ? "AI reads the whole form and answers every field on Apply."
      : "AI form reader off — Apply uses the Q&A bank first, then AI one question at a time."
  );
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
copyResumePathBtn?.addEventListener("click", () => {
  // Call directly — no await before it, or Chrome rejects the clipboard write.
  copyResumeFolderPath();
});
grantFolderAccessBtn?.addEventListener("click", () => {
  (async () => {
    const unlocked = await unlockFolderForSession();
    if (!unlocked) return;
    await tryFlushPendingOutput({ interactive: true });
  })().catch((err) => setStatus(String(err.message || err)));
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
          await scrapeCurrentJobPage({ continueApply: true });
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
    applyImportedJob(jobId, {
      preferSubmit: String(job.status || "") === "ready_for_review"
    }).catch((err) => setStatus(String(err.message || err), "error"));
  }
});

resumeOnlyToggleEl?.addEventListener("change", () => {
  persistResumeOnlySetting().catch(() => {});
});
previewModeToggleEl?.addEventListener("change", () => {
  persistPreviewModeSetting().catch(() => {});
});
atsRewriteToggleEl?.addEventListener("change", () => {
  persistAtsRewriteSetting().catch(() => {});
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
    const cancelled = /\bcancel/i.test(statusText);
    const generationBusy = !cancelled && (running || generationStartPending);

    setAtsBadgeSuppressed(generationBusy);

    if (running && !cancelled) {
      generationStartPending = false;
      wasGenerationRunning = true;
      updateGenerationProgress({ running: true, statusText });
      setBusy(true);
      // Chrome may revoke folder access while this panel is backgrounded mid-generate.
      await refreshFolderPermissionBanner();
    } else if (generationStartPending && !cancelled) {
      // Keep the local "Starting..." UI until the service worker flips the flag.
      updateGenerationProgress({
        running: true,
        statusText: statusText || "Starting resume generation..."
      });
      setBusy(true);
    } else if (cancelled) {
      generationStartPending = false;
      wasGenerationRunning = false;
      updateGenerationProgress({
        running: false,
        statusText,
        clearIdleStatus: true
      });
      setBusy(false);
    } else if (autofillInProgress) {
      updateJobsWorkStatus({
        running: true,
        statusText: statusText || "Apply: working..."
      });
    } else if (wasGenerationRunning) {
      wasGenerationRunning = false;
      updateGenerationProgress({
        running: false,
        statusText,
        clearIdleStatus: true
      });
      setBusy(false);
    } else {
      setBusy(false);
    }

    // Re-render in every state that is not a live run — including Apply, which
    // generates a resume mid-run and used to leave the score hidden until the
    // panel was reopened.
    renderAtsForCurrentJob(rememberAtsReport(data.last_ats_report));

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
      // The freshly generated job's score arrives with this refresh, after the
      // render above ran against the previous snapshot.
      renderAtsForCurrentJob();
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
