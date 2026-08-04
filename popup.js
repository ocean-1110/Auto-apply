import {
  DEFAULT_PROFILE_ID,
  getResumeProfiles,
  addCustomProfile,
  deleteCustomProfile
} from "./profiles.js";
import { getAllTemplates, DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { extractSpreadsheetId, buildSheetRowTsv } from "./sheets.js";

const DEFAULT_OUTPUT_DIR = "Resume Applications";

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
const openaiApiKeyEl = document.getElementById("openaiApiKey");
const outputDirEl = document.getElementById("outputDir");
const spreadsheetUrlEl = document.getElementById("spreadsheetUrl");
const sheetsWebAppUrlEl = document.getElementById("sheetsWebAppUrl");
const copyAppsScriptBtn = document.getElementById("copyAppsScript");
const copySheetRowBtn = document.getElementById("copySheetRow");
const pasteJdBtn = document.getElementById("pasteJd");
const generateResumeBtn = document.getElementById("generateResume");
const resetBtn = document.getElementById("reset");
const toggleAddProfileBtn = document.getElementById("toggleAddProfile");
const addProfileBody = document.getElementById("addProfileBody");
const newProfileNameEl = document.getElementById("newProfileName");
const newProfilePromptEl = document.getElementById("newProfilePrompt");
const saveProfileBtn = document.getElementById("saveProfile");

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
    openai_api_key: openaiApiKeyEl.value.trim(),
    output_dir: outputDirEl.value.trim() || DEFAULT_OUTPUT_DIR,
    spreadsheet_url: spreadsheetUrlEl.value.trim(),
    sheets_web_app_url: sheetsWebAppUrlEl.value.trim()
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get([
    "selected_profile_id",
    "selected_template_id",
    "last_job_title",
    "last_company_name",
    "last_jd_link",
    "last_jd_text",
    "openai_api_key",
    "output_dir",
    "spreadsheet_url",
    "sheets_web_app_url",
    "generation_status",
    "generation_running"
  ]);

  await refreshProfiles(data.selected_profile_id || DEFAULT_PROFILE_ID);
  await refreshTemplates(data.selected_template_id || templateIdForProfile(profileSelectEl.value));
  jobTitleEl.value = data.last_job_title || "";
  companyNameEl.value = data.last_company_name || "";
  jdLinkEl.value = data.last_jd_link || "";
  jdTextEl.value = data.last_jd_text || "";
  openaiApiKeyEl.value = data.openai_api_key || "";
  outputDirEl.value = data.output_dir || DEFAULT_OUTPUT_DIR;
  spreadsheetUrlEl.value = data.spreadsheet_url || "";
  sheetsWebAppUrlEl.value = data.sheets_web_app_url || "";
  setStatus(data.generation_status || "");
  setBusy(Boolean(data.generation_running));
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
  const apiKey = (openaiApiKeyEl.value || "").trim();
  const outputDir = (outputDirEl.value || "").trim() || DEFAULT_OUTPUT_DIR;
  const spreadsheetUrl = (spreadsheetUrlEl.value || "").trim();
  const sheetsWebAppUrl = (sheetsWebAppUrlEl.value || "").trim();

  if (!apiKey) {
    setStatus("Enter your OpenAI API key first.");
    openaiApiKeyEl.focus();
    return null;
  }
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

  await chrome.storage.local.set({
    selected_profile_id: profileId,
    selected_template_id: templateId,
    last_job_title: jobTitle,
    last_company_name: companyName,
    last_jd_link: jdLink,
    last_jd_text: jd,
    openai_api_key: apiKey,
    output_dir: outputDir,
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
      outputDir,
      spreadsheetUrl,
      sheetsWebAppUrl,
      templateId
    }
  };
}

function setBusy(busy) {
  if (generateResumeBtn) generateResumeBtn.disabled = busy;
}

async function generateResumeAndCoverLetter() {
  const collected = await collectJobMetaOrShowError();
  if (!collected) return;

  setStatus("Starting OpenAI resume generation...");
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
    setStatus("Running: calling OpenAI, then rendering PDFs...");
  } catch (err) {
    setStatus(`Generation failed: ${String(err.message || err)}`);
    setBusy(false);
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

async function saveNewProfile() {
  const label = newProfileNameEl.value;
  const promptTemplate = newProfilePromptEl.value;

  saveProfileBtn.disabled = true;
  try {
    const profile = await addCustomProfile({ label, promptTemplate });
    newProfileNameEl.value = "";
    newProfilePromptEl.value = "";
    await chrome.storage.local.set({ selected_profile_id: profile.id });
    await refreshProfiles(profile.id);
    addProfileBody.hidden = true;
    toggleAddProfileBtn.setAttribute("aria-expanded", "false");
    setStatus(`Profile saved: ${profile.label}`);
  } catch (err) {
    setStatus(String(err.message || err));
  } finally {
    saveProfileBtn.disabled = false;
  }
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
  openaiApiKeyEl,
  outputDirEl,
  spreadsheetUrlEl,
  sheetsWebAppUrlEl
]) {
  el.addEventListener("change", () => {
    persistJobFields().catch(() => {});
  });
}

toggleAddProfileBtn.addEventListener("click", () => {
  const open = addProfileBody.hidden;
  addProfileBody.hidden = !open;
  toggleAddProfileBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) newProfileNameEl.focus();
});

pasteJdBtn.addEventListener("click", pasteJdFromClipboard);
copyAppsScriptBtn.addEventListener("click", copyAppsScript);
copySheetRowBtn.addEventListener("click", copySheetRow);
generateResumeBtn.addEventListener("click", generateResumeAndCoverLetter);
resetBtn.addEventListener("click", resetWorkflow);
saveProfileBtn.addEventListener("click", saveNewProfile);
deleteProfileBtn.addEventListener("click", removeSelectedProfile);

document.addEventListener("keydown", (e) => {
  const key = String(e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === "enter") {
    e.preventDefault();
    generateResumeAndCoverLetter().catch(() => {});
  }
});

loadSettings().catch((err) => setStatus(`Init failed: ${String(err.message || err)}`));
setInterval(async () => {
  const data = await chrome.storage.local.get(["generation_status", "generation_running"]);
  if (typeof data.generation_status === "string") {
    setStatus(data.generation_status);
  }
  setBusy(Boolean(data.generation_running));
}, 1200);
