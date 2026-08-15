import { extractSpreadsheetId, extractSheetGid } from "./sheets.js";

const PRESETS_KEY = "sheet_presets";
const PROFILE_SHEET_KEY = "profile_sheet_preset_ids";

function newPresetId() {
  return `sheet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function presetDisplayLabel(preset) {
  const label = String(preset?.label || "").trim();
  if (label) return label;
  const tab = String(preset?.sheetName || "").trim();
  const gid = extractSheetGid(preset?.spreadsheetUrl || "");
  const id = extractSpreadsheetId(preset?.spreadsheetUrl || "");
  const bits = [];
  if (tab) bits.push(tab);
  else if (gid) bits.push(`gid ${gid}`);
  if (id) bits.push(id.slice(-6));
  return bits.join(" · ") || "Untitled sheet";
}

export async function getSheetPresets() {
  const data = await chrome.storage.local.get(PRESETS_KEY);
  const list = data[PRESETS_KEY];
  return Array.isArray(list) ? list : [];
}

export async function getProfileSheetMap() {
  const data = await chrome.storage.local.get(PROFILE_SHEET_KEY);
  const map = data[PROFILE_SHEET_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getPresetById(id) {
  if (!id) return null;
  const presets = await getSheetPresets();
  return presets.find((p) => p.id === id) || null;
}

export async function getPresetForProfile(profileId) {
  if (!profileId) return null;
  const map = await getProfileSheetMap();
  return getPresetById(map[profileId] || "");
}

export async function setProfileSheetPresetId(profileId, presetId) {
  if (!profileId) return;
  const map = await getProfileSheetMap();
  if (presetId) map[profileId] = presetId;
  else delete map[profileId];
  await chrome.storage.local.set({ [PROFILE_SHEET_KEY]: map });
}

function normalizePreset(input = {}, existingId = "") {
  return {
    id: existingId || String(input.id || "").trim() || newPresetId(),
    label: String(input.label || "").trim(),
    spreadsheetUrl: String(input.spreadsheetUrl || "").trim(),
    sheetName: String(input.sheetName || "").trim(),
    webAppUrl: String(input.webAppUrl || "").trim()
  };
}

export function validateSheetPreset(preset) {
  const spreadsheetUrl = String(preset?.spreadsheetUrl || "").trim();
  const webAppUrl = String(preset?.webAppUrl || "").trim();
  const sheetName = String(preset?.sheetName || "").trim();
  if (!extractSpreadsheetId(spreadsheetUrl)) {
    return "Enter a valid Google Spreadsheet link.";
  }
  if (!webAppUrl) {
    return "Paste the Apps Script Web App URL once, then Save — it is reused for this sheet.";
  }
  if (!sheetName && !extractSheetGid(spreadsheetUrl)) {
    return "Open the target tab, copy the URL with gid=..., or enter the Sheet tab name.";
  }
  return "";
}

export async function saveSheetPreset(input = {}, { profileId = "" } = {}) {
  const error = validateSheetPreset(input);
  if (error) throw new Error(error);

  const presets = await getSheetPresets();
  const incoming = normalizePreset(input, String(input.id || "").trim());
  if (!incoming.label) incoming.label = presetDisplayLabel(incoming);

  const index = presets.findIndex((p) => p.id === incoming.id);
  if (index >= 0) presets[index] = { ...presets[index], ...incoming };
  else presets.push(incoming);

  await chrome.storage.local.set({ [PRESETS_KEY]: presets });
  if (profileId) await setProfileSheetPresetId(profileId, incoming.id);
  return incoming;
}

export async function deleteSheetPreset(id) {
  if (!id) return;
  const presets = (await getSheetPresets()).filter((p) => p.id !== id);
  await chrome.storage.local.set({ [PRESETS_KEY]: presets });
  const map = await getProfileSheetMap();
  let changed = false;
  for (const [profileId, presetId] of Object.entries(map)) {
    if (presetId === id) {
      delete map[profileId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [PROFILE_SHEET_KEY]: map });
}
