import {
  DEFAULT_PROFILE_ID,
  getResumeProfiles,
  deleteCustomProfile
} from "./profiles.js";
import { getAllTemplates, DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { extractSpreadsheetId, buildSheetRowTsv, getExistingJobLinks } from "./sheets.js";
import {
  saveOutputDirectoryHandle,
  getOutputDirectoryName,
  flushPendingOutputToSelectedDirectory,
  getLastSaveMeta,
  browseLastSavedJobDirectory
} from "./fs-output.js";
import { isLinkedInSource, parseImportedJobsCsvText } from "./csv-jobs.js";

const APPS_SCRIPT_SOURCE = `/**
 * Resume GPT Builder — paste into Extensions → Apps Script on your spreadsheet,
 * then Deploy → Manage deployments → Edit → Version: New version → Deploy
 * (Execute as: Me, Who has access: Anyone).
 */
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function listSheetOptions(spreadsheet) {
  return spreadsheet
    .getSheets()
    .map(function (sheet) {
      return sheet.getName() + " (gid=" + sheet.getSheetId() + ")";
    })
    .join(", ");
}

function getTargetSheet(spreadsheet, sheetGid, sheetName) {
  var name = String(sheetName || "").trim();
  if (name) {
    var byName = spreadsheet.getSheetByName(name);
    if (byName) return byName;
    throw new Error(
      'Sheet tab "' + name + '" was not found. Available: ' + listSheetOptions(spreadsheet)
    );
  }

  var gid = Number(sheetGid);
  if (sheetGid !== "" && !isNaN(gid)) {
    var sheets = spreadsheet.getSheets();
    for (var i = 0; i < sheets.length; i += 1) {
      if (sheets[i].getSheetId() === gid) return sheets[i];
    }
    throw new Error(
      "Sheet tab was not found for gid " +
        sheetGid +
        ". Available: " +
        listSheetOptions(spreadsheet)
    );
  }

  return spreadsheet.getSheets()[0];
}

function getColumnAValues(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  // getRange(row, column, numRows, numColumns) — NOT end-row/end-column.
  return sheet.getRange(1, 1, lastRow, 1).getDisplayValues().map(function (row) {
    return String(row[0] || "").trim();
  });
}

function getJobLinks(sheet) {
  return getColumnAValues(sheet).filter(function (value) {
    return value !== "" && !/^job\\s*(url|link)\$/i.test(value);
  });
}

/** First empty row in column A — matches pasting under the last job URL. */
function findNextEmptyRowInColumnA(sheet) {
  var values = getColumnAValues(sheet);
  for (var i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== "") return i + 2; // 1-based next row
  }
  return 1;
}

function appendJobRow(sheet, data) {
  var row = findNextEmptyRowInColumnA(sheet);
  // Use A1 notation so we never confuse end-row with numRows.
  // (Apps Script getRange(r,c,numRows,numColumns) is NOT end-row/end-column.)
  sheet.getRange("A" + row + ":D" + row).setValues([
    [
      data.jobLink || "",
      data.jobTitle || "",
      data.companyName || "",
      data.applicationDate || ""
    ]
  ]);
  return {
    ok: true,
    apiVersion: "2026-08-06b",
    sheetName: sheet.getName(),
    sheetGid: String(sheet.getSheetId()),
    row: row
  };
}

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!data.spreadsheetId) {
      throw new Error("spreadsheetId is required.");
    }

    var ss = SpreadsheetApp.openById(String(data.spreadsheetId));
    var sheet = getTargetSheet(ss, String(data.sheetGid || ""), String(data.sheetName || ""));

    if (data.action === "getJobLinks") {
      return jsonResponse({
        ok: true,
        apiVersion: "2026-08-06b",
        jobLinks: getJobLinks(sheet),
        sheetName: sheet.getName(),
        sheetGid: String(sheet.getSheetId())
      });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      return jsonResponse(appendJobRow(sheet, data));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.action === "getJobLinks") {
    try {
      if (!params.spreadsheetId) throw new Error("spreadsheetId is required.");
      var ss = SpreadsheetApp.openById(String(params.spreadsheetId));
      var sheet = getTargetSheet(ss, String(params.sheetGid || ""), String(params.sheetName || ""));
      return jsonResponse({
        ok: true,
        apiVersion: "2026-08-06b",
        jobLinks: getJobLinks(sheet),
        sheetName: sheet.getName(),
        sheetGid: String(sheet.getSheetId())
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }
  return ContentService.createTextOutput(
    JSON.stringify({
      ok: true,
      apiVersion: "2026-08-06b",
      message: "Resume GPT Builder sheet append endpoint is running."
    })
  ).setMimeType(ContentService.MimeType.JSON);
}
`;

const statusEl = document.getElementById("status");
const profileSelectEl = document.getElementById("profileSelect");
const templateSelectEl = document.getElementById("templateSelect");
const deleteProfileBtn = document.getElementById("deleteProfile");
const jobTitleEl = document.getElementById("jobTitle");
const companyNameEl = document.getElementById("companyName");
const jdLinkEl = document.getElementById("jdLink");
const jdTextEl = document.getElementById("jdText");
const outputDirLabelEl = document.getElementById("outputDirLabel");
const selectOutputDirBtn = document.getElementById("selectOutputDir");
const spreadsheetSectionEl = document.getElementById("spreadsheetSection");
const sheetSummaryNoteEl = document.getElementById("sheetSummaryNote");
const aiQaSectionEl = document.getElementById("aiQaSection");
const spreadsheetUrlEl = document.getElementById("spreadsheetUrl");
const sheetTabNameEl = document.getElementById("sheetTabName");
const sheetsWebAppUrlEl = document.getElementById("sheetsWebAppUrl");
const copyAppsScriptBtn = document.getElementById("copyAppsScript");
const copySheetRowBtn = document.getElementById("copySheetRow");
const pasteJdBtn = document.getElementById("pasteJd");
const generateResumeBtn = document.getElementById("generateResume");
const autofillBtn = document.getElementById("autofillBtn");
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

// Imported CSV jobs UI
const jobsSidebarEl = document.getElementById("jobsSidebar");
const modeManualBtn = document.getElementById("modeManual");
const modeImportedBtn = document.getElementById("modeImported");
const csvFileInputEl = document.getElementById("csvFileInput");
const importCsvBtn = document.getElementById("importCsvBtn");
const importStatusEl = document.getElementById("importStatus");
const importedJobsListEl = document.getElementById("importedJobsList");
const filterAllJobsBtn = document.getElementById("filterAllJobs");
const filterLinkedInJobsBtn = document.getElementById("filterLinkedInJobs");
const filterOtherJobsBtn = document.getElementById("filterOtherJobs");
const sidebarImportEl = jobsSidebarEl?.querySelector(".sidebar-import") || null;

let profilesCache = [];
let templatesCache = [];
let wasGenerationRunning = false;

let awaitingFolderPermission = false;
let permissionRetryArmed = false;

let importedJobsById = {};
let importedJobsOrder = [];
let importedJobsSelectedId = null;
let importedJobsVersion = 0;
let importedJobsFilter = "all";

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.classList.remove("is-running", "is-done", "is-error");
  if (kind === "running" || kind === "done" || kind === "error") {
    statusEl.classList.add(`is-${kind}`);
  }
}

function updateGenerationProgress({ running, statusText }) {
  if (!genProgressEl) return;

  const text = String(statusText || "").trim();
  const failed = /fail/i.test(text);

  if (running) {
    genProgressEl.hidden = false;
    genProgressEl.classList.remove("is-done", "is-error");
    if (genProgressStateEl) genProgressStateEl.textContent = "In progress";
    if (genProgressDetailEl) genProgressDetailEl.textContent = text || "Working...";
    setStatus(text || "Generating...", "running");
    return;
  }

  // Show Done / Failed after a run (or when status already says saved/failed).
  if (wasGenerationRunning || /\bsaved\b/i.test(text) || failed) {
    if (!text && !wasGenerationRunning) {
      genProgressEl.hidden = true;
      return;
    }
    genProgressEl.hidden = false;
    genProgressEl.classList.toggle("is-error", failed);
    genProgressEl.classList.toggle("is-done", !failed);
    if (genProgressStateEl) {
      genProgressStateEl.textContent = failed ? "Failed" : "Done";
    }
    if (genProgressDetailEl) {
      genProgressDetailEl.textContent =
        text || (failed ? "Generation failed." : "Files are ready.");
    }
    setStatus(text || (failed ? "Generation failed." : "Done."), failed ? "error" : "done");
    return;
  }

  if (text) setStatus(text);
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
    last_jd_text: jdTextEl.value,
    spreadsheet_url: spreadsheetUrlEl.value.trim(),
    sheets_sheet_name: (sheetTabNameEl?.value || "").trim(),
    sheets_web_app_url: sheetsWebAppUrlEl.value.trim()
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

function syncSheetSummaryNote() {
  if (!sheetSummaryNoteEl) return;
  const spreadsheetUrl = (spreadsheetUrlEl?.value || "").trim();
  const webAppUrl = (sheetsWebAppUrlEl?.value || "").trim();
  const tabName = (sheetTabNameEl?.value || "").trim();
  const hasTarget = Boolean(tabName) || /[?#&]gid=\d+/i.test(spreadsheetUrl);
  const connected =
    Boolean(spreadsheetUrl) &&
    Boolean(webAppUrl) &&
    Boolean(extractSpreadsheetId(spreadsheetUrl)) &&
    hasTarget;
  sheetSummaryNoteEl.textContent = connected ? "Connected" : "Not connected";
  sheetSummaryNoteEl.classList.toggle("is-connected", connected);
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
    case "opening_form":
      return "Opening application form";
    case "filling":
      return "Filling form";
    case "ready_for_review":
      return "Ready for review";
    case "needs_review":
      return "Needs review";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return s ? s : "—";
  }
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
    "imported_jobs_version"
  ]);
  importedJobsById = data.imported_jobs_by_id || {};
  importedJobsOrder = data.imported_jobs_order || [];
  importedJobsSelectedId = data.imported_jobs_selected_id || null;
  importedJobsVersion = Number(data.imported_jobs_version || 0);

  renderImportedJobs();
}

function setImportedJobsFilter(filter, { persist = true } = {}) {
  importedJobsFilter = ["linkedin", "others"].includes(filter) ? filter : "all";
  filterAllJobsBtn?.classList.toggle("is-active", importedJobsFilter === "all");
  filterLinkedInJobsBtn?.classList.toggle("is-active", importedJobsFilter === "linkedin");
  filterOtherJobsBtn?.classList.toggle("is-active", importedJobsFilter === "others");
  if (persist) {
    chrome.storage.local.set({ imported_jobs_filter: importedJobsFilter }).catch(() => {});
  }
  renderImportedJobs();
}

function importedJobMatchesFilter(job) {
  if (job?.status === "completed") return false;
  if (importedJobsFilter === "linkedin") return isLinkedInSource(job?.source);
  if (importedJobsFilter === "others") return !isLinkedInSource(job?.source);
  return true;
}

function normalizeJobLink(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function renderImportedJobs() {
  if (!importedJobsListEl) return;
  importedJobsListEl.innerHTML = "";

  if (!importedJobsOrder.length) {
    importedJobsListEl.innerHTML =
      '<p class="import-status" style="margin:0">Import a CSV to populate the jobs list.</p>';
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
    if (jobId === importedJobsSelectedId) card.open = true;

    const summary = document.createElement("summary");
    summary.className = "job-summary";

    const title = document.createElement("span");
    title.className = "job-summary-title";
    title.textContent = String(job.jobTitle || jobId || "Untitled");

    const status = document.createElement("span");
    status.className = "job-summary-status";
    status.textContent = displayImportedJobStatus(job);

    summary.appendChild(title);
    summary.appendChild(status);

    const isCompleted = job.status === "completed";
    const isInProgress = ["opening", "generating", "opening_form", "filling"].includes(String(job.status));

    const applySummaryBtn = document.createElement("button");
    applySummaryBtn.type = "button";
    if (isCompleted) {
      applySummaryBtn.textContent = "Done";
      applySummaryBtn.disabled = true;
    } else if (isInProgress) {
      applySummaryBtn.textContent = "Working";
      applySummaryBtn.disabled = true;
    } else {
      applySummaryBtn.textContent = ["failed", "needs_review", "ready_for_review"].includes(
        String(job.status)
      )
        ? "Retry"
        : "Apply";
      applySummaryBtn.disabled = false;
      applySummaryBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await applyImportedJob(jobId);
      });
    }

    summary.appendChild(applySummaryBtn);

    card.appendChild(summary);

    const details = document.createElement("div");
    details.className = "job-card-details";

    const meta = document.createElement("p");
    meta.className = "job-meta";
    meta.textContent = `${job.companyName || ""}  |  ${String(job.source || "").trim() || "n/a"}`;
    details.appendChild(meta);

    const skills = document.createElement("p");
    skills.className = "job-meta";
    const skillsPreview = String(job.keySkills || "").trim().slice(0, 180);
    skills.textContent = skillsPreview ? `Key skills: ${skillsPreview}${String(job.keySkills || "").length > 180 ? "…" : ""}` : "";
    if (skills.textContent) details.appendChild(skills);

    const actions = document.createElement("div");
    actions.className = "job-actions";

    const completeBtn = document.createElement("button");
    completeBtn.className = "secondary";
    if (["ready_for_review", "needs_review"].includes(String(job.status))) {
      completeBtn.textContent = "Mark completed";
      completeBtn.disabled = false;
      completeBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await markImportedJobCompleted(jobId);
      });
    } else {
      completeBtn.textContent = "Mark completed";
      completeBtn.disabled = true;
    }

    actions.appendChild(completeBtn);
    details.appendChild(actions);

    const err = shortError(job);
    if (job.status === "failed" && err) {
      const errP = document.createElement("p");
      errP.className = "job-error";
      errP.textContent = err;
      details.appendChild(errP);
    }

    const detail = String(job?.statusDetail || "").trim();
    if (job.status !== "failed" && detail && job.status !== "imported") {
      const d = document.createElement("p");
      d.className = "job-meta";
      d.textContent = detail.slice(0, 220);
      details.appendChild(d);
    }

    const openSelected = (event) => {
      event?.stopPropagation?.();
      importedJobsSelectedId = jobId;
      chrome.storage.local.set({ imported_jobs_selected_id: jobId }).catch(() => {});
      // Copy values into the existing manual editor.
      if (jobTitleEl) jobTitleEl.value = job.jobTitle || "";
      if (companyNameEl) companyNameEl.value = job.companyName || "";
      if (jdLinkEl) jdLinkEl.value = job.jdLink || "";
      if (jdTextEl) jdTextEl.value = job.jdText || "";
      persistJobFields().catch(() => {});
      setStatus(`Selected imported job: ${job.jobTitle || jobId}`);
    };

    summary.addEventListener("click", (e) => {
      // Allow the details element to open/close, but still copy values.
      // If the click was on a button (handled above), ignore.
      const target = e.target;
      if (target && target.tagName && target.tagName.toLowerCase() === "button") return;
      openSelected(e);
    });

    card.appendChild(details);
    frag.appendChild(card);
  }

  if (!visibleCount) {
    importedJobsListEl.innerHTML =
      '<p class="import-status" style="margin:0">No pending jobs match this filter.</p>';
    return;
  }

  importedJobsListEl.appendChild(frag);
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
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsOrder = order;
  importedJobsSelectedId = null;
  importedJobsVersion = now;

  renderImportedJobs();

  return { imported: order.length, duplicateIds };
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

async function markImportedJobCompleted(jobId) {
  const now = Date.now();
  const data = await chrome.storage.local.get(["imported_jobs_by_id"]);
  const byId = data.imported_jobs_by_id || {};
  const job = byId[jobId];
  if (!job) return;

  byId[jobId] = {
    ...job,
    status: "completed",
    statusDetail: "Completed by user.",
    completedAt: now,
    updatedAt: now
  };

  await chrome.storage.local.set({
    imported_jobs_by_id: byId,
    imported_jobs_version: now
  });

  importedJobsById = byId;
  importedJobsVersion = now;
  renderImportedJobs();
  setStatus(`Marked completed: ${job.jobTitle || jobId}`);
}

async function refreshSaveBannerFromStorage() {
  const meta = await getLastSaveMeta();
  if (meta?.pathLabel) {
    showSaveBanner(meta.pathLabel);
  }
}

async function openSavedFolder() {
  setStatus("Opening saved folder in File Explorer...", "running");
  try {
    const meta = await getLastSaveMeta();
    if (!meta) {
      setStatus("Nothing saved yet.", "error");
      return;
    }

    // Prefer Explorer reveal via chrome.downloads.show when we already have an id.
    if (meta.downloadId != null && meta.method === "downloads") {
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

    // FS saves (and downloads-show fallback): copy job files into Downloads and reveal.
    const result = await browseLastSavedJobDirectory();
    if (result?.method === "file-picker") {
      setStatus(
        result.aborted
          ? "File browser closed."
          : `Showing files in saved folder${result.folderName ? ` (${result.folderName})` : ""}.`,
        "done"
      );
      return;
    }
    const label =
      result?.folderName != null
        ? `Downloads / ${result.folderName}`
        : meta.pathLabel || "Downloads";
    setStatus(
      `Opened ${label} — resume & cover letter should be visible in File Explorer.`,
      "done"
    );
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
    "spreadsheet_url",
    "sheets_sheet_name",
    "sheets_web_app_url",
    "generation_status",
    "generation_running",
    "pending_fs_write",
    "ui_sheet_section_open",
    "ui_ai_qa_section_open",
    "imported_jobs_filter"
  ]);

  await refreshProfiles(data.selected_profile_id || DEFAULT_PROFILE_ID);
  await refreshTemplates(data.selected_template_id || templateIdForProfile(profileSelectEl.value));
  jobTitleEl.value = data.last_job_title || "";
  companyNameEl.value = data.last_company_name || "";
  jdLinkEl.value = data.last_jd_link || "";
  jdTextEl.value = data.last_jd_text || "";
  spreadsheetUrlEl.value = data.spreadsheet_url || "";
  if (sheetTabNameEl) sheetTabNameEl.value = data.sheets_sheet_name || "";
  sheetsWebAppUrlEl.value = data.sheets_web_app_url || "";
  syncSheetSummaryNote();

  if (spreadsheetSectionEl) spreadsheetSectionEl.open = Boolean(data.ui_sheet_section_open);
  if (aiQaSectionEl) aiQaSectionEl.open = Boolean(data.ui_ai_qa_section_open);
  setImportedJobsFilter(data.imported_jobs_filter || "all", { persist: false });

  await refreshOutputDirLabel();
  setStatus(data.generation_status || "");
  setBusy(Boolean(data.generation_running));
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

async function copyAppsScript() {
  try {
    await navigator.clipboard.writeText(APPS_SCRIPT_SOURCE);
    setStatus("Apps Script copied. Paste it into Extensions → Apps Script, then deploy as Web app.");
  } catch {
    setStatus("Could not copy. Open apps-script/Code.gs in the project instead.");
  }
}

async function copySheetRow() {
  const jobTitle = (jobTitleEl.value || "").trim();
  const companyName = (companyNameEl.value || "").trim();
  const jdLink = (jdLinkEl.value || "").trim();

  if (!jobTitle && !companyName && !jdLink) {
    setStatus("Fill job title, company, and/or JD link before copying.");
    return;
  }

  const tsv = buildSheetRowTsv({ jobTitle, companyName, jdLink, includeDate: true });
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
  const spreadsheetUrl = (spreadsheetUrlEl.value || "").trim();
  const sheetTabName = (sheetTabNameEl?.value || "").trim();
  const sheetsWebAppUrl = (sheetsWebAppUrlEl.value || "").trim();

  if (!jobTitle) {
    setStatus("Enter a job title first.");
    jobTitleEl.focus();
    return null;
  }
  if (!companyName) {
    setStatus("Enter a company name first.");
    companyNameEl.focus();
    return null;
  }
  if (!jd) {
    setStatus("Paste a job description into the JD field first.");
    jdTextEl.focus();
    return null;
  }

  if (spreadsheetUrl || sheetsWebAppUrl || sheetTabName) {
    if (!extractSpreadsheetId(spreadsheetUrl)) {
      setStatus("Enter a valid Google Spreadsheet link.");
      spreadsheetUrlEl.focus();
      return null;
    }
    if (!sheetsWebAppUrl) {
      setStatus("Paste the Apps Script Web App URL (one-time setup), or clear the spreadsheet link.");
      sheetsWebAppUrlEl.focus();
      return null;
    }
    if (!sheetTabName && !/[?#&]gid=\d+/i.test(spreadsheetUrl)) {
      setStatus(
        "Open your target sheet tab in Google Sheets, copy that URL (must include gid=...), or enter the Sheet tab name."
      );
      spreadsheetUrlEl.focus();
      return null;
    }
  }

  const outputFolderName = (await getOutputDirectoryName()) || "";
  if (!outputFolderName) {
    setStatus('Select an output folder first (Select folder), then generate.');
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
    spreadsheet_url: spreadsheetUrl,
    sheets_sheet_name: sheetTabName,
    sheets_web_app_url: sheetsWebAppUrl
  });

  return {
    profileId,
    jobMeta: {
      jobTitle,
      companyName,
      jdLink,
      jdText: jd,
      outputDir: outputFolderName,
      spreadsheetUrl,
      sheetName: sheetTabName,
      sheetsWebAppUrl,
      templateId
    }
  };
}

function setBusy(busy) {
  if (generateResumeBtn) generateResumeBtn.disabled = busy;
  if (autofillBtn) autofillBtn.disabled = busy;
  if (generateAiAnswerBtn) generateAiAnswerBtn.disabled = busy;
}

function setCopyAnswerEnabled(enabled) {
  if (copyAiAnswerBtn) copyAiAnswerBtn.disabled = !enabled;
}

async function generateResumeAndCoverLetter() {
  const collected = await collectJobMetaOrShowError();
  if (!collected) return;

  wasGenerationRunning = true;
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
    updateGenerationProgress({
      running: false,
      statusText: `Generation failed: ${String(err.message || err)}`
    });
    wasGenerationRunning = false;
    setBusy(false);
  }
}

async function runAutofillOnCurrentPage() {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
  if (!profileId) {
    setStatus("Select a profile first.");
    return;
  }

  setStatus("Autofilling current application page...");
  setBusy(true);
  try {
    await chrome.storage.local.set({ selected_profile_id: profileId });
    const res = await chrome.runtime.sendMessage({
      type: "autofill_current_page",
      profileId
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Autofill failed.");
    }
    setStatus(res.status || `Autofilled ${res.filledCount || 0} field(s).`);
  } catch (err) {
    setStatus(`Autofill failed: ${String(err.message || err)}`);
  } finally {
    setBusy(false);
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

  await chrome.storage.local.set({
    last_job_title: "",
    last_company_name: "",
    last_jd_link: "",
    last_jd_text: ""
  });
  await chrome.storage.local.remove(["last_save_ready", "last_save_meta"]);
}

async function resetWorkflow() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "reset_generation_state" });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to reset.");
    }
    await clearJobFields();
    wasGenerationRunning = false;
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
  await chrome.tabs.create({ url: url.toString() });
}

async function editSelectedProfile() {
  const profileId = profileSelectEl.value || DEFAULT_PROFILE_ID;
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
});

templateSelectEl.addEventListener("change", () => {
  saveSelectedTemplate(templateSelectEl.value).catch(() => {});
});

for (const el of [
  jobTitleEl,
  companyNameEl,
  jdLinkEl,
  jdTextEl,
  spreadsheetUrlEl,
  sheetTabNameEl,
  sheetsWebAppUrlEl
].filter(Boolean)) {
  el.addEventListener("change", () => {
    persistJobFields().catch(() => {});
    syncSheetSummaryNote();
  });
}

wireAccordion(spreadsheetSectionEl, "ui_sheet_section_open");
wireAccordion(aiQaSectionEl, "ui_ai_qa_section_open");

selectOutputDirBtn.addEventListener("click", () => {
  selectOutputDirectory().catch((err) => setStatus(String(err.message || err)));
});

pasteJdBtn.addEventListener("click", pasteJdFromClipboard);
copyAppsScriptBtn.addEventListener("click", copyAppsScript);
copySheetRowBtn.addEventListener("click", copySheetRow);
generateResumeBtn.addEventListener("click", generateResumeAndCoverLetter);
autofillBtn.addEventListener("click", () => {
  runAutofillOnCurrentPage().catch((err) => setStatus(String(err.message || err)));
});

// Sidebar mode switching
modeManualBtn?.addEventListener("click", () => setSidebarMode("manual"));
modeImportedBtn?.addEventListener("click", () => setSidebarMode("imported"));
filterAllJobsBtn?.addEventListener("click", () => setImportedJobsFilter("all"));
filterLinkedInJobsBtn?.addEventListener("click", () => setImportedJobsFilter("linkedin"));
filterOtherJobsBtn?.addEventListener("click", () => setImportedJobsFilter("others"));

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

    const spreadsheetUrl = (spreadsheetUrlEl?.value || "").trim();
    const sheetTabName = (sheetTabNameEl?.value || "").trim();
    const webAppUrl = (sheetsWebAppUrlEl?.value || "").trim();
    if (Boolean(spreadsheetUrl) !== Boolean(webAppUrl)) {
      throw new Error("Fill both Google Sheet fields, or clear both before importing.");
    }

    let existingSheetLinks = [];
    if (spreadsheetUrl && webAppUrl) {
      setStatus("Checking Google Sheet column A for existing jobs...");
      existingSheetLinks = await getExistingJobLinks({
        spreadsheetUrl,
        webAppUrl,
        sheetName: sheetTabName
      });
    }

    const existingLinks = new Set(existingSheetLinks.map(normalizeJobLink).filter(Boolean));
    const csvLinks = new Set();
    let sheetDuplicates = 0;
    let csvDuplicates = 0;
    const pendingJobs = parsed.jobs.filter((job) => {
      const link = normalizeJobLink(job.jdLink);
      if (link && existingLinks.has(link)) {
        sheetDuplicates += 1;
        return false;
      }
      if (link && csvLinks.has(link)) {
        csvDuplicates += 1;
        return false;
      }
      if (link) csvLinks.add(link);
      return true;
    });

    const replaceRes = await replaceImportedJobs(pendingJobs);

    const noSheetNote = spreadsheetUrl ? "" : " Sheet dedup skipped (Google Sheet not connected).";
    const summary =
      `Loaded ${replaceRes.imported} pending jobs. ` +
      `Ignored ${sheetDuplicates} already in Sheet, ${csvDuplicates + replaceRes.duplicateIds} CSV duplicates, ` +
      `${parsed.skipped} invalid rows.${noSheetNote}`;
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

// The profile editor runs in its own tab, so the panel has to pick up profiles
// it creates or renames instead of only reading the list once at startup.
chrome.storage.onChanged.addListener((changes, area) => {
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
  })().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "flush_pending_output") {
    tryFlushPendingOutput()
      .then((result) => sendResponse(result || { ok: false }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
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

  return undefined;
});

document.addEventListener("keydown", (e) => {
  const key = String(e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "enter") {
    e.preventDefault();
    generateResumeAndCoverLetter().catch(() => {});
  }
});

loadSettings().catch((err) => setStatus(`Init failed: ${String(err.message || err)}`, "error"));
setSidebarMode("manual");
refreshImportedJobsFromStorage().catch(() => {});
setInterval(async () => {
  const data = await chrome.storage.local.get([
    "generation_status",
    "generation_running",
    "pending_fs_write",
    "last_save_ready",
    "last_save_meta",
    "imported_jobs_by_id",
    "imported_jobs_order",
    "imported_jobs_selected_id",
    "imported_jobs_version"
  ]);

  const running = Boolean(data.generation_running);
  const statusText =
    typeof data.generation_status === "string" ? data.generation_status : "";

  updateGenerationProgress({ running, statusText });
  setBusy(running);

  if (wasGenerationRunning && !running) {
    wasGenerationRunning = false;
  } else if (running) {
    wasGenerationRunning = true;
  }

  // While a gesture is pending, the click/keydown handler drives the retry.
  if (data.pending_fs_write && !awaitingFolderPermission) {
    await tryFlushPendingOutput();
  }
  if (data.last_save_ready && data.last_save_meta?.pathLabel) {
    showSaveBanner(data.last_save_meta.pathLabel);
    await chrome.storage.local.remove("last_save_ready");
  }

  const nextVersion = Number(data.imported_jobs_version || 0);
  if (nextVersion && nextVersion !== importedJobsVersion) {
    importedJobsById = data.imported_jobs_by_id || {};
    importedJobsOrder = data.imported_jobs_order || [];
    importedJobsSelectedId = data.imported_jobs_selected_id || null;
    importedJobsVersion = nextVersion;
    renderImportedJobs();
  }
}, 600);
