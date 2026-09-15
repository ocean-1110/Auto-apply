/**
 * One-time setup for Google Sheets append (from the extension README):
 *
 * 1. Open your spreadsheet on the tab you want to write to
 * 2. Extensions → Apps Script
 * 3. Paste this code and Save
 * 4. Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy
 *    Or: Deploy → New deployment → Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the Web App URL into the extension
 * 6. In the extension, paste the spreadsheet URL that includes that tab's gid
 *    (open the tab first, then copy the browser URL), or set Sheet tab name
 *
 * After generation, the extension appends:
 *   spreadsheetId, sheetGid, sheetName, jobLink, jobTitle, companyName,
 *   applicationDate, salary (or salaryMin/salaryMax), applicationStatus
 *
 * Row order matches sheet headers:
 *   A No | B Created Date | C Title | D Company | E Link | F Salary | G JD | H Apply Status
 *
 * - Salary is one cell, e.g. "$120000 - $150000"
 * - JD (column G) is left blank on purpose
 * - Apply Status (column H) is written when track-status is enabled
 * - Duplicate checks and status updates match on Link (column E)
 *
 * Rows are written on the selected tab, in the first empty cell of column A.
 */
var API_VERSION = "2026-09-14";
var LINK_COLUMN = 5;
var STATUS_COLUMN = 8;

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

function getColumnValues(sheet, columnIndex) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return [];
  return sheet.getRange(1, columnIndex, lastRow, 1).getDisplayValues().map(function (row) {
    return String(row[0] || "").trim();
  });
}

function getColumnAValues(sheet) {
  return getColumnValues(sheet, 1);
}

function getJobLinks(sheet) {
  return getColumnValues(sheet, LINK_COLUMN).filter(function (value) {
    if (!value) return false;
    if (/^(job\s*)?(url|link)$/i.test(value)) return false;
    if (/^link$/i.test(value)) return false;
    return true;
  });
}

/** First empty row in column A — matches pasting under the last numbered row. */
function findNextEmptyRowInColumnA(sheet) {
  var values = getColumnAValues(sheet);
  for (var i = values.length - 1; i >= 0; i -= 1) {
    if (values[i] !== "") return i + 2; // 1-based next row
  }
  return 1;
}

function nextSerialNo(sheet) {
  var values = getColumnAValues(sheet);
  var max = 0;
  for (var i = 0; i < values.length; i += 1) {
    var n = parseInt(String(values[i]).replace(/[^\d]/g, ""), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function normalizeJobLink(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function findRowByJobLink(sheet, jobLink) {
  var target = normalizeJobLink(jobLink);
  if (!target) return 0;
  var values = getColumnValues(sheet, LINK_COLUMN);
  for (var i = 0; i < values.length; i += 1) {
    if (normalizeJobLink(values[i]) === target) return i + 1;
  }
  return 0;
}

function salaryDigits_(value) {
  var s = String(value || "").trim();
  if (!s) return "";
  var cleaned = s.replace(/[$,\s]/g, "");
  var kMatch = cleaned.match(/^([\d.]+)\s*[kK]/i);
  if (kMatch) return String(Math.round(Number(kMatch[1]) * 1000));
  var n = Number(cleaned.replace(/[^\d.]/g, ""));
  if (Number.isFinite(n) && n > 0) return String(Math.round(n));
  var digits = cleaned.match(/\d+/);
  return digits ? digits[0] : "";
}

function formatSalaryRange_(minValue, maxValue) {
  var min = salaryDigits_(minValue);
  var max = salaryDigits_(maxValue);
  if (min && max) {
    if (min === max) return "$" + min;
    return "$" + min + " - $" + max;
  }
  if (min) return "$" + min;
  if (max) return "$" + max;
  return "";
}

function resolveSalary_(data) {
  var ready = String(data.salary || "").trim();
  if (ready) return ready;
  return formatSalaryRange_(data.salaryMin, data.salaryMax);
}

function appendJobRow(sheet, data) {
  var row = findNextEmptyRowInColumnA(sheet);
  var status = String(data.applicationStatus || "").trim();
  var cells = [
    nextSerialNo(sheet),
    data.applicationDate || "",
    data.jobTitle || "",
    data.companyName || "",
    data.jobLink || "",
    resolveSalary_(data),
    "", // JD — intentionally blank
    status
  ];
  // Sheet.getRange(row, column, numRows, numColumns) — 3rd/4th args are sizes, not lastRow/lastCol.
  sheet.getRange(row, 1, 1, STATUS_COLUMN).setValues([cells]);
  return {
    ok: true,
    apiVersion: API_VERSION,
    sheetName: sheet.getName(),
    sheetGid: String(sheet.getSheetId()),
    row: row
  };
}

function updateJobStatus(sheet, data) {
  var status = String(data.applicationStatus || "").trim();
  if (!status) throw new Error("applicationStatus is required.");
  var row = findRowByJobLink(sheet, data.jobLink);
  if (!row) {
    throw new Error('No sheet row found for job URL: "' + String(data.jobLink || "") + '"');
  }
  sheet.getRange(row, STATUS_COLUMN).setValue(status);
  return {
    ok: true,
    apiVersion: API_VERSION,
    sheetName: sheet.getName(),
    sheetGid: String(sheet.getSheetId()),
    row: row,
    applicationStatus: status
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
        apiVersion: API_VERSION,
        jobLinks: getJobLinks(sheet),
        sheetName: sheet.getName(),
        sheetGid: String(sheet.getSheetId())
      });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (data.action === "updateStatus") {
        return jsonResponse(updateJobStatus(sheet, data));
      }
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
        apiVersion: API_VERSION,
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
      apiVersion: API_VERSION,
      message: "Resume GPT Builder sheet append endpoint is running."
    })
  ).setMimeType(ContentService.MimeType.JSON);
}
