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
 *   spreadsheetId, sheetGid, sheetName, jobLink, jobTitle, companyName, applicationDate,
 *   workArrangement, employmentType, salaryMin, salaryMax, datePosted,
 *   applicationStatus (optional — column J when track status is enabled)
 *
 * Row order matches your sheet headers:
 *   A JOB URL | B JOB TITLE | C COMPANY NAME | D Application Date |
 *   E Work arrangement | F Employment type | G Salary min | H Salary max | I Date posted |
 *   J Status (optional: "Resume Generated" → "Applied")
 *
 * Rows are written on the selected tab, in the first empty cell of column A
 * (same place you'd paste after Copy row).
 */
var API_VERSION = "2026-08-23";

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
    return value !== "" && !/^job\s*(url|link)$/i.test(value);
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

function normalizeJobLink(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase();
}

function findRowByJobLink(sheet, jobLink) {
  var target = normalizeJobLink(jobLink);
  if (!target) return 0;
  var values = getColumnAValues(sheet);
  for (var i = 0; i < values.length; i += 1) {
    if (normalizeJobLink(values[i]) === target) return i + 1;
  }
  return 0;
}

function appendJobRow(sheet, data) {
  var row = findNextEmptyRowInColumnA(sheet);
  var status = String(data.applicationStatus || "").trim();
  var cells = [
    data.jobLink || "",
    data.jobTitle || "",
    data.companyName || "",
    data.applicationDate || "",
    data.workArrangement || "",
    data.employmentType || "",
    data.salaryMin || "",
    data.salaryMax || "",
    data.datePosted || ""
  ];
  if (status) {
    cells.push(status);
    sheet.getRange("A" + row + ":J" + row).setValues([cells]);
  } else {
    sheet.getRange("A" + row + ":I" + row).setValues([cells]);
  }
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
  sheet.getRange("J" + row).setValue(status);
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
