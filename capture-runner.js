/**
 * Unified Dice + JobRight capture for Resume GPT Builder.
 * Jobs flow directly into extension storage (no CSV import step).
 * - JobRight: Chrome session (content script + recommend API)
 * - Dice: dice-jobright-sf-job-capture local API JSON (Playwright on server)
 */

import { getExistingJobLinks } from "./sheets.js";
import {
  AUTO_CAPTURE_ENABLED_KEY,
  CAPTURE_ALARM_NAME,
  CAPTURE_API_BASE_KEY,
  CAPTURE_API_DEFAULT,
  CAPTURE_PERIOD_MINUTES,
  CAPTURE_SEARCH_Q_KEY,
  LAST_CAPTURE_STATUS_KEY,
  buildCaptureSummary,
  captureApiFetch,
  countCaptureJobsBySource,
  mergeJobsIntoQueue
} from "./capture-jobs.js";
import { awaitTabComplete } from "./tab-utils.js";
import { applyRememberedStatus, readJobStatusMemory } from "./job-status-memory.js";

const IMPORTED_JOBS_BY_ID_KEY = "imported_jobs_by_id";
const IMPORTED_JOBS_ORDER_KEY = "imported_jobs_order";
const IMPORTED_JOBS_VERSION_KEY = "imported_jobs_version";

let captureRunning = false;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildJobrightSearchUrl(query = "Salesforce") {
  const taxonomy = encodeURIComponent(
    JSON.stringify([{ taxonomyId: "00-00-00", title: query }])
  );
  const value = encodeURIComponent(query);
  return (
    `https://jobright.ai/jobs/search?visit=search&value=${value}` +
    `&searchType=job_title&country=US&jobTaxonomyList=${taxonomy}`
  );
}

async function getCaptureConfig() {
  const data = await chrome.storage.local.get([
    CAPTURE_API_BASE_KEY,
    CAPTURE_SEARCH_Q_KEY,
    AUTO_CAPTURE_ENABLED_KEY,
    "spreadsheet_url",
    "sheets_web_app_url",
    "sheets_sheet_name"
  ]);
  return {
    apiBase: String(data[CAPTURE_API_BASE_KEY] || CAPTURE_API_DEFAULT).trim(),
    searchQ: String(data[CAPTURE_SEARCH_Q_KEY] || "Salesforce").trim() || "Salesforce",
    autoEnabled: data[AUTO_CAPTURE_ENABLED_KEY] !== false,
    spreadsheetUrl: String(data.spreadsheet_url || "").trim(),
    webAppUrl: String(data.sheets_web_app_url || "").trim(),
    sheetName: String(data.sheets_sheet_name || "").trim()
  };
}

async function loadExistingSheetLinks(config) {
  const { spreadsheetUrl, webAppUrl, sheetName } = config;
  if (!spreadsheetUrl || !webAppUrl) return [];
  try {
    return await getExistingJobLinks({
      spreadsheetUrl,
      webAppUrl,
      sheetName
    });
  } catch (err) {
    console.warn("[capture] sheet link fetch failed:", err);
    return [];
  }
}

async function mergeIncomingJobs(incoming, sheetLinks) {
  const data = await chrome.storage.local.get([
    IMPORTED_JOBS_BY_ID_KEY,
    IMPORTED_JOBS_ORDER_KEY
  ]);
  const statusMemory = await readJobStatusMemory();
  const merged = mergeJobsIntoQueue({
    existingById: data[IMPORTED_JOBS_BY_ID_KEY] || {},
    existingOrder: data[IMPORTED_JOBS_ORDER_KEY] || [],
    incoming,
    sheetLinks,
    restoreStatus: (job) => applyRememberedStatus(job, statusMemory)
  });
  if (merged.added > 0) {
    const checkedData = await chrome.storage.local.get("imported_jobs_checked_ids");
    const checked = Array.isArray(checkedData.imported_jobs_checked_ids)
      ? checkedData.imported_jobs_checked_ids.map(String)
      : [];
    const checkedSet = new Set(checked);
    for (const id of merged.addedIds || []) checkedSet.add(String(id));
    await chrome.storage.local.set({
      [IMPORTED_JOBS_BY_ID_KEY]: merged.byId,
      [IMPORTED_JOBS_ORDER_KEY]: merged.order,
      [IMPORTED_JOBS_VERSION_KEY]: merged.version,
      imported_jobs_checked_ids: [...checkedSet]
    });
  }
  return merged;
}

async function scrapeJobrightInChrome(query) {
  const url = buildJobrightSearchUrl(query);
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;

  try {
    await awaitTabComplete(tabId, 45000, "JobRight tab load timeout");
    await sleep(4000);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/jobright-capture.js"]
      });
    } catch {
      /* may already be injected */
    }
    await sleep(1500);

    const result = await chrome.tabs.sendMessage(tabId, {
      type: "SCRAPE_JOBRIGHT_BATCH",
      query
    });

    if (!result?.ok) {
      throw new Error(result?.error || "JobRight scrape failed");
    }
    return { jobs: result.jobs || [], stats: result.stats || {} };
  } finally {
    try {
      if (tabId != null) await chrome.tabs.remove(tabId);
    } catch {
      /* ignore */
    }
  }
}

async function runDiceCapture(apiBase) {
  try {
    await captureApiFetch(apiBase, "/api/health");
  } catch {
    return {
      ok: false,
      error: `Capture server not reachable at ${apiBase}. Start dice-jobright-sf-job-capture (npm start).`,
      jobs: [],
      stats: {}
    };
  }

  try {
    await captureApiFetch(apiBase, "/api/run", { method: "POST" });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/already in progress|409/i.test(msg)) {
      return { ok: false, error: msg, jobs: [], stats: {} };
    }
  }

  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    let apiStatus;
    try {
      apiStatus = await captureApiFetch(apiBase, "/api/status");
    } catch {
      continue;
    }
    if (!apiStatus.capturing) break;
  }

  const data = await captureApiFetch(apiBase, "/api/jobs?status=new&limit=200");
  const jobs = (data.jobs || []).filter(
    (j) => String(j.source || "").toLowerCase() === "dice"
  );
  return {
    ok: true,
    jobs,
    stats: { kept: jobs.length, fetchedFromApi: jobs.length }
  };
}

async function showCaptureNotification(status) {
  const message = buildCaptureSummary(status);
  try {
    await chrome.notifications.create(`capture-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/ocean-icon.svg"),
      title: "Job capture complete",
      message,
      priority: 1,
      requireInteraction: false
    });
  } catch {
    /* notifications may be blocked */
  }
}

export async function runUnifiedJobCapture({ trigger = "manual", notify = null } = {}) {
  if (captureRunning) {
    return { ok: false, error: "Capture already in progress." };
  }
  captureRunning = true;
  const startedAt = new Date().toISOString();
  const config = await getCaptureConfig();
  const shouldNotify = notify ?? trigger === "alarm";

  const status = {
    at: startedAt,
    trigger,
    ok: false,
    found: { total: 0, jobright: 0, dice: 0 },
    added: { total: 0, jobright: 0, dice: 0 },
    skipped: {
      alreadyOnSheet: 0,
      alreadyOnSheetJobright: 0,
      alreadyOnSheetDice: 0,
      alreadyInList: 0,
      appliedOnSite: { jobright: 0, dice: 0 },
      invalid: 0
    },
    dice: { ok: false, fetched: 0, added: 0, error: "", stats: {} },
    jobright: { ok: false, fetched: 0, added: 0, error: "", stats: {} },
    skippedSheet: 0,
    skippedQueued: 0,
    skippedInvalid: 0,
    sheetDedupEnabled: Boolean(config.spreadsheetUrl && config.webAppUrl),
    summary: "",
    error: ""
  };

  try {
    const sheetLinks = await loadExistingSheetLinks(config);
    const incoming = [];

    try {
      const jr = await scrapeJobrightInChrome(config.searchQ);
      status.jobright.ok = true;
      status.jobright.fetched = jr.jobs.length;
      status.jobright.stats = jr.stats;
      status.skipped.appliedOnSite.jobright = Number(jr.stats?.skippedApplied || 0);
      incoming.push(...jr.jobs);
    } catch (err) {
      status.jobright.error = String(err?.message || err);
    }

    try {
      const dice = await runDiceCapture(config.apiBase);
      if (dice.ok) {
        status.dice.ok = true;
        status.dice.fetched = dice.jobs.length;
        status.dice.stats = dice.stats;
        incoming.push(...dice.jobs);
      } else {
        status.dice.error = dice.error || "Dice capture failed";
      }
    } catch (err) {
      status.dice.error = String(err?.message || err);
    }

    const found = countCaptureJobsBySource(incoming);
    status.found = { total: found.total, jobright: found.jobright, dice: found.dice };
    status.skipped.invalid = found.invalid;

    const merged = await mergeIncomingJobs(incoming, sheetLinks);

    let diceAdded = 0;
    let jobrightAdded = 0;
    for (const id of merged.addedIds) {
      const src = String(merged.byId[id]?.source || "").toLowerCase();
      if (src === "dice") diceAdded += 1;
      else if (src === "jobright") jobrightAdded += 1;
    }

    status.dice.added = diceAdded;
    status.jobright.added = jobrightAdded;
    status.added = {
      total: merged.added,
      jobright: jobrightAdded,
      dice: diceAdded
    };
    status.skipped.alreadyOnSheet = merged.skippedSheet;
    status.skipped.alreadyOnSheetJobright = merged.skippedSheetJobright;
    status.skipped.alreadyOnSheetDice = merged.skippedSheetDice;
    status.skipped.alreadyInList = merged.skippedQueued;
    status.skipped.invalid = merged.skippedInvalid;
    status.skippedSheet = merged.skippedSheet;
    status.skippedQueued = merged.skippedQueued;
    status.skippedInvalid = status.skipped.invalid;

    status.ok = status.jobright.ok || status.dice.ok;
    status.error =
      !status.ok && !status.jobright.error && !status.dice.error
        ? "Both capture sources failed."
        : [status.jobright.error, status.dice.error].filter(Boolean).join(" | ");

    status.summary = buildCaptureSummary(status);
    await chrome.storage.local.set({ [LAST_CAPTURE_STATUS_KEY]: status });

    if (shouldNotify) {
      await showCaptureNotification(status);
    }

    return status;
  } catch (err) {
    status.error = String(err?.message || err);
    status.summary = buildCaptureSummary(status);
    await chrome.storage.local.set({ [LAST_CAPTURE_STATUS_KEY]: status });
    return status;
  } finally {
    captureRunning = false;
  }
}

export async function ensureCaptureAlarm() {
  const config = await getCaptureConfig();
  const existing = await chrome.alarms.get(CAPTURE_ALARM_NAME);

  if (!config.autoEnabled) {
    if (existing) await chrome.alarms.clear(CAPTURE_ALARM_NAME);
    return;
  }

  if (!existing || existing.periodInMinutes !== CAPTURE_PERIOD_MINUTES) {
    await chrome.alarms.clear(CAPTURE_ALARM_NAME);
    chrome.alarms.create(CAPTURE_ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: CAPTURE_PERIOD_MINUTES
    });
  }
}

export function registerCaptureAlarmListener() {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CAPTURE_ALARM_NAME) return;
    runUnifiedJobCapture({ trigger: "alarm", notify: true }).catch((err) => {
      console.error("[capture alarm]", err);
    });
  });
}

export function isCaptureRunning() {
  return captureRunning;
}
