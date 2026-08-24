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

function validateWebAppUrl(webAppUrl) {
  const endpoint = String(webAppUrl || "").trim();
  if (!endpoint || !/^https:\/\/script\.google\.com\//i.test(endpoint)) {
    throw new Error(
      "Paste the Apps Script Web App URL (Deploy → Web app). Spreadsheet share link alone cannot be written to from Chrome."
    );
  }
  return endpoint;
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
    throw new Error("Google Sheet returned an invalid response. Redeploy the latest Apps Script code.");
  }
  if (parsed.ok === false) {
    const errText = String(parsed.error || "Google Sheet request failed.");
    if (/number of rows in the data does not match/i.test(errText)) {
      throw new Error(
        "Your Apps Script Web App is still the old version. Click Copy script in the extension, paste into Apps Script, Save, then Deploy → Manage deployments → Edit → New version → Deploy."
      );
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
 * Tab-separated row matching sheet columns A–I:
 * JOB URL | JOB TITLE | COMPANY NAME | Application Date |
 * Work arrangement | Employment type | Salary min | Salary max | Date posted
 * Paste into the first cell of an empty row in Google Sheets.
 */
export function buildSheetRowTsv({
  jobTitle,
  companyName,
  jdLink,
  includeDate = true,
  workArrangement = "",
  employmentType = "",
  salaryMin = "",
  salaryMax = "",
  datePosted = ""
}) {
  const cells = [jdLink || "", jobTitle || "", companyName || ""];
  cells.push(includeDate ? formatApplicationDate() : "");
  cells.push(
    workArrangement || "",
    employmentType || "",
    salaryMin || "",
    salaryMax || "",
    datePosted || ""
  );
  return cells.join("\t");
}

/**
 * Appends one row via the deployed Apps Script web app.
 * Uses text/plain body to avoid CORS preflight issues with Google Apps Script.
 * Optional applicationStatus writes column J (Status) when track-status is enabled.
 */
export async function appendJobToSpreadsheet({
  spreadsheetUrl,
  webAppUrl,
  jobTitle,
  companyName,
  jdLink,
  sheetName = "",
  workArrangement = "",
  employmentType = "",
  salaryMin = "",
  salaryMax = "",
  datePosted = "",
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
  const payload = {
    action: "appendJob",
    spreadsheetId,
    sheetGid,
    sheetName: tabName,
    jobLink: jdLink || "",
    jobTitle: jobTitle || "",
    companyName: companyName || "",
    applicationDate: formatApplicationDate(),
    workArrangement: workArrangement || "",
    employmentType: employmentType || "",
    salaryMin: salaryMin || "",
    salaryMax: salaryMax || "",
    datePosted: datePosted || "",
    ...(status ? { applicationStatus: status } : null)
  };

  const result = await postToSheetsWebApp(endpoint, payload);
  const version = String(result.apiVersion || "");
  if (!result.row || (version !== "2026-08-09" && version !== "2026-08-23")) {
    throw new Error(
      "Your Apps Script Web App is outdated (still running old code). In the extension click Copy script → paste into Apps Script → Save → Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy. Then try again."
    );
  }
  if (status && version !== "2026-08-23") {
    throw new Error(
      "Status tracking needs the latest Apps Script. Click Copy script → paste → Save → Deploy a new Web App version."
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
 * Update column J (Status) for an existing row matched by job URL.
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

  if (String(result.apiVersion || "") !== "2026-08-23") {
    throw new Error(
      "Status updates need the latest Apps Script. Click Copy script → paste → Save → Deploy a new Web App version."
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
    throw new Error(
      "The Apps Script deployment is outdated. Copy the latest script, then deploy a new Web App version."
    );
  }
  return result.jobLinks.map((value) => String(value || ""));
}
