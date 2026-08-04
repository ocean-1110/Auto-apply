import {
  DEFAULT_PROFILE_ID,
  getResumeProfiles,
  deleteCustomProfile
} from "./profiles.js";
import { getAllTemplates, DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { extractSpreadsheetId, buildSheetRowTsv } from "./sheets.js";
import {
  saveOutputDirectoryHandle,
  getOutputDirectoryName,
  flushPendingOutputToSelectedDirectory,
  getLastSaveMeta,
  browseLastSavedJobDirectory
} from "./fs-output.js";

const APPS_SCRIPT_SOURCE = `/**
 * Resume GPT Builder — paste into Extensions → Apps Script on your spreadsheet,
 * then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 */
function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!data.spreadsheetId) {
      throw new Error("spreadsheetId is required.");
    }

    const ss = SpreadsheetApp.openById(String(data.spreadsheetId));
    const sheet = ss.getSheets()[0];

    sheet.appendRow([
      data.jobLink || "",
      data.jobTitle || "",
      data.companyName || "",
      data.applicationDate || ""
    ]);

    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(
      ContentService.MimeType.JSON
    );
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService.createTextOutput(
    "Resume GPT Builder sheet append endpoint is running."
  );
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
const spreadsheetUrlEl = document.getElementById("spreadsheetUrl");
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
const openSavedFolderBtn = document.getElementById("openSavedFolder");

let profilesCache = [];
let templatesCache = [];

function setStatus(message) {
  statusEl.textContent = message;
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

async function refreshSaveBannerFromStorage() {
  const meta = await getLastSaveMeta();
  if (meta?.pathLabel) {
    showSaveBanner(meta.pathLabel);
  }
}

async function openSavedFolder() {
  setStatus("Opening saved folder...");
  try {
    const meta = await getLastSaveMeta();
    if (!meta) {
      setStatus("Nothing saved yet.");
      return;
    }

    if (meta.method === "fs") {
      await browseLastSavedJobDirectory();
      setStatus(`Opened folder: ${meta.pathLabel}`);
      return;
    }

    const res = await chrome.runtime.sendMessage({
      type: "open_saved_folder",
      meta
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Could not open folder.");
    }
    setStatus(`Opened folder: ${meta.pathLabel}`);
  } catch (err) {
    // FS picker may throw AbortError if user closes it after viewing — treat as ok.
    if (err && (err.name === "AbortError" || String(err.message || "").includes("abort"))) {
      setStatus("Folder browser closed.");
      return;
    }
    setStatus(`Open folder failed: ${String(err.message || err)}`);
  }
}

async function tryFlushPendingOutput() {
  try {
    const result = await flushPendingOutputToSelectedDirectory();
    if (result?.ok) {
      const pathLabel = result.pathLabel || "selected folder";
      setStatus(`Saved files to ${pathLabel}`);
      showSaveBanner(pathLabel);
      await chrome.storage.local.set({
        generation_status: `Saved files to ${pathLabel}`
      });
      chrome.runtime
        .sendMessage({ type: "show_save_notification", pathLabel })
        .catch(() => {});
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
    "sheets_web_app_url",
    "generation_status",
    "generation_running",
    "pending_fs_write"
  ]);

  await refreshProfiles(data.selected_profile_id || DEFAULT_PROFILE_ID);
  await refreshTemplates(data.selected_template_id || templateIdForProfile(profileSelectEl.value));
  jobTitleEl.value = data.last_job_title || "";
  companyNameEl.value = data.last_company_name || "";
  jdLinkEl.value = data.last_jd_link || "";
  jdTextEl.value = data.last_jd_text || "";
  spreadsheetUrlEl.value = data.spreadsheet_url || "";
  sheetsWebAppUrlEl.value = data.sheets_web_app_url || "";
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

  if (spreadsheetUrl || sheetsWebAppUrl) {
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

  setStatus("Starting resume generation...");
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
    setStatus("Running: calling OpenAI, then saving PDFs...");
  } catch (err) {
    setStatus(`Generation failed: ${String(err.message || err)}`);
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

async function resetWorkflow() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "reset_generation_state" });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to reset.");
    }
    setStatus("Reset complete. Ready for next run.");
    setBusy(false);
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

for (const el of [jobTitleEl, companyNameEl, jdLinkEl, jdTextEl, spreadsheetUrlEl, sheetsWebAppUrlEl]) {
  el.addEventListener("change", () => {
    persistJobFields().catch(() => {});
  });
}

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

loadSettings().catch((err) => setStatus(`Init failed: ${String(err.message || err)}`));
setInterval(async () => {
  const data = await chrome.storage.local.get([
    "generation_status",
    "generation_running",
    "pending_fs_write",
    "last_save_ready",
    "last_save_meta"
  ]);
  if (typeof data.generation_status === "string") {
    setStatus(data.generation_status);
  }
  setBusy(Boolean(data.generation_running));
  if (data.pending_fs_write) {
    await tryFlushPendingOutput();
  }
  if (data.last_save_ready && data.last_save_meta?.pathLabel) {
    showSaveBanner(data.last_save_meta.pathLabel);
    await chrome.storage.local.remove("last_save_ready");
  }
}, 1200);
