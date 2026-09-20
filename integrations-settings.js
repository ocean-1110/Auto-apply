/**
 * Google Sheet + login/signup settings used on the profile editor page.
 */
import { extractSpreadsheetId, pingSheetsWebApp, CURRENT_SHEET_API_VERSION } from "./sheets.js";
import {
  getSheetPresets,
  getPresetForProfile,
  saveSheetPreset,
  deleteSheetPreset,
  setProfileSheetPresetId,
  presetDisplayLabel,
  validateSheetPreset
} from "./sheet-presets.js";

export function initIntegrationsSettings({ getProfileId, setStatus }) {
  const els = {
    spreadsheetUrl: document.getElementById("spreadsheetUrl"),
    sheetTabName: document.getElementById("sheetTabName"),
    sheetsWebAppUrl: document.getElementById("sheetsWebAppUrl"),
    trackSheetStatusToggle: document.getElementById("trackSheetStatusToggle"),
    sheetPresetSelect: document.getElementById("sheetPresetSelect"),
    sheetPresetLabel: document.getElementById("sheetPresetLabel"),
    saveSheetPreset: document.getElementById("saveSheetPreset"),
    deleteSheetPreset: document.getElementById("deleteSheetPreset"),
    copyAppsScript: document.getElementById("copyAppsScript"),
    testSheetsWebApp: document.getElementById("testSheetsWebApp"),
    sheetSummaryNote: document.getElementById("sheetSummaryNote"),
    credentialsNote: document.getElementById("credentialsNote"),
    accountEmail: document.getElementById("accountEmail"),
    accountUsername: document.getElementById("accountUsername"),
    accountPassword: document.getElementById("accountPassword"),
    accountShowPassword: document.getElementById("accountShowPassword"),
    accountSaveBtn: document.getElementById("accountSaveBtn"),
    accountClearBtn: document.getElementById("accountClearBtn")
  };

  let sheetPresetsCache = [];
  let applyingSheetPreset = false;

  function readSheetFields() {
    return {
      id: els.sheetPresetSelect?.value || "",
      label: (els.sheetPresetLabel?.value || "").trim(),
      spreadsheetUrl: (els.spreadsheetUrl?.value || "").trim(),
      sheetName: (els.sheetTabName?.value || "").trim(),
      webAppUrl: (els.sheetsWebAppUrl?.value || "").trim(),
      trackApplicationStatus: Boolean(els.trackSheetStatusToggle?.checked)
    };
  }

  function syncSheetSummaryNote() {
    if (!els.sheetSummaryNote) return;
    const spreadsheetUrl = (els.spreadsheetUrl?.value || "").trim();
    const webAppUrl = (els.sheetsWebAppUrl?.value || "").trim();
    const tabName = (els.sheetTabName?.value || "").trim();
    const hasTarget = Boolean(tabName) || /[?#&]gid=\d+/i.test(spreadsheetUrl);
    const connected =
      Boolean(spreadsheetUrl) &&
      Boolean(webAppUrl) &&
      Boolean(extractSpreadsheetId(spreadsheetUrl)) &&
      hasTarget;
    els.sheetSummaryNote.textContent = connected ? "Connected" : "Not connected";
    els.sheetSummaryNote.classList.toggle("is-connected", connected);
  }

  function applySheetFields(preset = null, { keepWebApp = true } = {}) {
    applyingSheetPreset = true;
    try {
      if (els.sheetPresetSelect) els.sheetPresetSelect.value = preset?.id || "";
      if (els.sheetPresetLabel) els.sheetPresetLabel.value = preset?.label || "";
      if (els.spreadsheetUrl) els.spreadsheetUrl.value = preset?.spreadsheetUrl || "";
      if (els.sheetTabName) els.sheetTabName.value = preset?.sheetName || "";
      if (els.sheetsWebAppUrl) {
        els.sheetsWebAppUrl.value = preset?.webAppUrl || (keepWebApp ? els.sheetsWebAppUrl.value : "") || "";
      }
      if (els.trackSheetStatusToggle) {
        els.trackSheetStatusToggle.checked = Boolean(preset?.trackApplicationStatus);
      }
    } finally {
      applyingSheetPreset = false;
    }
    syncSheetSummaryNote();
  }

  function populateSheetPresetSelect(selectedId = "") {
    if (!els.sheetPresetSelect) return;
    const current = selectedId || els.sheetPresetSelect.value || "";
    els.sheetPresetSelect.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— None —";
    els.sheetPresetSelect.appendChild(none);
    for (const preset of sheetPresetsCache) {
      const option = document.createElement("option");
      option.value = preset.id;
      option.textContent = presetDisplayLabel(preset);
      els.sheetPresetSelect.appendChild(option);
    }
    const valid = new Set(sheetPresetsCache.map((p) => p.id));
    els.sheetPresetSelect.value = valid.has(current) ? current : "";
  }

  async function persistSheetFields() {
    const fields = readSheetFields();
    await chrome.storage.local.set({
      spreadsheet_url: fields.spreadsheetUrl,
      sheets_sheet_name: fields.sheetName,
      sheets_web_app_url: fields.webAppUrl,
      track_application_status: fields.trackApplicationStatus
    });
  }

  async function refreshSheetPresets(selectedId = "") {
    sheetPresetsCache = await getSheetPresets();
    populateSheetPresetSelect(selectedId);
  }

  function updateCredentialsNote(creds = {}) {
    if (!els.credentialsNote) return;
    const parts = [];
    if (String(creds.email || "").trim()) parts.push("email");
    if (String(creds.username || "").trim()) parts.push("username");
    if (String(creds.password || "")) parts.push("password");
    els.credentialsNote.textContent = parts.length ? `Set: ${parts.join(", ")}` : "Not set";
  }

  function applyAccountCredentials(creds = {}) {
    if (els.accountEmail) els.accountEmail.value = String(creds.email || "");
    if (els.accountUsername) els.accountUsername.value = String(creds.username || "");
    if (els.accountPassword) els.accountPassword.value = String(creds.password || "");
    updateCredentialsNote(creds);
  }

  function readAccountCredentialsFromForm() {
    return {
      email: String(els.accountEmail?.value || "").trim(),
      username: String(els.accountUsername?.value || "").trim(),
      password: String(els.accountPassword?.value || "")
    };
  }

  async function saveAccountCredentials() {
    const creds = readAccountCredentialsFromForm();
    await chrome.storage.local.set({ account_credentials: creds });
    updateCredentialsNote(creds);
    setStatus("Login credentials saved.");
  }

  async function load() {
    const data = await chrome.storage.local.get([
      "spreadsheet_url",
      "sheets_sheet_name",
      "sheets_web_app_url",
      "track_application_status",
      "account_credentials"
    ]);
    await refreshSheetPresets();
    const profileId = getProfileId();
    const boundPreset = profileId ? await getPresetForProfile(profileId) : null;
    if (boundPreset) {
      applySheetFields(boundPreset);
      await persistSheetFields();
    } else {
      populateSheetPresetSelect("");
      if (els.spreadsheetUrl) els.spreadsheetUrl.value = data.spreadsheet_url || "";
      if (els.sheetTabName) els.sheetTabName.value = data.sheets_sheet_name || "";
      if (els.sheetsWebAppUrl) els.sheetsWebAppUrl.value = data.sheets_web_app_url || "";
      if (els.trackSheetStatusToggle) {
        els.trackSheetStatusToggle.checked = Boolean(data.track_application_status);
      }
      syncSheetSummaryNote();
    }
    applyAccountCredentials(data.account_credentials || {});
  }

  els.sheetPresetSelect?.addEventListener("change", async () => {
    const id = els.sheetPresetSelect?.value || "";
    const profileId = getProfileId();
    const preset = sheetPresetsCache.find((p) => p.id === id) || null;
    applySheetFields(preset, { keepWebApp: !preset });
    if (profileId) await setProfileSheetPresetId(profileId, id);
    await persistSheetFields();
  });

  els.saveSheetPreset?.addEventListener("click", async () => {
    const profileId = getProfileId();
    const fields = readSheetFields();
    const error = validateSheetPreset(fields);
    if (error) {
      setStatus(error, true);
      return;
    }
    const saved = await saveSheetPreset(fields, { profileId });
    await refreshSheetPresets(saved.id);
    applySheetFields(saved);
    await persistSheetFields();
    setStatus(`Saved sheet "${presetDisplayLabel(saved)}" for this profile.`);
  });

  els.deleteSheetPreset?.addEventListener("click", async () => {
    const id = els.sheetPresetSelect?.value || "";
    if (!id) {
      setStatus("Select a saved sheet to delete.");
      return;
    }
    const preset = sheetPresetsCache.find((p) => p.id === id);
    await deleteSheetPreset(id);
    await refreshSheetPresets("");
    applySheetFields(null, { keepWebApp: true });
    await persistSheetFields();
    setStatus(`Deleted saved sheet${preset ? `: ${presetDisplayLabel(preset)}` : "."}`);
  });

  for (const el of [els.spreadsheetUrl, els.sheetTabName, els.sheetsWebAppUrl, els.sheetPresetLabel].filter(Boolean)) {
    el.addEventListener("change", () => {
      if (applyingSheetPreset) return;
      persistSheetFields().catch(() => {});
      syncSheetSummaryNote();
    });
  }
  els.trackSheetStatusToggle?.addEventListener("change", () => persistSheetFields().catch(() => {}));

  els.copyAppsScript?.addEventListener("click", async () => {
    try {
      const res = await fetch(chrome.runtime.getURL("apps-script/Code.gs"));
      const text = await res.text();
      if (!String(text || "").trim()) throw new Error("empty");
      await navigator.clipboard.writeText(text);
      setStatus(
        "Apps Script copied. Paste into Extensions → Apps Script → Save, then Deploy → Manage deployments → Edit → New version → Deploy. Paste the /exec URL here and click Test Web App."
      );
    } catch {
      setStatus("Could not copy. Open apps-script/Code.gs in the project instead.", true);
    }
  });

  els.testSheetsWebApp?.addEventListener("click", async () => {
    const webAppUrl = (els.sheetsWebAppUrl?.value || "").trim();
    if (!webAppUrl) {
      setStatus("Paste the Apps Script Web App URL (…/exec) first.", true);
      return;
    }
    try {
      await persistSheetFields();
      setStatus("Testing Web App deployment…");
      const ping = await pingSheetsWebApp(webAppUrl);
      if (ping.upToDate) {
        setStatus(
          `Web App OK — apiVersion ${ping.apiVersion} (current). Sheet append should work.`
        );
        if (els.sheetSummaryNote) {
          els.sheetSummaryNote.textContent = `OK · ${ping.apiVersion}`;
          els.sheetSummaryNote.classList.add("is-connected");
        }
        return;
      }
      setStatus(
        `Web App is live but outdated (apiVersion "${ping.apiVersion || "missing"}", need "${CURRENT_SHEET_API_VERSION}"). Save is not enough — Deploy → Manage deployments → Edit → New version → Deploy, then Test again.`,
        true
      );
      if (els.sheetSummaryNote) {
        els.sheetSummaryNote.textContent = `Outdated · ${ping.apiVersion || "?"}`;
        els.sheetSummaryNote.classList.remove("is-connected");
      }
    } catch (err) {
      setStatus(`Web App test failed: ${String(err?.message || err)}`, true);
      if (els.sheetSummaryNote) {
        els.sheetSummaryNote.textContent = "Test failed";
        els.sheetSummaryNote.classList.remove("is-connected");
      }
    }
  });

  els.accountShowPassword?.addEventListener("change", () => {
    if (els.accountPassword) {
      els.accountPassword.type = els.accountShowPassword.checked ? "text" : "password";
    }
  });
  els.accountSaveBtn?.addEventListener("click", () => saveAccountCredentials().catch(() => {}));
  els.accountClearBtn?.addEventListener("click", async () => {
    applyAccountCredentials({});
    await chrome.storage.local.remove("account_credentials");
    setStatus("Login credentials cleared.");
  });
  for (const el of [els.accountEmail, els.accountUsername, els.accountPassword].filter(Boolean)) {
    el.addEventListener("change", () => saveAccountCredentials().catch(() => {}));
  }

  return { load };
}
