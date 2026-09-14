import {
  appendJobToSpreadsheet,
  updateJobStatusInSpreadsheet,
  getExistingJobLinks,
  isJobLinkOnSheet,
  JobAlreadyOnSheetError
} from "./sheets.js";
import {
  ensureCaptureAlarm,
  registerCaptureAlarmListener,
  runUnifiedJobCapture,
  isCaptureRunning as isJobCaptureRunning
} from "./capture-runner.js";
import { buildPrompt, buildCoverLetterPrompt, getCandidateInfoText } from "./profiles.js";
import { resumeJsonToHtml, extractResumeJson, hasRenderableSkills, normalizeResumePayload, normalizeSkills, markHtmlForPdf } from "./resume-json.js";
import { scoreResumeAgainstJd } from "./ats-score.js";
import { ensureAtsReadyResume } from "./ats-rewrite.js";
import { DEFAULT_TEMPLATE_ID, templateRequiresTechnicalSummary } from "./templates/index.js";
import { TECHNICAL_SUMMARY_PROMPT } from "./prompts/technical-summary.js";
import { buildCoverLetterHtml } from "./cover-letter-html.js";
import {
  chatCompletion,
  setChatAbortSignal,
  DEFAULT_OPENAI_MODEL,
  RESUME_JSON_SYSTEM_PROMPT
} from "./openai.js";
import { getEnv } from "./env.js";
import { getApplicantInfo, saveApplicantInfo, APPLICANT_INFO_KEY } from "./applicant-info.js";
import { getProfileProjectContext } from "./project-manifest.js";
import {
  buildWorkHistory,
  buildEducationHistory,
  hasFormHistory,
  getStoredResumeJson,
  persistRoleSummaries
} from "./history.js";
import { awaitTabComplete } from "./tab-utils.js";
import {
  getOutputDirectoryHandle,
  getOutputDirectoryName,
  setPendingOutputFiles,
  clearPendingOutputFiles,
  setLastSaveMeta,
  getLastSaveMeta,
  readJobUploadDocsFromDirectory,
  sanitizeJobFolderName
} from "./fs-output.js";
import {
  setLastGeneratedDocs,
  pickUploadDocsFromBundle,
  getLastGeneratedDocs,
  setGeneratedDocsForJob,
  getGeneratedDocsForJob,
  activateGeneratedDocsForJob,
  clearGeneratedDocsForJob
} from "./upload-assets.js";
import { generateHumanizedApplicationAnswers, generateConstrainedChoiceAnswers, classifyApplicationQuestions, isComplexQuestion, shouldBankAnswer, generateRoleSummaries, DEFAULT_OPENAI_FORM_MODEL } from "./ai-answers.js";
import { findQaMatch, findQaMatchesBatch, saveQa, recordQaUsage } from "./qa-store.js";
import { upsertPendingQa, dismissPendingMatchingQuestion } from "./pending-qa.js";
import { getKbStatus, getStoredKb, rebuildProfileKb, buildFallbackKb } from "./profile-kb.js";
import { planFormAnswers, pickApplicationButton, isChoiceKind } from "./form-planner.js";
import {
  generateApplicationBrief,
  getApplicationBrief,
  storeApplicationBrief
} from "./application-brief.js";
import { appendApplicationEvent } from "./application-log.js";
import {
  applySiteFromUrl,
  applySiteLabel,
  isUrlOnApplySite,
  stepBudgetForSite,
  isAutoSubmitAllowedSite,
  isAiFormAssistAllowed,
  isGatewaySite
} from "./ats/adapters.js";
import {
  ensureCostSession,
  logLlmCall,
  logFillHits,
  getCostSummaryText
} from "./cost-tracker.js";
import { rememberJobStatus, rememberJobStatuses } from "./job-status-memory.js";

// Service worker entry (v1.3.5)
let isRunning = false;
let generationCancelRequested = false;
let generationAbortController = null;
let keepAliveTimer = null;

// Generation lock bookkeeping. `isRunning` alone used to wedge the extension:
// after Stop (or a run that died inside a non-abortable await) it stayed true
// until the service worker recycled, and every later Batch/Apply click was
// rejected with "Generation already in progress."
let generationProgressAt = 0;
let generationCancelRequestedAt = 0;
let generationRunToken = 0;
/** After Stop, give the running loop this long to unwind before force-releasing. */
const CANCEL_GRACE_MS = 20000;
/** A run that has not touched the status line in this long is dead, not busy. */
const GENERATION_STALL_MS = 15 * 60 * 1000;
let panelWindowId = null;

// The last real browser window the user looked at, so "scrape/autofill the
// current page" targets the tab they were viewing — not this extension panel
// (a popup-type window) that steals focus when they click a button in it.
let lastFocusedNormalWindowId = null;

const PANEL_WIDTH = 1280;
const PANEL_HEIGHT = 900;
const PANEL_WINDOW_ID_KEY = "panel_window_id";
const PANEL_URL = (mode = "window") =>
  `${chrome.runtime.getURL("popup.html")}?mode=${mode === "sidebar" ? "sidebar" : "window"}`;
const PANEL_MODE_KEY = "ui_panel_mode";

// Imported CSV job queue (UI sidebar)
const IMPORTED_JOBS_BY_ID_KEY = "imported_jobs_by_id";
const IMPORTED_JOBS_ORDER_KEY = "imported_jobs_order";
const IMPORTED_JOBS_SELECTED_ID_KEY = "imported_jobs_selected_id";
const IMPORTED_JOBS_VERSION_KEY = "imported_jobs_version";

async function rememberPanelWindowId(id) {
  panelWindowId = id ?? null;
  if (panelWindowId == null) {
    await chrome.storage.local.remove(PANEL_WINDOW_ID_KEY);
  } else {
    await chrome.storage.local.set({ [PANEL_WINDOW_ID_KEY]: panelWindowId });
  }
}

async function loadRememberedPanelWindowId() {
  if (panelWindowId != null) return panelWindowId;
  const data = await chrome.storage.local.get(PANEL_WINDOW_ID_KEY);
  const id = data[PANEL_WINDOW_ID_KEY];
  panelWindowId = typeof id === "number" ? id : null;
  return panelWindowId;
}

/** Find an already-open extension panel window (single instance). */
async function findExistingPanelWindow() {
  const rememberedId = await loadRememberedPanelWindowId();
  if (rememberedId != null) {
    try {
      const win = await chrome.windows.get(rememberedId, { populate: true });
      if (win?.id != null) {
        return win;
      }
    } catch {
      await rememberPanelWindowId(null);
    }
  }

  const panelUrl = chrome.runtime.getURL("popup.html");
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  for (const win of windows) {
    const match = win.tabs?.some((t) => typeof t.url === "string" && t.url.startsWith(panelUrl));
    if (match) {
      await rememberPanelWindowId(win.id);
      return win;
    }
  }
  return null;
}

/**
 * Panel mode kept in memory as well as storage.
 *
 * chrome.sidePanel.open() only works while the user gesture that triggered it is
 * still live, and a gesture does not survive an `await`. Reading the mode from
 * storage before opening spent the gesture and Chrome rejected the call with
 * "may only be called in response to a user gesture", so click paths read this
 * cache instead and never await before open().
 */
let preferredPanelMode = "window";
/** True once Chrome owns the icon-click behaviour, so open() is never needed. */
let panelBehaviorApplied = false;

async function getPreferredPanelMode() {
  const data = await chrome.storage.local.get(PANEL_MODE_KEY);
  preferredPanelMode = data[PANEL_MODE_KEY] === "sidebar" ? "sidebar" : "window";
  return preferredPanelMode;
}

/**
 * In sidebar mode, let Chrome open the panel itself on toolbar-icon / Alt+J.
 * That path has no gesture problem at all because the extension never calls
 * open() — Chrome does. action.onClicked then only fires in window mode.
 */
async function applyPanelBehavior(mode) {
  const sidebar = mode === "sidebar";
  try {
    await chrome.sidePanel.setOptions({ path: "popup.html?mode=sidebar", enabled: true });
  } catch (err) {
    console.warn("[panel] sidePanel.setOptions unavailable:", err);
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebar });
    panelBehaviorApplied = true;
  } catch (err) {
    // Without this, sidebar mode falls back to the manual open() path, which
    // Chrome blocks unless the gesture is still live.
    console.warn("[panel] sidePanel.setPanelBehavior unavailable:", err);
  }
}

async function syncPanelModeCache() {
  const mode = await getPreferredPanelMode().catch(() => "window");
  await applyPanelBehavior(mode);
  return mode;
}

// Keep the cache and Chrome's own behaviour in step when the panel mode changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[PANEL_MODE_KEY]) return;
  const next = changes[PANEL_MODE_KEY].newValue === "sidebar" ? "sidebar" : "window";
  preferredPanelMode = next;
  applyPanelBehavior(next).catch(() => {});
});

syncPanelModeCache().catch(() => {});

async function closePanelWindow() {
  const existing = await findExistingPanelWindow();
  if (existing?.id != null) {
    await chrome.windows.remove(existing.id).catch(() => {});
  }
}

async function resolveSidebarHostWindowId() {
  if (lastFocusedNormalWindowId != null) {
    const remembered = await chrome.windows.get(lastFocusedNormalWindowId).catch(() => null);
    if (remembered?.type === "normal") return remembered.id;
  }
  const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (last?.id != null) return last.id;
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return all[0]?.id ?? null;
}

async function openSidePanelForBrowser(knownWindowId = null) {
  const windowId = knownWindowId ?? (await resolveSidebarHostWindowId());
  if (windowId == null) {
    throw new Error("No browser window available for the sidebar.");
  }
  await chrome.sidePanel.setOptions({
    path: "popup.html?mode=sidebar",
    enabled: true
  });
  await chrome.sidePanel.open({ windowId });
  return windowId;
}

async function openPanelWindow() {
  const existing = await findExistingPanelWindow();
  if (existing?.id != null) {
    await chrome.windows.update(existing.id, { focused: true });
    const activeTab = existing.tabs?.find((t) => t.active) || existing.tabs?.[0];
    if (activeTab?.id != null) {
      try {
        await chrome.tabs.update(activeTab.id, { active: true });
      } catch {
        /* ignore */
      }
    }
    return;
  }

  const win = await chrome.windows.create({
    url: PANEL_URL("window"),
    type: "popup",
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    focused: true
  });
  await rememberPanelWindowId(win?.id ?? null);
}

/**
 * Make sure the Ocean UI is available (for File System Access writes, preview,
 * folder unlock) without switching modes. Sidebar stays sidebar — never pop a
 * window just because generation finished.
 */
async function ensurePanelVisible() {
  const mode = await getPreferredPanelMode();
  if (mode === "sidebar") {
    try {
      await openSidePanelForBrowser();
    } catch {
      // Side panel may already be open, or Chrome blocked open() without a
      // user gesture. Do not fall back to a popup window.
    }
    return;
  }
  await openPanelWindow();
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) {
    rememberPanelWindowId(null).catch(() => {});
  }
  if (windowId === lastFocusedNormalWindowId) {
    lastFocusedNormalWindowId = null;
  }
});

/** Remember the most recent normal (browser) window the user focused. */
function rememberFocusedNormalWindow(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.windows
    .get(windowId)
    .then((win) => {
      if (win && win.type === "normal") {
        lastFocusedNormalWindowId = windowId;
      }
    })
    .catch(() => {});
}

chrome.windows.onFocusChanged.addListener(rememberFocusedNormalWindow);

// A tab becoming active in a normal window also marks it as the current one.
chrome.tabs.onActivated.addListener(({ windowId }) => {
  rememberFocusedNormalWindow(windowId);
});

// Seed the value at startup so the first scrape works before any focus change.
(async () => {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (win?.type === "normal") lastFocusedNormalWindowId = win.id;
  } catch {
    /* no normal window yet */
  }
})();

/**
 * Open the panel from a user gesture.
 *
 * MUST stay synchronous up to chrome.sidePanel.open(): any await before it
 * consumes the gesture and Chrome rejects the call. `tab` comes straight from
 * the listener, so its windowId needs no lookup.
 */
function handleOpenPanel(tab = null) {
  const windowId = tab?.windowId;

  // Once Chrome owns the icon click, this listener only fires in window mode —
  // so there is nothing to decide and no sidebar attempt to make.
  if (panelBehaviorApplied && preferredPanelMode !== "sidebar") {
    return openPanelWindow().catch((err) => console.error("Failed to open panel:", err));
  }

  if (preferredPanelMode === "sidebar" && windowId != null) {
    // No await before this line, or the gesture is gone.
    let opening = null;
    try {
      opening = chrome.sidePanel.open({ windowId });
    } catch (sideErr) {
      console.warn("[panel] sidebar open threw, using a window instead:", sideErr);
    }
    if (opening) {
      opening.catch((sideErr) => {
        console.warn("[panel] sidebar open rejected, using a window instead:", sideErr);
        openPanelWindow().catch((err) => console.error("Failed to open panel:", err));
      });
      return Promise.resolve();
    }
  }

  return openPanelWindowForMode(windowId);
}

/**
 * Slow path, used when the mode was not yet known at click time (service worker
 * cold start). The gesture is already spent by the storage read, so a sidebar
 * open here is expected to fail — fall back to a window rather than nothing.
 */
async function openPanelWindowForMode(windowId = null) {
  try {
    const mode = await getPreferredPanelMode();
    if (mode === "sidebar") {
      // Re-assert so Chrome handles the next icon click natively.
      applyPanelBehavior(mode).catch(() => {});
      try {
        await openSidePanelForBrowser(windowId);
        return;
      } catch {
        console.warn(
          "[panel] sidebar needs a fresh click (service worker had just woken). " +
            "Opening a window this time; the next icon click will open the sidebar."
        );
      }
    }
    await openPanelWindow();
  } catch (err) {
    console.error("Failed to open panel:", err);
  }
}

// Icon click / Alt+J opens the single panel. In sidebar mode Chrome opens the
// side panel itself (openPanelOnActionClick) and this listener never fires.
chrome.action.onClicked.addListener((tab) => {
  handleOpenPanel(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "scrape_and_apply" || command === "generate_docs" || command === "easy_apply") {
    // Fire this first, synchronously, while the shortcut's gesture is still live.
    handleOpenPanel(tab);
  }
  (async () => {
    if (command === "scrape_and_apply" || command === "generate_docs" || command === "easy_apply") {
      // Give the panel a moment to load listeners, then relay the command.
      await new Promise((r) => setTimeout(r, 350));
      try {
        await chrome.runtime.sendMessage({ type: "panel_command", command });
      } catch {
        await setStatus(
          `Shortcut ${command} — open the panel once, then try again (panel was still loading).`
        );
      }
    }
  })().catch((err) => console.error("[commands]", err));
});

function startKeepAlive() {
  stopKeepAlive();
  // MV3 service workers can sleep during long OpenAI waits; ping storage periodically.
  keepAliveTimer = setInterval(() => {
    chrome.storage.local.set({ generation_heartbeat: Date.now() }).catch(() => {});
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    // Popup may have closed; status is already in storage.
  }
}

async function sendMessageToTab(tabId, message, { attempts = 3, retryDelayMs = 200, frameId } = {}) {
  let lastErr = null;
  const opts = frameId != null ? { frameId } : {};
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message, opts);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, retryDelayMs * (i + 1)));
    }
  }
  throw lastErr || new Error("Failed to send message to tab.");
}

/** List frame ids in a tab (iCIMS / Workday often put the form in an iframe). */
async function listTabFrameIds(tabId) {
  try {
    const infos = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => true
    });
    const ids = (infos || [])
      .map((row) => row.frameId)
      .filter((id) => typeof id === "number");
    if (ids.length) return ids;
  } catch {
    /* fall through */
  }
  return [0];
}

/**
 * Broadcast a content-script message to every frame and return per-frame replies.
 * Needed because chrome.tabs.sendMessage without frameId only hits the top frame,
 * while ATS forms (especially iCIMS) live inside iframes.
 */
async function sendMessageToAllFrames(tabId, message, { attempts = 2 } = {}) {
  await ensureAutofillScript(tabId);
  const frameIds = await listTabFrameIds(tabId);
  const results = [];
  for (const frameId of frameIds) {
    try {
      const res = await sendMessageToTab(tabId, message, { attempts, frameId });
      if (res != null) results.push({ frameId, ...(typeof res === "object" ? res : { ok: true }) });
    } catch {
      /* frame may be cross-origin chrome:// or missing the script */
    }
  }
  return results;
}

chrome.runtime.onInstalled.addListener(async () => {
  releaseGenerationLock();
  await chrome.storage.local.set({
    generation_running: false,
    generation_cancel_requested: false,
    generation_status: "Ready."
  });
  // Re-assert on every reload/update: this is what lets Chrome open the side
  // panel on an icon click, so the extension never calls the gesture-gated
  // sidePanel.open() itself.
  syncPanelModeCache().catch(() => {});
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  releaseGenerationLock();
  await chrome.storage.local.set({
    generation_running: false,
    generation_cancel_requested: false,
    generation_status: "Ready."
  });
  // Re-assert on every reload/update: this is what lets Chrome open the side
  // panel on an icon click, so the extension never calls the gesture-gated
  // sidePanel.open() itself.
  syncPanelModeCache().catch(() => {});
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

registerCaptureAlarmListener();

async function setStatus(status) {
  generationProgressAt = Date.now();
  await chrome.storage.local.set({ generation_status: status });
}

function clearGenerationCancel() {
  generationCancelRequested = false;
  generationCancelRequestedAt = 0;
  generationAbortController = new AbortController();
  setChatAbortSignal(generationAbortController.signal);
  chrome.storage.local.set({ generation_cancel_requested: false }).catch(() => {});
}

function requestGenerationCancel() {
  generationCancelRequested = true;
  generationCancelRequestedAt = Date.now();
  try {
    generationAbortController?.abort();
  } catch {
    /* ignore */
  }
  chrome.storage.local.set({ generation_cancel_requested: true }).catch(() => {});
}

function finishGenerationCancelState() {
  setChatAbortSignal(null);
  generationAbortController = null;
  generationCancelRequested = false;
  generationCancelRequestedAt = 0;
  chrome.storage.local.set({ generation_cancel_requested: false }).catch(() => {});
}

/**
 * Take the generation lock and return this run's token.
 *
 * The token is what makes a broken lock safe: if the lock is force-released and a
 * new run starts, the orphaned loop's token no longer matches, so it bails out at
 * its next checkpoint instead of interleaving with the new run.
 */
function acquireGenerationLock() {
  generationRunToken += 1;
  isRunning = true;
  generationProgressAt = Date.now();
  clearGenerationCancel();
  startKeepAlive();
  chrome.storage.local.set({ generation_running: true }).catch(() => {});
  return generationRunToken;
}

/** Throw if this run has been stopped or superseded by a newer one. */
function assertRunActive(token) {
  assertNotCancelled();
  if (token != null && token !== generationRunToken) {
    throw new Error("Cancelled by user.");
  }
}

/**
 * Drop the lock. Pass the run's token so a run that was already superseded does
 * not clear the lock out from under the run that replaced it.
 * Returns true when this call actually released the lock.
 */
function releaseGenerationLock(token = null) {
  if (token != null && token !== generationRunToken) return false;
  isRunning = false;
  generationProgressAt = 0;
  finishGenerationCancelState();
  stopKeepAlive();
  return true;
}

/**
 * Release the lock at the end of a run.
 * No-ops when the run never took the lock (`token == null`) or when a newer run
 * already owns it, so a late-finishing orphan cannot stop the run that replaced it.
 */
async function finishGenerationRun(token) {
  if (token == null) return;
  if (!releaseGenerationLock(token)) return;
  await chrome.storage.local.set({ generation_running: false });
}

function forceReleaseGenerationLock(reason) {
  console.warn(`[generation-lock] force released: ${reason}`);
  // Bump the token first so the orphaned run is superseded and cannot re-enter.
  generationRunToken += 1;
  releaseGenerationLock();
  chrome.storage.local.set({ generation_running: false }).catch(() => {});
}

/**
 * Reason a new run cannot start, or "" when the lock is free.
 *
 * A lock is only honoured while the run is demonstrably alive. If the user hit
 * Stop and the old loop never released it, or the run has gone silent for
 * `GENERATION_STALL_MS`, the lock is broken here so the next click works.
 */
function generationLockError(label = "Generation") {
  if (!isRunning) return "";
  const now = Date.now();

  if (generationCancelRequestedAt && now - generationCancelRequestedAt > CANCEL_GRACE_MS) {
    forceReleaseGenerationLock("stop requested but the previous run never finished unwinding");
    return "";
  }
  if (generationProgressAt && now - generationProgressAt > GENERATION_STALL_MS) {
    forceReleaseGenerationLock("previous run made no progress for 15 minutes");
    return "";
  }
  if (generationCancelRequestedAt) {
    const waitSec = Math.max(
      1,
      Math.ceil((CANCEL_GRACE_MS - (now - generationCancelRequestedAt)) / 1000)
    );
    return `Still stopping the previous run — try again in ${waitSec}s.`;
  }
  return `${label} already in progress.`;
}

function assertNotCancelled() {
  if (generationCancelRequested || generationAbortController?.signal?.aborted) {
    throw new Error("Cancelled by user.");
  }
}

function isCancelError(err) {
  const msg = String(err?.message || err || "");
  const name = String(err?.name || "");
  return (
    /cancell?ed by user/i.test(msg) ||
    name === "AbortError" ||
    /the user aborted a request/i.test(msg)
  );
}

/** Mark jobs left in opening/generating/filling so the list is not stuck after Stop or a SW restart. */
async function markInProgressJobsStopped(detail = "Cancelled by user.") {
  const byId = await getImportedJobsById();
  const now = Date.now();
  const stopped = [];
  for (const [jobId, job] of Object.entries(byId)) {
    const s = String(job?.status || "");
    if (!["opening", "generating", "opening_form", "filling"].includes(s)) continue;
    byId[jobId] = {
      ...job,
      status: "failed",
      statusDetail: detail,
      updatedAt: now
    };
    stopped.push(byId[jobId]);
  }
  if (stopped.length) {
    await setImportedJobsById(byId, { bumpVersion: true });
    await rememberJobStatuses(stopped).catch(() => {});
  }
}

function isJobAlreadyOnSheetError(err) {
  return err instanceof JobAlreadyOnSheetError || err?.code === "ALREADY_ON_SHEET";
}

async function resolveSheetSettings(jobMeta = {}) {
  const stored = await chrome.storage.local.get([
    "spreadsheet_url",
    "sheets_web_app_url",
    "sheets_sheet_name"
  ]);
  return {
    spreadsheetUrl: String(jobMeta.spreadsheetUrl || stored.spreadsheet_url || "").trim(),
    webAppUrl: String(jobMeta.sheetsWebAppUrl || stored.sheets_web_app_url || "").trim(),
    sheetName: String(jobMeta.sheetName || stored.sheets_sheet_name || "").trim()
  };
}

async function assertJobNotAlreadyOnSheet(jobMeta = {}, sheetLinksCache = null) {
  const jdLink = String(jobMeta.jdLink || "").trim();
  if (!jdLink) return;

  const { spreadsheetUrl, webAppUrl, sheetName } = await resolveSheetSettings(jobMeta);
  if (!spreadsheetUrl || !webAppUrl) return;

  const links =
    sheetLinksCache ??
    (await getExistingJobLinks({
      spreadsheetUrl,
      webAppUrl,
      sheetName
    }));

  if (isJobLinkOnSheet(links, jdLink)) {
    throw new JobAlreadyOnSheetError(jdLink);
  }
}

function isRetryableGenerationError(err) {
  if (isCancelError(err) || isJobAlreadyOnSheetError(err)) return false;
  if (isJobUnavailableError(err)) return false;
  const msg = String(err?.message || err || "");
  if (/api key is (missing|invalid)|401\b/i.test(msg)) return false;
  if (/missing job description/i.test(msg)) return false;
  return /openai request failed|failed to fetch|networkerror|network|timeout|timed out|429|rate limit|HTTP 5\d\d|502|503|504|empty response|not valid resume json|econnreset|err_network|err_internet|err_connection|temporarily unavailable|overloaded/i.test(
    msg
  );
}

/**
 * Retry a job step up to 3 times, then throw so the batch can skip to the next job.
 * Waits 3s, then 6s between attempts.
 */
async function runWithRetries(task, { attempts = 3, delaysMs = [3000, 6000], onRetry } = {}) {
  const max = Math.max(1, Number(attempts) || 3);
  let lastErr;
  for (let n = 1; n <= max; n += 1) {
    try {
      assertNotCancelled();
      return await task(n, max);
    } catch (err) {
      lastErr = err;
      if (isCancelError(err) || n >= max || !isRetryableGenerationError(err)) throw err;
      const wait = Number(delaysMs[Math.min(n - 1, delaysMs.length - 1)] || 3000);
      if (typeof onRetry === "function") {
        await onRetry({ attempt: n, nextAttempt: n + 1, max, waitMs: wait, err });
      }
      await sleepMs(wait);
    }
  }
  throw lastErr;
}

async function getImportedJobsById() {
  const data = await chrome.storage.local.get(IMPORTED_JOBS_BY_ID_KEY);
  return data[IMPORTED_JOBS_BY_ID_KEY] || {};
}

async function setImportedJobsById(byId, { bumpVersion = true } = {}) {
  const now = Date.now();
  if (bumpVersion) {
    await chrome.storage.local.set({
      [IMPORTED_JOBS_BY_ID_KEY]: byId,
      [IMPORTED_JOBS_VERSION_KEY]: now
    });
  } else {
    await chrome.storage.local.set({ [IMPORTED_JOBS_BY_ID_KEY]: byId });
  }
}

async function setImportedJobStatus(jobId, { status, statusDetail = "", markAttempt = false, profileId, completedAt, patch = null } = {}) {
  if (!jobId) return;
  const byId = await getImportedJobsById();
  const job = byId[jobId];
  if (!job) return;
  const now = Date.now();
  const nextStatus = status || job.status || "imported";
  const doneAt =
    completedAt ||
    (nextStatus === "completed" && !job.completedAt ? now : job.completedAt) ||
    undefined;

  byId[jobId] = {
    ...job,
    ...(patch && typeof patch === "object" ? patch : null),
    status: nextStatus,
    statusDetail: statusDetail || job.statusDetail || "",
    updatedAt: now,
    ...(profileId ? { profileId } : null),
    ...(doneAt ? { completedAt: doneAt } : null),
    ...(markAttempt ? { attempts: Number(job.attempts || 0) + 1, lastAttemptAt: now } : null)
  };

  await setImportedJobsById(byId, { bumpVersion: true });
  // Archive the outcome so it survives this job being removed from the queue.
  await rememberJobStatus(byId[jobId]).catch(() => {});
}

/** Remove a job from the imported queue (used when the posting is closed). */
async function removeImportedJobFromStorage(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return false;
  const byId = await getImportedJobsById();
  if (!byId[id]) return false;
  delete byId[id];

  const data = await chrome.storage.local.get([
    IMPORTED_JOBS_ORDER_KEY,
    IMPORTED_JOBS_SELECTED_ID_KEY,
    "imported_jobs_checked_ids"
  ]);
  const order = (Array.isArray(data[IMPORTED_JOBS_ORDER_KEY]) ? data[IMPORTED_JOBS_ORDER_KEY] : []).filter(
    (x) => String(x) !== id
  );
  const selected =
    String(data[IMPORTED_JOBS_SELECTED_ID_KEY] || "") === id
      ? null
      : data[IMPORTED_JOBS_SELECTED_ID_KEY] || null;
  const checked = (
    Array.isArray(data.imported_jobs_checked_ids) ? data.imported_jobs_checked_ids : []
  ).filter((x) => String(x) !== id);
  const now = Date.now();

  await chrome.storage.local.set({
    [IMPORTED_JOBS_BY_ID_KEY]: byId,
    [IMPORTED_JOBS_ORDER_KEY]: order,
    [IMPORTED_JOBS_SELECTED_ID_KEY]: selected,
    imported_jobs_checked_ids: checked,
    [IMPORTED_JOBS_VERSION_KEY]: now
  });
  await clearGeneratedDocsForJob(id).catch(() => {});
  return true;
}

/**
 * A closed posting is not a failure — it is a skip. Callers tag the error so the
 * job card reads "No longer available" instead of a red "Failed".
 */
function jobUnavailableError(detail) {
  const text = String(detail || "This job is no longer available.").trim();
  const err = new Error(`Job no longer available — skipped.\n${text}`);
  err.jobUnavailable = text;
  return err;
}

function isJobUnavailableError(err) {
  return Boolean(err?.jobUnavailable);
}

/**
 * Mark a closed posting on its job card and leave it in the list.
 * The card is kept (red "No longer available" badge carrying the reason) instead
 * of being deleted, so a skipped job stays visible and the user decides when to
 * remove it.
 */
async function markImportedJobUnavailable(importedJobId, detail, { profileId, notify = true } = {}) {
  const text = String(detail || "This job is no longer available.").trim();
  const id = String(importedJobId || "").trim();
  if (id) {
    await setImportedJobStatus(id, {
      status: "unavailable",
      statusDetail: `No longer available — ${text}`,
      profileId
    }).catch(() => {});
  }
  if (notify) {
    try {
      await chrome.notifications.create(`job-unavailable-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/ocean-icon.svg"),
        title: "Job no longer available",
        message: text.slice(0, 240),
        priority: 1
      });
    } catch {
      /* notifications may be blocked */
    }
  }
  return text;
}

function isUnusableJobTabUrl(url) {
  const raw = String(url || "");
  if (!raw || raw === "about:blank") return true;
  if (/^(chrome|edge|about|chrome-error|chrome-extension):/i.test(raw)) return true;
  if (/chrome-error|chromewebdata/i.test(raw)) return true;
  return !isHttpUrl(raw);
}

/**
 * Boards that render the job page client-side, so a "closed"/"expired" banner
 * can appear a beat after the first paint. Probing these only once lets an
 * expired posting read as open and a resume gets generated for a dead job.
 */
function isLateBannerJobUrl(url) {
  const raw = String(url || "");
  try {
    const host = new URL(raw).hostname;
    return /(^|\.)dice\.com$/i.test(host) || /(^|\.)jobright\.ai$/i.test(host);
  } catch {
    return /dice\.com|jobright\.ai/i.test(raw);
  }
}

/**
 * Probe a loaded tab for closed-job banners. Client-rendered boards (Dice,
 * Jobright) may paint the alert after the first body paint, so poll briefly on
 * those job-detail URLs. The poll exits as soon as a banner is found.
 */
async function probeJobUnavailableOnTab(tabId, { url = "", pollMs = 0 } = {}) {
  await ensureAutofillScript(tabId);
  const lateBanner = isLateBannerJobUrl(url);
  const totalMs = lateBanner ? Math.max(Number(pollMs) || 0, 4500) : 0;
  const attempts = lateBanner ? Math.max(4, Math.ceil(totalMs / 500)) : 1;

  let lastProbe = null;
  for (let i = 0; i < attempts; i += 1) {
    const probe = await sendMessageToTab(
      tabId,
      { type: "probe_application_form" },
      { attempts: 2 }
    );
    lastProbe = probe;
    if (probe?.ok === false && probe?.error) {
      return { closed: "", error: String(probe.error), probe };
    }
    const closed = String(probe?.jobUnavailable || "").trim();
    if (closed) return { closed, error: "", probe };
    if (i + 1 < attempts) await sleepMs(500);
  }

  return { closed: "", error: "", probe: lastProbe };
}

/**
 * Open (or reuse) a job URL and probe whether the posting is closed.
 * Never throws — unknown load/script errors are returned on `error`.
 * @returns {Promise<{ tabId: number|null, closed: string, error: string, url: string }>}
 */
async function openAndProbeJobAvailability(url, { active = false, reuseTabId = null } = {}) {
  const target = String(url || "").trim();
  if (!isHttpUrl(target)) {
    return { tabId: null, closed: "", error: "Invalid job URL.", url: target, createdTab: false };
  }

  let tabId = reuseTabId;
  // Only tabs this probe *creates* may be closed later. A tab the user already
  // had open (found via findTabByUrl) or a caller-supplied reuse tab must never
  // be closed here — doing so was closing the user's current job tab.
  let createdTab = false;
  try {
    if (tabId) {
      const live = await chrome.tabs.get(tabId).catch(() => null);
      if (!live?.id) tabId = null;
    }
    if (!tabId) {
      const existing = await findTabByUrl(target);
      if (existing?.id != null) {
        tabId = existing.id;
        if (active) {
          await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        }
        await waitForPageReady(tabId);
      } else {
        const tab = await chrome.tabs.create({ url: target, active: Boolean(active) });
        tabId = tab?.id || null;
        if (!tabId) {
          return { tabId: null, closed: "", error: "Failed to open a tab.", url: target, createdTab: false };
        }
        createdTab = true;
        await waitForPageReady(tabId);
      }
    } else {
      await navigateTabToUrl(tabId, target);
    }

    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (!live?.id) {
      return { tabId: null, closed: "", error: "Tab closed while loading.", url: target, createdTab };
    }
    if (isUnusableJobTabUrl(live.url)) {
      return { tabId, closed: "", error: "Job page failed to load.", url: target, createdTab };
    }

    const { closed, error } = await probeJobUnavailableOnTab(tabId, {
      url: target,
      pollMs: isLateBannerJobUrl(target) ? 4500 : 0
    });
    if (error) {
      return { tabId, closed: "", error, url: target, createdTab };
    }
    return { tabId, closed, error: "", url: target, createdTab };
  } catch (err) {
    return {
      tabId,
      closed: "",
      error: String(err?.message || err || "Availability probe failed."),
      url: target,
      createdTab
    };
  }
}

/**
 * Retry an availability probe a few times. A poisoned tab is discarded between attempts
 * so one bad page cannot stall the rest of the batch.
 */
async function probeJobAvailabilityWithRetries(
  url,
  { attempts = 3, reuseTabId = null, reuseTabCreated = false, onAttempt } = {}
) {
  let tabId = reuseTabId;
  // Carry provenance across retries/navigations: only close tabs we opened.
  let createdByUs = Boolean(reuseTabCreated);
  let last = { tabId, closed: "", error: "", url, attempts: 0, createdTab: createdByUs };
  const max = Math.max(1, Number(attempts) || 3);

  for (let i = 1; i <= max; i += 1) {
    if (typeof onAttempt === "function") {
      await onAttempt(i, max);
    }
    last = await openAndProbeJobAvailability(url, { active: false, reuseTabId: tabId });
    last.attempts = i;
    createdByUs = createdByUs || Boolean(last.createdTab);
    if (last.closed || !last.error) return { ...last, createdTab: createdByUs };

    if (last.tabId && createdByUs) {
      await chrome.tabs.remove(last.tabId).catch(() => {});
    }
    tabId = null;
    createdByUs = false;
    if (i < max) await sleepMs(700 * i);
  }

  return { ...last, tabId: null, createdTab: false };
}

async function assertJobUrlStillAvailable(jobMeta = {}) {
  const jobUrl = String(jobMeta.jdLink || "").trim();
  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return;

  await setStatus("Checking if job posting is still open...");
  const probe = await probeJobAvailabilityWithRetries(jobUrl, { attempts: 3 });
  // Never close a tab the user already had open — only one this probe created.
  if (probe.tabId && probe.createdTab) {
    await chrome.tabs.remove(probe.tabId).catch(() => {});
  }

  if (probe.closed) {
    const detail = await markImportedJobUnavailable(jobMeta.importedJobId, probe.closed, {
      profileId: jobMeta.profileId
    });
    throw jobUnavailableError(detail);
  }
  if (probe.error) {
    throw new Error(`Could not verify job is still open: ${probe.error}`);
  }
}

async function recoverInterruptedImportedJobs({ immediate = false } = {}) {
  const INTERUPTED_AFTER_MS = 10 * 60 * 1000; // 10 minutes

  const data = await chrome.storage.local.get([IMPORTED_JOBS_BY_ID_KEY, IMPORTED_JOBS_VERSION_KEY]);
  const byId = data[IMPORTED_JOBS_BY_ID_KEY] || {};
  const now = Date.now();

  const interrupted = [];

  for (const [jobId, job] of Object.entries(byId)) {
    const s = String(job?.status || "");
    if (!["opening", "generating", "opening_form", "filling"].includes(s)) continue;

    const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
    if (!immediate) {
      if (!updatedAt) continue;
      if (now - updatedAt < INTERUPTED_AFTER_MS) continue;
    }

    byId[jobId] = {
      ...job,
      status: "failed",
      statusDetail: immediate
        ? "Stopped (Ocean restarted). Retry Apply."
        : "Interrupted (service worker restarted). Retry.",
      updatedAt: now
    };
    interrupted.push(byId[jobId]);
  }

  if (interrupted.length) {
    await setImportedJobsById(byId, { bumpVersion: true });
    await rememberJobStatuses(interrupted).catch(() => {});
  }
}

// Fresh service-worker start means any previous Apply/Generate is dead.
// Skip if a new run already started on this wake (avoid racing the first message).
(async () => {
  try {
    const data = await chrome.storage.local.get(["generation_running"]);
    if (isRunning) return;
    if (data.generation_running) {
      await chrome.storage.local.set({
        generation_running: false,
        generation_status: "Ready."
      });
    }
    if (isRunning) return;
    await recoverInterruptedImportedJobs({ immediate: true });
  } catch {
    /* ignore */
  }
})();

async function getOpenAiSettings() {
  const apiKey = await getEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is missing. Add OPENAI_API_KEY to the extension .env file (see .env.example), then reload the extension."
    );
  }
  const model = (await getEnv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)) || DEFAULT_OPENAI_MODEL;
  return { apiKey, model };
}

/** Form classify + autofill answers — always prefer cheap mini, not the resume model. */
async function getOpenAiFormSettings() {
  const apiKey = await getEnv("OPENAI_API_KEY");
  if (!apiKey) {
    throw new Error(
      "OpenAI API key is missing. Add OPENAI_API_KEY to the extension .env file (see .env.example), then reload the extension."
    );
  }
  const model =
    (await getEnv("OPENAI_FORM_MODEL", DEFAULT_OPENAI_FORM_MODEL)) || DEFAULT_OPENAI_FORM_MODEL;
  return { apiKey, model };
}

async function tryQaBankMatch(profileId, question, { threshold = 0.82 } = {}) {
  if (!question) return null;
  let match = null;
  try {
    match = await findQaMatch(profileId, question, { threshold });
  } catch {
    match = null;
  }
  return match;
}

// Must match SCRIPT_BUILD in content/autofill.js.
const AUTOFILL_SCRIPT_BUILD = "2026-09-14.builtin-apply.1";
const AUTOFILL_CONTENT_FILES = [
  "content/scrapers/shared.js",
  "content/scrapers/schema.js",
  "content/scrapers/jobright.js",
  "content/scrapers/dice.js",
  "content/scrapers/greenhouse.js",
  "content/scrapers/hiringcafe.js",
  "content/scrapers/runner.js",
  "content/autofill.js"
];
const AUTOFILL_READY_SUBMIT_URL_KEY = "autofill_ready_submit_url";

/** Signal open panels that the Q&A bank changed so they can re-render. */
function bumpQaVersion() {
  chrome.storage.local.set({ qa_bank_version: Date.now() }).catch(() => {});
}

function hostnameFromUrl(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Job ids for HiringCafe live in the page's own network log
 * (`/api/job-description?id=`), which content scripts cannot see.
 * Read them from the MAIN world, then pass the id into the scraper.
 */
async function collectMainWorldScrapeHints(tabId, tabUrl = "") {
  const host = hostnameFromUrl(tabUrl);
  const isHiringCafe = /(^|\.)hiringcafe\.com$|(^|\.)hiring\.cafe$/i.test(host);
  const isDice = /(^|\.)dice\.com$/i.test(host);
  if (!isHiringCafe && !isDice) return {};
  try {
    const [row] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: () => {
        const ID_RE = /[a-z0-9-]+___[a-z0-9._-]+___[A-Za-z0-9._-]+/i;
        const firstId = (...cands) => {
          for (const c of cands) {
            const m = String(c || "").match(ID_RE);
            if (m) return m[0];
          }
          return "";
        };
        let jobId = "";
        try {
          const href = String(location.href || "");
          const u = new URL(href);
          jobId =
            firstId(
              u.searchParams.get("id"),
              u.searchParams.get("jobId"),
              u.searchParams.get("objectID"),
              u.searchParams.get("selectedJobId"),
              u.searchParams.get("searchState")
            ) || firstId(href);
        } catch {
          /* ignore */
        }
        try {
          const entries = performance.getEntriesByType("resource") || [];
          for (let i = entries.length - 1; i >= 0; i -= 1) {
            const name = String(entries[i].name || "");
            const m = name.match(/\/api\/job-description\?[^#]*\bid=([^&]+)/i);
            if (m) {
              jobId = firstId(decodeURIComponent(m[1])) || jobId;
              if (jobId) break;
            }
          }
        } catch {
          /* ignore */
        }
        if (!jobId) {
          try {
            jobId = firstId(document.getElementById("__NEXT_DATA__")?.textContent || "");
          } catch {
            /* ignore */
          }
        }
        let diceJobId = "";
        try {
          const u = new URL(location.href);
          diceJobId =
            u.searchParams.get("selectedJobId") ||
            u.searchParams.get("jobId") ||
            (location.pathname.match(/\/job-detail\/([^/?#]+)/) || [])[1] ||
            "";
        } catch {
          /* ignore */
        }
        return { jobId, diceJobId };
      }
    });
    const result = row?.result || {};
    const jobId = String(result.jobId || (isDice ? result.diceJobId : "") || "").trim();
    return jobId ? { jobId } : {};
  } catch {
    return {};
  }
}

/** Saved login / sign-up credentials used to autofill auth pages. */
async function getAccountCredentials() {
  const data = await chrome.storage.local.get("account_credentials");
  const c = data.account_credentials || {};
  return {
    email: String(c.email || "").trim(),
    username: String(c.username || "").trim(),
    password: String(c.password || "")
  };
}

/** Normalize a URL for loose tab matching (drop hash + trailing slash). */
function normalizeUrlForMatch(url) {
  try {
    const u = new URL(String(url || ""));
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
    return (u.origin + u.pathname + u.search).toLowerCase();
  } catch {
    return String(url || "").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

/** Find an open tab already showing this job URL, so we don't reopen it. */
async function findTabByUrl(url) {
  const target = normalizeUrlForMatch(url);
  if (!target) return null;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return null;
  }
  const exact = tabs.find((t) => t.url && normalizeUrlForMatch(t.url) === target);
  if (exact) return exact;
  const targetNoQuery = target.split("?")[0];
  return (
    tabs.find(
      (t) => t.url && normalizeUrlForMatch(t.url).split("?")[0] === targetNoQuery
    ) || null
  );
}

/** Identify an easy-apply-capable site from a URL. */
function detectSiteFromUrl(url) {
  return applySiteFromUrl(url);
}

async function ensureAutofillScript(tabId) {
  // Skip re-inject when the tab already runs the current build — re-injecting
  // every apply step was freezing heavy ATS pages.
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "autofill_ping" });
    if (pong?.build === AUTOFILL_SCRIPT_BUILD) return;
  } catch {
    /* not injected yet */
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: AUTOFILL_CONTENT_FILES
    });
    return;
  } catch {
    /* some frames may be restricted; fall back to the top frame */
  }
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "autofill_ping" });
    if (pong?.build === AUTOFILL_SCRIPT_BUILD) return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: AUTOFILL_CONTENT_FILES
  });
}

function mergeAutofillFrameResults(frameResults = []) {
  const merged = {
    ok: false,
    filledCount: 0,
    filled: [],
    credentialFilledCount: 0,
    credentialFilled: [],
    uploadedCount: 0,
    uploaded: [],
    uploadSkipped: [],
    unmatchedQuestions: [],
    unmatchedChoiceQuestions: [],
    frameResults
  };

  for (const r of frameResults) {
    if (!r || r.ok === false) continue;
    merged.ok = true;
    merged.filledCount += Number(r.filledCount || 0);
    if (Array.isArray(r.filled)) merged.filled.push(...r.filled);
    merged.credentialFilledCount += Number(r.credentialFilledCount || 0);
    if (Array.isArray(r.credentialFilled)) {
      for (const c of r.credentialFilled) {
        if (!merged.credentialFilled.includes(c)) merged.credentialFilled.push(c);
      }
    }
    merged.uploadedCount += Number(r.uploadedCount || 0);
    if (Array.isArray(r.uploaded)) merged.uploaded.push(...r.uploaded);
    if (Array.isArray(r.uploadSkipped)) merged.uploadSkipped.push(...r.uploadSkipped);
    if (Array.isArray(r.unmatchedQuestions)) {
      for (const q of r.unmatchedQuestions) {
        merged.unmatchedQuestions.push({ ...q, frameId: r.frameId });
      }
    }
    if (Array.isArray(r.unmatchedChoiceQuestions)) {
      for (const q of r.unmatchedChoiceQuestions) {
        merged.unmatchedChoiceQuestions.push({ ...q, frameId: r.frameId });
      }
    }
  }

  return merged;
}

/**
 * Prefer the active tab in a normal browser window (not this extension panel).
 */
async function getCurrentApplicationTab() {
  const normalWindows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });

  // Prefer the active tab of the window the user last looked at. This is the
  // "current page" even when the extension panel (a popup window) is focused.
  const trackedWindow =
    (lastFocusedNormalWindowId != null &&
      normalWindows.find((w) => w.id === lastFocusedNormalWindowId)) ||
    null;
  const activeInTracked = trackedWindow?.tabs?.find((t) => t.active) || null;
  if (activeInTracked?.id != null && /^https?:\/\//i.test(activeInTracked.url || "")) {
    return activeInTracked;
  }

  const focusedNormal =
    normalWindows.find((w) => w.focused) ||
    normalWindows.find((w) => w.tabs?.some((t) => t.active)) ||
    null;

  const activeInFocused = focusedNormal?.tabs?.find((t) => t.active) || null;
  if (activeInFocused?.id != null && /^https?:\/\//i.test(activeInFocused.url || "")) {
    return activeInFocused;
  }

  for (const win of normalWindows) {
    const active = win.tabs?.find((t) => t.active);
    if (active?.id != null && /^https?:\/\//i.test(active.url || "")) {
      return active;
    }
  }

  const httpTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  return httpTabs.find((t) => t.active) || httpTabs[0] || null;
}

async function getAutofillAiContext() {
  const stored = await chrome.storage.local.get([
    "last_job_title",
    "last_company_name",
    "last_jd_text",
    "last_jd_link",
    "last_response",
    "last_application_brief",
    "last_resume_json"
  ]);
  return {
    jobMeta: {
      jobTitle: stored.last_job_title || "",
      companyName: stored.last_company_name || "",
      jdText: stored.last_jd_text || "",
      jdLink: stored.last_jd_link || ""
    },
    resumeText: stored.last_response || "",
    applicationBrief: stored.last_application_brief || null,
    resumeData: stored.last_resume_json && typeof stored.last_resume_json === "object"
      ? stored.last_resume_json
      : null
  };
}

async function loadFormHistory(applicantInfo = {}, jobMeta = {}) {
  const resume = (await getStoredResumeJson()) || {};
  const workHistory = buildWorkHistory(resume);
  const educationHistory = buildEducationHistory(resume, applicantInfo);

  const needsSummary = workHistory.filter((job) => String(job.summary || "").trim().length < 80);
  if (needsSummary.length) {
    try {
      const { apiKey, model } = await getOpenAiSettings();
      if (apiKey) {
        const result = await generateRoleSummaries({
          apiKey,
          model,
          jobs: workHistory,
          jobMeta
        });
        if (result.usage) {
          await logLlmCall({
            purpose: "role-summaries",
            model,
            inputTokens: result.usage.prompt_tokens,
            outputTokens: result.usage.completion_tokens
          });
        }
        const byIndex = new Map((result.summaries || []).map((row) => [row.index, row.summary]));
        for (const job of workHistory) {
          const next = String(byIndex.get(job.index) || "").trim();
          if (next) job.summary = next;
        }
        await persistRoleSummaries(workHistory);
      }
    } catch {
      /* summaries are best-effort; bullets fallback remains */
    }
  }

  return { workHistory, educationHistory };
}

async function saveReusableQa({ profileId, question, answer, fieldType, site = "" }) {
  try {
    await saveQa({
      profileId: profileId || "",
      question,
      answer,
      fieldType,
      source: "ai",
      site
    });
    bumpQaVersion();
    await dismissPendingMatchingQuestion(question, profileId || "").catch(() => {});
  } catch {
    /* bank write is best-effort */
  }
}

function queueUnbankedQuestions(profileId, questions, site = "") {
  const list = (questions || []).filter((q) => q?.label && !isComplexQuestion(q));
  if (!list.length) return;
  upsertPendingQa(list, { profileId: profileId || "", site: site || "" }).catch(() => {});
}

/**
 * Answer application questions:
 * 1) Q&A bank first (learned answers)
 * 2) gpt-4o-mini classifies field type (identity/factual/choice/thinking/skip)
 * 3) Remaining: gpt-4o-mini answers — thinking uses JD + resume; factual stays short
 * Complex JD essays are never stored in the bank.
 * @returns {Promise<Array<{ id: string, answer: string, source?: string }>>}
 */
async function resolveTextAnswers({
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = "",
  profileId = "",
  applicationBrief = null,
  site = "",
  allowAi = true
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return [];

  const resolved = [];
  const stillNeed = [];
  let bankHits = 0;

  // Pass 1 — Q&A bank before any LLM (skip long thinking essays).
  for (const q of list) {
    if (isComplexQuestion(q)) {
      stillNeed.push(q);
      continue;
    }
    const match = await tryQaBankMatch(profileId, q.label, { threshold: 0.82 });
    if (match?.record?.answer) {
      resolved.push({ id: q.id, answer: match.record.answer, source: "bank" });
      recordQaUsage(match.record.id).catch(() => {});
      bankHits += 1;
      continue;
    }
    stillNeed.push(q);
  }

  if (!stillNeed.length || !allowAi) {
    resolved.bankHits = bankHits;
    resolved.aiAnswers = 0;
    return resolved;
  }

  // Pass 2 — understand each remaining field with the form model (mini).
  const { apiKey, model: formModel } = await getOpenAiFormSettings();
  let classified = new Map();
  try {
    await setStatus(`Understanding ${stillNeed.length} form field(s) with ${formModel}...`);
    classified = await classifyApplicationQuestions({
      apiKey,
      model: formModel,
      questions: stillNeed
    });
    if (classified._usage) {
      await logLlmCall({
        purpose: "autofill_classify",
        model: formModel,
        inputTokens: classified._usage.prompt_tokens,
        outputTokens: classified._usage.completion_tokens
      });
    }
  } catch {
    classified = new Map();
  }

  const forAi = [];
  for (const q of stillNeed) {
    const meta = classified.get(q.id) || {};
    const kind = meta.kind || (isComplexQuestion(q) ? "thinking" : "factual");
    const bankQuery = meta.bankQuery || q.label;

    if (kind === "skip" || kind === "identity") {
      // Identity is owned by profile autofill; skip avoids wrong fills.
      continue;
    }

    // Second bank try with cleaned classifier query (looser threshold).
    if (kind !== "thinking") {
      const rematch =
        (await tryQaBankMatch(profileId, bankQuery, { threshold: 0.75 })) ||
        (bankQuery !== q.label
          ? await tryQaBankMatch(profileId, q.label, { threshold: 0.75 })
          : null);
      if (rematch?.record?.answer) {
        resolved.push({ id: q.id, answer: rematch.record.answer, source: "bank" });
        recordQaUsage(rematch.record.id).catch(() => {});
        bankHits += 1;
        continue;
      }
    }

    forAi.push({ ...q, kind, label: q.label, bankQuery });
  }

  queueUnbankedQuestions(
    profileId,
    forAi.filter((q) => q.kind !== "thinking"),
    site
  );

  if (forAi.length) {
    const thinkingCount = forAi.filter((q) => q.kind === "thinking").length;
    await setStatus(
      thinkingCount
        ? `Answering ${forAi.length} question(s) from Q&A gaps — ${thinkingCount} need JD/resume...`
        : `Answering ${forAi.length} question(s) with ${formModel}...`
    );
    const brief = applicationBrief || (await getApplicationBrief());
    const aiResult = await generateHumanizedApplicationAnswers({
      apiKey,
      model: formModel,
      questions: forAi,
      applicantInfo,
      jobMeta,
      resumeText,
      applicationBrief: brief,
      knowledgeBase: await getStoredKb(profileId).catch(() => null)
    });
    if (aiResult.usage) {
      await logLlmCall({
        purpose: "autofill_text",
        model: formModel,
        inputTokens: aiResult.usage.prompt_tokens,
        outputTokens: aiResult.usage.completion_tokens
      });
    }
    const byId = new Map(
      (aiResult.answers || []).map((a) => [a.id, String(a?.answer || "").trim()])
    );
    for (const q of forAi) {
      const answer = byId.get(q.id) || "";
      if (!answer) continue;
      resolved.push({ id: q.id, answer, source: "ai" });
      if (shouldBankAnswer(q, answer, q.fieldType || "text")) {
        await saveReusableQa({
          profileId,
          question: q.bankQuery || q.label,
          answer,
          fieldType: q.fieldType || "text",
          site
        });
      }
    }
  }

  resolved.bankHits = bankHits;
  resolved.aiAnswers = resolved.filter((r) => r.source === "ai").length;
  return resolved;
}

/**
 * The option that carries the same meaning as a Q&A bank answer, or "".
 *
 * Plain substring matching flips answers: a bank answer of "No" happily matches
 * a "None of the above" option, and long disability/veteran phrasings differ
 * only by their leading Yes/No. So the lead word must agree before any looser
 * comparison is allowed.
 */
function matchAnswerToOption(answer, options = []) {
  const want = String(answer || "").trim().toLowerCase();
  if (!want || !options.length) return "";

  const exact = options.find((o) => String(o).trim().toLowerCase() === want);
  if (exact) return exact;

  const lead = (text) => {
    const t = String(text).trim().toLowerCase();
    if (/^y(es)?\b/.test(t)) return "yes";
    if (/^n(o)?\b/.test(t)) return "no";
    return "";
  };
  const wantLead = lead(want);

  return (
    options.find((o) => {
      const opt = String(o).trim().toLowerCase();
      const optLead = lead(opt);
      if (wantLead && optLead) return wantLead === optLead;
      if (wantLead || optLead) return false;
      return opt.includes(want) || want.includes(opt);
    }) || ""
  );
}

/**
 * Resolve CHOICE questions: Q&A bank first, classify with mini, then AI
 * constrained to options using profile + resume (+ JD when relevant).
 */
async function resolveChoiceAnswers(
  profileId,
  questions,
  applicantInfo = {},
  jobMeta = {},
  resumeText = "",
  { applicationBrief = null, site = "", allowAi = true } = {}
) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  const resolved = [];
  const stillNeed = [];
  let bankHits = 0;

  for (const q of list) {
    const match = await tryQaBankMatch(profileId, q.label, { threshold: 0.82 });
    if (match?.record?.answer) {
      // Prefer bank answer that exists in the option list when options are known.
      let answer = match.record.answer;
      if (Array.isArray(q.options) && q.options.length) {
        const onList = matchAnswerToOption(answer, q.options);
        if (!onList) {
          // The bank knows this candidate's position but this form words its
          // options differently. Hand the bank answer to the AI pass so it maps
          // the meaning onto a real option instead of inventing text.
          if (allowAi) stillNeed.push({ ...q, bankAnswer: answer });
          continue;
        }
        answer = onList;
      }
      resolved.push({ id: q.id, answer, source: "bank" });
      recordQaUsage(match.record.id).catch(() => {});
      bankHits += 1;
    } else {
      stillNeed.push(q);
    }
  }

  if (!stillNeed.length || !allowAi) {
    resolved.bankHits = bankHits;
    resolved.aiAnswers = 0;
    return resolved;
  }

  const { apiKey, model: formModel } = await getOpenAiFormSettings();
  let classified = new Map();
  try {
    classified = await classifyApplicationQuestions({
      apiKey,
      model: formModel,
      questions: stillNeed
    });
    if (classified._usage) {
      await logLlmCall({
        purpose: "autofill_classify",
        model: formModel,
        inputTokens: classified._usage.prompt_tokens,
        outputTokens: classified._usage.completion_tokens
      });
    }
  } catch {
    classified = new Map();
  }

  const forAi = [];
  for (const q of stillNeed) {
    const meta = classified.get(q.id) || {};
    const kind = meta.kind || "choice";
    const bankQuery = meta.bankQuery || q.label;
    if (kind === "skip" || kind === "identity") continue;

    const rematch = await tryQaBankMatch(profileId, bankQuery, { threshold: 0.75 });
    if (rematch?.record?.answer) {
      let answer = rematch.record.answer;
      if (Array.isArray(q.options) && q.options.length) {
        const onList = matchAnswerToOption(answer, q.options);
        if (!onList) {
          forAi.push({ ...q, kind: "choice", bankQuery, bankAnswer: answer });
          continue;
        }
        answer = onList;
      }
      resolved.push({ id: q.id, answer, source: "bank" });
      recordQaUsage(rematch.record.id).catch(() => {});
      bankHits += 1;
      continue;
    }
    forAi.push({ ...q, kind: "choice", bankQuery });
  }

  queueUnbankedQuestions(profileId, forAi, site);

  if (forAi.length) {
    try {
      const withOptions = forAi.filter((q) => Array.isArray(q.options) && q.options.length);
      if (withOptions.length) {
        await setStatus(`Choosing answers for ${withOptions.length} dropdown/radio question(s)...`);
        const brief = applicationBrief || (await getApplicationBrief());
        const aiResult = await generateConstrainedChoiceAnswers({
          apiKey,
          model: formModel,
          questions: withOptions,
          applicantInfo,
          jobMeta,
          resumeText,
          applicationBrief: brief,
          knowledgeBase: await getStoredKb(profileId).catch(() => null)
        });
        if (aiResult.usage) {
          await logLlmCall({
            purpose: "autofill_choice",
            model: formModel,
            inputTokens: aiResult.usage.prompt_tokens,
            outputTokens: aiResult.usage.completion_tokens
          });
        }
        const qById = new Map(withOptions.map((q) => [q.id, q]));
        for (const row of aiResult.answers || []) {
          if (!row?.id || !row?.answer) continue;
          resolved.push({ id: row.id, answer: row.answer, source: "ai" });
          const q = qById.get(row.id);
          if (q?.label) {
            await saveReusableQa({
              profileId,
              question: q.bankQuery || q.label,
              answer: row.answer,
              fieldType: q.fieldType || "select",
              site
            });
          }
        }
      }
    } catch {
      /* choice AI is best-effort */
    }
  }

  resolved.bankHits = bankHits;
  resolved.aiAnswers = resolved.filter((r) => r.source === "ai").length;
  return resolved;
}

async function formatUploadDocsLocation(docs) {
  // The docs' OWN labels always win. getLastSaveMeta() is global — it points at
  // whichever job was saved most recently — so consulting it before the docs'
  // own folderName used to label this job's PDFs with another job's folder.
  const ownFolder = String(docs?.pathLabel || docs?.folderName || "").trim();
  let folder = ownFolder;
  if (!folder) {
    const save = (await getLastSaveMeta().catch(() => null)) || {};
    folder = String(save.pathLabel || save.folderName || "").trim();
  }
  const resumeName = String(docs?.resume?.fileName || "").trim();
  const coverName = String(docs?.coverLetter?.fileName || "").trim();
  const joinPath = (name) => {
    if (!name) return "";
    if (!folder) return name;
    const base = folder.replace(/[\\/]+$/, "");
    if (base.endsWith(name)) return base;
    return `${base} / ${name}`;
  };
  const resumePath = joinPath(resumeName);
  const coverPath = joinPath(coverName);
  return {
    folder,
    resumePath,
    coverPath,
    summary: [resumePath, coverPath].filter(Boolean).join("  +  ") || folder
  };
}

function uploadDocsMismatchError(resolved) {
  const mismatch = resolved?.mismatch || resolved || {};
  if (resolved?.error) return resolved.error;
  return (
    `The only resume PDFs on hand were built for a different job (${mismatch.got}), ` +
    `not "${mismatch.expected}". Generate a resume for this job first, then Apply — ` +
    "uploading the other job's resume was stopped."
  );
}

/** The queued job whose posting URL matches this page, if any. */
async function findImportedJobByUrl(url) {
  const target = normalizeUrlForMatch(url);
  if (!target) return null;
  const byId = await getImportedJobsById();
  for (const [jobId, job] of Object.entries(byId)) {
    const link = job?.jdLink || job?.url || "";
    if (!link) continue;
    if (normalizeUrlForMatch(link) === target) return { jobId, job };
  }
  return null;
}

/**
 * Resume/cover letter PDFs to upload on THIS page.
 *
 * `getLastGeneratedDocs()` is a single global slot holding whatever was generated
 * or activated most recently, so after a batch build it points at the last job in
 * the batch. Applying to any other job from the panel would then upload that
 * job's PDFs. Match the tab to its queued job first and load that job's files;
 * only fall back to the global slot when the page is not a job we have queued,
 * and never hand over files that are known to belong to a different job.
 */
async function resolveUploadDocsForTab(tabId, { explicitDocs = null } = {}) {
  if (explicitDocs?.resume?.base64 || explicitDocs?.coverLetter?.base64) {
    return { docs: explicitDocs, mismatch: null };
  }

  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const url = tab?.url || "";
  const match = url ? await findImportedJobByUrl(url) : null;

  let jobLoadError = "";
  if (match) {
    let forJob = null;
    try {
      forJob = await ensureUploadDocsForImportedJob(match.jobId, match.job);
    } catch (err) {
      // e.g. "unlock the output folder" — more actionable than a generic message.
      jobLoadError = String(err?.message || err);
    }
    if (forJob?.resume?.base64 || forJob?.coverLetter?.base64) {
      return { docs: forJob, mismatch: null };
    }
  }

  const last = await getLastGeneratedDocs();
  if (!last?.resume?.base64 && !last?.coverLetter?.base64) {
    return { docs: last, mismatch: null, error: jobLoadError };
  }

  // The global slot has files. Refuse them when they demonstrably belong to a
  // different queued job than the one this page is showing.
  const lastJobId = String(last.importedJobId || "").trim();
  if (match && lastJobId && lastJobId !== match.jobId) {
    const byId = await getImportedJobsById();
    const otherJob = byId[lastJobId];
    return {
      docs: null,
      error: jobLoadError,
      mismatch: {
        expected: match.job?.jobTitle || match.jobId,
        got:
          last.pathLabel ||
          last.folderName ||
          otherJob?.jobTitle ||
          lastJobId
      }
    };
  }

  return { docs: last, mismatch: null };
}

async function stampDocsPath(docs, pathLabel, importedJobId = "") {
  if (!docs) return docs;
  const next = {
    ...docs,
    pathLabel: pathLabel || docs.pathLabel || "",
    folderName: docs.folderName || ""
  };
  try {
    if (importedJobId || next.importedJobId) {
      await setGeneratedDocsForJob(importedJobId || next.importedJobId, next);
    } else {
      await setLastGeneratedDocs(next);
    }
  } catch {
    /* cache stamp is best-effort */
  }
  return next;
}

async function markReadyToSubmit(url) {
  await chrome.storage.local.set({ [AUTOFILL_READY_SUBMIT_URL_KEY]: String(url || "") });
}

async function clearReadyToSubmit() {
  await chrome.storage.local.remove(AUTOFILL_READY_SUBMIT_URL_KEY);
}

async function isReadyToSubmit(url) {
  const data = await chrome.storage.local.get(AUTOFILL_READY_SUBMIT_URL_KEY);
  const saved = String(data[AUTOFILL_READY_SUBMIT_URL_KEY] || "");
  if (!saved || !url) return false;
  return normalizeUrlForMatch(saved) === normalizeUrlForMatch(url);
}

async function pauseAtSubmitForReview(tabId, summary, clickLabel = "Submit") {
  const live = await chrome.tabs.get(tabId).catch(() => null);
  await markReadyToSubmit(live?.url || summary.tabUrl || "");
  let focusedLabel = clickLabel;
  try {
    await ensureAutofillScript(tabId);
    const focused = await sendMessageToTab(
      tabId,
      { type: "focus_submit_button" },
      { attempts: 1 }
    );
    if (focused?.text) focusedLabel = focused.text;
  } catch {
    /* best-effort focus */
  }
  summary.status = "ready_for_review";
  summary.detail =
    `Filled the form and focused "${focusedLabel}". Review the fields, then click Submit in Ocean to send the application. Nothing was submitted yet.`;
  summary.tabId = tabId;
  await setStatus(
    `Ready for your confirmation — review the form, then click Submit in Ocean to press "${focusedLabel}".`
  );
  return summary;
}

/**
 * Autofill the currently open application page using the selected profile's answers.
 * Also injects last generated resume / cover letter PDFs into matching file inputs.
 * Unmatched question fields are answered from the Q&A bank, then OpenAI.
 */
async function startAutofillOnCurrentPage(profileId, tabId = null, { uploadDocs = null } = {}) {
  const applicantInfo = await getApplicantInfo(profileId);
  const hasAnyValue = Object.values(applicantInfo).some((v) => String(v || "").trim());

  // Resolve the tab before the documents: which PDFs to upload depends on which
  // job this page is, not on whichever job was generated most recently.
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : await getCurrentApplicationTab();
  if (!tab?.id) {
    return {
      ok: false,
      error: "No application tab found. Open the job application page in a normal browser window first."
    };
  }

  if (!/^https?:\/\//i.test(tab.url || "")) {
    return {
      ok: false,
      error: "The current tab is not a web page. Open the application form, then click Apply."
    };
  }

  const resolvedDocs = await resolveUploadDocsForTab(tab.id, { explicitDocs: uploadDocs });
  if (resolvedDocs.mismatch) {
    return {
      ok: false,
      error: uploadDocsMismatchError(resolvedDocs)
    };
  }
  const docs = resolvedDocs.docs;
  const hasUploadDocs = Boolean(docs?.resume?.base64 || docs?.coverLetter?.base64);
  const ctx = await getAutofillAiContext();
  let history = { workHistory: [], educationHistory: [] };
  try {
    history = await loadFormHistory(applicantInfo, ctx.jobMeta);
  } catch {
    history = { workHistory: [], educationHistory: [] };
  }
  const hasHistory = hasFormHistory(history.workHistory, history.educationHistory);

  if (!hasAnyValue && !hasUploadDocs && !hasHistory) {
    return {
      ok: false,
      skipped: true,
      error:
        "No applicant info, generated PDFs, or resume history found. Edit profile info and/or generate a resume first."
    };
  }

  const credentials = await getAccountCredentials();
  // Create-login forms often want the Login field to be the email address.
  if (!credentials.email && applicantInfo.email) {
    credentials.email = String(applicantInfo.email || "").trim();
  }

  const loc = await formatUploadDocsLocation(docs);
  if (loc.summary) {
    await setStatus(`Uploading from ${loc.summary}...`);
  }

  const site = detectSiteFromUrl(tab.url || "");
  // Dice (and any adapter with aiFormAssist:false) uses legacy profile/rules fill
  // and auto-advances Next/Submit — no whole-form GPT plan or per-field AI.
  const allowAiFill = isAiFormAssistAllowed(site);
  const planMode = allowAiFill && (await isAiFormPlanEnabled());
  let formModel = DEFAULT_OPENAI_FORM_MODEL;
  if (planMode) {
    try {
      const formSettings = await getOpenAiFormSettings();
      formModel = formSettings.model || DEFAULT_OPENAI_FORM_MODEL;
      // Learn QA bank + profile into the knowledge base before any page scan.
      await setStatus(`${formModel}: preparing QA bank and profile for this apply...`);
      await ensureProfileKbForApply(profileId, {
        apiKey: formSettings.apiKey,
        model: formModel
      });
    } catch (err) {
      if (isCancelError(err)) throw err;
      /* KB failure must not block the fill — plan still runs with fallback facts. */
    }
  } else if (!allowAiFill) {
    await setStatus(`Auto Apply (${applySiteLabel(site)}): rule-based fill (no AI)...`);
  }

  await ensureAutofillScript(tab.id);
  const frameResults = await sendMessageToAllFrames(tab.id, {
    type: "autofill_application",
    mode: planMode ? "plan" : "legacy",
    applicantInfo,
    credentials,
    workHistory: history.workHistory,
    educationHistory: history.educationHistory,
    uploadFiles: {
      resume: docs?.resume || null,
      coverLetter: docs?.coverLetter || null
    }
  });
  const result = mergeAutofillFrameResults(frameResults);

  await ensureCostSession(ctx.jobMeta.jdLink || ctx.jobMeta.jobTitle || tab.url || "");

  // Read the whole step and let gpt-4o-mini answer every field from the knowledge base,
  // Q&A bank, resume and JD. The per-question path below is emergency fallback only.
  if (planMode) {
    try {
      const plan = await runAiFormPlan({ tabId: tab.id, profileId, applicantInfo, ctx, site });
      await logFillHits({
        profileHits: Number(result?.filledCount || 0) + plan.fallbackFilled,
        bankHits: plan.bankHits,
        aiAnswers: plan.aiAnswers
      });
      return {
        ok: Boolean(result?.ok) || plan.filledCount > 0,
        tabId: tab.id,
        tabUrl: tab.url || "",
        ...result,
        filledCount: Number(result?.filledCount || 0) + plan.fallbackFilled,
        aiFilledCount: plan.textFilled,
        choiceFilledCount: plan.choiceFilled,
        bankHits: plan.bankHits,
        planFilledCount: plan.filledCount,
        planSkippedCount: plan.skipped,
        planFailedCount: plan.failed
      };
    } catch (err) {
      if (isCancelError(err)) throw err;
      await setStatus(
        `${formModel} form reader failed (${String(err?.message || err).slice(0, 160)}) — using the Q&A bank, then AI per question...`
      );
      // Plan mode skipped the per-question collection, so gather it now.
      const legacy = mergeAutofillFrameResults(
        await sendMessageToAllFrames(tab.id, { type: "collect_unmatched_questions", applicantInfo })
      );
      result.filledCount = Number(result.filledCount || 0) + legacy.filledCount;
      result.filled.push(...legacy.filled);
      result.unmatchedQuestions = legacy.unmatchedQuestions;
      result.unmatchedChoiceQuestions = legacy.unmatchedChoiceQuestions;
    }
  }

  let aiFilledCount = 0;
  let choiceFilledCount = 0;
  let bankHits = 0;
  let llmAnswerCount = 0;
  const unmatched = Array.isArray(result?.unmatchedQuestions) ? result.unmatchedQuestions : [];
  const unmatchedChoice = Array.isArray(result?.unmatchedChoiceQuestions)
    ? result.unmatchedChoiceQuestions
    : [];

  // Q&A bank first → classify with mini → AI (JD/resume for thinking fields).
  // Sites with aiFormAssist:false (Dice) stay on bank + profile rules only.
  if (unmatchedChoice.length) {
    try {
      const byFrame = new Map();
      for (const q of unmatchedChoice) {
        const fid = q.frameId;
        if (!byFrame.has(fid)) byFrame.set(fid, []);
        byFrame.get(fid).push(q);
      }
      for (const [frameId, questions] of byFrame) {
        const choiceAnswers = await resolveChoiceAnswers(
          profileId,
          questions,
          applicantInfo,
          ctx.jobMeta,
          ctx.resumeText,
          { applicationBrief: ctx.applicationBrief, site, allowAi: allowAiFill }
        );
        bankHits += Number(choiceAnswers.bankHits || 0);
        llmAnswerCount += Number(choiceAnswers.aiAnswers || 0);
        if (!choiceAnswers.length) continue;
        const cRes = await sendMessageToTab(
          tab.id,
          { type: "autofill_choice_answers", answers: choiceAnswers },
          { attempts: 2, frameId }
        );
        choiceFilledCount += Number(cRes?.filledCount || 0);
      }
    } catch {
      /* best-effort: choice reuse should never block the rest of autofill */
    }
  }

  if (unmatched.length) {
    await setStatus(
      allowAiFill
        ? `Form fill: Q&A bank first, then gpt-4o-mini for ${unmatched.length} remaining question(s)...`
        : `Form fill: Q&A bank only for ${unmatched.length} remaining question(s) (no AI on ${applySiteLabel(site)})...`
    );
    try {
      const byFrame = new Map();
      for (const q of unmatched) {
        const fid = q.frameId;
        if (!byFrame.has(fid)) byFrame.set(fid, []);
        byFrame.get(fid).push(q);
      }
      for (const [frameId, questions] of byFrame) {
        const answers = await resolveTextAnswers({
          questions,
          applicantInfo,
          jobMeta: ctx.jobMeta,
          resumeText: ctx.resumeText,
          profileId,
          applicationBrief: ctx.applicationBrief,
          site,
          allowAi: allowAiFill
        });
        bankHits += Number(answers.bankHits || 0);
        llmAnswerCount += Number(answers.aiAnswers || 0);
        if (!answers.length) continue;
        await setStatus(`Filling ${answers.length} answer(s)...`);
        const aiResult = await sendMessageToTab(
          tab.id,
          { type: "autofill_ai_answers", answers },
          { attempts: 2, frameId }
        );
        aiFilledCount += Number(aiResult?.filledCount || 0);
      }
    } catch (aiErr) {
      await logFillHits({
        profileHits: Number(result?.filledCount || 0),
        bankHits,
        aiAnswers: llmAnswerCount
      });
      return {
        ok: Boolean(result?.ok),
        tabId: tab.id,
        tabUrl: tab.url || "",
        ...result,
        aiFilledCount: 0,
        choiceFilledCount,
        bankHits,
        aiError: String(aiErr?.message || aiErr)
      };
    }
  }

  await logFillHits({
    profileHits: Number(result?.filledCount || 0),
    bankHits,
    aiAnswers: llmAnswerCount
  });

  // Dice (and other non-AI sites): re-scan after bank fill so leftover custom
  // questions are accurate — the first list was collected before bank answers.
  if (!allowAiFill) {
    try {
      const leftover = mergeAutofillFrameResults(
        await sendMessageToAllFrames(tab.id, { type: "collect_unmatched_questions", applicantInfo })
      );
      result.unmatchedQuestions = leftover.unmatchedQuestions || [];
      result.unmatchedChoiceQuestions = leftover.unmatchedChoiceQuestions || [];
      result.filledCount = Number(result.filledCount || 0) + Number(leftover.filledCount || 0);
      if (Array.isArray(leftover.filled) && leftover.filled.length) {
        result.filled = [...(result.filled || []), ...leftover.filled];
      }
    } catch {
      /* keep prior unmatched lists */
    }
  }

  return {
    ok: Boolean(result?.ok),
    tabId: tab.id,
    tabUrl: tab.url || "",
    ...result,
    aiFilledCount,
    choiceFilledCount,
    bankHits
  };
}

/**
 * Empty custom questions still on the page after a rule-based Dice fill.
 * Used to pause before Next so the user can answer them manually.
 */
async function collectUnansweredApplicationFields(tabId, profileId) {
  const applicantInfo = await getApplicantInfo(profileId).catch(() => ({}));
  const leftover = mergeAutofillFrameResults(
    await sendMessageToAllFrames(tabId, { type: "collect_unmatched_questions", applicantInfo }).catch(
      () => []
    )
  );
  const texts = Array.isArray(leftover.unmatchedQuestions) ? leftover.unmatchedQuestions : [];
  const choices = Array.isArray(leftover.unmatchedChoiceQuestions)
    ? leftover.unmatchedChoiceQuestions
    : [];
  const labels = [...texts, ...choices]
    .map((q) => String(q?.label || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    count: texts.length + choices.length,
    texts,
    choices,
    labels,
    detail: labels.length
      ? labels.map((l) => (l.length > 80 ? `${l.slice(0, 77)}…` : l)).join("; ")
      : ""
  };
}

function dicePauseForUnansweredFields(openFields, { beforeSubmit = false } = {}) {
  const where = beforeSubmit ? "Submit" : "Next";
  const listed = openFields.detail ? `: ${openFields.detail}` : "";
  return {
    status: "needs_review",
    detail:
      `Stopped before ${where} — ${openFields.count} unanswered field(s) on this Dice step` +
      `${listed}. Fill them on the page, then click Apply again.`
  };
}

// ---- AI form plan -------------------------------------------------------------
//
// Apply reads the whole step (content scan_application_form), answers every
// empty field in one model pass from the profile knowledge base, the Q&A bank,
// the resume and the JD (form-planner.js), then fills the answers
// (apply_form_plan). The knowledge base is re-learned whenever the Q&A bank or
// profile changes (profile-kb.js).

const MAX_PLAN_ROUNDS = 3;
const KB_REFRESH_DEBOUNCE_MS = 8000;
let kbRefreshTimer = null;

/**
 * Whole-form GPT plan when an API key exists (other ATS). Dice forces legacy
 * via isAiFormAssistAllowed — the panel toggle is still ignored for non-Dice.
 */
async function isAiFormPlanEnabled() {
  return Boolean(await getEnv("OPENAI_API_KEY"));
}

/** A scanned field's identity across re-scans — field ids are minted fresh on every scan. */
function planFieldSignature(field) {
  const norm = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${field.frameId}|${field.kind}|${norm(field.section)}|${norm(field.label).slice(0, 200)}`;
}

function bankFieldType(kind) {
  if (kind === "checkbox_group") return "checkbox";
  if (kind === "richtext") return "textarea";
  return ["select", "radio", "checkbox", "combobox", "textarea"].includes(kind) ? kind : "text";
}

function logKbUsage(model, usage) {
  if (!usage) return Promise.resolve();
  return logLlmCall({
    purpose: "profile_kb",
    model,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens
  });
}

/**
 * The profile's knowledge base, re-learned first when the Q&A bank or profile
 * changed since it was built. Called at the start of every Apply so gpt-4o-mini
 * has learned the QA bank and personal profile before it reads the form.
 * A failure never blocks Apply: a stale or raw knowledge base is still better
 * evidence than none.
 */
async function ensureProfileKbForApply(profileId, { apiKey, model }) {
  const modelLabel = model || DEFAULT_OPENAI_FORM_MODEL;
  let status;
  try {
    status = await getKbStatus(profileId);
  } catch {
    return getStoredKb(profileId).catch(() => null);
  }
  if (!status.stale) {
    return status.kb;
  }
  await setStatus(
    status.kb
      ? `${modelLabel}: updating knowledge base from new Q&A answers and profile...`
      : `${modelLabel}: learning QA bank and personal profile...`
  );
  try {
    const { kb, usage } = await rebuildProfileKb({
      profileId,
      apiKey,
      model,
      sources: status.sources
    });
    await logKbUsage(model, usage);
    return kb;
  } catch (err) {
    if (isCancelError(err)) throw err;
    return status.kb || buildFallbackKb(status.sources);
  }
}

/** Background re-learn for the selected profile after the bank or profile changes. */
async function refreshSelectedProfileKb() {
  const { selected_profile_id } = await chrome.storage.local.get("selected_profile_id");
  const profileId = String(selected_profile_id || "").trim();
  if (!profileId || !(await isAiFormPlanEnabled())) return;
  const status = await getKbStatus(profileId);
  if (!status.stale) return;
  const { apiKey, model } = await getOpenAiFormSettings();
  const { usage } = await rebuildProfileKb({ profileId, apiKey, model, sources: status.sources });
  await logKbUsage(model, usage);
}

// AI answers saved into the bank do not change the knowledge base's sources, so
// this only re-learns when the user's own answers or profile actually moved.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.qa_bank_version && !changes[APPLICANT_INFO_KEY]) return;
  clearTimeout(kbRefreshTimer);
  kbRefreshTimer = setTimeout(() => {
    refreshSelectedProfileKb().catch(() => {});
  }, KB_REFRESH_DEBOUNCE_MS);
});

/**
 * Grow the bank from a plan the way a person would. Answers the knowledge base
 * or bank already backed need no new entry; answers drawn from the resume are
 * stored for reuse; guesses go to "Needs answers" for the user to confirm — and
 * a confirmed answer becomes a knowledge-base fact. Essays are never banked.
 */
async function learnFromPlan({ profileId, fieldById, answers = [], bankMatches = new Map(), site = "" }) {
  const toConfirm = [];
  for (const answer of answers) {
    const field = fieldById.get(answer.id);
    if (!field) continue;
    if (answer.source === "qa") {
      const top = bankMatches.get(answer.id)?.[0]?.record;
      if (top?.id) recordQaUsage(top.id).catch(() => {});
      continue;
    }
    if (answer.source === "kb" || answer.source === "profile") continue;
    // Consent boxes are per-site boilerplate, not facts about the candidate.
    if (field.kind === "checkbox") continue;
    const fieldType = bankFieldType(field.kind);
    const q = {
      label: field.label,
      fieldType,
      multiline: fieldType === "textarea",
      richText: field.kind === "richtext"
    };
    if (isComplexQuestion(q)) continue;
    const value = answer.values?.length ? answer.values.join(", ") : answer.value;
    if (answer.source === "resume" && answer.confidence >= 0.7 && shouldBankAnswer(q, value, fieldType)) {
      await saveReusableQa({ profileId, question: field.label, answer: value, fieldType, site });
      continue;
    }
    toConfirm.push({ label: field.label, fieldType, options: field.options || [] });
  }
  if (toConfirm.length) queueUnbankedQuestions(profileId, toConfirm, site);
}

/**
 * Read the whole step, let the form model answer every empty field at once, and
 * fill the answers. Repeats while answering reveals follow-up fields ("If yes,
 * please explain"), up to MAX_PLAN_ROUNDS.
 */
async function runAiFormPlan({ tabId, profileId, applicantInfo, ctx, site }) {
  const { apiKey, model } = await getOpenAiFormSettings();
  const knowledgeBase = await ensureProfileKbForApply(profileId, { apiKey, model });
  const totals = {
    filledCount: 0,
    choiceFilled: 0,
    textFilled: 0,
    bankHits: 0,
    aiAnswers: 0,
    skipped: 0,
    failed: 0,
    fallbackFilled: 0
  };
  const attempted = new Set();

  for (let round = 0; round < MAX_PLAN_ROUNDS; round += 1) {
    assertNotCancelled();
    const frames = await sendMessageToAllFrames(tabId, { type: "scan_application_form", applicantInfo });
    const fields = [];
    const alreadyFilled = [];
    let page = null;
    for (const fr of frames) {
      if (!fr || fr.ok === false) continue;
      if (!page) {
        page = fr.page || null;
      } else if (fr.page?.formText) {
        // Merge visible form text from additional frames (ATS iframes).
        const extra = String(fr.page.formText || "").trim();
        if (extra) {
          const combined = `${page.formText || ""}\n${extra}`.trim().slice(0, 3500);
          page = { ...page, formText: combined };
        }
      }
      alreadyFilled.push(...(fr.filled || []));
      const seen = new Map();
      for (const field of fr.fields || []) {
        const base = planFieldSignature({ ...field, frameId: fr.frameId });
        const ordinal = seen.get(base) || 0;
        seen.set(base, ordinal + 1);
        const sig = `${base}#${ordinal}`;
        if (!attempted.has(sig)) fields.push({ ...field, frameId: fr.frameId, sig });
      }
    }
    if (!fields.length) break;

    await setStatus(
      round === 0
        ? `${model} is reading ${fields.length} field(s) on this page...`
        : `${model} is answering ${fields.length} follow-up field(s)...`
    );
    const bankMatches = await findQaMatchesBatch(
      profileId,
      fields.map((f) => ({ id: f.id, text: f.label })),
      { limit: 3, threshold: 0.5 }
    ).catch(() => new Map());

    const buttons = [];
    for (const fr of frames) {
      if (!fr || fr.ok === false) continue;
      for (const b of fr.buttons || []) {
        buttons.push({
          text: b.text,
          hint: b.hint || "",
          inForm: Boolean(b.inForm)
        });
      }
    }

    const plan = await planFormAnswers({
      apiKey,
      model,
      fields,
      knowledgeBase,
      applicantInfo,
      jobMeta: ctx.jobMeta,
      resumeText: ctx.resumeText,
      applicationBrief: ctx.applicationBrief,
      bankMatches,
      alreadyFilled,
      page,
      buttons
    });
    if (plan.usage) {
      await logLlmCall({
        purpose: "autofill_plan",
        model,
        inputTokens: plan.usage.prompt_tokens,
        outputTokens: plan.usage.completion_tokens
      });
    }

    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const byFrame = new Map();
    for (const answer of plan.answers) {
      const field = fieldById.get(answer.id);
      if (!field) continue;
      if (!byFrame.has(field.frameId)) byFrame.set(field.frameId, []);
      byFrame.get(field.frameId).push(answer);
    }

    let filledThisRound = 0;
    for (const [frameId, answers] of byFrame) {
      assertNotCancelled();
      await setStatus(`${model}: filling ${answers.length} answer(s)...`);
      const res = await sendMessageToTab(
        tabId,
        { type: "apply_form_plan", answers },
        { attempts: 2, frameId }
      ).catch(() => null);
      const filledIds = new Set((res?.filled || []).map((row) => row.id));
      for (const answer of answers) {
        if (!filledIds.has(answer.id)) {
          totals.failed += 1;
          continue;
        }
        filledThisRound += 1;
        totals.filledCount += 1;
        if (isChoiceKind(answer.kind)) totals.choiceFilled += 1;
        else totals.textFilled += 1;
        if (["kb", "qa", "profile"].includes(answer.source)) totals.bankHits += 1;
        else totals.aiAnswers += 1;
      }
    }
    totals.skipped += plan.skipped.length;

    // Each field is asked once per page: skipped or unfillable fields are not
    // re-asked next round. Fields a failed model call never answered get one more try.
    const unanswered = new Set(plan.unanswered);
    for (const f of fields) if (!unanswered.has(f.id)) attempted.add(f.sig);

    await learnFromPlan({
      profileId,
      fieldById,
      answers: plan.answers,
      bankMatches,
      site
    }).catch(() => {});

    // Nothing landed, so nothing new can have appeared.
    if (!filledThisRound) break;
  }

  // Safety net: explicit profile values for mapped dropdowns the plan left empty.
  const fallback = mergeAutofillFrameResults(
    await sendMessageToAllFrames(tabId, { type: "autofill_fallback_choices", applicantInfo }).catch(
      () => []
    )
  );
  totals.fallbackFilled = Number(fallback.filledCount || 0);
  return totals;
}

/**
 * Last resort when the rule-based finder recognises no Apply / Next button: show
 * the model the page's buttons and let it name the one that moves the
 * application forward. Never clicks Submit — a submit pick comes back as
 * `submitCandidate` so the caller can stop for review.
 * @returns {Promise<{ advanced: boolean, tabId: number, text?: string, submitCandidate?: boolean }>}
 */
async function tryAiApplyButton(
  tabId,
  { stage = "entry", preferNewTab = false, gateway = false, tried = new Set() } = {}
) {
  const none = { advanced: false, tabId };
  const live = await chrome.tabs.get(tabId).catch(() => null);
  const site = detectSiteFromUrl(live?.url || "");
  if (!isAiFormAssistAllowed(site)) return none;
  if (!(await isAiFormPlanEnabled().catch(() => false))) return none;
  let settings;
  try {
    settings = await getOpenAiFormSettings();
  } catch {
    return none;
  }

  const frames = await sendMessageToAllFrames(tabId, {
    type: "scan_application_form",
    buttonsOnly: true
  }).catch(() => []);
  const buttons = [];
  let page = null;
  for (const fr of frames) {
    if (!fr || fr.ok === false) continue;
    page = page || fr.page || null;
    for (const b of fr.buttons || []) {
      if (tried.has(`${fr.frameId}|${b.text}`)) continue;
      const href = String(b.href || "").trim();
      if (href && (isMarketingOrCorporateUrl(href) || !isPlausibleApplyDestination(href))) {
        // Keep same-page / hash / relative empties; only skip clear off-site marketing links.
        if (/^https?:/i.test(href)) continue;
      }
      const text = String(b.text || "");
      if (
        /\b(explore|get in touch|talk with|contact us|about us|corporate|governance|investors?|privacy|terms|sustainability|media hub|learn more|careers home|company overview)\b/i.test(
          text
        )
      ) {
        continue;
      }
      buttons.push({ ...b, frameId: fr.frameId });
    }
  }
  if (!buttons.length) return none;

  await setStatus(
    stage === "entry"
      ? `${settings.model} is looking for the Apply button...`
      : `${settings.model} is looking for the button that continues the application...`
  );
  const ctx = await getAutofillAiContext();
  let pick;
  try {
    pick = await pickApplicationButton({
      apiKey: settings.apiKey,
      model: settings.model,
      buttons,
      page,
      stage,
      job: ctx.jobMeta
    });
  } catch (err) {
    if (isCancelError(err)) throw err;
    return none;
  }
  if (pick.usage) {
    await logLlmCall({
      purpose: "apply_button_pick",
      model: settings.model,
      inputTokens: pick.usage.prompt_tokens,
      outputTokens: pick.usage.completion_tokens
    });
  }
  const button = pick.id ? buttons.find((b) => b.id === pick.id) : null;
  if (!button) return none;
  tried.add(`${button.frameId}|${button.text}`);
  if (pick.type === "submit") return { ...none, submitCandidate: true, text: button.text };
  // Only Apply / Next / Review / Continue-style progression — never ads, cookies, sign-in, etc.
  const allowed =
    pick.type === "entry" ||
    pick.type === "next" ||
    pick.type === "review" ||
    (stage === "entry" && /\bapply\b/i.test(String(button.text || ""))) ||
    (stage === "next" && /\b(next|continue|review|save\s*(and|&)\s*continue)\b/i.test(String(button.text || "")));
  if (!allowed) return none;

  const before = await chrome.tabs.get(tabId).catch(() => null);
  const prevUrl = before?.url || "";
  const prevSig = (await getApplyActionFromTab(tabId).catch(() => null))?.signature || "";
  await setStatus(`AI: clicking "${button.text}"...`);
  const clickRes = await sendMessageToTab(
    tabId,
    { type: "click_scanned_button", id: button.id, preferNewTab, allowSubmit: false },
    { attempts: 2, frameId: button.frameId }
  ).catch(() => null);
  if (clickRes?.refusedSubmit) return { ...none, submitCandidate: true, text: button.text };
  if (!clickRes?.ok) return none;

  if (clickRes.navigateUrl) {
    if (
      !isPlausibleApplyDestination(clickRes.navigateUrl) ||
      isDiceProfileUrl(clickRes.navigateUrl) ||
      isMarketingOrCorporateUrl(clickRes.navigateUrl)
    ) {
      return none;
    }
    if (preferNewTab || clickRes.openInNewTab) {
      const newId = await openApplyUrlInNewTab(clickRes.navigateUrl, tabId);
      if (newId) return { advanced: true, tabId: newId, text: button.text };
    }
    await navigateTabToUrl(tabId, clickRes.navigateUrl);
  }
  const wait = await waitForApplyAdvance(tabId, prevSig, prevUrl, 10000, { preferNewTab, gateway });
  if (wait?.advanced) {
    const landed = (await chrome.tabs.get(wait.tabId || tabId).catch(() => null))?.url || "";
    if (landed && (isMarketingOrCorporateUrl(landed) || isDiceProfileUrl(landed))) {
      if (prevUrl) await navigateTabToUrl(wait.tabId || tabId, prevUrl).catch(() => {});
      return none;
    }
  }
  return { advanced: Boolean(wait?.advanced), tabId: wait?.tabId || tabId, text: button.text };
}

function describeAutofillButton(probe = {}, { readyToSubmit = false } = {}) {
  const type = String(probe?.best?.action?.type || "");
  const text = String(probe?.best?.action?.text || "").trim();
  const needsFill = probe.needsFill !== false;
  const applyTitle =
    "Apply: open/fill the application. Only Apply / Next / Submit buttons are clicked. (Alt+Shift+E)";
  if (type === "submit" && (!needsFill || readyToSubmit)) {
    return {
      label: "Submit",
      actionType: "submit",
      actionText: text || "Submit",
      title: `Review the filled form, then click Submit to press "${text || "Submit"}" on the page. (Alt+Shift+E)`
    };
  }
  return {
    label: "Apply",
    actionType: type === "submit" ? "fill" : type || "",
    actionText: text,
    title: applyTitle
  };
}

function isDiceApplicationUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)dice\.com$/i.test(u.hostname)) return false;
    return /\/job-applications\b|\/wizard\b|easy-apply/i.test(`${u.pathname}${u.search}`);
  } catch {
    return /dice\.com\/(job-applications|wizard)/i.test(String(url || ""));
  }
}

/** Job listing / job-detail (no application form): same path as the job-card Apply button. */
function shouldUseJobCardApplyPath(url, probe) {
  if (probe?.anyForm) return false;
  const site = detectSiteFromUrl(url);
  if (site === "dice") return !isDiceApplicationUrl(url);
  return probe?.best?.action?.type === "entry";
}

/**
 * Panel Apply button: fill the current page first.
 * On a job listing (especially Dice), uses the same Apply path as the job card.
 */
async function runAutofillStep(
  profileId,
  { uploadDocs = null, clickAction = true, preferredAction = "" } = {}
) {
  let userWantsSubmit = String(preferredAction || "").toLowerCase() === "submit";

  const tab = await getCurrentApplicationTab();
  if (!tab?.id) {
    return { ok: false, error: "No application tab found. Open the job application page first." };
  }

  // Pick the PDFs for the job on screen, not the last job generated.
  const resolvedDocs = await resolveUploadDocsForTab(tab.id, { explicitDocs: uploadDocs });
  if (resolvedDocs.mismatch) {
    return { ok: false, error: uploadDocsMismatchError(resolvedDocs) };
  }
  const docs = resolvedDocs.docs;
  const loc = await formatUploadDocsLocation(docs);

  let tabId = tab.id;
  let probe = await getApplyActionFromTab(tabId).catch(() => ({ best: null, anyForm: false }));
  const ready = await isReadyToSubmit(tab.url || "");
  if (!userWantsSubmit && probe?.best?.action?.type === "submit" && ready) {
    userWantsSubmit = true;
  }

  if (!userWantsSubmit && shouldUseJobCardApplyPath(tab.url || "", probe)) {
    if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) {
      return {
        ok: false,
        error:
          resolvedDocs.error ||
          "Generate a resume first, then click Apply — or use Apply on the job card.",
        button: describeAutofillButton(probe)
      };
    }
    const site = detectSiteFromUrl(tab.url || "");
    await setStatus("Apply: applying from this job page (same as job-card Apply)...");
    const ea = await startMultiStepApplyOnTab(profileId, tabId, {
      maxSteps: 14,
      uploadDocs: docs,
      closeOnSuccess: false,
      preferNewTab: site === "dice" || site === "jobgether"
    });
    if (!ea.ok && ea.error) {
      return { ok: false, error: ea.error, button: describeAutofillButton(probe) };
    }
    const liveId = ea.tabId || tabId;
    const after = liveId
      ? await getApplyActionFromTab(liveId).catch(() => probe)
      : probe;
    return {
      ok: true,
      ...ea,
      button: describeAutofillButton(after, {
        readyToSubmit: String(ea.status || "") === "ready_for_review"
      }),
      status:
        ea.detail ||
        (ea.status === "submitted"
          ? "Application submitted."
          : ea.status === "skipped"
            ? ea.detail || "No Apply button on this page."
            : `Apply ${ea.status || "done"}.`)
    };
  }

  async function fillSummary(fillRes, extra = "") {
    const uploaded = Array.isArray(fillRes?.uploaded) ? fillRes.uploaded : [];
    const fileNote =
      loc.summary ||
      (uploaded.length ? uploaded.map((u) => u.fileName || u.kind).join(", ") : "");
    return (
      `Filled ${fillRes?.filledCount || 0} field(s)` +
      (fillRes?.choiceFilledCount ? `, ${fillRes.choiceFilledCount} choice(s)` : "") +
      (fillRes?.bankHits ? `, ${fillRes.bankHits} from Q&A bank` : "") +
      (fillRes?.aiFilledCount ? `, AI ${fillRes.aiFilledCount}` : "") +
      (fileNote ? `. Files: ${fileNote}` : "") +
      extra +
      ` ${await getCostSummaryText()}`
    ).trim();
  }

  if (userWantsSubmit) {
    // Submit is the last step, not the only one: anything the page still needs
    // gets filled first, even when a previous pass already paused for review.
    if (probe.needsFill) {
      if (loc.summary) await setStatus(`Uploading from ${loc.summary}...`);
      const fillRes = await startAutofillOnCurrentPage(profileId, tabId, { uploadDocs: docs });
      if (fillRes?.skipped || fillRes?.ok === false) return fillRes;
      tabId = fillRes.tabId || tabId;
    }
    await setStatus("Autofill: clicking Submit...");
    const liveProbe = await getApplyActionFromTab(tabId).catch(() => probe);
    const clickRes = await sendMessageToTab(
      tabId,
      { type: "click_apply_action", preferredType: "submit" },
      { attempts: 2, frameId: liveProbe?.best?.frameId }
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!(clickRes?.clicked || clickRes?.navigateUrl || clickRes?.isSubmit)) {
      return {
        ok: false,
        error: clickRes?.error || "Could not click Submit. The application tab was left open."
      };
    }
    if (clickRes?.navigateUrl) {
      await navigateTabToUrl(tabId, clickRes.navigateUrl);
    }
    await clearReadyToSubmit();
    const submitSite = detectSiteFromUrl(
      (await chrome.tabs.get(tabId).catch(() => null))?.url || tab.url || ""
    );
    const finished = await finishSubmittedApplication(tabId, {
      closeOnSuccess: isAutoSubmitAllowedSite(submitSite),
      clickLabel: liveProbe?.best?.action?.text || "Submit"
    });
    return {
      ok: true,
      tabId: finished.tabId,
      clicked: { type: "submit", ok: true, text: liveProbe?.best?.action?.text || "Submit" },
      submitted: finished.status === "submitted",
      button: describeAutofillButton(liveProbe, { readyToSubmit: false }),
      status: finished.detail || "Clicked Submit."
    };
  }

  const fillRes = await startAutofillOnCurrentPage(profileId, tabId, { uploadDocs: docs });
  if (fillRes?.skipped || fillRes?.ok === false) {
    return fillRes;
  }

  tabId = fillRes.tabId || tabId;
  probe = await getApplyActionFromTab(tabId).catch(() => probe);
  let button = describeAutofillButton(probe, { readyToSubmit: false });
  let clicked = null;
  let advanced = false;
  const actionType = probe?.best?.action?.type || "";

  if (actionType === "submit") {
    await markReadyToSubmit((await chrome.tabs.get(tabId).catch(() => null))?.url || fillRes.tabUrl || "");
    button = describeAutofillButton(probe, { readyToSubmit: true });
    const status = await fillSummary(fillRes, ". Click Submit to send the application.");
    await setStatus(status);
    return {
      ok: true,
      ...fillRes,
      clicked: null,
      advanced: false,
      submitted: false,
      button,
      status
    };
  }

  if (clickAction && (actionType === "next" || actionType === "review" || actionType === "entry")) {
    const live = await chrome.tabs.get(tabId).catch(() => null);
    const prevUrl = live?.url || "";
    const prevSig = probe.signature || "";

    await setStatus(`Autofill: clicking ${probe.best.action.text || actionType}...`);
    const clickRes = await sendMessageToTab(
      tabId,
      { type: "click_apply_action", preferredType: actionType },
      { attempts: 2, frameId: probe.best.frameId }
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));

    clicked = {
      type: actionType,
      text: probe.best.action.text || actionType,
      ok: Boolean(clickRes?.ok !== false && (clickRes?.clicked || clickRes?.navigateUrl || clickRes?.isSubmit))
    };

    if (clickRes?.navigateUrl) {
      await navigateTabToUrl(tabId, clickRes.navigateUrl);
    }

    if (clickRes?.isSubmit) {
      await clearReadyToSubmit();
      const finished = await finishSubmittedApplication(tabId, {
        closeOnSuccess: false,
        clickLabel: clicked.text
      });
      return {
        ok: true,
        ...fillRes,
        clicked,
        advanced: false,
        submitted: finished.status === "submitted",
        button: describeAutofillButton({ best: { action: { type: "submit", text: clicked.text } } }),
        status: finished.detail || (await fillSummary(fillRes, `, clicked ${clicked.text}.`))
      };
    }

    const wait = await waitForApplyAdvance(tabId, prevSig, prevUrl, 15000);
    tabId = wait.tabId;
    advanced = Boolean(wait.advanced);
    await clearReadyToSubmit();

    if (advanced) {
      await waitForPageReady(tabId).catch(() => {});
      await setStatus("Autofill: filling the next page...");
      const nextFill = await startAutofillOnCurrentPage(profileId, tabId, { uploadDocs: docs });
      probe = await getApplyActionFromTab(tabId).catch(() => ({ best: null, anyForm: false }));
      const nextReady = probe?.best?.action?.type === "submit";
      if (nextReady) {
        await markReadyToSubmit((await chrome.tabs.get(tabId).catch(() => null))?.url || "");
      }
      button = describeAutofillButton(probe, { readyToSubmit: nextReady });
      return {
        ok: true,
        ...nextFill,
        priorFilledCount: fillRes.filledCount || 0,
        clicked,
        advanced: true,
        submitted: false,
        button,
        status:
          `Advanced via ${clicked.text}. Filled next page: ${nextFill.filledCount || 0} field(s)` +
          (nextFill.choiceFilledCount ? `, ${nextFill.choiceFilledCount} choice(s)` : "") +
          (nextFill.bankHits ? `, ${nextFill.bankHits} from Q&A bank` : "") +
          (nextFill.aiFilledCount ? `, AI ${nextFill.aiFilledCount}` : "") +
          (loc.summary ? `. Files: ${loc.summary}` : "") +
          (nextReady ? ". Click Submit to send." : ".") +
          ` ${await getCostSummaryText()}`
      };
    }
  }

  probe = await getApplyActionFromTab(tabId).catch(() => probe);
  button = describeAutofillButton(probe, {
    readyToSubmit: await isReadyToSubmit((await chrome.tabs.get(tabId).catch(() => null))?.url || "")
  });
  const status = await fillSummary(fillRes, clicked?.ok ? `, clicked ${clicked.text}.` : ".");
  return {
    ok: true,
    ...fillRes,
    clicked,
    advanced,
    submitted: false,
    button,
    status
  };
}

/**
 * Panel Apply button: run the whole application (fill → Next → next page),
 * same engine as job-card Apply. Dice clicks Submit automatically.
 * Other ATS pause on Submit so a second Apply click sends the form.
 */
async function runPanelApply(profileId, { preferredAction = "" } = {}) {
  const tab = await getCurrentApplicationTab();
  if (!tab?.id) {
    return { ok: false, error: "No application tab found. Open the job application page first." };
  }
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return {
      ok: false,
      error: "The current tab is not a web page. Open the job page, then click Apply."
    };
  }

  // PDFs for the job on screen — not whatever the last batch build left behind.
  const resolvedDocs = await resolveUploadDocsForTab(tab.id);
  if (resolvedDocs.mismatch) {
    return { ok: false, error: uploadDocsMismatchError(resolvedDocs) };
  }
  const docs = resolvedDocs.docs;

  let probe = await getApplyActionFromTab(tab.id).catch(() => ({ best: null, anyForm: false }));
  const site = detectSiteFromUrl(tab.url || "");
  const ready = await isReadyToSubmit(tab.url || "");
  const wantsSubmit =
    String(preferredAction || "").toLowerCase() === "submit" ||
    (probe?.best?.action?.type === "submit" && ready);

  if (wantsSubmit && probe?.best?.action?.type === "submit") {
    return runAutofillStep(profileId, {
      uploadDocs: docs,
      clickAction: true,
      preferredAction: "submit"
    });
  }

  if (!probe?.anyForm && !docs?.resume?.base64 && !docs?.coverLetter?.base64) {
    return {
      ok: false,
      error: resolvedDocs.error || "Generate a resume first, then click Apply.",
      button: describeAutofillButton(probe)
    };
  }

  await setStatus("Apply: filling the form and continuing the application...");
  const ea = await startMultiStepApplyOnTab(profileId, tab.id, {
    maxSteps: 14,
    uploadDocs: docs,
    closeOnSuccess: isAutoSubmitAllowedSite(site),
    preferNewTab: site === "dice" || isGatewaySite(site)
  });
  if (!ea.ok && ea.error) {
    return { ok: false, error: ea.error, button: describeAutofillButton(probe) };
  }

  const liveId = ea.tabId || tab.id;
  const after = liveId
    ? await getApplyActionFromTab(liveId).catch(() => probe)
    : probe;
  const readyForReview = String(ea.status || "") === "ready_for_review";
  let status = String(ea.detail || "").trim();
  if (ea.status === "submitted") {
    status = status || "Application submitted.";
  } else if (readyForReview) {
    status =
      status ||
      "Filled every step. Review the form, then click Submit in Ocean to send the application.";
  } else if (ea.status === "skipped") {
    status = status || "No Apply button on this page.";
  } else if (ea.status === "already_applied") {
    status = status || "Already applied.";
  } else if (!status) {
    status = `Apply ${ea.status || "done"}.`;
  }

  return {
    ok: true,
    ...ea,
    button: describeAutofillButton(after, { readyToSubmit: readyForReview }),
    status
  };
}

/**
 * Drive multi-step Autofill on any ATS / job board:
 * fill all frames → if Next/Continue click it → wait for next page → refill.
 * On the final Submit page, clicks Submit.
 */
async function sleepMs(ms) {
  const end = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < end) {
    if (generationCancelRequested || generationAbortController?.signal?.aborted) {
      throw new Error("Cancelled by user.");
    }
    await new Promise((r) => setTimeout(r, Math.min(200, Math.max(0, end - Date.now()))));
  }
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/** Corporate / marketing / about pages — never treat as an application destination. */
function isMarketingOrCorporateUrl(url) {
  const href = String(url || "").trim();
  if (!href) return false;
  try {
    const u = new URL(href);
    const blob = `${u.hostname}${u.pathname}${u.search}`.toLowerCase();
    return /about-us|about\/|corporate-profile|corporate-governance|board-of-directors|code-of-business|investor|investors\b|\/privacy\b|\/terms\b|media-hub|press-release|sustainability|human-rights|public-policy|contact-us|talk-with|get-in-touch|\/news\b|\/community\b|suppliers\b/i.test(
      blob
    );
  } catch {
    return /about-us|corporate-profile|corporate-governance|investor|privacy|sustainability/i.test(href);
  }
}

function isAllowedApplyNavUrl(url) {
  const href = String(url || "").trim();
  if (!/^https?:\/\//i.test(href)) return false;
  if (isMarketingOrCorporateUrl(href)) return false;
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    const path = `${u.pathname || ""}${u.search || ""}`;
    if (host === "dice.com" || host.endsWith(".dice.com")) {
      return /\/job-applications\b|\/job-detail\b|\/wizard\b|easy-apply/i.test(path);
    }
    if (/(^|\.)greenhouse\.io$/i.test(host)) return true;
    if (/(^|\.)myworkdayjobs\.com$/i.test(host) || /(^|\.)workdayjobs\.com$/i.test(host)) {
      return true;
    }
    if (/(^|\.)indeed\.com$/i.test(host)) {
      return /\/(viewjob|apply|indeedapply|job)\b|jk=/i.test(path);
    }
    if (/(^|\.)jobgether\.com$/i.test(host)) return true;
    if (/(^|\.)builtin\.com$/i.test(host)) return true;
    if (/(^|\.)smartrecruiters\.com$/i.test(host)) return true;
    if (/(^|\.)zohorecruit\.com$/i.test(host)) return true;
    if (/(^|\.)recruit\.zoho\./i.test(host)) return true;
    if (/(^|\.)oraclecloud\.com$/i.test(host)) return true;
    return /\/(apply|application|job-applications)\b/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Destinations Apply may open or follow after a click (incl. gateway handoff).
 * Rejects marketing/about pages such as Halliburton corporate-profile links.
 */
function isPlausibleApplyDestination(url) {
  const href = String(url || "").trim();
  if (!isHttpUrl(href) || isDiceProfileUrl(href) || isMarketingOrCorporateUrl(href)) return false;
  if (isAllowedApplyNavUrl(href)) return true;
  try {
    const u = new URL(href);
    const host = u.hostname.toLowerCase();
    const path = `${u.pathname || ""}${u.search || ""}`.toLowerCase();
    if (/^(jobs|careers|career|apply|recruiting|talents?)\./i.test(host)) return true;
    if (
      /(^|\.)(lever\.co|ashbyhq\.com|icims\.com|jobvite\.com|workable\.com|breezy\.hr|taleo\.net|successfactors\.com|bamboohr\.com|paylocity\.com|ultipro\.com)$/i.test(
        host
      )
    ) {
      return true;
    }
    return /\/(job|jobs|career|careers|position|positions|requisition|vacancy|vacancies|opening|openings|apply|application)\b/i.test(
      path
    );
  } catch {
    return false;
  }
}

function applicationSuccessFromUrl(url) {
  const href = String(url || "");
  if (!href) return "";
  try {
    const u = new URL(href);
    const path = u.pathname || "";
    const host = (u.hostname || "").toLowerCase();
    if (/(^|\.)greenhouse\.io$/i.test(host) && /confirmation|thanks|submitted|success/i.test(path)) {
      return "Application submitted (confirmation page).";
    }
    if (
      (/(^|\.)myworkdayjobs\.com$/i.test(host) || /(^|\.)workdayjobs\.com$/i.test(host)) &&
      /\/apply\/(?:complete|submitted|success)|applicationSubmitted|\/submitted/i.test(path)
    ) {
      return "Application submitted (confirmation page).";
    }
    if (/(^|\.)indeed\.com$/i.test(host) && /\/apply\/(?:complete|success|submitted)|applicationSubmitted/i.test(path)) {
      return "Application submitted (confirmation page).";
    }
    if (
      /\/wizard\/success(?:\/|$)/i.test(path) ||
      /\/job-applications\/[^/]+\/(?:wizard\/)?success\b/i.test(path) ||
      /\/apply\/success\b/i.test(path)
    ) {
      return "Application submitted (confirmation page).";
    }
  } catch {
    if (/\/wizard\/success(?:\/|\?|#|$)/i.test(href)) {
      return "Application submitted (confirmation page).";
    }
  }
  return "";
}

function isDiceProfileUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/(^|\.)dice\.com$/i.test(u.hostname)) return false;
    return /^\/profile(?:\/|$)/i.test(u.pathname || "");
  } catch {
    return /dice\.com\/profile(?:\/|\?|#|$)/i.test(String(url || ""));
  }
}

/** Close Dice tabs sitting on /wizard/success (or equivalent). Never closes other sites. */
async function closeAllDiceSuccessTabs({ delayMs = 1000 } = {}) {
  if (delayMs > 0) await sleepMs(delayMs);
  const tabs = await chrome.tabs.query({});
  let closed = 0;
  for (const t of tabs) {
    if (t.id == null) continue;
    const href = t.url || t.pendingUrl || "";
    if (!/(^|\.)dice\.com$/i.test(hostnameFromUrl(href))) continue;
    if (!applicationSuccessFromUrl(href)) continue;
    await closeTabQuietly(t.id);
    closed += 1;
  }
  return closed;
}

function isDiceTabUrl(url) {
  return /(^|\.)dice\.com$/i.test(hostnameFromUrl(url));
}

/** Wait for load + a short SPA settle so the job/apply page is actually visible. */
async function waitForPageReady(tabId, timeoutMs = 15000) {
  try {
    await awaitTabComplete(tabId, timeoutMs);
  } catch {
    /* Hung or SPA page: continue with whatever is already painted. */
  }
  const deadline = Date.now() + Math.min(2500, Math.max(800, timeoutMs));
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return;
    if (tab.status === "complete" && isHttpUrl(tab.url) && tab.url !== "about:blank") {
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => Boolean(document.body && String(document.body.innerText || "").trim().length > 20)
        });
        if (result) {
          await sleepMs(400);
          return;
        }
      } catch {
        await sleepMs(300);
        return;
      }
    }
    await sleepMs(250);
  }
  await sleepMs(300);
}

async function dismissPageOverlays(tabId, { rounds = 3, cookiesOnly = false } = {}) {
  try {
    await ensureAutofillScript(tabId);
    await sendMessageToTab(
      tabId,
      { type: "dismiss_page_overlays", rounds, cookiesOnly },
      { attempts: 1 }
    );
  } catch {
    /* script may not be injectable yet */
  }
}

/** Cookie banners often paint after first paint — retry Accept/Allow a few times. */
async function dismissCookieBannersEarly(tabId) {
  await dismissPageOverlays(tabId, { rounds: 4, cookiesOnly: true });
  await sleepMs(600);
  await dismissPageOverlays(tabId, { rounds: 2, cookiesOnly: true });
}

/**
 * How long Auto Apply keeps looking for an Apply/Easy Apply entry point, and how
 * long it waits for a click to visibly do something, before giving up and moving
 * to the next job. A page that has an Apply button reveals it well inside this;
 * anything longer was just a dead wait on a page that has none.
 */
const APPLY_ENTRY_WAIT_MS = 2000;
const APPLY_NO_REACTION_MS = 2000;

function probeHasApplyEntry(probe) {
  if (!probe) return false;
  if (probe.anyForm) return true;
  if (probe.best?.action?.type === "entry") return true;
  return (probe.applyUrls || []).some((u) => isAllowedApplyNavUrl(u) && !isDiceProfileUrl(u));
}

async function waitBrieflyForApplyEntry(tabId, timeoutMs = APPLY_ENTRY_WAIT_MS) {
  const start = Date.now();
  let probe = null;
  // Probe immediately, then keep re-checking until the deadline — a page that
  // already has its Apply button returns on the first pass with no extra wait.
  while (true) {
    await dismissPageOverlays(tabId, { rounds: 1 });
    probe = await getApplyActionFromTab(tabId).catch(() => probe);
    if (
      probe?.alreadyApplied ||
      probe?.jobUnavailable ||
      probe?.applicationSuccess ||
      probeHasApplyEntry(probe)
    ) {
      return probe;
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleepMs(250);
  }
  return (
    probe || {
      best: null,
      anyForm: false,
      applyUrls: [],
      alreadyApplied: "",
      jobUnavailable: "",
      applicationSuccess: ""
    }
  );
}

async function navigateTabToUrl(tabId, url) {
  const next = String(url || "").trim();
  if (!isHttpUrl(next)) return false;
  const live = await chrome.tabs.get(tabId).catch(() => null);
  if (live?.url && normalizeUrlForMatch(live.url) === normalizeUrlForMatch(next)) {
    await waitForPageReady(tabId);
    return true;
  }
  await chrome.tabs.update(tabId, { url: next });
  await waitForPageReady(tabId);
  return true;
}

function pickBestApplyAction(frameResults = []) {
  const anyForm = frameResults.some((f) => f?.isApplicationForm);
  // On an application form, Submit beats Next (Dice last wizard step).
  const rank = anyForm
    ? { submit: 1, next: 2, review: 3, entry: 4 }
    : { entry: 1, next: 2, review: 3, submit: 4 };
  let best = null;
  for (const f of frameResults) {
    if (!f?.action?.type) continue;
    const cand = {
      frameId: f.frameId,
      action: f.action,
      signature: f.signature || "",
      href: f.href || "",
      isApplicationForm: Boolean(f.isApplicationForm)
    };
    if (!best) {
      best = cand;
      continue;
    }
    const br = rank[best.action.type] ?? 9;
    const cr = rank[cand.action.type] ?? 9;
    if (cr < br) best = cand;
    else if (cr === br && cand.isApplicationForm && !best.isApplicationForm) best = cand;
  }
  const blockedReason =
    frameResults.find((f) => f?.blockedReason)?.blockedReason || "";
  const jobUnavailable =
    frameResults.find((f) => f?.jobUnavailable)?.jobUnavailable || "";
  const alreadyApplied =
    frameResults.find((f) => f?.alreadyApplied)?.alreadyApplied || "";
  const applicationSuccess =
    frameResults.find((f) => f?.applicationSuccess)?.applicationSuccess ||
    applicationSuccessFromUrl(best?.href || frameResults[0]?.href || "") ||
    "";
  const emailVerification = frameResults.some((f) => f?.emailVerification);
  const emailVerificationText =
    frameResults.find((f) => f?.emailVerificationText)?.emailVerificationText || "";
  let workdayWizard = null;
  let diceSubmitPage = false;
  for (const f of frameResults) {
    if (f?.workdayWizard && !workdayWizard) workdayWizard = f.workdayWizard;
    if (f?.diceSubmitPage) diceSubmitPage = true;
    if (
      f?.workdayWizard?.isReview &&
      f.action?.type === "submit" &&
      best?.action?.type !== "submit"
    ) {
      best = {
        frameId: f.frameId,
        action: f.action,
        signature: f.signature || "",
        href: f.href || "",
        isApplicationForm: Boolean(f.isApplicationForm)
      };
    }
    if (diceSubmitPage && f?.action?.type === "submit" && best?.action?.type !== "submit") {
      best = {
        frameId: f.frameId,
        action: f.action,
        signature: f.signature || "",
        href: f.href || "",
        isApplicationForm: Boolean(f.isApplicationForm)
      };
    }
  }
  const applyUrls = [];
  for (const f of frameResults) {
    for (const u of f?.applyUrls || []) {
      if (u && !applyUrls.includes(u)) applyUrls.push(u);
    }
  }
  return {
    best,
    anyForm,
    blockedReason,
    jobUnavailable,
    alreadyApplied,
    applicationSuccess,
    emailVerification,
    emailVerificationText,
    workdayWizard,
    diceSubmitPage,
    fillableCount: Math.max(0, ...frameResults.map((f) => Number(f?.fillableCount || 0))),
    applyUrls,
    needsFill: frameResults.some((f) => f?.needsFill),
    uploadsBusy: frameResults.some((f) => f?.uploadsBusy),
    signature: best?.signature || frameResults[0]?.signature || "",
    href: best?.href || frameResults[0]?.href || ""
  };
}

async function getApplyActionFromTab(tabId) {
  await ensureAutofillScript(tabId);
  const frames = await sendMessageToAllFrames(tabId, { type: "get_apply_action" }, { attempts: 1 });
  const picked = pickBestApplyAction(frames);
  const live = await chrome.tabs.get(tabId).catch(() => null);
  const urlSuccess = applicationSuccessFromUrl(live?.url || live?.pendingUrl || "");
  if (urlSuccess && !picked.applicationSuccess) {
    picked.applicationSuccess = urlSuccess;
    picked.href = live?.url || picked.href;
  }
  return picked;
}

function extractGreenhouseSecurityCodeFromText(text) {
  const cleaned = String(text || "");
  if (!/security\s*code/i.test(cleaned) && !/greenhouse/i.test(cleaned)) return "";
  const tokens = cleaned.match(/\b[A-Za-z0-9]{6,12}\b/g) || [];
  for (const token of tokens) {
    if (
      /[A-Za-z]/.test(token) &&
      /[0-9]/.test(token) &&
      !/greenhouse|outlook|microsoft|security|verify/i.test(token)
    ) {
      return token;
    }
  }
  return "";
}

/**
 * Fallback: read Greenhouse OTP from an already-open Outlook web tab.
 */
async function scrapeOutlookGreenhouseSecurityCode({ afterEpochMs = 0, timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const outlookRe = /(^|\.)outlook\.(live|office|office365)\.com$/i;

  const findOutlookTabs = async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((t) => {
      try {
        return outlookRe.test(new URL(t.url || "").hostname);
      } catch {
        return false;
      }
    });
  };

  const extractInTab = async (tabId) => {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const text = String(document.body?.innerText || document.body?.textContent || "");
          if (!/security\s*code/i.test(text) && !/greenhouse/i.test(text)) {
            return { ok: false, reason: "no_greenhouse_mail_visible" };
          }
          return { ok: true, text: text.slice(0, 20000) };
        }
      });
      if (!result?.ok) return { ok: false, code: "" };
      const code = extractGreenhouseSecurityCodeFromText(result.text || "");
      return code ? { ok: true, code } : { ok: false, code: "" };
    } catch {
      return { ok: false, code: "" };
    }
  };

  while (Date.now() < deadline) {
    const tabs = await findOutlookTabs();
    for (const tab of tabs) {
      if (tab.id == null) continue;
      const hit = await extractInTab(tab.id);
      if (hit.ok && hit.code) return hit;
    }
    await sleepMs(3500);
  }
  return {
    ok: false,
    code: "",
    error: "No Greenhouse security code found in an open Outlook tab."
  };
}

async function completeGreenhouseEmailVerification(tabId, { afterEpochMs } = {}) {
  await setStatus("Auto Apply: Greenhouse — waiting for security code email (Outlook)...");
  const since = afterEpochMs || Date.now() - 60_000;
  const mail = await scrapeOutlookGreenhouseSecurityCode({
    afterEpochMs: since,
    timeoutMs: 60_000
  }).catch((err) => ({
    ok: false,
    code: "",
    error: String(err?.message || err)
  }));

  if (!mail?.ok || !mail.code) {
    return {
      ok: false,
      detail:
        mail?.error ||
        "Greenhouse asked for an email security code. Open the Outlook web inbox (outlook.live.com) signed in, then retry Auto Apply."
    };
  }
  await setStatus(`Auto Apply: Greenhouse — entering security code ${mail.code}...`);
  await ensureAutofillScript(tabId);
  const fillRes = await sendMessageToTab(
    tabId,
    { type: "fill_greenhouse_security_code", code: mail.code },
    { attempts: 2 }
  ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  if (!fillRes?.ok) {
    return {
      ok: false,
      detail: fillRes?.error || "Could not fill the Greenhouse security code field."
    };
  }
  await sleepMs(600);
  if (!fillRes?.submitted) {
    const clickRes = await sendMessageToTab(
      tabId,
      { type: "click_apply_action", preferredType: "submit" },
      { attempts: 2 }
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!(clickRes?.clicked || clickRes?.isSubmit)) {
      return {
        ok: false,
        detail: clickRes?.error || "Security code filled but Submit could not be clicked."
      };
    }
  }
  const confirmed = await waitForApplicationSuccess(tabId, 25000);
  if (confirmed.success) {
    return { ok: true, detail: confirmed.detail || "Your application has been received" };
  }
  if (confirmed.emailVerification) {
    return {
      ok: false,
      detail: "Security code was entered but Greenhouse still asks for verification."
    };
  }
  return {
    ok: false,
    detail: "Security code submitted but Greenhouse success screen was not detected."
  };
}

async function waitForApplicationSuccess(tabId, timeoutMs = 25000) {
  const start = Date.now();
  const knownTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));
  knownTabIds.add(tabId);

  while (Date.now() - start < timeoutMs) {
    const live = await chrome.tabs.get(tabId).catch(() => null);
    if (!live?.id) return { success: false, tabGone: true, detail: "", tabId };
    const urlHit = applicationSuccessFromUrl(live.url || live.pendingUrl || "");
    if (urlHit) return { success: true, tabGone: false, detail: urlHit, tabId };

    // Some flows open confirmation in a new tab — adopt it so we can close it.
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null || knownTabIds.has(t.id)) continue;
      const raw = t.url || t.pendingUrl || "";
      if (!isHttpUrl(raw)) {
        knownTabIds.add(t.id);
        continue;
      }
      const hit = applicationSuccessFromUrl(raw);
      if (hit) {
        return { success: true, tabGone: false, detail: hit, tabId: t.id };
      }
      knownTabIds.add(t.id);
    }

    try {
      await ensureAutofillScript(tabId);
      const probe = await getApplyActionFromTab(tabId);
      const detail = String(probe?.applicationSuccess || "").trim();
      if (detail) return { success: true, tabGone: false, detail, tabId };
      if (probe?.emailVerification) {
        return {
          success: false,
          tabGone: false,
          emailVerification: true,
          detail: probe.emailVerificationText || "Greenhouse security code verification",
          tabId
        };
      }
    } catch {
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const path = String(location.pathname || "");
            if (
              /\/wizard\/success(?:\/|$)/i.test(path) ||
              /\/job-applications\/[^/]+\/(?:wizard\/)?success\b/i.test(path)
            ) {
              return "Application submitted (confirmation page).";
            }
            const blob = `${document.title || ""}\n${document.body?.innerText || ""}`.slice(0, 12000);
            const match = blob.match(
              /awesome!?\s*your application is on its way|your application is on its way|your application has been submitted|application submitted successfully|thank you for (your )?appl(y|ication)|we('ve| have) received your application/i
            );
            return match ? String(match[0]) : "";
          }
        });
        if (result) return { success: true, tabGone: false, detail: String(result), tabId };
      } catch {
        /* keep polling */
      }
    }
    await sleepMs(400);
  }
  return { success: false, tabGone: false, detail: "", tabId };
}

async function closeTabQuietly(tabId) {
  if (tabId == null) return;
  await chrome.tabs.remove(tabId).catch(() => {});
}

/** True only for a live Dice tab — other sites must never be closed by Auto Apply. */
async function isDiceBrowserTab(tabId) {
  if (tabId == null) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return Boolean(tab?.id && isDiceTabUrl(tab.url || tab.pendingUrl || ""));
}

/**
 * After a confirmed Dice submit: close only success / apply-wizard tab(s).
 * Never closes the original job-detail tab the user started from.
 */
async function closeApplyFlowTabs({
  currentTabId = null,
  originTabId = null,
  delayMs = 1000
} = {}) {
  await closeAllDiceSuccessTabs({ delayMs });

  // Extra close for the tab we were on if it is still a success or apply wizard
  // tab (and not the origin job listing / job-detail page).
  if (currentTabId == null || currentTabId === originTabId) return;
  if (!(await isDiceBrowserTab(currentTabId))) return;
  const live = await chrome.tabs.get(currentTabId).catch(() => null);
  if (!live?.id) return;
  const href = live.url || live.pendingUrl || "";
  if (applicationSuccessFromUrl(href) || isDiceApplicationUrl(href)) {
    await closeTabQuietly(currentTabId);
  }
}

/**
 * After Submit is clicked, wait for the ATS confirmation page, then close
 * only the Dice success wizard tab. The original job tab is left open.
 */
async function finishSubmittedApplication(
  tabId,
  { closeOnSuccess = false, clickLabel = "Submit", originTabId = null } = {}
) {
  await waitForPageReady(tabId).catch(() => {});
  const waited = await waitForApplicationSuccess(tabId, 25000);
  if (waited.emailVerification) {
    await setStatus("Auto Apply: Greenhouse — security code required...");
    const otp = await completeGreenhouseEmailVerification(tabId, {
      afterEpochMs: Date.now() - 15_000
    });
    if (otp.ok) {
      return {
        status: "submitted",
        detail: otp.detail,
        tabClosed: false,
        tabId
      };
    }
    return {
      status: "needs_review",
      detail: otp.detail,
      tabClosed: false,
      tabId
    };
  }
  const successTabId = waited.tabId || tabId;
  if (waited.success) {
    if (closeOnSuccess && !waited.tabGone) {
      await setStatus("Application succeeded — closing Dice success tab...");
      await closeApplyFlowTabs({
        currentTabId: successTabId,
        originTabId: originTabId != null ? originTabId : null,
        delayMs: 1000
      });
      // If Submit ran on a wizard tab and success opened elsewhere, close that
      // wizard tab too — but never the original job-detail tab.
      if (
        tabId != null &&
        tabId !== successTabId &&
        tabId !== originTabId &&
        (await isDiceBrowserTab(tabId))
      ) {
        const wizard = await chrome.tabs.get(tabId).catch(() => null);
        const wizardUrl = wizard?.url || wizard?.pendingUrl || "";
        if (isDiceApplicationUrl(wizardUrl) || applicationSuccessFromUrl(wizardUrl)) {
          await closeTabQuietly(tabId);
        }
      }
    }
    return {
      status: "submitted",
      detail: `Application succeeded. Clicked ${clickLabel}. ${waited.detail}`,
      tabClosed: Boolean(closeOnSuccess && !waited.tabGone),
      // Keep pointing at the origin job tab when we closed only the success tab.
      tabId:
        waited.tabGone || closeOnSuccess
          ? originTabId != null && originTabId !== successTabId
            ? originTabId
            : null
          : successTabId
    };
  }
  if (waited.tabGone) {
    return {
      status: "needs_review",
      detail: `Clicked ${clickLabel}, but the application tab closed before the success page appeared. The job tab was left open.`,
      tabClosed: false,
      tabId: originTabId != null ? originTabId : null
    };
  }
  return {
    status: "needs_review",
    detail: `Clicked ${clickLabel}, but the confirmation page did not appear. The tab was left open so you can finish.`,
    tabClosed: false,
    tabId
  };
}

async function clickSubmitOnTab(tabId, { frameId, clickLabel = "Submit", settleMs = 1000 } = {}) {
  await setStatus(`Auto Apply: on Submit page — waiting ${Math.round(settleMs / 1000)}s...`);
  await sleepMs(settleMs);
  await setStatus(`Auto Apply: clicking ${clickLabel}...`);
  let clickRes = await sendMessageToTab(
    tabId,
    { type: "click_apply_action", preferredType: "submit" },
    { attempts: 2, frameId }
  ).catch((err) => ({ ok: false, error: String(err?.message || err) }));

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (clickRes?.clicked || clickRes?.navigateUrl) break;
    await sleepMs(500);
    clickRes = await sendMessageToTab(
      tabId,
      { type: "click_apply_action", preferredType: "submit" },
      { attempts: 2, frameId }
    ).catch((err) => clickRes || { ok: false, error: String(err?.message || err) });
  }
  return clickRes;
}

async function waitForApplyAdvance(tabId, prevSig, prevUrl, timeoutMs = 15000, { preferNewTab = false, gateway = false } = {}) {
  const start = Date.now();
  const knownTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));
  // A click that worked shows *some* reaction fast: a new tab, a navigation, or a
  // loading spinner. If none of that has happened within the no-reaction deadline,
  // the click did nothing — give up now instead of sitting on the full timeout.
  const noReactionDeadline = start + APPLY_NO_REACTION_MS;

  while (Date.now() - start < timeoutMs) {
    await sleepMs(400);

    // Apply links often use target=_blank. For Dice we keep the application in that
    // new tab; elsewhere we fold it back into the original tab.
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null || knownTabIds.has(t.id) || t.id === tabId) continue;
      const rawUrl = t.url || t.pendingUrl || "";
      if (rawUrl && !isHttpUrl(rawUrl)) {
        knownTabIds.add(t.id);
        continue;
      }
      try {
        await awaitTabComplete(t.id, 20000);
      } catch {
        /* continue with whatever URL we have */
      }
      const fresh = await chrome.tabs.get(t.id).catch(() => null);
      const newUrl = fresh?.url || "";
      if (!fresh?.id || !isHttpUrl(newUrl)) {
        if (fresh?.id) knownTabIds.add(fresh.id);
        continue;
      }

      if (preferNewTab && isPlausibleApplyDestination(newUrl) && !isDiceProfileUrl(newUrl)) {
        await chrome.tabs.update(fresh.id, { active: true }).catch(() => {});
        await waitForPageReady(fresh.id).catch(() => {});
        return { advanced: true, tabId: fresh.id, reason: "adopted_new_tab" };
      }
      // Gateway sites (Jobright/Jobgether) hand off to an employer ATS / careers apply page.
      // Never adopt marketing/about pages (e.g. halliburton.com/.../corporate-profile).
      if (
        gateway &&
        isPlausibleApplyDestination(newUrl) &&
        !isGatewaySite(detectSiteFromUrl(newUrl)) &&
        !isDiceProfileUrl(newUrl)
      ) {
        await chrome.tabs.update(fresh.id, { active: true }).catch(() => {});
        await waitForPageReady(fresh.id).catch(() => {});
        return { advanced: true, tabId: fresh.id, reason: "adopted_gateway_tab" };
      }
      if (isDiceProfileUrl(newUrl) || isMarketingOrCorporateUrl(newUrl) || !isPlausibleApplyDestination(newUrl)) {
        await chrome.tabs.remove(fresh.id).catch(() => {});
        knownTabIds.add(fresh.id);
        continue;
      }
      if (isUrlOnApplySite(prevUrl, "indeed") && !isUrlOnApplySite(newUrl, "indeed")) {
        await chrome.tabs.remove(fresh.id).catch(() => {});
        knownTabIds.add(fresh.id);
        continue;
      }

      const orig = await chrome.tabs.get(tabId).catch(() => null);
      const origUrl = orig?.url || "";
      if (orig?.id && normalizeUrlForMatch(origUrl) !== normalizeUrlForMatch(newUrl)) {
        await navigateTabToUrl(tabId, newUrl);
      } else {
        await waitForPageReady(tabId).catch(() => {});
      }
      await chrome.tabs.remove(fresh.id).catch(() => {});
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      return { advanced: true, tabId, reason: "merged_new_tab" };
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id) return { advanced: false, tabId, reason: "tab_gone" };

    if (tab.url && prevUrl && tab.url !== prevUrl) {
      // Reject accidental navigations to About / Corporate / marketing pages.
      if (isMarketingOrCorporateUrl(tab.url)) {
        await navigateTabToUrl(tabId, prevUrl).catch(() => {});
        return { advanced: false, tabId, reason: "rejected_marketing_nav" };
      }
      // If we left a known ATS host for a clearly non-apply URL, undo and keep looking.
      try {
        const prevHost = new URL(prevUrl).hostname.toLowerCase();
        const nextHost = new URL(tab.url).hostname.toLowerCase();
        const leftKnownAts =
          isAllowedApplyNavUrl(prevUrl) ||
          /(^|\.)(dice\.com|greenhouse\.io|myworkdayjobs\.com|workdayjobs\.com|indeed\.com|smartrecruiters\.com|oraclecloud\.com|builtin\.com)$/i.test(
            prevHost
          );
        if (leftKnownAts && nextHost !== prevHost && !isPlausibleApplyDestination(tab.url)) {
          await navigateTabToUrl(tabId, prevUrl).catch(() => {});
          return { advanced: false, tabId, reason: "rejected_offsite_nav" };
        }
      } catch {
        /* ignore */
      }
      try {
        await waitForPageReady(tabId);
      } catch {
        await sleepMs(500);
      }
      return { advanced: true, tabId, reason: "url_change" };
    }

    try {
      await ensureAutofillScript(tabId);
      const snap = await sendMessageToTab(tabId, { type: "get_apply_action" }, { attempts: 1 });
      if (snap?.signature && prevSig && snap.signature !== prevSig) {
        await sleepMs(300);
        return { advanced: true, tabId, reason: "dom_change" };
      }
      // Also check iframes for signature change
      const all = await getApplyActionFromTab(tabId);
      if (all.signature && prevSig && all.signature !== prevSig) {
        await sleepMs(300);
        return { advanced: true, tabId, reason: "frame_dom_change" };
      }
    } catch {
      /* page may be mid-navigation */
    }

    // Nothing moved and the page isn't even loading — stop waiting on a dead click.
    if (Date.now() > noReactionDeadline && tab.status !== "loading") {
      return { advanced: false, tabId, reason: "no_reaction" };
    }
  }
  return { advanced: false, tabId, reason: "timeout" };
}

async function openApplyUrlInNewTab(url, openerTabId = null) {
  const href = String(url || "").trim();
  if (!isHttpUrl(href)) return null;
  const createOpts = { url: href, active: true };
  if (openerTabId != null) {
    const opener = await chrome.tabs.get(openerTabId).catch(() => null);
    if (opener?.windowId != null) createOpts.windowId = opener.windowId;
    if (opener?.index != null) createOpts.index = opener.index + 1;
  }
  const tab = await chrome.tabs.create(createOpts);
  if (!tab?.id) return null;
  await waitForPageReady(tab.id).catch(() => {});
  return tab.id;
}

/**
 * After Auto Apply marks a job submitted, mirror the job-card "Applied" action
 * (status + optional Google Sheet "Applied" update).
 */
async function finalizeImportedJobAsApplied(importedJobId, {
  profileId = "",
  jobMeta = {},
  site = "",
  detail = ""
} = {}) {
  await setImportedJobStatus(importedJobId, {
    status: "completed",
    statusDetail: detail || "Application submitted.",
    profileId,
    completedAt: Date.now()
  });

  await appendApplicationEvent({
    profileId,
    importedJobId,
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || "",
    jdLink: jobMeta.jdLink || "",
    status: "completed",
    source: site || "",
    detail: detail || "Application submitted."
  });

  let sheetNote = "";
  try {
    const stored = await chrome.storage.local.get([
      "track_application_status",
      "spreadsheet_url",
      "sheets_web_app_url",
      "sheets_sheet_name"
    ]);
    const track =
      jobMeta.trackApplicationStatus === true || stored.track_application_status === true;
    const spreadsheetUrl = String(jobMeta.spreadsheetUrl || stored.spreadsheet_url || "").trim();
    const webAppUrl = String(jobMeta.sheetsWebAppUrl || stored.sheets_web_app_url || "").trim();
    const sheetName = String(jobMeta.sheetName || stored.sheets_sheet_name || "").trim();
    const jdLink = String(jobMeta.jdLink || "").trim();
    if (track && spreadsheetUrl && webAppUrl && jdLink) {
      await updateJobStatusInSpreadsheet({
        spreadsheetUrl,
        webAppUrl,
        sheetName,
        jdLink,
        applicationStatus: "Applied"
      });
      sheetNote = " Sheet status → Applied.";
    }
  } catch (err) {
    sheetNote = ` Sheet status update failed: ${String(err?.message || err)}`;
  }
  return sheetNote;
}

/**
 * Open a job URL, ensure resume PDFs, run Auto Apply, and mark status.
 * Used by single Apply and Batch Apply.
 */
async function runApplyImportedJobCore(
  importedJobId,
  profileId,
  jobMeta = {},
  { allowGenerate = true, progressLabel = "" } = {}
) {
  const prefix = progressLabel ? `${progressLabel}: ` : "";
  await setStatus(`${prefix}Opening job URL...`);
  await setImportedJobStatus(importedJobId, {
    status: "opening",
    statusDetail: `${prefix}Opening job URL...`,
    markAttempt: true,
    profileId
  });

  const url = String(jobMeta.jdLink || "").trim();
  if (!url) {
    throw new Error("Missing job URL (jdLink).");
  }

  let tabId;
  const existingTab = await findTabByUrl(url);
  if (existingTab?.id != null) {
    tabId = existingTab.id;
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    if (existingTab.windowId != null) {
      await chrome.windows.update(existingTab.windowId, { focused: true }).catch(() => {});
    }
    await waitForPageReady(tabId, 12000);
  } else {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab?.id;
    if (!tabId) throw new Error("Failed to open browser tab.");
    await waitForPageReady(tabId, 12000);
  }

  await dismissCookieBannersEarly(tabId);

  try {
    // Poll on client-rendered boards — a closed/expired banner can land after the
    // first paint, and this is the last gate before a resume is generated.
    const { closed, probe: availProbe } = await probeJobUnavailableOnTab(tabId, { url });
    if (closed) {
      const detail = await markImportedJobUnavailable(importedJobId, closed, { profileId });
      await setStatus(`${prefix}Job closed — skipped, marked on the job card: ${detail}`);
      return { ok: true, status: "unavailable", detail, site: "" };
    }
    if (availProbe?.alreadyApplied) {
      const site = detectSiteFromUrl(url);
      await finalizeImportedJobAsApplied(importedJobId, {
        profileId,
        jobMeta,
        site,
        detail: availProbe.alreadyApplied
      });
      await setStatus(`${prefix}Already applied — skipped.`);
      return {
        ok: true,
        status: "already_applied",
        detail: availProbe.alreadyApplied,
        site
      };
    }
  } catch {
    /* best-effort */
  }

  await chrome.storage.local.set({
    selected_profile_id: profileId,
    selected_template_id: jobMeta.templateId || DEFAULT_TEMPLATE_ID,
    last_job_title: jobMeta.jobTitle || "",
    last_company_name: jobMeta.companyName || "",
    last_jd_link: jobMeta.jdLink || "",
    last_jd_text: jobMeta.jdText || "",
    spreadsheet_url: jobMeta.spreadsheetUrl || "",
    sheets_sheet_name: jobMeta.sheetName || "",
    sheets_web_app_url: jobMeta.sheetsWebAppUrl || ""
  });

  const liveJob = (await getImportedJobsById())[importedJobId];
  let uploadDocs = await ensureUploadDocsForImportedJob(importedJobId, liveJob);

  if (uploadDocs?.resume?.base64 || uploadDocs?.coverLetter?.base64) {
    const resumeName = uploadDocs.resume?.fileName || "resume";
    const coverName = uploadDocs.coverLetter?.fileName
      ? ` + ${uploadDocs.coverLetter.fileName}`
      : "";
    await setStatus(`${prefix}Using saved files: ${resumeName}${coverName}`);
    await setImportedJobStatus(importedJobId, {
      status: "opening_form",
      statusDetail: `${prefix}Resume ready — opening application form...`
    });
  } else if (extractFolderNameFromSaveMeta(liveJob?.resumeFolder || "")) {
    throw new Error(
      "A resume was generated for this job, but the saved PDFs could not be loaded from the output folder. Click in the extension panel to unlock the folder, then Apply again."
    );
  } else if (!allowGenerate) {
    throw new Error("No resume ready for this job. Run Batch resume build first, then Batch Apply.");
  } else {
    const resumeOnlyStored =
      (await chrome.storage.local.get("generate_resume_only")).generate_resume_only === true;
    const trackStored =
      (await chrome.storage.local.get("track_application_status")).track_application_status === true;
    const genMeta = {
      ...jobMeta,
      resumeOnly: resumeOnlyStored,
      trackApplicationStatus: jobMeta.trackApplicationStatus === true || trackStored,
      importedJobId,
      previewMode: false
    };
    await setImportedJobStatus(importedJobId, {
      status: "generating",
      statusDetail: resumeOnlyStored
        ? `${prefix}Generating resume only...`
        : `${prefix}Generating resume & cover letter...`
    });
    await setStatus(`${prefix}Generating resume...`);
    const saved = await runGenerationPipeline({ profileId, jobMeta: genMeta });
    uploadDocs = saved?.docs || (await getGeneratedDocsForJob(importedJobId));
    await setImportedJobStatus(importedJobId, {
      status: "opening_form",
      statusDetail: `${prefix}Waiting for the job page, then Auto Apply...`,
      patch: {
        hasGeneratedResume: true,
        resumeFolder: saved?.folderName || "",
        resumeFileName: saved?.resumeFileName || "",
        coverLetterFileName: saved?.coverLetterFileName || ""
      }
    });
  }

  const liveTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!liveTab?.id) {
    throw new Error("The job tab was closed before Auto Apply could start.");
  }
  tabId = liveTab.id;
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  await waitForPageReady(tabId, 8000);
  await dismissCookieBannersEarly(tabId);
  const site = detectSiteFromUrl(liveTab.url || url);

  try {
    await ensureAutofillScript(tabId);
    const probe = await sendMessageToTab(tabId, { type: "probe_application_form" }, { attempts: 2 });
    if (probe?.jobUnavailable) {
      const detail = await markImportedJobUnavailable(importedJobId, probe.jobUnavailable, {
        profileId
      });
      await setStatus(`${prefix}Job closed — skipped, marked on the job card: ${detail}`);
      return { ok: true, status: "unavailable", detail, site };
    }
  } catch {
    /* best-effort */
  }

  uploadDocs =
    (await ensureUploadDocsForImportedJob(
      importedJobId,
      (await getImportedJobsById())[importedJobId]
    )) || uploadDocs;
  if (!uploadDocs?.resume?.base64 && !uploadDocs?.coverLetter?.base64) {
    throw new Error(
      "No resume/cover letter PDFs are ready for this job. Generate a resume first, then Apply."
    );
  }

  const loc = await formatUploadDocsLocation(uploadDocs);
  await setImportedJobStatus(importedJobId, {
    status: "filling",
    statusDetail: loc.summary
      ? `${prefix}Uploading ${loc.summary} and filling the form (${site})...`
      : `${prefix}Running Auto Apply (${site})...`
  });
  await setStatus(
    loc.summary
      ? `${prefix}Uploading from ${loc.summary} onto ${site}...`
      : `${prefix}Running Auto Apply (${site})...`
  );

  const ea = await startMultiStepApplyOnTab(profileId, tabId, {
    maxSteps: 14,
    uploadDocs,
    closeOnSuccess: isAutoSubmitAllowedSite(site),
    preferNewTab: site === "dice"
  });
  if (!ea.ok && ea.error) throw new Error(ea.error);

  if (ea.status === "unavailable") {
    const detail = await markImportedJobUnavailable(importedJobId, ea.detail || "unavailable", {
      profileId
    });
    await setStatus(`${prefix}Job closed — skipped, marked on the job card: ${detail}`);
    return { ok: true, status: "unavailable", detail, site };
  }

  if (ea.status === "already_applied") {
    await finalizeImportedJobAsApplied(importedJobId, {
      profileId,
      jobMeta,
      site,
      detail: ea.detail || "Already applied on Dice."
    });
    await setStatus(`${prefix}Already applied — skipped.`);
    return {
      ok: true,
      status: "already_applied",
      detail: ea.detail || "Already applied on Dice.",
      site
    };
  }

  if (ea.status === "skipped") {
    await setImportedJobStatus(importedJobId, {
      status: "needs_review",
      statusDetail: `${prefix}Auto Apply (${site}): skipped. ${ea.detail || ""}`.trim(),
      profileId
    });
    await appendApplicationEvent({
      profileId,
      importedJobId,
      jobTitle: jobMeta.jobTitle || "",
      companyName: jobMeta.companyName || "",
      jdLink: jobMeta.jdLink || url || "",
      status: "needs_review",
      source: site,
      detail: ea.detail || "skipped"
    });
    await setStatus(`${prefix}Skipped: ${ea.detail || "external apply"}.`);
    return {
      ok: true,
      status: "skipped",
      detail: ea.detail || "skipped",
      site
    };
  }

  if (ea.status === "submitted") {
    const sheetNote = await finalizeImportedJobAsApplied(importedJobId, {
      profileId,
      jobMeta,
      site,
      detail:
        `Auto Apply (${site}): submitted. ` +
        `Steps ${ea.steps || 0}, filled ${ea.filled || 0}, uploaded ${ea.uploaded || 0}. ` +
        `${ea.detail || ""}`.trim()
    });
    await setStatus(
      `${prefix}Applied.${isAutoSubmitAllowedSite(site) ? " Success tab closed." : ""} ${sheetNote} ${await getCostSummaryText()}`.trim()
    );
    return {
      ok: true,
      status: "submitted",
      detail: ea.detail || "submitted",
      site,
      sheetNote,
      steps: ea.steps || 0
    };
  }

  const nextStatus = ea.status === "needs_review" ? "needs_review" : "ready_for_review";
  await setImportedJobStatus(importedJobId, {
    status: nextStatus,
    statusDetail:
      `${prefix}Auto Apply (${site}): ${ea.status || "done"}. ` +
      `Steps ${ea.steps || 0}, filled ${ea.filled || 0}, uploaded ${ea.uploaded || 0}, ` +
      `bank ${ea.bankHits || 0}, AI ${ea.aiFilled || 0}, choices ${ea.choiceFilled || 0}. ` +
      `${ea.detail || ""} ${(await getCostSummaryText())}`.trim(),
    profileId
  });
  await appendApplicationEvent({
    profileId,
    importedJobId,
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || "",
    jdLink: jobMeta.jdLink || url || "",
    status: nextStatus,
    source: site,
    detail: ea.detail || ""
  });
  await setStatus(`${prefix}Auto Apply: ${ea.status || "done"}. ${await getCostSummaryText()}`);
  return {
    ok: true,
    status: nextStatus,
    detail: ea.detail || ea.status || "done",
    site,
    steps: ea.steps || 0
  };
}

/**
 * Universal multi-step Auto Apply: fill → Next if no Submit →
 * wait for next page/tab → refill. Dice clicks Submit and closes after
 * confirmation. Other ATS stop on the Submit page so you can review, then
 * click Submit in Ocean — the tab is never closed on a timeout.
 */
async function startMultiStepApplyOnTab(
  profileId,
  tabId = null,
  { maxSteps = 14, uploadDocs = null, closeOnSuccess = false, preferNewTab = false } = {}
) {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await getCurrentApplicationTab();
  if (!tab?.id) {
    return { ok: false, error: "No application tab found. Open the job application page first." };
  }
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return { ok: false, error: "The current tab is not a web page. Open the job page, then run Auto Apply." };
  }

  await waitForPageReady(tab.id, 12000);
  await dismissCookieBannersEarly(tab.id);

  let currentTabId = tab.id;
  const originTabId = tab.id;
  const initialSite = detectSiteFromUrl(tab.url);
  let liveSite = initialSite;
  const site = initialSite;
  const stepBudgetInit = stepBudgetForSite(initialSite, maxSteps);
  let stepBudget = stepBudgetInit;
  const useNewTab = preferNewTab || initialSite === "dice" || isGatewaySite(initialSite);
  const autoClickSubmit = isAutoSubmitAllowedSite(initialSite);
  // Dice only: close the success wizard tab after Submit. Keep the job page open.
  // Other sites never close the current tab.
  const mayCloseTabs = Boolean(closeOnSuccess && autoClickSubmit);
  // Resolve the PDFs ONCE, against the job page we start on, and reuse them for
  // every step. Later steps land on an ATS URL that no longer matches the job
  // posting, so re-resolving mid-run could fall back to another job's files.
  const runUploadDocs = uploadDocs || (await resolveUploadDocsForTab(tab.id)).docs;
  const loc = await formatUploadDocsLocation(runUploadDocs);
  await ensureCostSession(tab.url || "");
  const summary = {
    ok: true,
    site,
    steps: 0,
    filled: 0,
    uploaded: 0,
    aiFilled: 0,
    answered: 0,
    choiceFilled: 0,
    bankHits: 0,
    status: "",
    detail: "",
    tabId: currentTabId,
    tabUrl: tab.url || "",
    originTabId
  };

  let noAdvance = 0;
  let workdayStepHint = "";
  let greenhouseSubmitAt = 0;
  let didClickSubmit = false;
  let lookedForEntry = false;
  let rebudgetedForLiveSite = false;
  // Buttons the AI already picked this run, so a dead end is never clicked twice.
  const aiButtonTried = new Set();
  let aiButtonPicks = 0;

  for (let step = 0; step < stepBudget; step += 1) {
    assertNotCancelled();
    const liveNow = await chrome.tabs.get(currentTabId).catch(() => null);
    liveSite = detectSiteFromUrl(liveNow?.url || summary.tabUrl);
    // A gateway (Jobright/Jobgether) hands off to an employer ATS with its own
    // step count — grow the budget once to fit the real destination.
    if (
      !rebudgetedForLiveSite &&
      isGatewaySite(initialSite) &&
      liveSite !== initialSite &&
      !isGatewaySite(liveSite)
    ) {
      if (initialSite === "builtin") {
        await setStatus(
          `Auto Apply (Built In): external ATS (${applySiteLabel(liveSite)}) — continuing with application form...`
        );
      }
      stepBudget = stepBudgetForSite(liveSite, stepBudget);
      rebudgetedForLiveSite = true;
    }
    if (initialSite === "indeed" && liveNow?.url && !isUrlOnApplySite(liveNow.url, "indeed")) {
      summary.status = "skipped";
      summary.detail =
        "Indeed redirected to an external ATS. Automatic filling and submission stopped.";
      summary.tabId = currentTabId;
      return summary;
    }
    const activeSite =
      rebudgetedForLiveSite && liveSite !== initialSite && !isGatewaySite(liveSite)
        ? liveSite
        : initialSite;
    const stepLabel = workdayStepHint
      ? `${applySiteLabel(activeSite)} · ${workdayStepHint}`
      : applySiteLabel(activeSite);
    await setStatus(`Auto Apply (${stepLabel}): step ${step + 1}/${stepBudget} — checking page...`);
    await ensureAutofillScript(currentTabId);

    let probe = await getApplyActionFromTab(currentTabId).catch(() => ({
      best: null,
      anyForm: false,
      blockedReason: "",
      jobUnavailable: "",
      applicationSuccess: "",
      applyUrls: [],
      signature: "",
      href: ""
    }));

    // After the application form/modal is open, only clear cookie banners —
    // never dismiss/close controls (that was closing Easy Apply modals).
    await dismissPageOverlays(currentTabId, {
      rounds: 1,
      cookiesOnly: Boolean(probe.anyForm)
    });
    if (probe.anyForm) {
      // Re-probe after cookie handling in case the form settled.
      probe = await getApplyActionFromTab(currentTabId).catch(() => probe);
    }

    if (probe.applicationSuccess && didClickSubmit) {
      if (mayCloseTabs) {
        await setStatus("Application succeeded — closing Dice success tab...");
        await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
      }
      summary.status = "submitted";
      summary.detail = probe.applicationSuccess;
      summary.tabId = mayCloseTabs ? originTabId : currentTabId;
      return summary;
    }

    if (probe.alreadyApplied) {
      summary.status = "already_applied";
      summary.detail = probe.alreadyApplied;
      summary.tabId = currentTabId;
      return summary;
    }

    if (probe.jobUnavailable) {
      summary.status = "unavailable";
      summary.detail = probe.jobUnavailable;
      summary.tabId = currentTabId;
      return summary;
    }

    if (probe.workdayWizard) {
      workdayStepHint = probe.workdayWizard.current || workdayStepHint;
      const detected = Number(probe.workdayWizard.stepCount || 0);
      if (detected > 0) {
        const adaptive = Math.min(22, Math.max(detected + 5, 8));
        if (adaptive < stepBudget) stepBudget = adaptive;
      }
    }

    if (probe.emailVerification && liveSite === "greenhouse") {
      const otp = await completeGreenhouseEmailVerification(currentTabId, {
        afterEpochMs: greenhouseSubmitAt || Date.now() - 15_000
      });
      if (otp.ok) {
        if (didClickSubmit) {
          if (mayCloseTabs) {
            await setStatus("Application succeeded — closing Dice success tab...");
            await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
          }
          summary.status = "submitted";
          summary.detail = otp.detail;
          summary.tabId = mayCloseTabs ? originTabId : currentTabId;
          return summary;
        }
        continue;
      }
      summary.status = "needs_review";
      summary.detail = otp.detail;
      summary.tabId = currentTabId;
      return summary;
    }

    // Dice final step: wait 1s on the Submit page, click Submit, then close wizard tabs.
    // If required fields are still empty, fall through to fill first.
    if (
      site === "dice" &&
      autoClickSubmit &&
      (probe.diceSubmitPage || probe.best?.action?.type === "submit") &&
      !probe.needsFill &&
      !probe.uploadsBusy
    ) {
      if (probe.uploadsBusy) {
        for (let wait = 0; wait < 15 && probe.uploadsBusy; wait += 1) {
          await setStatus("Auto Apply: waiting for upload before Submit...");
          await sleepMs(500);
          probe = await getApplyActionFromTab(currentTabId).catch(() => probe);
          if (probe.applicationSuccess) break;
        }
      }
      if (!probe.applicationSuccess) {
        for (let i = 0; i < 15 && probe.best?.action?.type !== "submit"; i += 1) {
          await setStatus("Auto Apply: on Submit page — waiting for button...");
          await sleepMs(400);
          probe = await getApplyActionFromTab(currentTabId).catch(() => probe);
          if (probe.applicationSuccess) break;
        }
      }
      if (probe.applicationSuccess && didClickSubmit) {
        if (mayCloseTabs) {
          await setStatus("Application succeeded — closing Dice success tab...");
          await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
        }
        summary.status = "submitted";
        summary.detail = probe.applicationSuccess;
        summary.tabId = mayCloseTabs ? originTabId : currentTabId;
        return summary;
      }
      if (probe.best?.action?.type === "submit") {
        didClickSubmit = true;
        const clickLabel = probe.best.action.text || "Submit";
        const clickRes = await clickSubmitOnTab(currentTabId, {
          frameId: probe.best.frameId,
          clickLabel,
          settleMs: 1000
        });
        if (clickRes?.externalRedirect && initialSite !== "builtin") {
          summary.status = "skipped";
          summary.detail =
            "Indeed Apply opens an external ATS. Automatic filling and submission stopped.";
          summary.tabId = currentTabId;
          return summary;
        }
        if (!(clickRes?.clicked || clickRes?.navigateUrl || clickRes?.isSubmit)) {
          await markReadyToSubmit(
            (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || ""
          );
          summary.status = "needs_review";
          summary.detail =
            "Could not click Submit. The application tab was left open so you can finish.";
          summary.tabId = currentTabId;
          return summary;
        }
        if (clickRes?.navigateUrl) {
          if (
            isMarketingOrCorporateUrl(clickRes.navigateUrl) ||
            !isPlausibleApplyDestination(clickRes.navigateUrl)
          ) {
            await markReadyToSubmit(
              (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || ""
            );
            summary.status = "needs_review";
            summary.detail =
              "Submit pointed at a non-application page — left the tab open so you can finish.";
            summary.tabId = currentTabId;
            return summary;
          }
          await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
        }
        const finished = await finishSubmittedApplication(currentTabId, {
          closeOnSuccess: mayCloseTabs,
          clickLabel,
          originTabId
        });
        summary.status = finished.status;
        summary.detail = finished.detail;
        summary.tabId = finished.tabId;
        summary.steps = step + 1;
        return summary;
      }
    }

    // Not on a form yet: click Easy Apply / Apply only (never ads / Cancel / profile).
    if (!probe.anyForm) {
      const allowedApplyUrl = (probe.applyUrls || []).find(
        (u) => isAllowedApplyNavUrl(u) && !isDiceProfileUrl(u)
      );
      if (
        probe.best?.action?.type !== "entry" &&
        !allowedApplyUrl &&
        !probe.alreadyApplied &&
        !probe.jobUnavailable
      ) {
        if (!lookedForEntry) {
          await setStatus(`Auto Apply (${stepLabel}): waiting briefly for Apply...`);
          probe = await waitBrieflyForApplyEntry(currentTabId, APPLY_ENTRY_WAIT_MS);
          lookedForEntry = true;
        }
        if (probe.alreadyApplied || probe.jobUnavailable || probe.anyForm) {
          continue;
        }
        const retryUrl = (probe.applyUrls || []).find(
          (u) => isAllowedApplyNavUrl(u) && !isDiceProfileUrl(u)
        );
        if (probe.best?.action?.type !== "entry" && !retryUrl) {
          // No recognisable Apply button ("I'm interested", "Apply for this job"...):
          // let AI read the page's buttons before giving up on this job.
          if (aiButtonPicks < 3 && !probe.blockedReason) {
            aiButtonPicks += 1;
            const beforeAiUrl =
              (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || "";
            const ai = await tryAiApplyButton(currentTabId, {
              stage: "entry",
              preferNewTab: useNewTab,
              gateway: isGatewaySite(liveSite),
              tried: aiButtonTried
            });
            if (ai.advanced) {
              currentTabId = ai.tabId;
              summary.tabId = currentTabId;
              summary.tabUrl =
                (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl;
              summary.steps = step + 1;
              lookedForEntry = false;
              if (isDiceProfileUrl(summary.tabUrl) || isMarketingOrCorporateUrl(summary.tabUrl)) {
                if (isMarketingOrCorporateUrl(summary.tabUrl) && beforeAiUrl) {
                  await navigateTabToUrl(currentTabId, beforeAiUrl).catch(() => {});
                }
                summary.status = "needs_review";
                summary.detail = isMarketingOrCorporateUrl(summary.tabUrl)
                  ? `AI clicked "${ai.text}" and opened a company About / Corporate page instead of Apply.`
                  : `AI clicked "${ai.text}" and landed on Dice Profile instead of the application.`;
                return summary;
              }
              continue;
            }
          }
          summary.status = "skipped";
          summary.detail =
            probe.blockedReason ||
            "No Apply / Easy Apply button on this page — continuing.";
          summary.tabId = currentTabId;
          return summary;
        }
      }

      const live = await chrome.tabs.get(currentTabId).catch(() => null);
      const prevUrl = live?.url || "";
      const prevSig = probe.signature || "";
      const applyUrl =
        (probe.applyUrls || []).find((u) => isAllowedApplyNavUrl(u) && !isDiceProfileUrl(u)) ||
        allowedApplyUrl;

      if (probe.best?.action?.type === "entry") {
        await setStatus(`Auto Apply: clicking ${probe.best.action.text || "Apply"}...`);
        const clickRes = await sendMessageToTab(
          currentTabId,
          { type: "click_apply_action", preferredType: "entry", preferNewTab: useNewTab },
          { attempts: 2, frameId: probe.best.frameId }
        );
        if (clickRes?.externalRedirect && initialSite !== "builtin") {
          summary.status = "skipped";
          summary.detail =
            "Indeed Apply opens an external ATS. Automatic filling and submission stopped.";
          summary.tabId = currentTabId;
          return summary;
        }
        if (clickRes?.navigateUrl && isDiceProfileUrl(clickRes.navigateUrl)) {
          summary.status = "needs_review";
          summary.detail =
            "Dice tried to open Profile instead of Apply. Click the teal Apply button in the job detail panel, then run Auto Apply again.";
          return summary;
        }
        if (clickRes?.navigateUrl && isAllowedApplyNavUrl(clickRes.navigateUrl)) {
          if (useNewTab || clickRes.openInNewTab) {
            const newId = await openApplyUrlInNewTab(clickRes.navigateUrl, currentTabId);
            if (newId) {
              currentTabId = newId;
              summary.tabId = currentTabId;
              summary.tabUrl = clickRes.navigateUrl;
              summary.steps = step + 1;
              lookedForEntry = false;
              continue;
            }
          }
          await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
        }
      } else if (applyUrl) {
        await setStatus(
          useNewTab
            ? "Auto Apply: opening the application page in a new tab..."
            : "Auto Apply: opening the application page..."
        );
        if (useNewTab) {
          const newId = await openApplyUrlInNewTab(applyUrl, currentTabId);
          if (newId) {
            currentTabId = newId;
            summary.tabId = currentTabId;
            summary.tabUrl = applyUrl;
            summary.steps = step + 1;
            lookedForEntry = false;
            continue;
          }
        }
        await navigateTabToUrl(currentTabId, applyUrl);
        lookedForEntry = false;
      } else {
        summary.status = "skipped";
        summary.detail =
          probe.blockedReason ||
          "No Apply / Easy Apply button on this page — continuing.";
        summary.tabId = currentTabId;
        return summary;
      }

      const advanced = await waitForApplyAdvance(currentTabId, prevSig, prevUrl, 10000, {
        preferNewTab: useNewTab,
        gateway: isGatewaySite(liveSite)
      });
      currentTabId = advanced.tabId;
      summary.tabId = currentTabId;
      summary.tabUrl = (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl;
      lookedForEntry = !advanced.advanced;

      // Mis-click on the avatar lands on /profile — stop instead of continuing there.
      if (isDiceProfileUrl(summary.tabUrl)) {
        summary.status = "needs_review";
        summary.detail =
          "Landed on Dice Profile instead of the application. The extension will only click the teal Apply button in the job detail panel — try Apply again.";
        return summary;
      }

      summary.steps = step + 1;
      continue;
    }

    if (probe.blockedReason && !probe.anyForm) {
      let credNote = "";
      try {
        const credentials = await getAccountCredentials();
        if (credentials.email || credentials.username || credentials.password) {
          const credRes = await sendMessageToTab(
            currentTabId,
            { type: "autofill_credentials", credentials },
            { attempts: 2 }
          );
          if (Number(credRes?.filledCount || 0) > 0) {
            credNote = ` Saved login prefilled (${(credRes.filled || []).join(", ")}) — sign in, then run Auto Apply again.`;
          }
        }
      } catch {
        /* best-effort */
      }
      summary.status = "needs_review";
      summary.detail = probe.blockedReason + credNote;
      summary.tabId = currentTabId;
      return summary;
    }

    await setStatus(
      loc.summary
        ? `Auto Apply (${stepLabel}): step ${step + 1}/${stepBudget} — uploading ${loc.summary}...`
        : `Auto Apply (${stepLabel}): step ${step + 1}/${stepBudget} — filling form...`
    );
    const fillRes = await startAutofillOnCurrentPage(profileId, currentTabId, { uploadDocs: runUploadDocs });
    if (fillRes?.skipped && step === 0) {
      return { ok: false, error: fillRes.error || "Autofill skipped.", ...summary, status: "failed" };
    }
    if (Number(fillRes?.uploadedCount || 0) > 0 && loc.summary) {
      await setStatus(`Uploaded ${loc.summary} (${fillRes.uploadedCount} file(s)). Filling remaining fields...`);
    }
    summary.filled += Number(fillRes?.filledCount || 0);
    summary.uploaded += Number(fillRes?.uploadedCount || 0);
    summary.aiFilled += Number(fillRes?.aiFilledCount || 0);
    summary.choiceFilled += Number(fillRes?.choiceFilledCount || 0);
    summary.bankHits += Number(fillRes?.bankHits || 0);
    summary.answered += Number(fillRes?.aiFilledCount || 0);
    summary.steps = step + 1;
    summary.tabId = currentTabId;
    summary.tabUrl = (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl;

    if (Number(fillRes?.uploadedCount || 0) > 0) {
      // Dice: 0.5s then Next. Other ATS: short beat to accept the PDF.
      await sleepMs(500);
    }

    probe = await getApplyActionFromTab(currentTabId).catch(() => ({
      best: null,
      anyForm: false,
      applicationSuccess: "",
      needsFill: false,
      uploadsBusy: false
    }));

    // Do not click Next while the step still has empty fields or an in-flight upload
    // (Dice shows "Leave site?" and can bounce to profile/settings).
    // Skip this when Submit is already on the page — Dice will auto-submit;
    // other ATS pause so you can review and click Submit in Ocean.
    if (
      (probe.uploadsBusy || probe.needsFill) &&
      probe.best?.action?.type !== "submit" &&
      !probe.diceSubmitPage
    ) {
      // Dice upload page: one short recheck only — do not spin for seconds.
      const maxWaits = site === "dice" ? 1 : 12;
      const waitMs = site === "dice" ? 500 : 500;
      for (let wait = 0; wait < maxWaits; wait += 1) {
        await sleepMs(waitMs);
        if (probe.needsFill && !probe.uploadsBusy) {
          await setStatus("Auto Apply: finishing remaining fields before Next...");
          const again = await startAutofillOnCurrentPage(profileId, currentTabId, { uploadDocs: runUploadDocs });
          summary.filled += Number(again?.filledCount || 0);
          summary.uploaded += Number(again?.uploadedCount || 0);
          summary.aiFilled += Number(again?.aiFilledCount || 0);
          summary.choiceFilled += Number(again?.choiceFilledCount || 0);
          summary.bankHits += Number(again?.bankHits || 0);
        } else if (site !== "dice") {
          await setStatus("Auto Apply: waiting for file upload to finish...");
        }
        probe = await getApplyActionFromTab(currentTabId).catch(() => probe);
        if (probe.applicationSuccess || probe.best?.action?.type === "submit") break;
        if (!probe.uploadsBusy && !probe.needsFill) break;
      }
    }

    // Dice: only poll for Submit when we are on the final step (or no Next yet).
    // On the upload page Next is already available — do not wait multi-seconds for Submit.
    if (
      site === "dice" &&
      !probe.applicationSuccess &&
      !probe.needsFill &&
      probe.best?.action?.type !== "submit" &&
      probe.best?.action?.type !== "next" &&
      probe.best?.action?.type !== "review"
    ) {
      for (let i = 0; i < 8; i += 1) {
        await sleepMs(400);
        const again = await getApplyActionFromTab(currentTabId).catch(() => null);
        if (!again) continue;
        probe = again;
        if (
          again.applicationSuccess ||
          again.best?.action?.type === "submit" ||
          again.best?.action?.type === "next" ||
          again.diceSubmitPage
        ) {
          break;
        }
        if (again.uploadsBusy) continue;
      }
    }

    if (probe.applicationSuccess && didClickSubmit) {
      if (mayCloseTabs) {
        await setStatus("Application succeeded — closing Dice success tab...");
        await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
      }
      summary.status = "submitted";
      summary.detail = probe.applicationSuccess;
      summary.tabId = mayCloseTabs ? originTabId : currentTabId;
      return summary;
    }

    if (probe.uploadsBusy) {
      summary.status = "needs_review";
      summary.detail =
        "File upload is still in progress on this page. Wait for the resume/cover letter to finish uploading, then run Auto Apply again.";
      return summary;
    }

    // Dice: never advance while custom / unanswered fields remain. Notify and stop
    // so the user can fill them, then click Apply again.
    if (site === "dice" && !probe.applicationSuccess) {
      const onSubmitStep =
        probe.diceSubmitPage || probe.best?.action?.type === "submit";
      if (!onSubmitStep) {
        const openFields = await collectUnansweredApplicationFields(currentTabId, profileId);
        if (openFields.count > 0) {
          const pause = dicePauseForUnansweredFields(openFields, { beforeSubmit: false });
          await setStatus(pause.detail);
          summary.status = pause.status;
          summary.detail = pause.detail;
          summary.tabId = currentTabId;
          return summary;
        }
        if (probe.needsFill) {
          summary.status = "needs_review";
          summary.detail =
            "Stopped before Next — empty fields remain on this Dice step. Fill them on the page, then click Apply again.";
          await setStatus(summary.detail);
          summary.tabId = currentTabId;
          return summary;
        }
      } else if (probe.needsFill) {
        const openFields = await collectUnansweredApplicationFields(currentTabId, profileId);
        const pause = dicePauseForUnansweredFields(
          openFields.count
            ? openFields
            : { count: 1, detail: "required fields still empty" },
          { beforeSubmit: true }
        );
        await setStatus(pause.detail);
        summary.status = pause.status;
        summary.detail = pause.detail;
        summary.tabId = currentTabId;
        return summary;
      }
    }

    // Dice last page: Submit may appear a beat after fill. Keep polling briefly
    // instead of stopping with "ready for review". Workday Review prefers Submit.
    // Skip when Next/Continue is already the right action (e.g. upload step).
    if (
      (!probe.best || probe.best.action?.type !== "submit") &&
      (site === "dice" || liveSite === "workday") &&
      probe.anyForm &&
      probe.best?.action?.type !== "next" &&
      probe.best?.action?.type !== "review"
    ) {
      await setStatus(
        liveSite === "workday"
          ? "Auto Apply: waiting for Submit on the Workday Review step..."
          : "Auto Apply: waiting for Submit on the last page..."
      );
      for (let i = 0; i < 8; i += 1) {
        await sleepMs(liveSite === "workday" ? 450 + 100 * i : 400);
        probe = await getApplyActionFromTab(currentTabId).catch(() => probe);
        if (probe.applicationSuccess || probe.best?.action?.type === "submit") break;
        if (probe.best?.action?.type === "next" || probe.best?.action?.type === "review") break;
        if (liveSite === "workday" && probe.best && !probe.workdayWizard?.isReview) break;
      }
    }

    if (!probe.best) {
      // The step is filled but no button reads like Next / Continue / Submit.
      // Let AI pick the one that continues; a Submit pick stops for review.
      if (probe.anyForm && aiButtonPicks < 3) {
        aiButtonPicks += 1;
        const ai = await tryAiApplyButton(currentTabId, {
          stage: "next",
          gateway: isGatewaySite(liveSite),
          tried: aiButtonTried
        });
        if (ai.advanced) {
          currentTabId = ai.tabId;
          summary.tabId = currentTabId;
          summary.tabUrl =
            (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl;
          noAdvance = 0;
          continue;
        }
        if (ai.submitCandidate) {
          await markReadyToSubmit(
            (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || ""
          );
          summary.status = "ready_for_review";
          summary.detail = `Filled the form. "${ai.text}" looks like the final submit button — review the form, then click Submit in Ocean.`;
          summary.tabId = currentTabId;
          return summary;
        }
      }
      summary.status = probe.anyForm ? "ready_for_review" : "needs_review";
      summary.detail = probe.anyForm
        ? "Filled the form. No Next/Submit button detected — please review and submit."
        : "No application form or action button found on this page.";
      return summary;
    }

    if (probe.best.action.type === "submit") {
      const clickLabel = probe.best.action.text || "Submit";
      if (!autoClickSubmit) {
        return pauseAtSubmitForReview(currentTabId, summary, clickLabel);
      }
      didClickSubmit = true;
      greenhouseSubmitAt = Date.now();
      const clickRes = await clickSubmitOnTab(currentTabId, {
        frameId: probe.best.frameId,
        clickLabel,
        settleMs: site === "dice" ? 1000 : liveSite === "workday" ? 800 : 400
      });
      if (clickRes?.externalRedirect && initialSite !== "builtin") {
        summary.status = "skipped";
        summary.detail =
          "Indeed Apply opens an external ATS. Automatic filling and submission stopped.";
        summary.tabId = currentTabId;
        return summary;
      }
      if (!(clickRes?.clicked || clickRes?.navigateUrl || clickRes?.isSubmit)) {
        await markReadyToSubmit(
          (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || ""
        );
        summary.status = "needs_review";
        summary.detail =
          "Could not click Submit. The application tab was left open so you can finish.";
        summary.tabId = currentTabId;
        return summary;
      }
      if (clickRes?.navigateUrl) {
        if (
          isMarketingOrCorporateUrl(clickRes.navigateUrl) ||
          !isPlausibleApplyDestination(clickRes.navigateUrl)
        ) {
          await markReadyToSubmit(
            (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl || ""
          );
          summary.status = "needs_review";
          summary.detail =
            "Submit pointed at a non-application page — left the tab open so you can finish.";
          summary.tabId = currentTabId;
          return summary;
        }
        await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
      }
      const finished = await finishSubmittedApplication(currentTabId, {
        closeOnSuccess: mayCloseTabs,
        clickLabel,
        originTabId
      });
      summary.status = finished.status;
      summary.detail = finished.detail;
      summary.tabId = finished.tabId;
      return summary;
    }

    // Next / Continue / Review on the application form only.
    const live = await chrome.tabs.get(currentTabId).catch(() => null);
    const prevUrl = live?.url || "";
    const prevSig = probe.signature || "";
    const actionType = probe.best.action.type;

    // Dice: never click carousel Next on the final Submit/review step.
    if (site === "dice" && (probe.diceSubmitPage || actionType === "submit")) {
      continue;
    }

    if (actionType !== "next" && actionType !== "review") {
      summary.status = "ready_for_review";
      summary.detail = `Filled the form. Unexpected action "${probe.best.action.text || actionType}".`;
      return summary;
    }

    await setStatus(`Autofill: clicking ${probe.best.action.text || actionType}...`);
    let clickRes = await sendMessageToTab(
      currentTabId,
      { type: "click_apply_action", preferredType: actionType },
      { attempts: 2, frameId: probe.best.frameId }
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));

    if (clickRes?.deferred === "uploads-busy") {
      await setStatus("Auto Apply: upload still running — waiting before Next...");
      await sleepMs(500);
      clickRes = await sendMessageToTab(
        currentTabId,
        { type: "click_apply_action", preferredType: actionType },
        { attempts: 2, frameId: probe.best.frameId }
      ).catch((err) => clickRes || { ok: false, error: String(err?.message || err) });
      if (clickRes?.deferred === "uploads-busy") {
        summary.status = "needs_review";
        summary.detail =
          "Could not click Next because the cover letter/resume upload was still finishing.";
        return summary;
      }
    }

    if (clickRes?.externalRedirect && initialSite !== "builtin") {
      summary.status = "skipped";
      summary.detail =
        "Indeed Apply opens an external ATS. Automatic filling and submission stopped.";
      summary.tabId = currentTabId;
      return summary;
    }

    if (clickRes?.isSubmit) {
      didClickSubmit = true;
      greenhouseSubmitAt = Date.now();
      const finished = await finishSubmittedApplication(currentTabId, {
        closeOnSuccess: mayCloseTabs,
        clickLabel: probe.best.action.text || "Submit",
        originTabId
      });
      summary.status = finished.status;
      summary.detail = finished.detail;
      summary.tabId = finished.tabId;
      return summary;
    }
    if (clickRes?.navigateUrl && isPlausibleApplyDestination(clickRes.navigateUrl)) {
      if (useNewTab || clickRes.openInNewTab) {
        const newId = await openApplyUrlInNewTab(clickRes.navigateUrl, currentTabId);
        if (newId) currentTabId = newId;
        else await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
      } else {
        await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
      }
    }

    const advanced = await waitForApplyAdvance(currentTabId, prevSig, prevUrl, 15000, {
      preferNewTab: useNewTab,
      gateway: isGatewaySite(liveSite)
    });
    currentTabId = advanced.tabId;
    summary.tabId = currentTabId;
    summary.tabUrl = (await chrome.tabs.get(currentTabId).catch(() => null))?.url || summary.tabUrl;

    if (isMarketingOrCorporateUrl(summary.tabUrl)) {
      if (prevUrl) await navigateTabToUrl(currentTabId, prevUrl).catch(() => {});
      summary.status = "needs_review";
      summary.detail =
        "Stopped a navigation to a company About / Corporate page (not an application step).";
      return summary;
    }

    if (isDiceProfileUrl(summary.tabUrl)) {
      summary.status = "needs_review";
      summary.detail =
        "Navigation hit Dice Profile instead of the next application step. Stopped so your profile page is left alone.";
      return summary;
    }

    if (initialSite === "indeed" && summary.tabUrl && !isUrlOnApplySite(summary.tabUrl, "indeed")) {
      summary.status = "skipped";
      summary.detail =
        "Indeed redirected to an external ATS. Automatic filling and submission stopped.";
      return summary;
    }

    const afterAdvance = await getApplyActionFromTab(currentTabId).catch(() => null);
    if (afterAdvance?.applicationSuccess && didClickSubmit) {
      if (mayCloseTabs) {
        await setStatus("Application succeeded — closing Dice success tab...");
        await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
      }
      summary.status = "submitted";
      summary.detail = afterAdvance.applicationSuccess;
      summary.tabId = mayCloseTabs ? originTabId : currentTabId;
      return summary;
    }

    if (afterAdvance?.emailVerification && detectSiteFromUrl(summary.tabUrl) === "greenhouse") {
      const otp = await completeGreenhouseEmailVerification(currentTabId, {
        afterEpochMs: greenhouseSubmitAt || Date.now() - 15_000
      });
      if (otp.ok) {
        if (didClickSubmit) {
          if (mayCloseTabs) {
            await setStatus("Application succeeded — closing Dice success tab...");
            await closeApplyFlowTabs({ currentTabId, originTabId, delayMs: 1000 });
          }
          summary.status = "submitted";
          summary.detail = otp.detail;
          summary.tabId = mayCloseTabs ? originTabId : currentTabId;
          return summary;
        }
        continue;
      }
      summary.status = "needs_review";
      summary.detail = otp.detail;
      return summary;
    }

    if (initialSite === "indeed" && summary.tabUrl && !isUrlOnApplySite(summary.tabUrl, "indeed")) {
      summary.status = "skipped";
      summary.detail =
        "Indeed redirected to an external ATS. Automatic filling and submission stopped.";
      return summary;
    }

    if (advanced.advanced) {
      noAdvance = 0;
    } else {
      noAdvance += 1;
      if (noAdvance >= 2) {
        summary.status = "needs_review";
        summary.detail =
          "Could not advance past this step (a required field or validation likely needs your input).";
        return summary;
      }
    }
  }

  summary.status = "ready_for_review";
  summary.detail = "Reached the step limit; please review the remaining steps.";
  return summary;
}

/**
 * Drive a multi-step "Easy Apply" flow on a tab (Dice / Jobright / any ATS).
 * Uses the universal SW loop so iframe ATS forms and new-tab applies work.
 */
async function startEasyApplyOnTab(profileId, tabId = null) {
  return startMultiStepApplyOnTab(profileId, tabId, { maxSteps: 14 });
}

/**
 * Answer a single pasted application question using JD + resume + profile.
 * Used when autofill cannot detect/fill a field on the page.
 */
async function answerManualApplicationQuestion(profileId, questionText) {
  const question = String(questionText || "").trim();
  if (!question) {
    return { ok: false, error: "Paste a form question first." };
  }
  if (!profileId) {
    return { ok: false, error: "Select a profile first." };
  }

  const applicantInfo = await getApplicantInfo(profileId);
  const stored = await chrome.storage.local.get([
    "last_job_title",
    "last_company_name",
    "last_jd_text",
    "last_response",
    "last_application_brief"
  ]);

  const answers = await resolveTextAnswers({
    questions: [
      {
        id: "manual_q1",
        label: question.slice(0, 1000),
        multiline: question.length > 80 || /\?/.test(question)
      }
    ],
    applicantInfo,
    jobMeta: {
      jobTitle: stored.last_job_title || "",
      companyName: stored.last_company_name || "",
      jdText: stored.last_jd_text || ""
    },
    resumeText: stored.last_response || "",
    profileId,
    applicationBrief: stored.last_application_brief || null
  });

  const answer = String(answers[0]?.answer || "").trim();
  if (!answer) {
    return { ok: false, error: "OpenAI returned an empty answer." };
  }
  return { ok: true, answer };
}

const pendingDownloadPaths = new Map(); // downloadId -> relative path under Downloads

function normalizeDownloadRelativePath(filename) {
  return String(filename || "")
    .replace(/\\/g, "/")
    .replace(/^[/]+/, "")
    .replace(/\/+/g, "/");
}

function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      pendingDownloadPaths.delete(downloadId);
      if (err) reject(err);
      else resolve(downloadId);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Download timed out (id ${downloadId}).`));
    }, timeoutMs);

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        finish();
        return;
      }
      if (delta.state?.current === "interrupted") {
        finish(new Error(`Download interrupted (id ${downloadId}).`));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }).then((items) => {
      const item = items?.[0];
      if (!item) return;
      if (item.state === "complete") finish();
      if (item.state === "interrupted") finish(new Error(`Download interrupted (id ${downloadId}).`));
    }).catch(() => {});
  });
}

async function downloadDataUrl(url, filename) {
  const relativePath = normalizeDownloadRelativePath(filename);
  if (!relativePath) {
    throw new Error("Download path is empty.");
  }

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename: relativePath,
        saveAs: false,
        conflictAction: "overwrite"
      },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (id == null) {
          reject(new Error("Download failed to start."));
          return;
        }
        pendingDownloadPaths.set(id, relativePath);
        resolve(id);
      }
    );
  });

  await waitForDownloadComplete(downloadId);
  return downloadId;
}

// Keep files under Downloads/{output}/{role}-{company}/… and create folders via path.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const forced = pendingDownloadPaths.get(item.id);
  const name = normalizeDownloadRelativePath(forced || item.filename);
  suggest({
    filename: name,
    conflictAction: "overwrite"
  });
});

function sanitizePathSegment(value, fallback = "untitled") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 140)
    .trim();
  return cleaned || fallback;
}

function joinDownloadPath(...parts) {
  return parts
    .map((part) => String(part || "").replace(/^\/+|\/+$/g, "").replace(/\\/g, "/"))
    .filter(Boolean)
    .join("/");
}

const RESUME_FOLDER_SEQ_KEY = "resume_folder_seq";

function firstNameFromPerson(personName) {
  const parts = String(personName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts[0] || "Candidate";
}

async function nextResumeFolderId() {
  const stored = await chrome.storage.local.get(RESUME_FOLDER_SEQ_KEY);
  const next = Math.max(1, Number(stored[RESUME_FOLDER_SEQ_KEY] || 0) + 1);
  await chrome.storage.local.set({ [RESUME_FOLDER_SEQ_KEY]: next });
  return next;
}

/** Job folder: {id} - {first name} - {company} - {role} */
async function buildJobFolderName(jobMeta = {}, personName = "") {
  const id = await nextResumeFolderId();
  const first = sanitizePathSegment(firstNameFromPerson(personName), "Candidate");
  const company = sanitizePathSegment(jobMeta.companyName || "Company", "Company");
  const role = sanitizePathSegment(jobMeta.jobTitle || "Role", "Role");
  return sanitizePathSegment(`${id} - ${first} - ${company} - ${role}`, `${id} - Candidate - Company - Role`);
}

function buildJdTxtContent({ jobTitle, companyName, jdLink, jdText }) {
  return [
    `Job Title: ${jobTitle || ""}`,
    `Company: ${companyName || ""}`,
    `JD Link: ${jdLink || ""}`,
    "",
    "---",
    "",
    jdText || ""
  ].join("\n");
}

function enforceHeaderStructure(html) {
  if (/<h1[\s\S]*?<\/h1>/i.test(html) && /class\s*=\s*["'][^"']*contact[^"']*["']/i.test(html)) {
    return html;
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return html;
  const bodyContent = bodyMatch[1];

  const blocks = Array.from(
    bodyContent.matchAll(/<(p|div|h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/gi)
  ).map((m) => ({ full: m[0], text: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));

  const meaningful = blocks.filter((b) => b.text);
  if (!meaningful.length) return html;

  const nameText = meaningful[0].text;
  const contactText = meaningful[1]?.text || "";

  let updatedBody = bodyContent;
  updatedBody = updatedBody.replace(meaningful[0].full, "");
  if (meaningful[1]) updatedBody = updatedBody.replace(meaningful[1].full, "");

  const headerHtml = `<div class="top"><h1>${nameText}</h1><p class="contact">${contactText}</p></div>`;
  const rebuilt = `${headerHtml}${updatedBody}`;

  return html.replace(/<body[^>]*>[\s\S]*?<\/body>/i, (m) =>
    m.replace(bodyMatch[1], rebuilt)
  );
}

function splitCombinedRoleHeadlines(html) {
  // Convert:
  // Senior Software Engineer | Uniqcli | Aug 2022 - Present | Chicago Ridge, United States
  // into:
  // Uniqcli Aug 2022 - Present
  // Senior Software Engineer Chicago Ridge, United States
  const pattern =
    /(^|>)([^<\n|]+?)\s*\|\s*([^<\n|]+?)\s*\|\s*([A-Za-z]{3}\s+\d{4}\s*-\s*(?:Present|[A-Za-z]{3}\s+\d{4}))\s*\|\s*([^<\n]+?)(?=<|$)/gim;

  return html.replace(pattern, (_m, prefix, title, company, dates, location) => {
    const c = company.trim();
    const d = dates.trim();
    const t = title.trim();
    const l = location.trim();
    return `${prefix}<p class="role-company">${c} | ${d}</p><p class="role-meta">${t}${
      l ? ` | ${l}` : ""
    }</p>`;
  });
}

function boldSkillsSection(html) {
  const headingPattern = /<h[1-6][^>]*>\s*SKILLS\s*<\/h[1-6]>/i;
  if (!headingPattern.test(html)) return html;

  return html.replace(
    /(<h[1-6][^>]*>\s*SKILLS\s*<\/h[1-6]>\s*)([\s\S]*?)(?=<h[1-6][^>]*>|\s*$)/i,
    (_m, heading, sectionBody) => {
      const updated = sectionBody
        .replace(/<li([^>]*)>([\s\S]*?)<\/li>/gi, (_li, attrs, content) => {
          if (/<strong[\s>]/i.test(content)) return `<li${attrs}>${content}</li>`;
          return `<li${attrs}><strong>${content.trim()}</strong></li>`;
        })
        .replace(/<p([^>]*)>([\s\S]*?)<\/p>/gi, (_p, attrs, content) => {
          const textOnly = content.replace(/<[^>]+>/g, "").trim();
          if (!textOnly) return `<p${attrs}>${content}</p>`;
          if (/<strong[\s>]/i.test(content)) return `<p${attrs}>${content}</p>`;
          return `<p${attrs}><strong>${content.trim()}</strong></p>`;
        });
      return `${heading}${updated}`;
    }
  );
}

function normalizeBulletSentence(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return clean;

  const sentence = clean.split(/(?<=[.!?])\s+/)[0].trim();
  let oneSentence = sentence.replace(/[.!?]+$/, "");

  if (oneSentence.length < 170) {
    oneSentence +=
      ", while ensuring production reliability, maintainable architecture, and stable delivery across real-world business workflows";
  }

  if (oneSentence.length > 250) {
    oneSentence = oneSentence.slice(0, 250).replace(/\s+\S*$/, "");
  }

  return `${oneSentence}.`;
}

function enforceBulletLengthAndSentence(html) {
  return html.replace(/<li([^>]*)>([\s\S]*?)<\/li>/gi, (_m, attrs, inner) => {
    const content = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!content) return `<li${attrs}>${inner}</li>`;
    const normalized = normalizeBulletSentence(content);
    return `<li${attrs}>${normalized}</li>`;
  });
}

function enforceA4PrintCss(html) {
  const css = `
@page { size: A4; margin: 10mm; }
html, body { width: 210mm; }
body {
  font-family: "Times New Roman", Times, serif !important;
  font-size: 10.8pt !important;
  line-height: 1.18 !important;
}
h1 {
  text-align: center !important;
  font-size: 22.5pt !important;
  margin: 0 0 3px 0 !important;
}
.top, .header, .contact {
  text-align: center !important;
}
.top { margin-bottom: 5px !important; }
.top .contact { margin: 0 0 2px 0 !important; }
h2, .section-title {
  margin-top: 9px !important;
  margin-bottom: 4px !important;
  padding-bottom: 2px !important;
}
h3, .role-company {
  margin-top: 7px !important;
  margin-bottom: 2px !important;
}
.role-meta {
  margin-top: 0 !important;
  margin-bottom: 6px !important;
}
p, li {
  margin-top: 0 !important;
  margin-bottom: 2.6px !important;
  line-height: 1.18 !important;
  text-align: left !important;
}
ul { margin-top: 0 !important; margin-bottom: 6px !important; }
li { margin-bottom: 3px !important; }
h2 + p, h2 + ul, h2 + div, h2 + h3 { margin-top: 3px !important; }
h2 + p.education { margin-top: 1.15em !important; }
p.education + p.education { margin-top: 5px !important; }
h3 + p, h3 + ul, .role-meta + p { margin-top: 3px !important; }
.role-meta + ul { margin-top: 10px !important; }
a, a:visited {
  color: #1155cc !important;
  text-decoration: underline !important;
}
`;
  if (/<style[\s\S]*@page\s*\{[\s\S]*size\s*:\s*A4/i.test(html)) {
    return html.replace(/<\/head>/i, `<style>${css}</style></head>`);
  }

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (match) => `${match}<style>${css}</style>`);
  }

  return `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`;
}

function debuggerAttach(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function debuggerDetach(debuggee) {
  return new Promise((resolve) => {
    chrome.debugger.detach(debuggee, () => resolve());
  });
}

function debuggerCommand(debuggee, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function detectPdfPaperFromHtml(html) {
  const blob = String(html || "");
  if (/size\s*:\s*Letter/i.test(blob) || /width:\s*8\.5in/i.test(blob)) {
    return { paperWidth: 8.5, paperHeight: 11, format: "letter" };
  }
  return { paperWidth: 8.27, paperHeight: 11.69, format: "a4" };
}

async function htmlToPdfBase64(html) {
  const htmlText = String(html || "");
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(htmlText)}`;
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Failed to create render tab.");
  const tabId = tab.id;

  try {
    await awaitTabComplete(tabId);
    await sleepMs(250);
    const debuggee = { tabId };
    await debuggerAttach(debuggee);
    try {
      await debuggerCommand(debuggee, "Page.enable");
      const paper = detectPdfPaperFromHtml(htmlText);
      const printParams = {
        printBackground: true,
        paperWidth: paper.paperWidth,
        paperHeight: paper.paperHeight,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
        preferCSSPageSize: true
      };
      let result;
      try {
        result = await debuggerCommand(debuggee, "Page.printToPDF", {
          ...printParams,
          generateTaggedPDF: true,
          generateDocumentOutline: true
        });
      } catch {
        result = await debuggerCommand(debuggee, "Page.printToPDF", printParams);
      }
      if (!result?.data) throw new Error("PDF generation failed.");
      // #region agent log
      fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
        body: JSON.stringify({
          sessionId: "df7ed5",
          runId: "post-fix",
          hypothesisId: "F",
          location: "sw.js:htmlToPdfBase64",
          message: "PDF render succeeded",
          data: {
            pdfMethod: "printToPDF",
            paperFormat: paper.format,
            printMargins: "css-only",
            pdfBase64Length: String(result.data || "").length,
            htmlHasExperiencePageBreak: /section\.experience[\s\S]*page-break-before\s*:\s*always/i.test(
              htmlText
            ),
            htmlHasPdfBodyPadding: /html\[data-ocean-pdf="1"\]\s*body[\s\S]*padding:\s*0/i.test(
              htmlText
            )
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion
      return result.data;
    } finally {
      await debuggerDetach(debuggee);
    }
  } catch (err) {
    const error = String(err?.message || err);
    // #region agent log
    fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
      body: JSON.stringify({
        sessionId: "df7ed5",
        runId: "post-fix",
        hypothesisId: "F",
        location: "sw.js:htmlToPdfBase64",
        message: "PDF render failed",
        data: { pdfMethod: "printToPDF", error },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    throw err;
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // tab may already be closed
    }
  }
}

// MV3 service workers have no URL.createObjectURL / Blob URL support,
// so all downloads use data: URLs, which chrome.downloads.download accepts.
function downloadTextFile(text, mimeType, filename) {
  const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(String(text || ""))}`;
  return downloadDataUrl(url, filename);
}

function downloadBase64File(base64, mimeType, filename) {
  const url = `data:${mimeType};base64,${base64}`;
  return downloadDataUrl(url, filename);
}

async function buildResumeFileBundle(rawText, resumeData, jobMeta = {}) {
  const templateId = jobMeta.templateId || DEFAULT_TEMPLATE_ID;
  const html = resumeJsonToHtml(resumeData, templateId, { forPdf: true });
  // #region agent log
  fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
    body: JSON.stringify({
      sessionId: "df7ed5",
      runId: "pre-fix",
      hypothesisId: "A",
      location: "sw.js:buildResumeFileBundle",
      message: "resume HTML built for PDF",
      data: {
        templateId,
        htmlLength: String(html || "").length,
        hasOceanPdfAttr: /data-ocean-pdf\s*=\s*["']1["']/i.test(String(html || "")),
        hasScreenCardCss: /@media\s+screen[\s\S]*html:not\(\[data-ocean-pdf/i.test(String(html || "")),
        hasExperienceForcedPageBreak: /section\.experience[\s\S]*page-break-before\s*:\s*always/i.test(
          String(html || "")
        ),
        hasSectionFlowCss: /section[\s\S]*break-inside:\s*auto/i.test(String(html || ""))
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion
  const pdfBase64 = await htmlToPdfBase64(html);

  const personName = String(resumeData?.name || "").trim() || "Candidate";
  // A resave targets the folder this job already owns; only a first save takes
  // the next id in the sequence.
  const reuseFolder = extractFolderNameFromSaveMeta(jobMeta.overwriteFolderName || "");
  const folderName = reuseFolder || (await buildJobFolderName(jobMeta, personName));
  const resumeFileBase = sanitizePathSegment(personName.replace(/\s+/g, "_") || "Resume", "Resume");

  const jdTxt = buildJdTxtContent({
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || "",
    jdLink: jobMeta.jdLink || "",
    jdText: jobMeta.jdText || ""
  });

  const files = [
    { name: "jd.txt", mimeType: "text/plain", encoding: "utf8", content: jdTxt },
    {
      name: `${resumeFileBase}_Resume.html`,
      mimeType: "text/html",
      encoding: "utf8",
      content: html
    },
    {
      name: `${resumeFileBase}_Resume.pdf`,
      mimeType: "application/pdf",
      encoding: "base64",
      content: pdfBase64
    }
  ];

  try {
    await chrome.storage.local.set({
      last_response: String(rawText || "").slice(0, 200000),
      last_resume_json: resumeData,
      last_output_dir: folderName
    });
  } catch {
    // ignore
  }

  return { folderName, resumeFileBase, files, personName };
}

async function addCoverLetterToBundle(files, rawCoverText, contact = {}) {
  const html = markHtmlForPdf(buildCoverLetterHtml(rawCoverText, contact));
  const pdfBase64 = await htmlToPdfBase64(html);
  files.push({
    name: "Cover_Letter.pdf",
    mimeType: "application/pdf",
    encoding: "base64",
    content: pdfBase64
  });
  try {
    await chrome.storage.local.set({
      last_cover_letter_response: String(rawCoverText || "").slice(0, 100000)
    });
  } catch {
    // ignore
  }
}

/** Fallback when no user folder is selected: Downloads/{folderName}/... */
async function saveBundleViaDownloads(folderName, files) {
  let lastDownloadId = null;
  for (const file of files) {
    const rel = joinDownloadPath(folderName, file.name);
    if (file.encoding === "base64") {
      lastDownloadId = await downloadBase64File(
        file.content,
        file.mimeType || "application/octet-stream",
        rel
      );
    } else {
      lastDownloadId = await downloadTextFile(
        file.content,
        file.mimeType || "text/plain",
        rel
      );
    }
  }
  const pathLabel = `Downloads / ${folderName}`;
  await setLastSaveMeta({
    pathLabel,
    method: "downloads",
    folderName,
    downloadId: lastDownloadId
  });
  return { pathLabel, downloadId: lastDownloadId, method: "downloads" };
}

async function showSaveNotification(pathLabel) {
  try {
    await chrome.notifications.create(`save-${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/ocean-icon.svg"),
      title: "Resume files saved",
      message: pathLabel || "Files saved successfully.",
      priority: 1,
      requireInteraction: false,
      buttons: [{ title: "Open folder" }]
    });
  } catch {
    // Notifications may be blocked or icon unsupported; in-panel UI still shows.
  }
}

async function openSavedFolderFromMeta(meta) {
  if (!meta) throw new Error("Nothing has been saved yet.");

  if (meta.method === "downloads" && meta.downloadId != null) {
    try {
      chrome.downloads.show(Number(meta.downloadId));
      return { ok: true, method: "downloads" };
    } catch (err) {
      throw new Error(String(err?.message || err) || "Could not open Downloads folder.");
    }
  }

  // FS saves: ask the panel to browse the stored job directory handle.
  try {
    const res = await chrome.runtime.sendMessage({ type: "open_saved_folder_fs" });
    if (res?.ok) return res;
    throw new Error(res?.error || "Could not open the saved folder.");
  } catch (err) {
    throw new Error(
      String(err?.message || err) || "Open the extension panel and click Open folder."
    );
  }
}

async function notifyPanelToFlushOutput() {
  try {
    return await chrome.runtime.sendMessage({ type: "flush_pending_output" });
  } catch {
    return null;
  }
}

async function notifyPanelToLoadJobDocs(folderName, jobId) {
  try {
    return await chrome.runtime.sendMessage({
      type: "load_job_upload_docs",
      folderName,
      jobId
    });
  } catch {
    return null;
  }
}

function extractFolderNameFromSaveMeta(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Prefer a bare folder name; path labels look like "Root / folder".
  if (!raw.includes("/") && !raw.includes("\\")) return sanitizeJobFolderName(raw);
  const parts = raw.split(/[/\\]/).map((p) => p.trim()).filter(Boolean);
  return sanitizeJobFolderName(parts[parts.length - 1] || "");
}

/**
 * Resolve resume/cover letter PDFs for an imported job:
 * 1) per-job IndexedDB cache
 * 2) files saved under the job's output folder
 * 3) panel-assisted folder read (permission gesture)
 */
async function ensureUploadDocsForImportedJob(jobId, job = null) {
  const id = String(jobId || "").trim();
  if (!id) return null;

  let docs = await getGeneratedDocsForJob(id);
  if (docs?.resume?.base64 || docs?.coverLetter?.base64) {
    await activateGeneratedDocsForJob(id);
    const rootLabel = (await getOutputDirectoryName()) || "";
    if (!docs.pathLabel && (rootLabel || docs.folderName)) {
      docs = await stampDocsPath(
        docs,
        rootLabel && docs.folderName ? `${rootLabel} / ${docs.folderName}` : docs.folderName || rootLabel,
        id
      );
    }
    return docs;
  }

  const folderName = extractFolderNameFromSaveMeta(job?.resumeFolder || job?.folderName || "");
  if (!folderName) return null;

  await setStatus(`Loading saved resume/cover letter from ${folderName}...`);

  try {
    docs = await readJobUploadDocsFromDirectory(folderName, { interactive: false });
  } catch (err) {
    if (err?.code !== "NEEDS_PERMISSION") {
      docs = null;
    } else {
      try {
        await ensurePanelVisible();
      } catch {
        /* panel may already be open */
      }
      const panelRes = await notifyPanelToLoadJobDocs(folderName, id);
      if (panelRes?.ok && (panelRes.docs?.resume || panelRes.docs?.coverLetter)) {
        docs = panelRes.docs;
      } else if (panelRes?.needsPermission) {
        throw new Error(
          "Click once in the extension panel to unlock the output folder, then click Apply again."
        );
      }
    }
  }

  if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) {
    // One more try via panel even when SW read returned empty (permission/path issues).
    try {
      await ensurePanelVisible();
    } catch {
      /* ignore */
    }
    const panelRes = await notifyPanelToLoadJobDocs(folderName, id);
    if (panelRes?.ok) docs = panelRes.docs;
    if (panelRes?.needsPermission) {
      throw new Error(
        "Click once in the extension panel to unlock the output folder, then click Apply again."
      );
    }
  }

  if (!docs?.resume?.base64 && !docs?.coverLetter?.base64) return null;

  const rootLabel = (await getOutputDirectoryName()) || "";
  docs = {
    ...docs,
    pathLabel:
      docs.pathLabel ||
      (rootLabel && docs.folderName ? `${rootLabel} / ${docs.folderName}` : docs.folderName || rootLabel)
  };
  await setGeneratedDocsForJob(id, docs);
  await activateGeneratedDocsForJob(id);
  return docs;
}

/**
 * Chrome will not grant folder access without a user gesture, so focus the panel
 * and wait for the click that unlocks it. The panel writes the pending files as
 * soon as that happens and clears pending_fs_write.
 */
async function waitForPanelFolderUnlock(rootLabel, folderName, timeoutMs = 120000) {
  try {
    await ensurePanelVisible();
  } catch {
    /* panel may already be open */
  }

  await setStatus(
    `Folder access needed to finish saving ${folderName}. Click Unlock in the extension panel` +
      `${rootLabel ? ` (${rootLabel})` : ""} — choose Allow on every visit if Chrome offers it.`
  );

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const stillPending = (await chrome.storage.local.get("pending_fs_write")).pending_fs_write;
    if (!stillPending) {
      const pathLabel = `${rootLabel || "Selected folder"} / ${folderName}`;
      await showSaveNotification(pathLabel);
      return pathLabel;
    }
  }

  return "";
}

/**
 * Silent save into the user-selected PC folder only (File System Access API).
 * Does NOT use chrome.downloads — that triggers Save As dialogs when Chrome
 * is set to "Ask where to save each file".
 */
async function commitOutputBundle(folderName, files, { importedJobId = "" } = {}) {
  let docs = null;
  try {
    docs = pickUploadDocsFromBundle(folderName, files);
    if (importedJobId) {
      await setGeneratedDocsForJob(importedJobId, docs);
    } else {
      await setLastGeneratedDocs(docs);
    }
  } catch {
    // Upload cache should not block saving.
  }

  const hasHandle = Boolean(await getOutputDirectoryHandle());
  const rootLabel = (await getOutputDirectoryName()) || "";

  if (!hasHandle) {
    throw new Error(
      'No output folder selected. Click "Select folder" in the extension, then generate again.'
    );
  }

  await setPendingOutputFiles({ folderName, files });
  await setStatus(`Saving to ${rootLabel || "selected folder"} / ${folderName} ...`);

  // Ensure the panel is available so it can write with the directory handle.
  // Respect sidebar vs window — do not pop a window if the user is in sidebar.
  try {
    await ensurePanelVisible();
  } catch {
    /* panel may already be open */
  }
  await new Promise((r) => setTimeout(r, 350));

  let lastError = "";
  let pathLabel = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const flushResult = await notifyPanelToFlushOutput();
    if (flushResult?.ok) {
      pathLabel = flushResult.pathLabel || `${rootLabel} / ${folderName}`;
      await showSaveNotification(pathLabel);
      docs = await stampDocsPath(docs, pathLabel, importedJobId);
      return { pathLabel, folderName, docs };
    }

    if (flushResult?.needsPermission) {
      pathLabel = await waitForPanelFolderUnlock(rootLabel, folderName);
      if (pathLabel) {
        docs = await stampDocsPath(docs, pathLabel, importedJobId);
        return { pathLabel, folderName, docs };
      }
      lastError =
        "Chrome needs one click in the extension panel to unlock the output folder.";
      break;
    }

    lastError = flushResult?.error || "Panel did not confirm the save.";
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  const stillPending = (await chrome.storage.local.get("pending_fs_write")).pending_fs_write;
  if (!stillPending) {
    pathLabel = `${rootLabel || "Selected folder"} / ${folderName}`;
    await showSaveNotification(pathLabel);
    docs = await stampDocsPath(docs, pathLabel, importedJobId);
    return { pathLabel, folderName, docs };
  }

  throw new Error(
    `Could not save into the selected folder (${lastError}). The files are still queued — click "Grant access" in the extension panel to finish writing them.`
  );
}

async function saveResumeAndCoverLetter(
  output,
  resumeData,
  jobMeta,
  { apiKey, model, runCoverLetter = true, profileId = "" } = {}
) {
  assertNotCancelled();
  await setStatus("Rendering resume from JSON...");
  const bundle = await buildResumeFileBundle(output, resumeData, jobMeta);
  const { folderName, resumeFileBase, files } = bundle;
  let coverLetterCreated = false;
  let coverLetterWarning = "";

  if (runCoverLetter) {
    try {
      await setStatus("Resume ready. Generating cover letter via OpenAI...");
      const coverPrompt = await buildCoverLetterPrompt({
        jdText: jobMeta.jdText || "",
        jobTitle: jobMeta.jobTitle || "",
        companyName: jobMeta.companyName || "",
        // Candidate info lives on the resume profile, not the CoverLetter one.
        profileId
      });
      const coverResult = await chatCompletion({
        apiKey,
        model,
        messages: [
          {
            role: "system",
            content:
              "You write professional cover letters as plain text only. No markdown fences, no HTML, no subject line."
          },
          { role: "user", content: coverPrompt }
        ],
        jsonMode: false
      });
      const coverOutput = coverResult?.content || "";
      if (!coverOutput) throw new Error("Empty cover letter response.");
      await logLlmCall({
        purpose: "cover_letter",
        model,
        inputTokens: coverResult.usage?.prompt_tokens,
        outputTokens: coverResult.usage?.completion_tokens
      });
      await setStatus("Rendering cover letter PDF...");
      await addCoverLetterToBundle(files, coverOutput, {
        name: resumeData?.name,
        headline: resumeData?.headline,
        location: resumeData?.location,
        email: resumeData?.email,
        phone: resumeData?.phone,
        linkedin: resumeData?.linkedin
      });
      coverLetterCreated = true;
    } catch (coverErr) {
      coverLetterWarning = `, but cover letter failed: ${String(coverErr?.message || coverErr)}`;
    }
  } else {
    try {
      await chrome.storage.local.remove("last_cover_letter_response");
    } catch {
      // ignore
    }
  }

  const saved = await commitOutputBundle(folderName, files, {
    importedJobId: jobMeta?.importedJobId || ""
  });
  const savedDir = saved?.pathLabel || "";
  const docs = saved?.docs || pickUploadDocsFromBundle(folderName, files);
  let status = `Saved to ${savedDir} (${resumeFileBase}_Resume.pdf${
    coverLetterCreated ? " + Cover_Letter.pdf" : ""
  } + jd.txt + HTML)${coverLetterWarning}`;

  if ((jobMeta.spreadsheetUrl || jobMeta.sheetsWebAppUrl) && !jobMeta.skipSheetAppend) {
    assertNotCancelled();
    await setStatus("Appending row to Google Sheet...");
    try {
      const sheetResult = await appendJobToSpreadsheet({
        spreadsheetUrl: jobMeta.spreadsheetUrl,
        webAppUrl: jobMeta.sheetsWebAppUrl,
        sheetName: jobMeta.sheetName || "",
        jobTitle: jobMeta.jobTitle,
        companyName: jobMeta.companyName,
        jdLink: jobMeta.jdLink,
        salaryMin: jobMeta.salaryMin || "",
        salaryMax: jobMeta.salaryMax || "",
        applicationStatus: jobMeta.trackApplicationStatus ? "Resume Generated" : ""
      });
      const sheetLabel = sheetResult.sheetName
        ? `"${sheetResult.sheetName}" row ${sheetResult.row}`
        : `row ${sheetResult.row}`;
      status = `${status} and appended to Google Sheet (${sheetLabel})`;
    } catch (sheetErr) {
      status = `${status}, but sheet append failed: ${String(sheetErr?.message || sheetErr)}`;
    }
  }

  return {
    savedDir,
    status,
    folderName,
    docs,
    resumeFileName: docs?.resume?.fileName || `${resumeFileBase}_Resume.pdf`,
    coverLetterFileName: docs?.coverLetter?.fileName || (coverLetterCreated ? "Cover_Letter.pdf" : "")
  };
}

async function ensureResumeSkills(data, { apiKey, model, jdText = "" } = {}) {
  assertNotCancelled();
  const normalized = normalizeSkills(data?.skills);
  if (hasRenderableSkills(normalized, 3)) {
    data.skills = normalized;
    return data;
  }

  await setStatus("Skills section empty — regenerating skills...");
  const skillsResult = await chatCompletion({
    apiKey,
    model,
    messages: [
      {
        role: "system",
        content:
          'Return ONLY JSON: {"skills":[{"category":"","items":""}]}. ' +
          "Produce 6–9 dense skill categories tailored to the job description and resume. " +
          "Each items value must be a long comma-separated list of technologies/tools."
      },
      {
        role: "user",
        content:
          `Job description:\n${String(jdText || "").slice(0, 8000)}\n\n` +
          `Resume JSON (for context):\n${JSON.stringify(
            {
              name: data?.name,
              headline: data?.headline,
              profile: data?.profile,
              experience: (data?.experience || []).map((j) => ({
                company: j?.company,
                title: j?.title,
                project: j?.project
              }))
            },
            null,
            2
          )}`
      }
    ],
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 4096
  });

  await logLlmCall({
    purpose: "resume-skills-repair",
    model,
    inputTokens: skillsResult.usage?.prompt_tokens,
    outputTokens: skillsResult.usage?.completion_tokens
  });

  const repaired = extractResumeJson(skillsResult?.content || "");
  const repairedSkills = normalizeSkills(repaired?.skills);
  if (!hasRenderableSkills(repairedSkills, 3)) {
    throw new Error(
      "Resume Skills section was empty and could not be regenerated. Try generating again."
    );
  }
  data.skills = repairedSkills;
  return data;
}

async function runGenerationPipeline({ profileId, jobMeta }) {
  const { apiKey, model } = await getOpenAiSettings();
  const meta = jobMeta || {};
  if (!meta._availabilityChecked) {
    await assertJobUrlStillAvailable(meta);
  }
  await assertJobNotAlreadyOnSheet(meta, meta._sheetLinksCache);
  const resumeOnly = meta.resumeOnly === true;
  await ensureCostSession(meta.jdLink || meta.jobTitle || "");

  assertNotCancelled();
  await setStatus("Building resume prompt...");
  // Real past projects that match this JD, so the tailored experience is built
  // on work that happened instead of invented for the posting.
  const projectContext = await getProfileProjectContext(profileId, {
    jdText: meta.jdText || "",
    jobTitle: meta.jobTitle || ""
  });
  if (projectContext.total) {
    await setStatus(
      `Project manifest: ${projectContext.matched} of ${projectContext.total} project(s) match this JD; sending ${projectContext.projects.length}...`
    );
  }
  // buildPrompt fills the template's {CANDIDATE_INFORMATION} / {PROJECT_MANIFESTS}
  // slots, or appends both sections when the template has no placeholders.
  const basePrompt = await buildPrompt(profileId, meta.jdText || "", {
    jobTitle: meta.jobTitle || "",
    companyName: meta.companyName || "",
    projectManifests: projectContext.list,
    projectManifestBlock: projectContext.block
  });
  // Only templates that render a Technical Summary ask the model to produce one.
  const wantsTechnicalSummary = templateRequiresTechnicalSummary(
    meta.templateId || DEFAULT_TEMPLATE_ID
  );
  const resumePrompt = wantsTechnicalSummary
    ? `${basePrompt}\n\n${TECHNICAL_SUMMARY_PROMPT}`
    : basePrompt;

  assertNotCancelled();
  await setStatus("Calling OpenAI for resume JSON...");
  const resumeResult = await chatCompletion({
    apiKey,
    model,
    messages: [
      { role: "system", content: RESUME_JSON_SYSTEM_PROMPT },
      { role: "user", content: resumePrompt },
      {
        role: "user",
        content: [
          "Reminder: return the COMPLETE resume JSON now. Skills items must be long and dense. Experience must include all required jobs with full long-form bullet counts (each bullet ~170–240 characters). Do not shorten or omit sections.",
          projectContext.projects.length
            ? "Build the experience bullets on the candidate project manifest entries that fit this JD, keeping each project with its own employer. Paraphrase them into normal work history."
            : "",
          wantsTechnicalSummary
            ? 'Also include the "technical_summary" array (6–7 bullets) right after "profile", following the Technical Summary rules above.'
            : ""
        ]
          .filter(Boolean)
          .join(" ")
      }
    ],
    jsonMode: true,
    maxTokens: 16384
  });
  const jsonText = resumeResult?.content || "";
  await logLlmCall({
    purpose: "resume",
    model,
    inputTokens: resumeResult.usage?.prompt_tokens,
    outputTokens: resumeResult.usage?.completion_tokens
  });

  assertNotCancelled();
  let data = extractResumeJson(jsonText);
  if (!data) {
    throw new Error(
      "OpenAI response is not valid resume JSON. Try again or check the profile prompt."
    );
  }
  data = normalizeResumePayload(data);

  // #region agent log
  fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "30a7bc" },
    body: JSON.stringify({
      sessionId: "30a7bc",
      runId: "pre-fix",
      hypothesisId: "A",
      location: "sw.js:runGenerationPipeline:afterExtract",
      message: "Experience entries right after AI JSON parse",
      data: {
        profileId,
        experienceCount: Array.isArray(data?.experience) ? data.experience.length : 0,
        entries: (data?.experience || []).map((j, i) => ({
          index: i,
          keys: j && typeof j === "object" ? Object.keys(j) : [],
          company: j?.company ?? null,
          employer: j?.employer ?? null,
          organization: j?.organization ?? null,
          title: j?.title ?? null,
          dates: j?.dates ?? null
        }))
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  data = await ensureResumeSkills(data, {
    apiKey,
    model,
    jdText: meta.jdText || ""
  });

  assertNotCancelled();
  // Panel toggle "Rewrite for ATS", off by default: score the resume but never
  // rewrite it. jobMeta can override per run; otherwise the stored setting applies.
  const atsRewriteEnabled =
    meta.atsRewriteEnabled != null
      ? meta.atsRewriteEnabled === true
      : (await chrome.storage.local.get("ats_rewrite_enabled")).ats_rewrite_enabled === true;
  await setStatus(
    atsRewriteEnabled
      ? "Scoring resume against the job description..."
      : "Scoring resume against the job description (rewrite off)..."
  );
  let improved;
  try {
    improved = await ensureAtsReadyResume(data, {
      apiKey,
      model,
      jdText: meta.jdText || "",
      jobTitle: meta.jobTitle || "",
      companyName: meta.companyName || "",
      projects: projectContext.projects,
      candidateInfo: await getCandidateInfoText(profileId),
      setStatus,
      rewriteEnabled: atsRewriteEnabled
    });
    data = improved.data || data;
  } catch (rewriteErr) {
    if (isCancelError(rewriteErr)) throw rewriteErr;
    await setStatus(
      `ATS rewrite skipped (${String(rewriteErr?.message || rewriteErr)}). Using the generated resume.`
    );
    improved = {
      data,
      atsReport: await scoreResumeAgainstJd(data, {
        jdText: meta.jdText || "",
        jobTitle: meta.jobTitle || "",
        apiKey,
        model
      }).catch((scoreErr) => {
        if (isCancelError(scoreErr)) throw scoreErr;
        return null;
      })
    };
  }

  // #region agent log
  fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "30a7bc" },
    body: JSON.stringify({
      sessionId: "30a7bc",
      runId: "pre-fix",
      hypothesisId: "B",
      location: "sw.js:runGenerationPipeline:afterAtsRewrite",
      message: "Experience entries after ATS rewrite",
      data: {
        rewritten: Boolean(improved?.atsReport?.rewritten),
        entries: (data?.experience || []).map((j, i) => ({
          index: i,
          keys: j && typeof j === "object" ? Object.keys(j) : [],
          company: j?.company ?? null,
          title: j?.title ?? null,
          dates: j?.dates ?? null
        }))
      },
      timestamp: Date.now()
    })
  }).catch(() => {});
  // #endregion

  assertNotCancelled();
  data = await ensureResumeSkills(data, {
    apiKey,
    model,
    jdText: meta.jdText || ""
  });

  let scoredFinal = improved?.atsReport;
  // With rewrite off the resume is unchanged since it was scored a moment ago,
  // so re-scoring it would just burn another model call for the same number.
  const needsFinalScore = atsRewriteEnabled || !Number(scoredFinal?.score);
  if (needsFinalScore) {
    try {
      await setStatus("Asking GPT for the final ATS score...");
      scoredFinal = await scoreResumeAgainstJd(data, {
        jdText: meta.jdText || "",
        jobTitle: meta.jobTitle || "",
        apiKey,
        model
      });
    } catch (scoreErr) {
      if (isCancelError(scoreErr)) throw scoreErr;
      await setStatus(
        `GPT ATS score failed (${String(scoreErr?.message || scoreErr)}). Using the last score if available.`
      );
      if (!scoredFinal) scoredFinal = {};
    }
  }
  const atsReport = {
    ...scoredFinal,
    rewritten: Boolean(improved?.atsReport?.rewritten),
    rewriteAttempts: Number(improved?.atsReport?.rewriteAttempts || 0),
    rewriteSkipped: improved?.atsReport?.rewriteSkipped || "",
    previousScore: improved?.atsReport?.previousScore ?? scoredFinal.score,
    finalScore: scoredFinal.score,
    rewriteIssues: improved?.atsReport?.rewriteIssues || []
  };

  const rawText = JSON.stringify(data, null, 2);
  await chrome.storage.local.set({ last_response: rawText, last_ats_report: atsReport });
  const finalPct = Math.round(Number(atsReport.finalScore ?? atsReport.score) || 0);
  const rewriteNote = atsReport.rewritten
    ? ` Final ATS ${finalPct}% (was ${Math.round(Number(atsReport.previousScore))}%).`
    : atsReport.rewriteSkipped === "disabled"
      ? ` ATS ${finalPct}% (Rewrite for ATS is off — resume kept as generated).`
      : ` Final ATS ${finalPct}%.`;

  const previewStored = meta.previewMode === true;

  // Preview mode: hold JSON for review — do not render/save PDFs until Save.
  if (previewStored) {
    await chrome.storage.local.set({
      last_resume_json: data,
      last_response: rawText,
      last_ats_report: atsReport,
      preview_pending_save: true,
      preview_pending_meta: {
        profileId,
        jobTitle: meta.jobTitle || "",
        companyName: meta.companyName || "",
        jdLink: meta.jdLink || "",
        jdText: meta.jdText || "",
        outputDir: meta.outputDir || "",
        spreadsheetUrl: meta.spreadsheetUrl || "",
        sheetName: meta.sheetName || "",
        sheetsWebAppUrl: meta.sheetsWebAppUrl || "",
        templateId: meta.templateId || "",
        resumeOnly,
        trackApplicationStatus: meta.trackApplicationStatus === true,
        importedJobId: meta.importedJobId || "",
        workArrangement: meta.workArrangement || "",
        employmentType: meta.employmentType || "",
        salaryMin: meta.salaryMin || "",
        salaryMax: meta.salaryMax || "",
        datePosted: meta.datePosted || "",
        atsScore: Number(atsReport.finalScore ?? atsReport.score) || 0
      },
      ui_open_preview: Date.now()
    });

    if (meta?.importedJobId) {
      const live = (await getImportedJobsById())[meta.importedJobId];
      await setImportedJobStatus(meta.importedJobId, {
        status: live?.status || "generated",
        statusDetail: `Preview ready.${rewriteNote} Open Preview to revise or Save PDFs.`,
        patch: {
          hasGeneratedResume: false,
          atsScore: Number(atsReport.finalScore ?? atsReport.score) || 0,
          atsReport
        }
      });
    }

    try {
      await ensurePanelVisible();
    } catch {
      /* panel may already be open */
    }

    const costLine = await getCostSummaryText();
    await setStatus(
      `Preview ready.${rewriteNote} Review in Preview, optionally regenerate, then Save PDFs. ${costLine}`.trim()
    );
    return {
      previewOnly: true,
      folderName: "",
      resumeFileName: "",
      coverLetterFileName: "",
      docs: null,
      atsScore: Number(atsReport.finalScore ?? atsReport.score) || 0,
      atsReport,
      status: `Preview ready.${rewriteNote} Save PDFs from the Preview page when ready. ${costLine}`.trim()
    };
  }

  await setStatus(
    resumeOnly
      ? `Resume JSON ready.${rewriteNote} Rendering PDF (skipping cover letter)...`
      : `Resume JSON ready.${rewriteNote} Rendering PDF + cover letter...`
  );

  assertNotCancelled();
  const saved = await saveResumeAndCoverLetter(rawText, data, meta, {
    apiKey,
    model,
    runCoverLetter: !resumeOnly,
    profileId
  });

  if (meta?.importedJobId) {
    const live = (await getImportedJobsById())[meta.importedJobId];
    await setImportedJobStatus(meta.importedJobId, {
      status: live?.status || "generated",
      statusDetail: live?.statusDetail || saved?.status || "",
      patch: {
        hasGeneratedResume: true,
        resumeFolder: saved?.folderName || "",
        resumeFileName: saved?.resumeFileName || "",
        coverLetterFileName: saved?.coverLetterFileName || "",
        atsScore: Number(atsReport.finalScore ?? atsReport.score) || 0,
        atsReport
      }
    });
  }

  assertNotCancelled();
  try {
    await setStatus("Building application brief for form fill...");
    const applicantInfo = await getApplicantInfo(profileId);
    const brief = await generateApplicationBrief({
      apiKey,
      model,
      resumeData: data,
      jobMeta: meta,
      applicantInfo
    });
    await storeApplicationBrief(brief);
  } catch (briefErr) {
    if (isCancelError(briefErr)) throw briefErr;
    await storeApplicationBrief(null);
  }

  const costLine = await getCostSummaryText();
  return {
    ...saved,
    atsScore: Number(atsReport.finalScore ?? atsReport.score) || 0,
    atsReport,
    status: `${saved.status} Click Apply on the job or application page when ready. ${costLine}`.trim()
  };
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex !== 0) return;
  (async () => {
    try {
      const { getLastSaveMeta } = await import("./fs-output.js");
      const meta = await getLastSaveMeta();
      if (meta?.method === "fs") {
        await ensurePanelVisible();
        await new Promise((r) => setTimeout(r, 400));
      }
      await openSavedFolderFromMeta(meta);
    } catch (err) {
      await setStatus(`Open folder failed: ${String(err?.message || err)}`);
    } finally {
      chrome.notifications.clear(notificationId).catch(() => {});
    }
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "cancel_generation") {
    (async () => {
      const wasRunning = isRunning;
      requestGenerationCancel();
      // Clear the "In progress" flag immediately so Stop does not leave the
      // panel stuck while the apply loop is still winding down (or after the
      // service worker died and isRunning was lost).
      await chrome.storage.local.set({ generation_running: false });
      await markInProgressJobsStopped("Cancelled by user.");
      await setStatus("Cancelled by user.");
      if (!wasRunning) {
        releaseGenerationLock();
      } else {
        // Some steps (tab probes, PDF writes, downloads) cannot be aborted mid-flight.
        // If the loop has not released the lock by the end of the grace period, break
        // it here so the next Batch/Apply click is not rejected as "already in progress".
        setTimeout(() => {
          if (isRunning && generationCancelRequestedAt) {
            forceReleaseGenerationLock("stop grace period elapsed");
          }
        }, CANCEL_GRACE_MS + 1000);
      }
      safeSendResponse(sendResponse, { ok: true, cancelling: wasRunning, cleared: !wasRunning });
    })().catch((err) => {
      safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
    });
    return true;
  }

  if (message?.type === "reset_generation_state") {
    (async () => {
      try {
        releaseGenerationLock();
        await chrome.storage.local.set({
          generation_status: "Reset complete. Ready for next run.",
          generation_running: false,
          last_response: "",
          last_application_brief: null,
          last_ats_report: null
        });
        safeSendResponse(sendResponse, { ok: true });
      } catch (err) {
        releaseGenerationLock();
        await chrome.storage.local.set({ generation_running: false });
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (message?.type === "open_side_panel") {
    (async () => {
      try {
        await chrome.storage.local.set({ [PANEL_MODE_KEY]: "sidebar" });
        const windowId = await openSidePanelForBrowser();
        await closePanelWindow();
        safeSendResponse(sendResponse, { ok: true, windowId });
      } catch (err) {
        // Still return a host window id so the popup can open the side panel
        // from a user gesture if SW open() was blocked.
        try {
          const windowId = await resolveSidebarHostWindowId();
          safeSendResponse(sendResponse, {
            ok: windowId != null,
            windowId,
            error: String(err?.message || err)
          });
        } catch (inner) {
          safeSendResponse(sendResponse, { ok: false, error: String(inner?.message || inner) });
        }
      }
    })();
    return true;
  }

  if (message?.type === "open_panel_window") {
    (async () => {
      try {
        await chrome.storage.local.set({ [PANEL_MODE_KEY]: "window" });
        await openPanelWindow();
        safeSendResponse(sendResponse, { ok: true });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "close_panel_window") {
    (async () => {
      await closePanelWindow();
      safeSendResponse(sendResponse, { ok: true });
    })();
    return true;
  }

  if (message?.type === "open_saved_folder") {
    (async () => {
      try {
        const { getLastSaveMeta } = await import("./fs-output.js");
        const meta = message.meta || (await getLastSaveMeta());
        const result = await openSavedFolderFromMeta(meta);
        safeSendResponse(sendResponse, result);
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "show_save_notification") {
    showSaveNotification(message.pathLabel || "").then(() => {
      safeSendResponse(sendResponse, { ok: true });
    });
    return true;
  }

  if (message?.type === "run_job_capture") {
    (async () => {
      try {
        const result = await runUnifiedJobCapture({
          trigger: message.trigger || "manual"
        });
        safeSendResponse(sendResponse, result);
      } catch (err) {
        safeSendResponse(sendResponse, {
          ok: false,
          error: String(err?.message || err)
        });
      }
    })();
    return true;
  }

  if (message?.type === "get_capture_status") {
    (async () => {
      try {
        const data = await chrome.storage.local.get(["last_capture_status"]);
        safeSendResponse(sendResponse, {
          ok: true,
          running: isJobCaptureRunning(),
          status: data.last_capture_status || null,
          summary: data.last_capture_status?.summary || ""
        });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "set_auto_capture") {
    (async () => {
      try {
        const { AUTO_CAPTURE_ENABLED_KEY } = await import("./capture-jobs.js");
        await chrome.storage.local.set({
          [AUTO_CAPTURE_ENABLED_KEY]: message.enabled !== false
        });
        await ensureCaptureAlarm();
        safeSendResponse(sendResponse, { ok: true, enabled: message.enabled !== false });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "scrape_current_page") {
    (async () => {
      try {
        const tab = await getCurrentApplicationTab();
        if (!tab?.id) {
          safeSendResponse(sendResponse, {
            ok: false,
            error:
              "No active job tab found. Open the job page in a normal browser window first."
          });
          return;
        }
        if (!/^https?:\/\//i.test(tab.url || "")) {
          safeSendResponse(sendResponse, {
            ok: false,
            error: "The current tab is not a web page. Open the job posting, then scrape."
          });
          return;
        }

        await setStatus("Scraping the open job page...");
        await ensureAutofillScript(tab.id);
        const hints = await collectMainWorldScrapeHints(tab.id, tab.url || "");
        const res = await sendMessageToTab(
          tab.id,
          { type: "ocean_scrape_page", siteId: message.siteId || "auto", hints },
          { attempts: 3, frameId: 0 }
        );

        if (!res?.ok) {
          const err = res?.error || "Could not scrape this page.";
          await setStatus(`Scrape failed: ${err}`);
          safeSendResponse(sendResponse, { ok: false, error: err });
          return;
        }

        await setStatus(
          `Scraped ${res.jobData?.jobTitle || "job"}${
            res.jobData?.companyName ? ` @ ${res.jobData.companyName}` : ""
          } (${res.site || "page"}).`
        );
        safeSendResponse(sendResponse, {
          ok: true,
          site: res.site || "",
          jobData: res.jobData || {},
          tabUrl: tab.url || ""
        });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Scrape failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
      }
    })();
    return true;
  }

  if (message?.type === "probe_autofill_action") {
    (async () => {
      try {
        const tab = await getCurrentApplicationTab();
        if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
          safeSendResponse(sendResponse, {
            ok: true,
            button: describeAutofillButton({})
          });
          return;
        }
        await ensureAutofillScript(tab.id);
        const probe = await getApplyActionFromTab(tab.id).catch(() => ({}));
        const readyToSubmit = await isReadyToSubmit(tab.url || "");
        safeSendResponse(sendResponse, {
          ok: true,
          button: describeAutofillButton(probe, { readyToSubmit }),
          anyForm: Boolean(probe?.anyForm),
          actionText: probe?.best?.action?.text || ""
        });
      } catch (err) {
        safeSendResponse(sendResponse, {
          ok: true,
          button: describeAutofillButton({}),
          error: String(err?.message || err)
        });
      }
    })();
    return true;
  }

  if (message?.type === "autofill_current_page") {
    (async () => {
      let panelApplyRunToken = null;
      try {
        const profileId = message.profileId;
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
          return;
        }
        const busy = generationLockError("Ocean");
        if (busy) {
          safeSendResponse(sendResponse, { ok: false, error: busy });
          return;
        }
        panelApplyRunToken = acquireGenerationLock();
        const preferredAction = String(message.preferredAction || "");
        await setStatus(
          preferredAction.toLowerCase() === "submit"
            ? "Submit: clicking the page Submit button..."
            : "Apply: filling the form and continuing the application..."
        );
        const result = await runPanelApply(profileId, {
          preferredAction
        });
        if (result.skipped) {
          await setStatus(`Apply skipped: ${result.error}`);
          safeSendResponse(sendResponse, { ok: false, error: result.error, button: result.button });
          return;
        }
        if (!result.ok) {
          const err = result.error || "Apply failed.";
          await setStatus(`Apply failed: ${err}`);
          safeSendResponse(sendResponse, { ok: false, error: err, button: result.button });
          return;
        }

        const importedJobId = String(message.importedJobId || "").trim();
        if (
          importedJobId &&
          preferredAction.toLowerCase() === "submit" &&
          (result.submitted || /submit/i.test(String(result.status || "")))
        ) {
          try {
            const jobs = await getImportedJobsById();
            const job = jobs[importedJobId];
            if (job) {
              await finalizeImportedJobAsApplied(importedJobId, {
                profileId,
                jobMeta: {
                  jobTitle: job.jobTitle || "",
                  companyName: job.companyName || "",
                  jdLink: job.jdLink || job.url || ""
                },
                site: detectSiteFromUrl(job.jdLink || job.url || ""),
                detail: result.status || "Submitted from Ocean."
              });
            }
          } catch {
            /* best-effort card update */
          }
        }

        const msg = result.status || "Apply done.";
        await setStatus(msg);
        safeSendResponse(sendResponse, { ok: true, ...result, status: msg });
      } catch (err) {
        const error = String(err?.message || err);
        if (isCancelError(err)) {
          await setStatus("Cancelled by user.");
          safeSendResponse(sendResponse, { ok: false, error: "Cancelled by user." });
        } else {
          await setStatus(`Apply failed: ${error}`);
          safeSendResponse(sendResponse, { ok: false, error });
        }
      } finally {
        await finishGenerationRun(panelApplyRunToken);
      }
    })();
    return true;
  }

  if (message?.type === "profile_learn_capture") {
    (async () => {
      try {
        const key = String(message.key || "").trim();
        const value = String(message.value || "").trim();
        if (!key || !value) {
          safeSendResponse(sendResponse, { ok: false });
          return;
        }
        const { selected_profile_id } = await chrome.storage.local.get("selected_profile_id");
        const profileId = selected_profile_id || "";
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "No profile selected." });
          return;
        }
        const info = await getApplicantInfo(profileId);
        if (!(key in info)) {
          safeSendResponse(sendResponse, { ok: false });
          return;
        }
        // Fill-if-empty: never overwrite a value the user curated in the profile.
        if (String(info[key] || "").trim()) {
          safeSendResponse(sendResponse, { ok: true, skipped: true });
          return;
        }
        info[key] = value;
        await saveApplicantInfo(profileId, info);
        safeSendResponse(sendResponse, { ok: true, learned: true });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "qa_learn_capture") {
    (async () => {
      try {
        const question = String(message.question || "").trim();
        const answer = String(message.answer || "").trim();
        if (!question || !answer) {
          safeSendResponse(sendResponse, { ok: false });
          return;
        }
        const { selected_profile_id } = await chrome.storage.local.get("selected_profile_id");
        await saveQa({
          profileId: selected_profile_id || "",
          question,
          answer,
          fieldType: message.fieldType || "text",
          source: "user",
          site: message.site || ""
        });
        bumpQaVersion();
        await dismissPendingMatchingQuestion(question, selected_profile_id || "").catch(() => {});
        safeSendResponse(sendResponse, { ok: true });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "kb_get") {
    (async () => {
      try {
        const profileId = String(message.profileId || "").trim();
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Pick a profile first." });
          return;
        }
        const status = await getKbStatus(profileId);
        safeSendResponse(sendResponse, {
          ok: true,
          kb: status.kb,
          stale: status.stale,
          qaCount: status.sources.qaRows.length,
          profileFieldCount: status.sources.profile.length
        });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "kb_rebuild") {
    (async () => {
      try {
        const profileId = String(message.profileId || "").trim();
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Pick a profile first." });
          return;
        }
        const { apiKey, model } = await getOpenAiFormSettings();
        const status = await getKbStatus(profileId);
        const { kb, usage, error } = await rebuildProfileKb({
          profileId,
          apiKey,
          model,
          sources: status.sources
        });
        await logKbUsage(model, usage);
        safeSendResponse(sendResponse, {
          ok: true,
          kb,
          stale: false,
          qaCount: status.sources.qaRows.length,
          profileFieldCount: status.sources.profile.length,
          ...(error ? { warning: error } : null)
        });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (message?.type === "easy_apply_answer_questions") {
    (async () => {
      try {
        const profileId = message.profileId;
        const questions = Array.isArray(message.questions) ? message.questions : [];
        if (!questions.length) {
          safeSendResponse(sendResponse, { ok: true, answers: [] });
          return;
        }
        const applicantInfo = await getApplicantInfo(profileId);
        const ctx = await getAutofillAiContext();
        const answers = await resolveTextAnswers({
          questions,
          applicantInfo,
          jobMeta: message.jobMeta || ctx.jobMeta,
          resumeText: ctx.resumeText,
          profileId,
          applicationBrief: ctx.applicationBrief,
          site: message.site || hostnameFromUrl(message.jobMeta?.jdLink || ctx.jobMeta?.jdLink || "")
        });
        safeSendResponse(sendResponse, { ok: true, answers });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err), answers: [] });
      }
    })();
    return true;
  }

  if (message?.type === "easy_apply_choice_answers") {
    (async () => {
      try {
        const ctx = await getAutofillAiContext();
        const applicantInfo = await getApplicantInfo(message.profileId);
        const answers = await resolveChoiceAnswers(
          message.profileId,
          Array.isArray(message.questions) ? message.questions : [],
          applicantInfo,
          ctx.jobMeta,
          ctx.resumeText,
          { applicationBrief: ctx.applicationBrief, site: message.site || hostnameFromUrl(ctx.jobMeta?.jdLink || "") }
        );
        safeSendResponse(sendResponse, { ok: true, answers });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err), answers: [] });
      }
    })();
    return true;
  }

  if (message?.type === "easy_apply_current_page") {
    // Legacy shortcut — same as the panel Apply button (whole application).
    (async () => {
      let panelApplyRunToken = null;
      try {
        const profileId = message.profileId;
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
          return;
        }
        const busy = generationLockError("Ocean");
        if (busy) {
          safeSendResponse(sendResponse, { ok: false, error: busy });
          return;
        }
        panelApplyRunToken = acquireGenerationLock();
        await setStatus("Apply: filling the form and continuing the application...");
        const result = await runPanelApply(profileId, { preferredAction: message.preferredAction || "" });
        if (result.skipped || !result.ok) {
          const err = result.error || "Apply failed.";
          await setStatus(`Apply failed: ${err}`);
          safeSendResponse(sendResponse, { ok: false, error: err, button: result.button });
          return;
        }
        const msg = result.status || "Apply done.";
        await setStatus(msg);
        safeSendResponse(sendResponse, { ok: true, ...result, status: msg });
      } catch (err) {
        const error = String(err?.message || err);
        if (isCancelError(err)) {
          await setStatus("Cancelled by user.");
          safeSendResponse(sendResponse, { ok: false, error: "Cancelled by user." });
        } else {
          await setStatus(`Apply failed: ${error}`);
          safeSendResponse(sendResponse, { ok: false, error });
        }
      } finally {
        await finishGenerationRun(panelApplyRunToken);
      }
    })();
    return true;
  }

  if (message?.type === "apply_imported_job") {
    const importedJobId = message.importedJobId;
    const profileId = message.profileId;
    const jobMeta = message.jobMeta || {};

    if (!importedJobId) {
      safeSendResponse(sendResponse, { ok: false, error: "Missing importedJobId." });
      return false;
    }
    if (!profileId) {
      safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
      return false;
    }
    const applyBusy = generationLockError("Apply");
    if (applyBusy) {
      safeSendResponse(sendResponse, { ok: false, error: applyBusy });
      return false;
    }

    const applyRunToken = acquireGenerationLock();
    safeSendResponse(sendResponse, { ok: true, started: true });

    (async () => {
      try {
        await runApplyImportedJobCore(importedJobId, profileId, jobMeta, {
          allowGenerate: true
        });
      } catch (err) {
        const error = String(err?.message || err);
        if (isCancelError(err)) {
          await setStatus("Cancelled by user.");
          await setImportedJobStatus(importedJobId, {
            status: "failed",
            statusDetail: "Cancelled by user.",
            profileId
          });
        } else if (isJobUnavailableError(err)) {
          await setStatus(
            `Job no longer available — skipped, marked on the job card: ${err.jobUnavailable}`
          );
        } else {
          await setStatus(`Imported job failed: ${error}`);
          await setImportedJobStatus(importedJobId, {
            status: "failed",
            statusDetail: error,
            profileId
          });
          await appendApplicationEvent({
            profileId,
            importedJobId,
            jobTitle: jobMeta.jobTitle || "",
            companyName: jobMeta.companyName || "",
            jdLink: jobMeta.jdLink || "",
            status: "failed",
            detail: error
          });
        }
      } finally {
        await finishGenerationRun(applyRunToken);
      }
    })();

    return false;
  }

  if (message?.type === "batch_apply_jobs") {
    const profileId = message.profileId;
    const jobIds = Array.isArray(message.jobIds)
      ? message.jobIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const shared = message.jobMeta || {};
    const pauseMs = Math.max(0, Number(message.pauseMs) || 500);

    if (!profileId) {
      safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
      return false;
    }
    if (!jobIds.length) {
      safeSendResponse(sendResponse, { ok: false, error: "Check one or more jobs first." });
      return false;
    }
    const batchApplyBusy = generationLockError("Batch apply");
    if (batchApplyBusy) {
      safeSendResponse(sendResponse, { ok: false, error: batchApplyBusy });
      return false;
    }

    const batchApplyRunToken = acquireGenerationLock();
    safeSendResponse(sendResponse, { ok: true, started: true, total: jobIds.length });

    (async () => {
      let appliedCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      let reviewCount = 0;
      let cancelled = false;
      try {
        const trackStored =
          (await chrome.storage.local.get("track_application_status")).track_application_status ===
          true;

        for (let i = 0; i < jobIds.length; i += 1) {
          let importedJobId = "";
          try {
            assertRunActive(batchApplyRunToken);
            importedJobId = jobIds[i];
            const byId = await getImportedJobsById();
            const job = byId[importedJobId];
            if (!job) {
              failCount += 1;
              continue;
            }

            const status = String(job.status || "");
            if (status === "completed" || status === "unavailable") {
              skippedCount += 1;
              continue;
            }

            const jobUrl = String(job.jdLink || job.url || "").trim();
            if (!jobUrl) {
              failCount += 1;
              await setImportedJobStatus(importedJobId, {
                status: "failed",
                statusDetail: "Missing job URL — cannot apply.",
                profileId
              });
              continue;
            }

            const progressLabel = `Batch apply ${i + 1}/${jobIds.length}`;
            await setStatus(
              `${progressLabel}: ${job.jobTitle || importedJobId} @ ${job.companyName || ""}`
            );

            const jobMeta = {
              jobTitle: job.jobTitle || "",
              companyName: job.companyName || "",
              jdLink: jobUrl,
              jdText: String(job.jdText || "").trim(),
              templateId: shared.templateId || DEFAULT_TEMPLATE_ID,
              spreadsheetUrl: shared.spreadsheetUrl || "",
              sheetName: shared.sheetName || "",
              sheetsWebAppUrl: shared.sheetsWebAppUrl || "",
              workArrangement: job.workArrangement || "",
              employmentType: job.employmentType || "",
              salaryMin: job.salaryMin || "",
              salaryMax: job.salaryMax || "",
              datePosted: job.datePosted || "",
              trackApplicationStatus:
                shared.trackApplicationStatus === true || trackStored,
              atsRewriteEnabled: shared.atsRewriteEnabled,
              importedJobId
            };

            const result = await runApplyImportedJobCore(importedJobId, profileId, jobMeta, {
              allowGenerate: true,
              progressLabel
            });

            if (result.status === "submitted") appliedCount += 1;
            else if (
              result.status === "already_applied" ||
              result.status === "unavailable" ||
              result.status === "skipped"
            ) {
              skippedCount += 1;
            }
            else if (result.status === "needs_review" || result.status === "ready_for_review") {
              reviewCount += 1;
            } else {
              failCount += 1;
            }
          } catch (err) {
            if (isCancelError(err)) {
              cancelled = true;
              if (importedJobId) {
                await setImportedJobStatus(importedJobId, {
                  status: "failed",
                  statusDetail: "Cancelled by user.",
                  profileId
                });
              }
              await setStatus("Batch apply cancelled by user.");
              break;
            }
            const error = String(err?.message || err);
            if (isJobUnavailableError(err)) {
              skippedCount += 1;
              await setStatus(
                `Batch apply ${i + 1}/${jobIds.length}: job closed — skipped, marked on the job card. Continuing...`
              );
              continue;
            }
            failCount += 1;
            if (importedJobId) {
              await setImportedJobStatus(importedJobId, {
                status: "failed",
                statusDetail: error,
                profileId
              });
              await appendApplicationEvent({
                profileId,
                importedJobId,
                jobTitle: "",
                companyName: "",
                jdLink: "",
                status: "failed",
                detail: error
              }).catch(() => {});
            }
            await setStatus(
              `Batch apply ${i + 1}/${jobIds.length} failed: ${error}. Continuing...`
            );
          }

          if (cancelled) break;
          if (i < jobIds.length - 1) {
            await setStatus(
              `Batch apply: waiting ${Math.round(pauseMs / 1000)}s before next job...`
            );
            await sleepMs(pauseMs);
          }
        }

        if (!cancelled) {
          await setStatus(
            `Batch apply done. Applied ${appliedCount}, needs review ${reviewCount}, skipped ${skippedCount}, failed ${failCount}. ${await getCostSummaryText()}`
          );
        }
      } catch (err) {
        if (isCancelError(err)) {
          await setStatus("Batch apply cancelled by user.");
        } else {
          await setStatus(`Batch apply failed: ${String(err?.message || err)}`);
        }
      } finally {
        await finishGenerationRun(batchApplyRunToken);
      }
    })();

    return false;
  }

  if (message?.type === "answer_application_question") {
    (async () => {
      try {
        await setStatus("Generating brief humanized answer...");
        const result = await answerManualApplicationQuestion(
          message.profileId,
          message.question
        );
        if (!result.ok) {
          await setStatus(`AI answer failed: ${result.error}`);
          safeSendResponse(sendResponse, { ok: false, error: result.error });
          return;
        }
        await setStatus("AI answer ready — copy it into the form.");
        safeSendResponse(sendResponse, { ok: true, answer: result.answer });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`AI answer failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
      }
    })();
    return true;
  }

  if (message?.type === "batch_generate_jobs") {
    const profileId = message.profileId;
    const jobIds = Array.isArray(message.jobIds) ? message.jobIds.map((id) => String(id || "").trim()).filter(Boolean) : [];
    const shared = message.jobMeta || {};

    if (!profileId) {
      safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
      return false;
    }
    if (!jobIds.length) {
      safeSendResponse(sendResponse, { ok: false, error: "Check one or more jobs first." });
      return false;
    }
    const batchBusy = generationLockError("Batch resume build");
    if (batchBusy) {
      safeSendResponse(sendResponse, { ok: false, error: batchBusy });
      return false;
    }

    const batchRunToken = acquireGenerationLock();
    safeSendResponse(sendResponse, { ok: true, started: true, total: jobIds.length });

    (async () => {
      let okCount = 0;
      let failCount = 0;
      let skipCount = 0;
      let closedCount = 0;
      let cancelled = false;
      let probeTabId = null;
      let probeTabCreated = false;
      try {
        let byId = await getImportedJobsById();
        const resumeOnlyStored =
          (await chrome.storage.local.get("generate_resume_only")).generate_resume_only === true;
        const trackStored =
          (await chrome.storage.local.get("track_application_status")).track_application_status ===
          true;

        let sheetLinksCache = null;
        try {
          const sheetSettings = await resolveSheetSettings(shared);
          if (sheetSettings.spreadsheetUrl && sheetSettings.webAppUrl) {
            sheetLinksCache = await getExistingJobLinks(sheetSettings);
          }
        } catch (sheetErr) {
          console.warn("[batch] sheet link prefetch failed:", sheetErr);
        }

        for (let i = 0; i < jobIds.length; i += 1) {
          let importedJobId = "";
          try {
            assertRunActive(batchRunToken);

            importedJobId = jobIds[i];
            byId = await getImportedJobsById();
            const job = byId[importedJobId];
            if (!job) {
              failCount += 1;
              continue;
            }

            const jobUrl = String(job.jdLink || job.url || "").trim();
            const jdText = String(job.jdText || shared.jdText || "").trim();

            await setImportedJobStatus(importedJobId, {
              status: "opening",
              statusDetail: `Checking if still open (${i + 1}/${jobIds.length})...`,
              markAttempt: true,
              profileId
            });
            await setStatus(
              `Batch ${i + 1}/${jobIds.length}: checking ${job.jobTitle || importedJobId} @ ${job.companyName || ""}`
            );

            if (jobUrl) {
              const probe = await probeJobAvailabilityWithRetries(jobUrl, {
                attempts: 3,
                reuseTabId: probeTabCreated ? probeTabId : null,
                reuseTabCreated: probeTabCreated,
                onAttempt: async (attempt, max) => {
                  await setStatus(
                    `Batch ${i + 1}/${jobIds.length}: checking job (try ${attempt}/${max})...`
                  );
                }
              });
              probeTabId = probe.tabId || null;
              probeTabCreated = probe.tabId ? Boolean(probe.createdTab) : false;
              if (probe.closed) {
                closedCount += 1;
                const detail = await markImportedJobUnavailable(importedJobId, probe.closed, {
                  profileId
                });
                await setStatus(
                  `Closed — skipped, marked on the job card: ${job.jobTitle || importedJobId} (${detail})`
                );
                continue;
              }
              if (probe.error) {
                failCount += 1;
                await setImportedJobStatus(importedJobId, {
                  status: "check_failed",
                  statusDetail: `Skipped after 3 checks: ${probe.error}`,
                  profileId
                });
                await setStatus(
                  `Batch ${i + 1}/${jobIds.length}: skipped ${job.jobTitle || importedJobId} (${probe.error}). Continuing...`
                );
                continue;
              }
            }

            if (!jdText) {
              failCount += 1;
              await setImportedJobStatus(importedJobId, {
                status: "failed",
                statusDetail: "Missing job description — cannot generate a resume.",
                profileId
              });
              continue;
            }

            const jobMeta = {
              jobTitle: job.jobTitle || "",
              companyName: job.companyName || "",
              jdLink: jobUrl,
              jdText,
              templateId: shared.templateId || DEFAULT_TEMPLATE_ID,
              spreadsheetUrl: shared.spreadsheetUrl || "",
              sheetName: shared.sheetName || "",
              sheetsWebAppUrl: shared.sheetsWebAppUrl || "",
              workArrangement: job.workArrangement || "",
              employmentType: job.employmentType || "",
              salaryMin: job.salaryMin || "",
              salaryMax: job.salaryMax || "",
              datePosted: job.datePosted || "",
              resumeOnly: resumeOnlyStored,
              trackApplicationStatus:
                shared.trackApplicationStatus === true || trackStored,
              // Pinned when the batch started, so the whole run uses one setting.
              atsRewriteEnabled: shared.atsRewriteEnabled,
              importedJobId,
              previewMode: false,
              _sheetLinksCache: sheetLinksCache,
              _availabilityChecked: true
            };

            await chrome.storage.local.set({
              selected_profile_id: profileId,
              selected_template_id: jobMeta.templateId,
              last_job_title: jobMeta.jobTitle,
              last_company_name: jobMeta.companyName,
              last_jd_link: jobMeta.jdLink,
              last_jd_text: jobMeta.jdText
            });

            await setImportedJobStatus(importedJobId, {
              status: "generating",
              statusDetail: `Batch resume ${i + 1}/${jobIds.length}...`,
              profileId
            });
            await setStatus(
              `Batch resume ${i + 1}/${jobIds.length}: ${jobMeta.jobTitle || importedJobId} @ ${jobMeta.companyName || ""}`
            );

            const saved = await runWithRetries(
              () => runGenerationPipeline({ profileId, jobMeta }),
              {
                attempts: 3,
                delaysMs: [3000, 6000],
                onRetry: async ({ nextAttempt, max, waitMs, err }) => {
                  const why = String(err?.message || err).slice(0, 160);
                  await setImportedJobStatus(importedJobId, {
                    status: "generating",
                    statusDetail: `Retry ${nextAttempt}/${max} in ${Math.round(waitMs / 1000)}s — ${why}`,
                    profileId
                  });
                  await setStatus(
                    `Batch ${i + 1}/${jobIds.length}: network/API issue. Retry ${nextAttempt}/${max} in ${Math.round(waitMs / 1000)}s...`
                  );
                }
              }
            );
            okCount += 1;
            await setImportedJobStatus(importedJobId, {
              status: "generated",
              statusDetail: saved?.status || "Resume saved.",
              profileId,
              patch: {
                hasGeneratedResume: true,
                resumeFolder: saved?.folderName || "",
                resumeFileName: saved?.resumeFileName || "",
                coverLetterFileName: saved?.coverLetterFileName || "",
                atsScore: Number(saved?.atsScore) || undefined,
                atsReport: saved?.atsReport
                  ? {
                      score: Number(saved.atsReport.finalScore ?? saved.atsReport.score) || 0,
                      finalScore: Number(saved.atsReport.finalScore ?? saved.atsReport.score) || 0,
                      rawScore: Number(saved.atsReport.rawScore) || undefined,
                      keywordCoverage: saved.atsReport.keywordCoverage,
                      skillsCoverage: saved.atsReport.skillsCoverage,
                      rationale: String(saved.atsReport.rationale || "").slice(0, 280),
                      source: saved.atsReport.source || "gpt"
                    }
                  : Number(saved?.atsScore)
                    ? {
                        score: Number(saved.atsScore),
                        finalScore: Number(saved.atsScore),
                        source: "stored"
                      }
                    : undefined
              }
            });
          } catch (err) {
            if (isCancelError(err)) {
              cancelled = true;
              if (importedJobId) {
                await setImportedJobStatus(importedJobId, {
                  status: "failed",
                  statusDetail: "Cancelled by user.",
                  profileId
                });
              }
              break;
            }
            const error = String(err?.message || err);
            if (isJobUnavailableError(err)) {
              closedCount += 1;
              await setStatus(
                `Batch ${i + 1}/${jobIds.length}: job closed — skipped, marked on the job card. Continuing...`
              );
              continue;
            }
            if (isJobAlreadyOnSheetError(err)) {
              skipCount += 1;
              if (importedJobId) {
                await setImportedJobStatus(importedJobId, {
                  status: "skipped",
                  statusDetail: "Already on tracking sheet — resume not generated.",
                  profileId
                });
              }
              await setStatus(
                `Batch ${i + 1}/${jobIds.length}: skipped — already on sheet. Continuing...`
              );
              continue;
            }
            failCount += 1;
            if (importedJobId) {
              await setImportedJobStatus(importedJobId, {
                status: "failed",
                statusDetail: `Skipped after 3 tries: ${error}`,
                profileId
              });
            }
            await setStatus(
              `Batch item skipped (${importedJobId || "job"}): ${error}. Continuing...`
            );
          }
        }

        const closedNote = closedCount ? `, ${closedCount} closed/removed` : "";
        const skipNote = skipCount ? `, ${skipCount} already on sheet` : "";
        if (cancelled) {
          await setStatus(
            `Batch resume build stopped: ${okCount} saved, ${failCount} failed${skipNote}${closedNote} before cancel. ${await getCostSummaryText()}`
          );
        } else {
          await setStatus(
            `Batch resume build finished: ${okCount} saved, ${failCount} failed${skipNote}${closedNote}. ${await getCostSummaryText()}`
          );
        }
      } catch (err) {
        if (isCancelError(err)) {
          await setStatus("Cancelled by user.");
        } else {
          await setStatus(`Batch resume build failed: ${String(err?.message || err)}`);
        }
      } finally {
        if (probeTabId && probeTabCreated) {
          await chrome.tabs.remove(probeTabId).catch(() => {});
        }
        await finishGenerationRun(batchRunToken);
      }
    })();

    return false;
  }

  if (message?.type === "check_jobs_availability") {
    const jobIds = Array.isArray(message.jobIds)
      ? message.jobIds.map((id) => String(id || "").trim()).filter(Boolean)
      : [];

    if (!jobIds.length) {
      safeSendResponse(sendResponse, { ok: false, error: "Check one or more jobs first." });
      return false;
    }
    const checkBusy = generationLockError("Another job");
    if (checkBusy) {
      safeSendResponse(sendResponse, { ok: false, error: checkBusy });
      return false;
    }

    const checkRunToken = acquireGenerationLock();
    safeSendResponse(sendResponse, { ok: true, started: true, total: jobIds.length });

    (async () => {
      let closedCount = 0;
      let openCount = 0;
      let failedCount = 0;
      let cancelled = false;
      let probeTabId = null;
      let probeTabCreated = false;
      try {
        for (let i = 0; i < jobIds.length; i += 1) {
          try {
            assertRunActive(checkRunToken);
          } catch {
            cancelled = true;
            break;
          }

          const importedJobId = jobIds[i];
          const byId = await getImportedJobsById();
          const job = byId[importedJobId];
          if (!job) {
            failedCount += 1;
            continue;
          }

          try {
            const jobUrl = String(job.jdLink || job.url || "").trim();
            const priorStatus = String(job.status || "imported");
            await setImportedJobStatus(importedJobId, {
              status: priorStatus === "unavailable" ? "unavailable" : priorStatus,
              statusDetail: `Checking availability (${i + 1}/${jobIds.length})...`,
              profileId: job.profileId
            });
            await setStatus(
              `Availability ${i + 1}/${jobIds.length}: ${job.jobTitle || importedJobId} @ ${job.companyName || ""}`
            );

            if (!jobUrl) {
              failedCount += 1;
              await setImportedJobStatus(importedJobId, {
                status: "check_failed",
                statusDetail: "No job URL to check. Open the posting later and verify it by hand."
              });
              continue;
            }

            let probe = { tabId: probeTabId, closed: "", error: "", attempts: 0 };
            try {
              probe = await probeJobAvailabilityWithRetries(jobUrl, {
                attempts: 3,
                reuseTabId: probeTabCreated ? probeTabId : null,
                reuseTabCreated: probeTabCreated,
                onAttempt: async (attempt, max) => {
                  await setStatus(
                    `Availability ${i + 1}/${jobIds.length}: ${job.jobTitle || importedJobId} (try ${attempt}/${max})`
                  );
                }
              });
            } catch (err) {
              probe = {
                tabId: null,
                closed: "",
                error: String(err?.message || err || "Availability probe failed."),
                attempts: 3
              };
              if (probeTabId && probeTabCreated) {
                await chrome.tabs.remove(probeTabId).catch(() => {});
              }
              probeTabCreated = false;
            }
            probeTabId = probe.tabId || null;
            probeTabCreated = probe.tabId ? Boolean(probe.createdTab) : false;

            if (probe.closed) {
              closedCount += 1;
              await setImportedJobStatus(importedJobId, {
                status: "unavailable",
                statusDetail: `No longer available — delete recommended. ${probe.closed}`
              });
              await setStatus(
                `Unavailable (${closedCount}): ${job.jobTitle || importedJobId} — marked in red`
              );
              continue;
            }

            if (probe.error) {
              failedCount += 1;
              probeTabId = null;
              probeTabCreated = false;
              await setImportedJobStatus(importedJobId, {
                status: "check_failed",
                statusDetail: `Could not verify after ${probe.attempts || 3} tries: ${probe.error}`
              });
              await setStatus(
                `Check failed (${failedCount}): ${job.jobTitle || importedJobId} — marked in yellow, skipping`
              );
              continue;
            }

            openCount += 1;
            let restoredStatus = priorStatus;
            if (
              priorStatus === "unavailable" ||
              priorStatus === "opening" ||
              priorStatus === "check_failed"
            ) {
              restoredStatus = job.hasGeneratedResume ? "generated" : "imported";
            }
            await setImportedJobStatus(importedJobId, {
              status: restoredStatus,
              statusDetail: "Still open."
            });
          } catch (jobErr) {
            failedCount += 1;
            if (probeTabId && probeTabCreated) {
              await chrome.tabs.remove(probeTabId).catch(() => {});
            }
            probeTabId = null;
            probeTabCreated = false;
            await setImportedJobStatus(importedJobId, {
              status: "check_failed",
              statusDetail: `Could not verify: ${String(jobErr?.message || jobErr)}`
            }).catch(() => {});
            await setStatus(
              `Check failed (${failedCount}): ${job.jobTitle || importedJobId} — skipping`
            ).catch(() => {});
          }
        }

        await setStatus(
          `Availability check ${cancelled ? "cancelled" : "done"}. Closed ${closedCount} (red), still open ${openCount}, check failed ${failedCount} (yellow).`
        );
      } catch (err) {
        if (isCancelError(err)) {
          await setStatus("Availability check cancelled by user.");
        } else {
          await setStatus(`Availability check failed: ${String(err?.message || err)}`);
        }
      } finally {
        if (probeTabId && probeTabCreated) {
          await chrome.tabs.remove(probeTabId).catch(() => {});
        }
        await finishGenerationRun(checkRunToken);
      }
    })();

    return false;
  }

/**
 * The job the Preview page is showing.
 *
 * Preview mode parks a complete `preview_pending_meta` at generation time. With
 * preview mode off nothing is parked, but the Preview page still offers Revise
 * and Resave — so rebuild the same shape from the panel's last job fields plus
 * the selected imported job. Without this a resave landed in a
 * "Candidate - Company - Role" folder with no JD and no sheet settings.
 */
async function resolvePreviewJobContext() {
  const stored = await chrome.storage.local.get([
    "preview_pending_meta",
    "preview_pending_save",
    "selected_profile_id",
    "selected_template_id",
    "generate_resume_only",
    "last_job_title",
    "last_company_name",
    "last_jd_link",
    "last_jd_text",
    "last_output_dir",
    "last_ats_report",
    "imported_jobs_selected_id",
    "imported_jobs_by_id",
    "spreadsheet_url",
    "sheets_web_app_url",
    "sheets_sheet_name",
    "track_application_status"
  ]);

  const pending =
    stored.preview_pending_meta && typeof stored.preview_pending_meta === "object"
      ? stored.preview_pending_meta
      : {};
  const jobs =
    stored.imported_jobs_by_id && typeof stored.imported_jobs_by_id === "object"
      ? stored.imported_jobs_by_id
      : {};
  const importedJobId = String(
    pending.importedJobId || stored.imported_jobs_selected_id || ""
  ).trim();
  const job = importedJobId ? jobs[importedJobId] : null;
  const atsReport =
    stored.last_ats_report && typeof stored.last_ats_report === "object"
      ? stored.last_ats_report
      : null;

  const jobMeta = {
    jobTitle: pending.jobTitle || job?.jobTitle || stored.last_job_title || "",
    companyName: pending.companyName || job?.companyName || stored.last_company_name || "",
    jdLink: pending.jdLink || job?.jdLink || stored.last_jd_link || "",
    jdText: String(pending.jdText || job?.jdText || stored.last_jd_text || "").trim(),
    outputDir: pending.outputDir || "",
    spreadsheetUrl: pending.spreadsheetUrl || stored.spreadsheet_url || "",
    sheetName: pending.sheetName || stored.sheets_sheet_name || "",
    sheetsWebAppUrl: pending.sheetsWebAppUrl || stored.sheets_web_app_url || "",
    templateId: pending.templateId || stored.selected_template_id || DEFAULT_TEMPLATE_ID,
    resumeOnly: pending.resumeOnly === true || stored.generate_resume_only === true,
    trackApplicationStatus:
      pending.trackApplicationStatus === true || stored.track_application_status === true,
    importedJobId,
    workArrangement: pending.workArrangement || job?.workArrangement || "",
    employmentType: pending.employmentType || job?.employmentType || "",
    salaryMin: pending.salaryMin || job?.salaryMin || "",
    salaryMax: pending.salaryMax || job?.salaryMax || "",
    datePosted: pending.datePosted || job?.datePosted || ""
  };

  // Already on disk: the pending meta says so, the job is marked generated, or
  // nothing is waiting to be saved (preview mode off saves during generation).
  const alreadySaved =
    pending.alreadySaved === true ||
    Boolean(job?.hasGeneratedResume) ||
    stored.preview_pending_save !== true;
  const savedFolder =
    extractFolderNameFromSaveMeta(pending.savedFolder || "") ||
    extractFolderNameFromSaveMeta(job?.resumeFolder || "") ||
    extractFolderNameFromSaveMeta(stored.last_output_dir || "");

  return {
    pending,
    job,
    jobMeta,
    alreadySaved,
    savedFolder,
    atsScore:
      Number(pending.atsScore) ||
      Number(atsReport?.finalScore ?? atsReport?.score) ||
      Number(job?.atsScore) ||
      0,
    profileId: String(pending.profileId || stored.selected_profile_id || "").trim(),
    resumeOnly: jobMeta.resumeOnly
  };
}

  if (message?.type === "preview_regenerate_resume") {
    (async () => {
      try {
        const prompt = String(message.prompt || "").trim();
        if (!prompt) {
          safeSendResponse(sendResponse, { ok: false, error: "Enter revision instructions first." });
          return;
        }
        const stored = await chrome.storage.local.get("last_resume_json");
        const current =
          stored.last_resume_json && typeof stored.last_resume_json === "object"
            ? stored.last_resume_json
            : null;
        if (!current) {
          safeSendResponse(sendResponse, { ok: false, error: "No resume JSON to update. Generate first." });
          return;
        }
        // Works with preview mode on or off — the context resolver rebuilds the
        // job details when nothing was parked at generation time.
        const context = await resolvePreviewJobContext();
        const pending = context.pending;
        const jdText = context.jobMeta.jdText;
        const jobTitle = context.jobMeta.jobTitle;
        const companyName = context.jobMeta.companyName;

        const previewTemplateId = message.templateId || context.jobMeta.templateId;

        // Same candidate information and JD-matched project manifest the first
        // generation used, so an update stays anchored instead of drifting.
        const previewProfileId = context.profileId;
        const previewProjects = await getProfileProjectContext(previewProfileId, {
          jdText,
          jobTitle
        });
        const previewCandidateInfo = await getCandidateInfoText(previewProfileId);

        const { apiKey, model } = await getOpenAiSettings();
        await setStatus("Preview: regenerating resume from your prompt...");
        const userMsg = [
          "Update the resume JSON using the instructions below.",
          "Return ONLY one complete valid resume JSON object (same schema).",
          "Keep identity fields accurate. Apply the user's edits while staying ATS-friendly and realistic.",
          templateRequiresTechnicalSummary(previewTemplateId)
            ? 'Keep the "technical_summary" array (6–7 one-sentence senior-level bullets) in the output; refresh it if the edits change the resume.'
            : "",
          previewCandidateInfo
            ? "Candidate information below is the source of truth for employers, dates, titles, technologies, and metrics; do not contradict it."
            : "",
          previewProjects.block
            ? "Keep the experience grounded in the candidate project manifest below; prefer its JD-matched projects when the instructions ask for stronger or different experience."
            : "",
          "",
          `Job title: ${jobTitle || "(n/a)"}`,
          `Company: ${companyName || "(n/a)"}`,
          "",
          "=== JOB DESCRIPTION ===",
          jdText || "(no JD on file)",
          ...(previewCandidateInfo
            ? ["", "=== CANDIDATE INFORMATION — SOURCE OF TRUTH ===", previewCandidateInfo]
            : []),
          ...(previewProjects.block ? ["", previewProjects.block] : []),
          "",
          "=== CURRENT RESUME JSON ===",
          JSON.stringify(current, null, 2),
          "",
          "=== USER INSTRUCTIONS ===",
          prompt
        ].join("\n");

        const result = await chatCompletion({
          apiKey,
          model,
          messages: [
            { role: "system", content: RESUME_JSON_SYSTEM_PROMPT },
            { role: "user", content: userMsg }
          ],
          jsonMode: true,
          maxTokens: 16384
        });
        await logLlmCall({
          purpose: "preview_regenerate",
          model,
          inputTokens: result.usage?.prompt_tokens,
          outputTokens: result.usage?.completion_tokens
        });

        let data = extractResumeJson(result?.content || "");
        if (!data) {
          throw new Error("OpenAI did not return valid resume JSON. Try again with clearer instructions.");
        }
        data = await ensureResumeSkills(data, {
          apiKey,
          model,
          jdText
        });

        let atsReport = null;
        try {
          atsReport = await scoreResumeAgainstJd(data, {
            jdText,
            jobTitle,
            apiKey,
            model
          });
        } catch {
          atsReport = null;
        }

        const rawText = JSON.stringify(data, null, 2);
        // Park a complete meta so Save works even when preview mode never ran,
        // and remember that this resume is already on disk so the save replaces
        // it instead of writing a second folder.
        const nextPending = {
          ...pending,
          ...context.jobMeta,
          profileId: previewProfileId,
          templateId: previewTemplateId,
          resumeOnly: context.resumeOnly,
          alreadySaved: context.alreadySaved,
          savedFolder: context.savedFolder,
          atsScore:
            Number(atsReport?.finalScore ?? atsReport?.score) || context.atsScore || 0
        };
        await chrome.storage.local.set({
          last_resume_json: data,
          last_response: rawText,
          ...(atsReport ? { last_ats_report: atsReport } : null),
          preview_pending_save: true,
          preview_pending_meta: nextPending
        });

        const costLine = await getCostSummaryText();
        const status = `Resume updated from your prompt. Review Preview, then Save PDFs. ${costLine}`.trim();
        await setStatus(status);
        safeSendResponse(sendResponse, {
          ok: true,
          resume: data,
          atsReport,
          status
        });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Preview regenerate failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
      }
    })();
    return true;
  }

  if (message?.type === "preview_save_documents") {
    (async () => {
      let previewRunToken = null;
      try {
        const saveBusy = generationLockError("Generation");
        if (saveBusy) {
          safeSendResponse(sendResponse, { ok: false, error: saveBusy });
          return;
        }
        const stored = await chrome.storage.local.get(["last_resume_json", "last_response"]);
        const resumeData =
          stored.last_resume_json && typeof stored.last_resume_json === "object"
            ? stored.last_resume_json
            : null;
        if (!resumeData) {
          safeSendResponse(sendResponse, { ok: false, error: "No resume to save. Generate first." });
          return;
        }
        // Preview mode off still gets a full job context, so Resave lands in the
        // right folder with the right JD instead of a bare "Company - Role" one.
        const context = await resolvePreviewJobContext();
        const pending = context.pending;
        const profileId = context.profileId;
        const resumeOnly = context.resumeOnly;
        const jobMeta = {
          ...context.jobMeta,
          templateId: message.templateId || context.jobMeta.templateId,
          // Replace the PDFs already saved for this job rather than writing a
          // second numbered folder next to them, and never add a duplicate
          // tracking row for a job whose row already exists.
          overwriteFolderName: context.alreadySaved ? context.savedFolder : "",
          skipSheetAppend: context.alreadySaved
        };

        // #region agent log
        fetch("http://127.0.0.1:7779/ingest/d1be8714-c21e-4091-a0f5-4508d30396e2", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "df7ed5" },
          body: JSON.stringify({
            sessionId: "df7ed5",
            runId: "pre-fix",
            hypothesisId: "B,D",
            location: "sw.js:preview_save_documents",
            message: "preview save handler started",
            data: {
              messageTemplateId: message.templateId || "",
              jobMetaTemplateId: jobMeta.templateId,
              storedTemplateId: stored.selected_template_id || "",
              pendingTemplateId: pending.templateId || "",
              hasResumeData: Boolean(resumeData)
            },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion

        previewRunToken = acquireGenerationLock();
        await setStatus("Preview: saving resume PDFs...");

        const { apiKey, model } = await getOpenAiSettings();
        const rawText =
          String(stored.last_response || "").trim() || JSON.stringify(resumeData, null, 2);
        const saved = await saveResumeAndCoverLetter(rawText, resumeData, jobMeta, {
          apiKey,
          model,
          runCoverLetter: !resumeOnly,
          profileId
        });

        if (jobMeta.importedJobId) {
          const liveJob = (await getImportedJobsById())[jobMeta.importedJobId];
          await setImportedJobStatus(jobMeta.importedJobId, {
            // A resave must not drag a submitted application back to "generated".
            status: liveJob?.status === "completed" ? "completed" : "generated",
            statusDetail: saved?.status || "Resume saved from Preview.",
            profileId,
            patch: {
              hasGeneratedResume: true,
              resumeFolder: saved?.folderName || "",
              resumeFileName: saved?.resumeFileName || "",
              coverLetterFileName: saved?.coverLetterFileName || "",
              atsScore: Number(context.atsScore) || undefined
            }
          });
        }

        try {
          if (profileId) {
            const applicantInfo = await getApplicantInfo(profileId);
            const brief = await generateApplicationBrief({
              apiKey,
              model,
              resumeData,
              jobMeta,
              applicantInfo
            });
            await storeApplicationBrief(brief);
          }
        } catch {
          await storeApplicationBrief(null);
        }

        await chrome.storage.local.set({
          preview_pending_save: false,
          generation_running: false,
          // Remember where this resume now lives so the next Resave overwrites it.
          preview_pending_meta: {
            ...pending,
            ...jobMeta,
            profileId,
            alreadySaved: true,
            savedFolder: saved?.folderName || context.savedFolder || "",
            atsScore: context.atsScore || 0
          }
        });
        await chrome.storage.local.remove("ui_open_preview");

        const cover =
          (await chrome.storage.local.get("last_cover_letter_response")).last_cover_letter_response ||
          "";
        const costLine = await getCostSummaryText();
        const status = `${saved.status || "Saved."} ${costLine}`.trim();
        await setStatus(status);
        safeSendResponse(sendResponse, {
          ok: true,
          ...saved,
          coverLetter: cover,
          status
        });
      } catch (err) {
        await chrome.storage.local.set({ generation_running: false });
        const error = String(err?.message || err);
        await setStatus(`Preview save failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
      } finally {
        await finishGenerationRun(previewRunToken);
      }
    })();
    return true;
  }

  if (message?.type !== "generate_resume") {
    return undefined;
  }

  const generateBusy = generationLockError("Generation");
  if (generateBusy) {
    safeSendResponse(sendResponse, { ok: false, error: generateBusy });
    return undefined;
  }

  const generateRunToken = acquireGenerationLock();
  setStatus("Starting OpenAI resume generation...");

  safeSendResponse(sendResponse, { ok: true, started: true });

  (async () => {
    try {
      const result = await runGenerationPipeline({
        profileId: message.profileId,
        jobMeta: message.jobMeta || {}
      });
      await chrome.storage.local.set({ generation_running: false });
      await setStatus(result.status);
    } catch (err) {
      await chrome.storage.local.set({ generation_running: false });
      if (isCancelError(err)) {
        await setStatus("Cancelled by user.");
      } else if (isJobUnavailableError(err)) {
        await setStatus(
          `Job no longer available — resume skipped: ${err.jobUnavailable}`
        );
      } else {
        await setStatus(`Generation failed: ${String(err?.message || err)}`);
      }
    } finally {
      await finishGenerationRun(generateRunToken);
    }
  })();

  return false;
});
