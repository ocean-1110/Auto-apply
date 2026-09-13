export function extractSpreadsheetId(urlOrId) {
  const raw = String(urlOrId || "").trim();
  if (!raw) return "";

  const fromUrl = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) return fromUrl[1];

  if (/^[a-zA-Z0-9-_]+$/.test(raw)) return raw;
  return "";
}

export function extractSheetGid(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  const match = raw.match(/[?#&]gid=(\d+)/i);
  return match ? match[1] : "";
}

/** Apps Script API versions that know the current sheet column layout. */
export const CURRENT_SHEET_API_VERSION = "2026-09-12";

function validateWebAppUrl(webAppUrl) {
  const endpoint = String(webAppUrl || "").trim();
  if (!endpoint || !/^https:\/\/script\.google\.com\//i.test(endpoint)) {
    throw new Error(
      "Paste the Apps Script Web App URL (Deploy → Web app). Spreadsheet share link alone cannot be written to from Chrome."
    );
  }
  // Must be the /exec Web App URL, not the script editor or /dev link.
  if (!/\/macros\/s\/|\/a\/macros\//i.test(endpoint) && !/\/exec(?:\?|$)/i.test(endpoint)) {
    throw new Error(
      "That does not look like a Web App URL. In Apps Script open Deploy → Manage deployments, copy the Web app URL (ends with /exec), and paste it here — not the script source."
    );
  }
  return endpoint;
}

/**
 * GET the web app to read apiVersion from the live deployment (Save alone does not update this).
 */
export async function pingSheetsWebApp(webAppUrl) {
  const endpoint = validateWebAppUrl(webAppUrl);
  const response = await fetch(endpoint, { method: "GET", redirect: "follow" });
  const result = await readSheetsResponse(response);
  const apiVersion = String(result.apiVersion || "").trim();
  return {
    ok: true,
    apiVersion,
    current: CURRENT_SHEET_API_VERSION,
    upToDate: apiVersion === CURRENT_SHEET_API_VERSION,
    message: String(result.message || "")
  };
}

function outdatedDeployHint(extra = "") {
  const bit = String(extra || "").trim();
  return (
    "Apps Script is still serving old code (Save is not enough). " +
    "In the spreadsheet: Extensions → Apps Script → paste Copy Apps Script → Save → " +
    "Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy. " +
    "Then paste the same Web app URL (…/exec) into the extension. " +
    (bit ? `Detail: ${bit}` : `Expected apiVersion ${CURRENT_SHEET_API_VERSION}.`)
  );
}

async function readSheetsResponse(response) {
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(parsed?.error || `Google Sheet request failed (HTTP ${response.status}).`);
  }
  if (!parsed) {
    throw new Error(
      "Google Sheet returned HTML/invalid JSON (often a wrong URL or an undeployed script). " +
        outdatedDeployHint()
    );
  }
  if (parsed.ok === false) {
    const errText = String(parsed.error || "Google Sheet request failed.");
    if (/number of (rows|columns) in the data does not match/i.test(errText)) {
      throw new Error(outdatedDeployHint(errText));
    }
    throw new Error(errText);
  }

  return parsed;
}

async function postToSheetsWebApp(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
  return readSheetsResponse(response);
}

export function formatApplicationDate(date = new Date()) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Format salary as "$120000 - $150000" (or a single "$120000" when only one bound exists).
 */
export function formatSalaryRange(salaryMin = "", salaryMax = "") {
  const toDigits = (value) => {
    const s = String(value || "").trim();
    if (!s) return "";
    const cleaned = s.replace(/[$,\s]/g, "");
    const kMatch = cleaned.match(/^([\d.]+)\s*[kK]\b/i) || cleaned.match(/^([\d.]+)[kK]/);
    if (kMatch) return String(Math.round(Number(kMatch[1]) * 1000));
    const n = Number(cleaned.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return String(Math.round(n));
    const digits = cleaned.match(/\d+/);
    return digits ? digits[0] : "";
  };

  const min = toDigits(salaryMin);
  const max = toDigits(salaryMax);
  if (min && max) {
    if (min === max) return `$${min}`;
    return `$${min} - $${max}`;
  }
  if (min) return `$${min}`;
  if (max) return `$${max}`;
  return "";
}

/** Normalize job URLs for duplicate checks (matches capture queue logic). */
export function normalizeSheetJobLink(value) {
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

export function isJobLinkOnSheet(existingLinks, jdLink) {
  const target = normalizeSheetJobLink(jdLink).toLowerCase();
  if (!target) return false;
  return (existingLinks || []).some(
    (link) => normalizeSheetJobLink(link).toLowerCase() === target
  );
}

export class JobAlreadyOnSheetError extends Error {
  constructor(jdLink = "") {
    super("This job is already on your tracking sheet (Link column). Skipping resume generation.");
    this.name = "JobAlreadyOnSheetError";
    this.code = "ALREADY_ON_SHEET";
    this.jdLink = String(jdLink || "").trim();
  }
}

/**
 * Tab-separated row matching sheet columns A–H:
 * No | Created Date | Title | Company | Link | Salary | JD | Apply Status
 * Paste into the first cell of an empty row in Google Sheets.
 * No and JD are left blank for manual paste; Salary uses "$min - $max".
 */
export function buildSheetRowTsv({
  jobTitle,
  companyName,
  jdLink,
  includeDate = true,
  salaryMin = "",
  salaryMax = "",
  applicationStatus = ""
}) {
  const cells = [
    "", // No — filled by Apps Script on auto-append; blank for manual paste
    includeDate ? formatApplicationDate() : "",
    jobTitle || "",
    companyName || "",
    jdLink || "",
    formatSalaryRange(salaryMin, salaryMax),
    "", // JD — intentionally blank
    applicationStatus || ""
  ];
  return cells.join("\t");
}

/**
 * Appends one row via the deployed Apps Script web app.
 * Uses text/plain body to avoid CORS preflight issues with Google Apps Script.
 * Optional applicationStatus writes column H (Apply Status) when track-status is enabled.
 */
export async function appendJobToSpreadsheet({
  spreadsheetUrl,
  webAppUrl,
  jobTitle,
  companyName,
  jdLink,
  sheetName = "",
  salaryMin = "",
  salaryMax = "",
  applicationStatus = ""
}) {
  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    throw new Error("Invalid Google Spreadsheet link.");
  }

  const endpoint = validateWebAppUrl(webAppUrl);

  const sheetGid = extractSheetGid(spreadsheetUrl);
  const tabName = String(sheetName || "").trim();
  if (!sheetGid && !tabName) {
    throw new Error(
      "Open the target sheet tab in Google Sheets, copy that browser URL (it must include gid=...), or enter the Sheet tab name."
    );
  }

  const status = String(applicationStatus || "").trim();
  const salary = formatSalaryRange(salaryMin, salaryMax);
  const payload = {
    action: "appendJob",
    spreadsheetId,
    sheetGid,
    sheetName: tabName,
    jobLink: jdLink || "",
    jobTitle: jobTitle || "",
    companyName: companyName || "",
    applicationDate: formatApplicationDate(),
    salary,
    salaryMin: salaryMin || "",
    salaryMax: salaryMax || "",
    ...(status ? { applicationStatus: status } : null)
  };

  const result = await postToSheetsWebApp(endpoint, payload);
  const version = String(result.apiVersion || "");
  if (!result.row || version !== CURRENT_SHEET_API_VERSION) {
    throw new Error(
      outdatedDeployHint(
        version
          ? `deployed apiVersion="${version}", need "${CURRENT_SHEET_API_VERSION}"`
          : "response had no apiVersion (old deployment)"
      )
    );
  }

  return {
    spreadsheetId,
    sheetGid: result.sheetGid || sheetGid,
    sheetName: result.sheetName || tabName,
    row: Number(result.row) || 0,
    ...payload
  };
}

/**
 * Update column H (Apply Status) for an existing row matched by job Link (column E).
 */
export async function updateJobStatusInSpreadsheet({
  spreadsheetUrl,
  webAppUrl,
  jdLink,
  sheetName = "",
  applicationStatus = "Applied"
}) {
  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    throw new Error("Invalid Google Spreadsheet link.");
  }
  const endpoint = validateWebAppUrl(webAppUrl);
  const sheetGid = extractSheetGid(spreadsheetUrl);
  const tabName = String(sheetName || "").trim();
  if (!sheetGid && !tabName) {
    throw new Error(
      "Open the target sheet tab in Google Sheets, copy that browser URL (it must include gid=...), or enter the Sheet tab name."
    );
  }
  const status = String(applicationStatus || "").trim();
  if (!status) throw new Error("applicationStatus is required.");
  if (!String(jdLink || "").trim()) throw new Error("Job URL is required to update sheet status.");

  const result = await postToSheetsWebApp(endpoint, {
    action: "updateStatus",
    spreadsheetId,
    sheetGid,
    sheetName: tabName,
    jobLink: jdLink || "",
    applicationStatus: status
  });

  if (String(result.apiVersion || "") !== CURRENT_SHEET_API_VERSION) {
    throw new Error(
      outdatedDeployHint(
        `deployed apiVersion="${result.apiVersion || ""}", need "${CURRENT_SHEET_API_VERSION}"`
      )
    );
  }

  return {
    spreadsheetId,
    sheetGid: result.sheetGid || sheetGid,
    sheetName: result.sheetName || tabName,
    row: Number(result.row) || 0,
    applicationStatus: status
  };
}

export async function getExistingJobLinks({ spreadsheetUrl, webAppUrl, sheetName = "" }) {
  const spreadsheetId = extractSpreadsheetId(spreadsheetUrl);
  if (!spreadsheetId) {
    throw new Error("Invalid Google Spreadsheet link.");
  }

  const endpoint = validateWebAppUrl(webAppUrl);
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set("action", "getJobLinks");
  requestUrl.searchParams.set("spreadsheetId", spreadsheetId);
  requestUrl.searchParams.set("sheetGid", extractSheetGid(spreadsheetUrl));
  const tabName = String(sheetName || "").trim();
  if (tabName) requestUrl.searchParams.set("sheetName", tabName);
  const response = await fetch(requestUrl.toString(), { method: "GET", redirect: "follow" });
  const result = await readSheetsResponse(response);

  if (!Array.isArray(result.jobLinks)) {
    throw new Error(outdatedDeployHint("getJobLinks missing from deployment"));
  }
  return result.jobLinks.map((value) => String(value || ""));
}
