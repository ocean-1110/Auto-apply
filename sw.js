import { appendJobToSpreadsheet } from "./sheets.js";
import {
  ensureCaptureAlarm,
  registerCaptureAlarmListener,
  runUnifiedJobCapture,
  isCaptureRunning as isJobCaptureRunning
} from "./capture-runner.js";
import { buildPrompt, buildCoverLetterPrompt } from "./profiles.js";
import { resumeJsonToHtml, extractResumeJson, hasRenderableSkills, normalizeSkills } from "./resume-json.js";
import { scoreResumeAgainstJd } from "./ats-score.js";
import { ensureAtsReadyResume } from "./ats-rewrite.js";
import { DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import { buildCoverLetterHtml } from "./cover-letter-html.js";
import {
  chatCompletion,
  setChatAbortSignal,
  DEFAULT_OPENAI_MODEL,
  RESUME_JSON_SYSTEM_PROMPT
} from "./openai.js";
import { getEnv } from "./env.js";
import { getApplicantInfo, saveApplicantInfo } from "./applicant-info.js";
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
import { generateHumanizedApplicationAnswers, generateConstrainedChoiceAnswers, isComplexQuestion, shouldBankAnswer, generateRoleSummaries } from "./ai-answers.js";
import { findQaMatch, saveQa, recordQaUsage } from "./qa-store.js";
import { upsertPendingQa, dismissPendingMatchingQuestion } from "./pending-qa.js";
import {
  generateApplicationBrief,
  getApplicationBrief,
  storeApplicationBrief
} from "./application-brief.js";
import { appendApplicationEvent } from "./application-log.js";
import {
  ensureCostSession,
  logLlmCall,
  logFillHits,
  getCostSummaryText
} from "./cost-tracker.js";

// Service worker entry (v1.3.5)
let isRunning = false;
let generationCancelRequested = false;
let generationAbortController = null;
let keepAliveTimer = null;
let panelWindowId = null;

// The last real browser window the user looked at, so "scrape/autofill the
// current page" targets the tab they were viewing — not this extension panel
// (a popup-type window) that steals focus when they click a button in it.
let lastFocusedNormalWindowId = null;

const PANEL_WIDTH = 1280;
const PANEL_HEIGHT = 900;
const PANEL_WINDOW_ID_KEY = "panel_window_id";
const PANEL_URL = () => chrome.runtime.getURL("popup.html");

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

  const panelUrl = PANEL_URL();
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
    url: PANEL_URL(),
    type: "popup",
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    focused: true
  });
  await rememberPanelWindowId(win?.id ?? null);
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

async function handleOpenPanel() {
  try {
    await openPanelWindow();
  } catch (err) {
    console.error("Failed to open panel:", err);
  }
}

// Icon click / Alt+J opens the single panel.
chrome.action.onClicked.addListener(() => {
  handleOpenPanel();
});

chrome.commands.onCommand.addListener((command) => {
  (async () => {
    if (command === "scrape_and_apply" || command === "generate_docs" || command === "easy_apply") {
      await openPanelWindow();
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
  isRunning = false;
  generationCancelRequested = false;
  stopKeepAlive();
  await chrome.storage.local.set({
    generation_running: false,
    generation_cancel_requested: false,
    generation_status: "Ready."
  });
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  isRunning = false;
  generationCancelRequested = false;
  stopKeepAlive();
  await chrome.storage.local.set({
    generation_running: false,
    generation_cancel_requested: false,
    generation_status: "Ready."
  });
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

registerCaptureAlarmListener();

async function setStatus(status) {
  await chrome.storage.local.set({ generation_status: status });
}

function clearGenerationCancel() {
  generationCancelRequested = false;
  generationAbortController = new AbortController();
  setChatAbortSignal(generationAbortController.signal);
  chrome.storage.local.set({ generation_cancel_requested: false }).catch(() => {});
}

function requestGenerationCancel() {
  generationCancelRequested = true;
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
  chrome.storage.local.set({ generation_cancel_requested: false }).catch(() => {});
}

function assertNotCancelled() {
  if (generationCancelRequested || generationAbortController?.signal?.aborted) {
    throw new Error("Generation cancelled by user.");
  }
}

function isCancelError(err) {
  return /cancelled by user/i.test(String(err?.message || err || ""));
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
 * Open (or reuse) a job URL and probe whether the posting is closed.
 * @returns {Promise<{ tabId: number|null, closed: string, url: string }>}
 */
async function openAndProbeJobAvailability(url, { active = false, reuseTabId = null } = {}) {
  const target = String(url || "").trim();
  if (!isHttpUrl(target)) {
    return { tabId: null, closed: "", url: target };
  }

  let tabId = reuseTabId;
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
      if (!tabId) return { tabId: null, closed: "", url: target };
      await waitForPageReady(tabId);
    }
  } else {
    await navigateTabToUrl(tabId, target);
  }

  try {
    await ensureAutofillScript(tabId);
    const probe = await sendMessageToTab(
      tabId,
      { type: "probe_application_form" },
      { attempts: 3 }
    );
    const closed = String(probe?.jobUnavailable || "").trim();
    return { tabId, closed, url: target };
  } catch {
    return { tabId, closed: "", url: target };
  }
}

async function recoverInterruptedImportedJobs() {
  const INTERUPTED_AFTER_MS = 10 * 60 * 1000; // 10 minutes

  const data = await chrome.storage.local.get([IMPORTED_JOBS_BY_ID_KEY, IMPORTED_JOBS_VERSION_KEY]);
  const byId = data[IMPORTED_JOBS_BY_ID_KEY] || {};
  const now = Date.now();

  let changed = false;

  for (const [jobId, job] of Object.entries(byId)) {
    const s = String(job?.status || "");
    if (!["opening", "generating", "opening_form", "filling"].includes(s)) continue;

    const updatedAt = Number(job?.updatedAt || job?.createdAt || 0);
    if (!updatedAt) continue;
    if (now - updatedAt < INTERUPTED_AFTER_MS) continue;

    byId[jobId] = {
      ...job,
      status: "failed",
      statusDetail: "Interrupted (service worker restarted). Retry.",
      updatedAt: now
    };
    changed = true;
  }

  if (changed) {
    await setImportedJobsById(byId, { bumpVersion: true });
  }
}

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

// Must match SCRIPT_BUILD in content/autofill.js.
const AUTOFILL_SCRIPT_BUILD = "2026-08-18.1";

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
  const host = hostnameFromUrl(url);
  if (host.includes("dice.com")) return "dice";
  if (host.includes("jobright.ai")) return "jobright";
  return "generic";
}

async function ensureAutofillScript(tabId) {
  // Inject into every frame — iCIMS / some Workday pages host the form inside
  // an iframe. The content script guards itself with SCRIPT_BUILD so re-inject is safe.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/autofill.js"]
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
    files: ["content/autofill.js"]
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
 * Answer application questions: Q&A bank first for reusable/simple items,
 * then OpenAI last resort. Complex JD essays are never stored in the bank.
 * @returns {Promise<Array<{ id: string, answer: string, source?: string }>>}
 */
async function resolveTextAnswers({
  questions,
  applicantInfo,
  jobMeta = {},
  resumeText = "",
  profileId = "",
  applicationBrief = null,
  site = ""
}) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return [];

  const resolved = [];
  const stillNeed = [];
  let bankHits = 0;

  for (const q of list) {
    if (!isComplexQuestion(q)) {
      let match = null;
      try {
        match = await findQaMatch(profileId, q.label);
      } catch {
        match = null;
      }
      if (match?.record?.answer) {
        resolved.push({ id: q.id, answer: match.record.answer, source: "bank" });
        recordQaUsage(match.record.id).catch(() => {});
        bankHits += 1;
        continue;
      }
    }
    stillNeed.push(q);
  }

  queueUnbankedQuestions(profileId, stillNeed, site);

  if (stillNeed.length) {
    const { apiKey, model } = await getOpenAiSettings();
    const brief = applicationBrief || (await getApplicationBrief());
    const aiResult = await generateHumanizedApplicationAnswers({
      apiKey,
      model,
      questions: stillNeed,
      applicantInfo,
      jobMeta,
      resumeText,
      applicationBrief: brief
    });
    if (aiResult.usage) {
      await logLlmCall({
        purpose: "autofill_text",
        model,
        inputTokens: aiResult.usage.prompt_tokens,
        outputTokens: aiResult.usage.completion_tokens
      });
    }
    const byId = new Map(
      (aiResult.answers || []).map((a) => [a.id, String(a?.answer || "").trim()])
    );
    for (const q of stillNeed) {
      const answer = byId.get(q.id) || "";
      if (!answer) continue;
      resolved.push({ id: q.id, answer, source: "ai" });
      if (shouldBankAnswer(q, answer, q.fieldType || "text")) {
        await saveReusableQa({
          profileId,
          question: q.label,
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
 * Resolve CHOICE questions: Q&A bank first, then AI constrained to options.
 * AI answers are written back to the bank.
 */
async function resolveChoiceAnswers(
  profileId,
  questions,
  applicantInfo = {},
  jobMeta = {},
  resumeText = "",
  { applicationBrief = null, site = "" } = {}
) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  const resolved = [];
  const stillNeed = [];
  let bankHits = 0;

  for (const q of list) {
    let match = null;
    try {
      match = await findQaMatch(profileId, q.label);
    } catch {
      match = null;
    }
    if (match?.record?.answer) {
      resolved.push({ id: q.id, answer: match.record.answer, source: "bank" });
      recordQaUsage(match.record.id).catch(() => {});
      bankHits += 1;
    } else {
      stillNeed.push(q);
    }
  }

  queueUnbankedQuestions(profileId, stillNeed, site);

  if (stillNeed.length) {
    try {
      const { apiKey, model } = await getOpenAiSettings();
      const withOptions = stillNeed.filter((q) => Array.isArray(q.options) && q.options.length);
      if (withOptions.length) {
        await setStatus(`Choosing answers for ${withOptions.length} dropdown/radio question(s)...`);
        const brief = applicationBrief || (await getApplicationBrief());
        const aiResult = await generateConstrainedChoiceAnswers({
          apiKey,
          model,
          questions: withOptions,
          applicantInfo,
          jobMeta,
          resumeText,
          applicationBrief: brief
        });
        if (aiResult.usage) {
          await logLlmCall({
            purpose: "autofill_choice",
            model,
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
              question: q.label,
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

/**
 * Autofill the currently open application page using the selected profile's answers.
 * Also injects last generated resume / cover letter PDFs into matching file inputs.
 * Unmatched question fields are answered from the Q&A bank, then OpenAI.
 */
async function startAutofillOnCurrentPage(profileId, tabId = null, { uploadDocs = null } = {}) {
  const applicantInfo = await getApplicantInfo(profileId);
  const hasAnyValue = Object.values(applicantInfo).some((v) => String(v || "").trim());
  const docs = uploadDocs || (await getLastGeneratedDocs());
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
      error: "The current tab is not a web page. Open the application form, then click Autofill."
    };
  }

  const credentials = await getAccountCredentials();
  // Create-login forms often want the Login field to be the email address.
  if (!credentials.email && applicantInfo.email) {
    credentials.email = String(applicantInfo.email || "").trim();
  }

  await ensureAutofillScript(tab.id);
  const frameResults = await sendMessageToAllFrames(tab.id, {
    type: "autofill_application",
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

  let aiFilledCount = 0;
  let choiceFilledCount = 0;
  let bankHits = 0;
  let llmAnswerCount = 0;
  const unmatched = Array.isArray(result?.unmatchedQuestions) ? result.unmatchedQuestions : [];
  const unmatchedChoice = Array.isArray(result?.unmatchedChoiceQuestions)
    ? result.unmatchedChoiceQuestions
    : [];

  const site = hostnameFromUrl(tab.url || "");
  await ensureCostSession(ctx.jobMeta.jdLink || ctx.jobMeta.jobTitle || tab.url || "");

  // Q&A bank first for dropdown/checkbox/radio, then AI last resort (saved back).
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
          { applicationBrief: ctx.applicationBrief, site }
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
    const needAiCount = unmatched.filter((q) => isComplexQuestion(q)).length;
    await setStatus(
      needAiCount
        ? `Checking Q&A bank, then AI for ${unmatched.length} question(s)...`
        : `Checking Q&A bank for ${unmatched.length} question(s)...`
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
          site
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
 * Drive multi-step Auto Apply on any ATS / job board:
 * fill all frames â†’ if Next/Continue (no final Submit) click it â†’ wait for
 * next page/tab/step â†’ refill. Stops before Submit so the user can review.
 */
async function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/** Wait for load + a short SPA settle so the job/apply page is actually visible. */
async function waitForPageReady(tabId, timeoutMs = 30000) {
  await awaitTabComplete(tabId, timeoutMs);
  const deadline = Date.now() + 8000;
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
          await sleepMs(500);
          return;
        }
      } catch {
        await sleepMs(400);
        return;
      }
    }
    await sleepMs(300);
  }
  await sleepMs(400);
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
  const rank = { next: 1, review: 2, entry: 3, submit: 4 };
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
  const anyForm = frameResults.some((f) => f?.isApplicationForm);
  const blockedReason =
    frameResults.find((f) => f?.blockedReason)?.blockedReason || "";
  const jobUnavailable =
    frameResults.find((f) => f?.jobUnavailable)?.jobUnavailable || "";
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
    applyUrls,
    signature: best?.signature || frameResults[0]?.signature || "",
    href: best?.href || frameResults[0]?.href || ""
  };
}

async function getApplyActionFromTab(tabId) {
  await ensureAutofillScript(tabId);
  const frames = await sendMessageToAllFrames(tabId, { type: "get_apply_action" }, { attempts: 1 });
  return pickBestApplyAction(frames);
}

async function waitForApplyAdvance(tabId, prevSig, prevUrl, timeoutMs = 15000) {
  const start = Date.now();
  const knownTabIds = new Set((await chrome.tabs.query({})).map((t) => t.id));

  while (Date.now() - start < timeoutMs) {
    await sleepMs(400);

    // Apply links often use target=_blank. Fold that new tab back into THIS tab
    // so we never leave two copies of the same application page.
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
  }
  return { advanced: false, tabId, reason: "timeout" };
}

/**
 * Universal multi-step Auto Apply (Jobright-style): fill â†’ Next if no Submit â†’
 * wait for next page/tab â†’ refill. Never auto-clicks final Submit.
 */
async function startMultiStepApplyOnTab(
  profileId,
  tabId = null,
  { maxSteps = 14, uploadDocs = null } = {}
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

  await waitForPageReady(tab.id);

  let currentTabId = tab.id;
  const site = detectSiteFromUrl(tab.url);
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
    tabUrl: tab.url || ""
  };

  let noAdvance = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    await setStatus(`Auto Apply: step ${step + 1}/${maxSteps} — checking page...`);
    await ensureAutofillScript(currentTabId);

    let probe = await getApplyActionFromTab(currentTabId).catch(() => ({
      best: null,
      anyForm: false,
      blockedReason: "",
      jobUnavailable: "",
      applyUrls: [],
      signature: "",
      href: ""
    }));

    if (probe.jobUnavailable) {
      summary.status = "unavailable";
      summary.detail = probe.jobUnavailable;
      summary.tabId = currentTabId;
      return summary;
    }

    // Not on a form yet: click Easy Apply / Apply, or follow apply URL.
    if (!probe.anyForm && (!probe.best || probe.best.action.type === "entry")) {
      const live = await chrome.tabs.get(currentTabId).catch(() => null);
      const prevUrl = live?.url || "";
      const prevSig = probe.signature || "";

      if (probe.best?.action?.type === "entry") {
        const clickRes = await sendMessageToTab(
          currentTabId,
          { type: "click_apply_action", preferredType: "entry" },
          { attempts: 2, frameId: probe.best.frameId }
        );
        if (clickRes?.navigateUrl) {
          await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
        }
      } else {
        const entry = await sendMessageToTab(
          currentTabId,
          { type: "click_easy_apply_entry" },
          { attempts: 2 }
        ).catch(() => null);
        if (entry?.navigateUrl) {
          await navigateTabToUrl(currentTabId, entry.navigateUrl);
        } else if (!entry?.clicked && probe.applyUrls?.length) {
          const nextUrl = String(probe.applyUrls[0] || "").trim();
          const liveUrl = (await chrome.tabs.get(currentTabId).catch(() => null))?.url || "";
          if (nextUrl && normalizeUrlForMatch(nextUrl) !== normalizeUrlForMatch(liveUrl)) {
            await navigateTabToUrl(currentTabId, nextUrl);
          }
        } else if (!entry?.clicked && probe.blockedReason) {
          summary.status = "needs_review";
          summary.detail = probe.blockedReason;
          summary.tabId = currentTabId;
          return summary;
        }
      }

      const advanced = await waitForApplyAdvance(currentTabId, prevSig, prevUrl, 12000);
      currentTabId = advanced.tabId;
      probe = await getApplyActionFromTab(currentTabId).catch(() => probe);

      if (!probe.anyForm && !(probe.best && probe.best.action.type !== "entry")) {
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
        summary.detail =
          (probe.blockedReason ||
            "No application form found on this page. Open the apply form, then run Auto Apply.") +
          credNote;
        summary.tabId = currentTabId;
        return summary;
      }
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

    await setStatus(`Auto Apply: step ${step + 1}/${maxSteps} — filling form...`);
    const fillRes = await startAutofillOnCurrentPage(profileId, currentTabId, { uploadDocs });
    if (fillRes?.skipped && step === 0) {
      return { ok: false, error: fillRes.error || "Autofill skipped.", ...summary, status: "failed" };
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

    probe = await getApplyActionFromTab(currentTabId).catch(() => ({ best: null, anyForm: false }));

    if (!probe.best) {
      summary.status = probe.anyForm ? "ready_for_review" : "needs_review";
      summary.detail = probe.anyForm
        ? "Filled the form. No Next/Submit button detected — please review and submit."
        : "No application form or action button found on this page.";
      return summary;
    }

    if (probe.best.action.type === "submit") {
      summary.status = "ready_for_review";
      summary.detail = `Reached the final Submit step (${probe.best.action.text || "Submit"}). Stopped so you can review and submit.`;
      return summary;
    }

    // Next / Continue / Review / entry — advance then refill.
    const live = await chrome.tabs.get(currentTabId).catch(() => null);
    const prevUrl = live?.url || "";
    const prevSig = probe.signature || "";
    const actionType = probe.best.action.type;

    await setStatus(`Auto Apply: clicking ${probe.best.action.text || actionType}...`);
    const clickRes = await sendMessageToTab(
      currentTabId,
      { type: "click_apply_action", preferredType: actionType },
      { attempts: 2, frameId: probe.best.frameId }
    ).catch((err) => ({ ok: false, error: String(err?.message || err) }));

    if (clickRes?.isSubmit) {
      summary.status = "ready_for_review";
      summary.detail = "Reached the final Submit step. Stopped so you can review and submit.";
      return summary;
    }
    if (clickRes?.navigateUrl) {
      await navigateTabToUrl(currentTabId, clickRes.navigateUrl);
    }

    const advanced = await waitForApplyAdvance(currentTabId, prevSig, prevUrl, 15000);
    currentTabId = advanced.tabId;
    summary.tabId = currentTabId;

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
  text-align: justify !important;
  text-justify: inter-word !important;
}
ul { margin-top: 0 !important; margin-bottom: 6px !important; }
li { margin-bottom: 3px !important; }
h2 + p, h2 + ul, h2 + div, h2 + h3 { margin-top: 3px !important; }
h2 + p.education { margin-top: 1.15em !important; }
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

async function htmlToPdfBase64(html) {
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error("Failed to create render tab.");
  const tabId = tab.id;

  try {
    await awaitTabComplete(tabId);
    // Give layout/fonts a brief moment after "complete".
    await new Promise((resolve) => setTimeout(resolve, 250));
    const debuggee = { tabId };
    await debuggerAttach(debuggee);
    try {
      await debuggerCommand(debuggee, "Page.enable");
      const result = await debuggerCommand(debuggee, "Page.printToPDF", {
        printBackground: true,
        paperWidth: 8.27,
        paperHeight: 11.69,
        marginTop: 0.4,
        marginBottom: 0.4,
        marginLeft: 0.35,
        marginRight: 0.35,
        preferCSSPageSize: true
      });
      if (!result?.data) throw new Error("PDF generation failed.");
      return result.data;
    } finally {
      await debuggerDetach(debuggee);
    }
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
  const html = resumeJsonToHtml(resumeData, templateId);
  const pdfBase64 = await htmlToPdfBase64(html);

  const personName = String(resumeData?.name || "").trim() || "Candidate";
  const folderName = await buildJobFolderName(jobMeta, personName);
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
  const html = buildCoverLetterHtml(rawCoverText, contact);
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
        await openPanelWindow();
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
      await openPanelWindow();
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
    await openPanelWindow();
  } catch {
    /* panel may already be open */
  }

  await setStatus(
    `Click anywhere in the extension panel to unlock ${rootLabel || "the output folder"} and finish saving ${folderName}.`
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

  // Ensure the panel is open so it can write with the directory handle (silent).
  try {
    await openPanelWindow();
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
      return { pathLabel, folderName, docs };
    }

    if (flushResult?.needsPermission) {
      pathLabel = await waitForPanelFolderUnlock(rootLabel, folderName);
      if (pathLabel) return { pathLabel, folderName, docs };
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
    return { pathLabel, folderName, docs };
  }

  throw new Error(
    `Could not save into the selected folder (${lastError}). The files are still queued — click "Grant access" in the extension panel to finish writing them.`
  );
}

async function saveResumeAndCoverLetter(output, resumeData, jobMeta, { apiKey, model, runCoverLetter = true } = {}) {
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
        companyName: jobMeta.companyName || ""
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

  if (jobMeta.spreadsheetUrl || jobMeta.sheetsWebAppUrl) {
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
        workArrangement: jobMeta.workArrangement || "",
        employmentType: jobMeta.employmentType || "",
        salaryMin: jobMeta.salaryMin || "",
        salaryMax: jobMeta.salaryMax || "",
        datePosted: jobMeta.datePosted || "",
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
  const resumeOnly = meta.resumeOnly === true;
  await ensureCostSession(meta.jdLink || meta.jobTitle || "");

  assertNotCancelled();
  await setStatus("Building resume prompt...");
  const resumePrompt = await buildPrompt(profileId, meta.jdText || "", {
    jobTitle: meta.jobTitle || "",
    companyName: meta.companyName || ""
  });

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
        content:
          "Reminder: return the COMPLETE resume JSON now. Skills items must be long and dense. Experience must include all required jobs with full long-form bullet counts (each bullet ~170–240 characters). Do not shorten or omit sections."
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

  data = await ensureResumeSkills(data, {
    apiKey,
    model,
    jdText: meta.jdText || ""
  });

  assertNotCancelled();
  await setStatus("Scoring resume against the job description...");
  let improved;
  try {
    improved = await ensureAtsReadyResume(data, {
      apiKey,
      model,
      jdText: meta.jdText || "",
      jobTitle: meta.jobTitle || "",
      companyName: meta.companyName || "",
      setStatus
    });
    data = improved.data || data;
  } catch (rewriteErr) {
    if (isCancelError(rewriteErr)) throw rewriteErr;
    await setStatus(
      `ATS rewrite skipped (${String(rewriteErr?.message || rewriteErr)}). Using the generated resume.`
    );
    improved = {
      data,
      atsReport: scoreResumeAgainstJd(data, {
        jdText: meta.jdText || "",
        jobTitle: meta.jobTitle || ""
      })
    };
  }

  assertNotCancelled();
  data = await ensureResumeSkills(data, {
    apiKey,
    model,
    jdText: meta.jdText || ""
  });

  const scoredFinal = scoreResumeAgainstJd(data, {
    jdText: meta.jdText || "",
    jobTitle: meta.jobTitle || ""
  });
  const atsReport = {
    ...scoredFinal,
    rewritten: Boolean(improved?.atsReport?.rewritten),
    rewriteAttempts: Number(improved?.atsReport?.rewriteAttempts || 0),
    previousScore: improved?.atsReport?.previousScore ?? scoredFinal.score,
    finalScore: scoredFinal.score,
    rewriteIssues: improved?.atsReport?.rewriteIssues || []
  };

  const rawText = JSON.stringify(data, null, 2);
  await chrome.storage.local.set({ last_response: rawText, last_ats_report: atsReport });
  const finalPct = Math.round(Number(atsReport.finalScore ?? atsReport.score) || 0);
  const rewriteNote = atsReport.rewritten
    ? ` Final ATS ${finalPct}% (was ${Math.round(Number(atsReport.previousScore))}%).`
    : ` Final ATS ${finalPct}%.`;
  await setStatus(
    resumeOnly
      ? `Resume JSON ready.${rewriteNote} Rendering PDF (skipping cover letter)...`
      : `Resume JSON ready.${rewriteNote} Rendering PDF + cover letter...`
  );

  assertNotCancelled();
  const saved = await saveResumeAndCoverLetter(rawText, data, meta, {
    apiKey,
    model,
    runCoverLetter: !resumeOnly
  });

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
    status: `${saved.status} Click Autofill on the application page when ready. ${costLine}`.trim()
  };
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (buttonIndex !== 0) return;
  (async () => {
    try {
      const { getLastSaveMeta } = await import("./fs-output.js");
      const meta = await getLastSaveMeta();
      if (meta?.method === "fs") {
        await openPanelWindow();
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
    if (!isRunning) {
      safeSendResponse(sendResponse, { ok: false, error: "Nothing is generating." });
      return false;
    }
    requestGenerationCancel();
    setStatus("Generation cancelled by user.");
    safeSendResponse(sendResponse, { ok: true, cancelling: true });
    return false;
  }

  if (message?.type === "reset_generation_state") {
    (async () => {
      try {
        isRunning = false;
        finishGenerationCancelState();
        stopKeepAlive();
        await chrome.storage.local.set({
          generation_status: "Reset complete. Ready for next run.",
          generation_running: false,
          last_response: "",
          last_application_brief: null,
          last_ats_report: null
        });
        safeSendResponse(sendResponse, { ok: true });
      } catch (err) {
        isRunning = false;
        stopKeepAlive();
        await chrome.storage.local.set({ generation_running: false });
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
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
        const res = await sendMessageToTab(
          tab.id,
          { type: "scrape_job_page" },
          { attempts: 3 }
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

  if (message?.type === "autofill_current_page") {
    (async () => {
      try {
        const profileId = message.profileId;
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
          return;
        }
        await setStatus("Autofilling current application page...");
        const result = await startAutofillOnCurrentPage(profileId);
        if (result.skipped) {
          await setStatus(`Autofill skipped: ${result.error}`);
          safeSendResponse(sendResponse, { ok: false, error: result.error });
          return;
        }
        if (!result.ok) {
          const err = result.error || "Autofill failed.";
          await setStatus(`Autofill failed: ${err}`);
          safeSendResponse(sendResponse, { ok: false, error: err });
          return;
        }
        const msg =
          `Autofilled ${result.filledCount || 0} field(s)` +
          (result.credentialFilledCount ? `, login ${result.credentialFilled.join("/")}` : "") +
          (result.uploadedCount ? `, uploaded ${result.uploadedCount} file(s)` : "") +
          (result.bankHits ? `, ${result.bankHits} from Q&A bank` : "") +
          (result.choiceFilledCount ? `, ${result.choiceFilledCount} choice(s)` : "") +
          (result.aiFilledCount ? `, AI-answered ${result.aiFilledCount} question(s)` : "") +
          (result.aiError ? ` (AI answers failed: ${result.aiError})` : "") +
          " on the current page. " +
          (await getCostSummaryText());
        await setStatus(msg);
        safeSendResponse(sendResponse, { ok: true, ...result, status: msg });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Autofill failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
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
    (async () => {
      try {
        const profileId = message.profileId;
        if (!profileId) {
          safeSendResponse(sendResponse, { ok: false, error: "Select a profile first." });
          return;
        }
        await setStatus("Running Auto Apply on the current page...");
        const result = await startMultiStepApplyOnTab(profileId);
        if (!result.ok) {
          await setStatus(`Auto Apply failed: ${result.error}`);
          safeSendResponse(sendResponse, result);
          return;
        }
        const costLine = await getCostSummaryText();
        const msg =
          `Auto Apply (${result.site || "site"}): ${result.status || "done"} — ` +
          `${result.steps || 0} step(s), filled ${result.filled || 0}, ` +
          `bank ${result.bankHits || 0}, AI ${result.aiFilled || 0}. ${result.detail || ""} ${costLine}`.trim();
        await setStatus(msg);
        const stored = await chrome.storage.local.get([
          "last_job_title",
          "last_company_name",
          "last_jd_link"
        ]);
        await appendApplicationEvent({
          profileId,
          jobTitle: stored.last_job_title || "",
          companyName: stored.last_company_name || "",
          jdLink: stored.last_jd_link || result.tabUrl || "",
          status:
            result.status === "submitted" || result.status === "ready_for_review"
              ? result.status === "submitted"
                ? "completed"
                : "ready_for_review"
              : result.status || "ready_for_review",
          source: result.site || "",
          detail: result.detail || ""
        });
        safeSendResponse(sendResponse, { ...result, status: msg });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Auto Apply failed: ${error}`);
        safeSendResponse(sendResponse, { ok: false, error });
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
    if (isRunning) {
      safeSendResponse(sendResponse, { ok: false, error: "Generation already in progress." });
      return false;
    }

    isRunning = true;
    clearGenerationCancel();
    startKeepAlive();
    chrome.storage.local.set({ generation_running: true });

    safeSendResponse(sendResponse, { ok: true, started: true });

    (async () => {
      try {
        await setStatus(`Imported job: opening URL...`);
        await setImportedJobStatus(importedJobId, {
          status: "opening",
          statusDetail: "Opening job URL...",
          markAttempt: true,
          profileId
        });

        const url = String(jobMeta.jdLink || "").trim();
        if (!url) {
          throw new Error("Missing job URL (jdLink).");
        }

        // Reuse a tab already showing this job (e.g. opened via "See job")
        // instead of opening the page again.
        let tabId;
        const existingTab = await findTabByUrl(url);
        if (existingTab?.id != null) {
          tabId = existingTab.id;
          await chrome.tabs.update(tabId, { active: true }).catch(() => {});
          if (existingTab.windowId != null) {
            await chrome.windows
              .update(existingTab.windowId, { focused: true })
              .catch(() => {});
          }
          await waitForPageReady(tabId);
        } else {
          const tab = await chrome.tabs.create({ url, active: true });
          tabId = tab?.id;
          if (!tabId) throw new Error("Failed to open browser tab.");
          await waitForPageReady(tabId);
        }

        // Stop early if the posting is gone (expired / filled / removed / 404) so
        // we don't waste an OpenAI call — and remove it from the list.
        try {
          await ensureAutofillScript(tabId);
          const availProbe = await sendMessageToTab(
            tabId,
            { type: "probe_application_form" },
            { attempts: 2 }
          );
          if (availProbe?.jobUnavailable) {
            await removeImportedJobFromStorage(importedJobId);
            await setStatus(
              `Job closed — removed from list: ${availProbe.jobUnavailable}`
            );
            return;
          }
        } catch {
          /* availability probe is best-effort; continue on failure */
        }

        // Persist job fields so AI Q&A has the correct context.
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
          await setStatus(`Using saved files for this job: ${resumeName}${coverName}`);
          await setImportedJobStatus(importedJobId, {
            status: "opening_form",
            statusDetail: "Resume ready — opening application form..."
          });
        } else if (extractFolderNameFromSaveMeta(liveJob?.resumeFolder || "")) {
          throw new Error(
            "A resume was generated for this job, but the saved PDFs could not be loaded from the output folder. Click in the extension panel to unlock the folder, then Apply again."
          );
        } else {
          const resumeOnlyStored =
            (await chrome.storage.local.get("generate_resume_only")).generate_resume_only === true;
          const trackStored =
            (await chrome.storage.local.get("track_application_status")).track_application_status ===
            true;
          const genMeta = {
            ...jobMeta,
            resumeOnly: resumeOnlyStored,
            trackApplicationStatus:
              jobMeta.trackApplicationStatus === true || trackStored,
            importedJobId
          };
          await setImportedJobStatus(importedJobId, {
            status: "generating",
            statusDetail: resumeOnlyStored
              ? "Generating resume only..."
              : "Generating resume & cover letter..."
          });
          await setStatus(`Generating resume for imported job...`);
          const saved = await runGenerationPipeline({ profileId, jobMeta: genMeta });
          uploadDocs = saved?.docs || (await getGeneratedDocsForJob(importedJobId));
          await setImportedJobStatus(importedJobId, {
            status: "opening_form",
            statusDetail: "Waiting for the job page, then Auto Apply...",
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
        await waitForPageReady(tabId);
        const site = detectSiteFromUrl(liveTab.url || url);

        try {
          await ensureAutofillScript(tabId);
          const probe = await sendMessageToTab(tabId, { type: "probe_application_form" }, { attempts: 2 });
          if (probe?.jobUnavailable) {
            await removeImportedJobFromStorage(importedJobId);
            await setStatus(`Job closed — removed from list: ${probe.jobUnavailable}`);
            return;
          }
        } catch {
          /* availability probe is best-effort; Auto Apply handles the rest */
        }

        // Re-activate right before fill so this job's PDFs win over any later batch job.
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

        await setImportedJobStatus(importedJobId, {
          status: "filling",
          statusDetail: `Running Auto Apply (${site})...`
        });
        await setStatus(
          `Running Auto Apply (${site}) with ${uploadDocs.resume?.fileName || "resume"}${
            uploadDocs.coverLetter?.fileName ? ` + ${uploadDocs.coverLetter.fileName}` : ""
          }...`
        );

        const ea = await startMultiStepApplyOnTab(profileId, tabId, {
          maxSteps: 10,
          uploadDocs
        });
        if (!ea.ok && ea.error) throw new Error(ea.error);

        if (ea.status === "unavailable") {
          await removeImportedJobFromStorage(importedJobId);
          await setStatus(`Job closed — removed from list: ${ea.detail || "unavailable"}`);
          return;
        }

        const nextStatus =
          ea.status === "submitted"
            ? "completed"
            : ea.status === "needs_review"
              ? "needs_review"
              : "ready_for_review";
        await setImportedJobStatus(importedJobId, {
          status: nextStatus,
          statusDetail:
            `Auto Apply (${site}): ${ea.status || "done"}. ` +
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
        await setStatus(
          `Imported job Auto Apply: ${ea.status || "done"} (no submit). ${await getCostSummaryText()}`
        );
      } catch (err) {
        const error = String(err?.message || err);
        if (isCancelError(err)) {
          await setStatus("Generation cancelled by user.");
          await setImportedJobStatus(importedJobId, {
            status: "failed",
            statusDetail: "Cancelled by user.",
            profileId
          });
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
        await chrome.storage.local.set({ generation_running: false });
        isRunning = false;
        finishGenerationCancelState();
        stopKeepAlive();
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
    if (isRunning) {
      safeSendResponse(sendResponse, { ok: false, error: "Generation already in progress." });
      return false;
    }

    isRunning = true;
    clearGenerationCancel();
    startKeepAlive();
    chrome.storage.local.set({ generation_running: true });
    safeSendResponse(sendResponse, { ok: true, started: true, total: jobIds.length });

    (async () => {
      let okCount = 0;
      let failCount = 0;
      let closedCount = 0;
      let cancelled = false;
      let probeTabId = null;
      try {
        let byId = await getImportedJobsById();
        const resumeOnlyStored =
          (await chrome.storage.local.get("generate_resume_only")).generate_resume_only === true;
        const trackStored =
          (await chrome.storage.local.get("track_application_status")).track_application_status ===
          true;

        for (let i = 0; i < jobIds.length; i += 1) {
          try {
            assertNotCancelled();
          } catch {
            cancelled = true;
            break;
          }

          const importedJobId = jobIds[i];
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
            const probe = await openAndProbeJobAvailability(jobUrl, {
              active: false,
              reuseTabId: probeTabId
            });
            probeTabId = probe.tabId || probeTabId;
            if (probe.closed) {
              closedCount += 1;
              await removeImportedJobFromStorage(importedJobId);
              await setStatus(
                `Closed — removed from list: ${job.jobTitle || importedJobId} (${probe.closed})`
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
            importedJobId
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

          try {
            const saved = await runGenerationPipeline({ profileId, jobMeta });
            okCount += 1;
            await setImportedJobStatus(importedJobId, {
              status: "generated",
              statusDetail: saved?.status || "Resume saved.",
              profileId,
              patch: {
                hasGeneratedResume: true,
                resumeFolder: saved?.folderName || "",
                resumeFileName: saved?.resumeFileName || "",
                coverLetterFileName: saved?.coverLetterFileName || ""
              }
            });
          } catch (err) {
            if (isCancelError(err)) {
              cancelled = true;
              await setImportedJobStatus(importedJobId, {
                status: "failed",
                statusDetail: "Cancelled by user.",
                profileId
              });
              break;
            }
            failCount += 1;
            const error = String(err?.message || err);
            await setImportedJobStatus(importedJobId, {
              status: "failed",
              statusDetail: error,
              profileId
            });
            await setStatus(`Batch item failed (${jobMeta.jobTitle || importedJobId}): ${error}`);
          }
        }

        const closedNote = closedCount ? `, ${closedCount} closed/removed` : "";
        if (cancelled) {
          await setStatus(
            `Batch resume build stopped: ${okCount} saved, ${failCount} failed${closedNote} before cancel. ${await getCostSummaryText()}`
          );
        } else {
          await setStatus(
            `Batch resume build finished: ${okCount} saved, ${failCount} failed${closedNote}. ${await getCostSummaryText()}`
          );
        }
      } catch (err) {
        if (isCancelError(err)) {
          await setStatus("Generation cancelled by user.");
        } else {
          await setStatus(`Batch resume build failed: ${String(err?.message || err)}`);
        }
      } finally {
        if (probeTabId) {
          await chrome.tabs.remove(probeTabId).catch(() => {});
        }
        await chrome.storage.local.set({ generation_running: false });
        isRunning = false;
        finishGenerationCancelState();
        stopKeepAlive();
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
    if (isRunning) {
      safeSendResponse(sendResponse, {
        ok: false,
        error: "Another job is already running. Stop it first, then check availability."
      });
      return false;
    }

    isRunning = true;
    clearGenerationCancel();
    startKeepAlive();
    chrome.storage.local.set({ generation_running: true });
    safeSendResponse(sendResponse, { ok: true, started: true, total: jobIds.length });

    (async () => {
      let closedCount = 0;
      let openCount = 0;
      let failedCount = 0;
      let cancelled = false;
      let probeTabId = null;
      try {
        for (let i = 0; i < jobIds.length; i += 1) {
          try {
            assertNotCancelled();
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
              status: priorStatus,
              statusDetail: "No job URL to check."
            });
            continue;
          }

          const probe = await openAndProbeJobAvailability(jobUrl, {
            active: false,
            reuseTabId: probeTabId
          });
          probeTabId = probe.tabId || probeTabId;

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

          openCount += 1;
          let restoredStatus = priorStatus;
          if (priorStatus === "unavailable" || priorStatus === "opening") {
            restoredStatus = job.hasGeneratedResume ? "generated" : "imported";
          }
          await setImportedJobStatus(importedJobId, {
            status: restoredStatus,
            statusDetail: "Still open."
          });
        }

        if (cancelled) {
          await setStatus(
            `Availability check cancelled. Closed ${closedCount}, still open ${openCount}, failed ${failedCount}.`
          );
        } else {
          await setStatus(
            `Availability check done. Closed ${closedCount} (red), still open ${openCount}, failed ${failedCount}.`
          );
        }
      } catch (err) {
        if (isCancelError(err)) {
          await setStatus("Availability check cancelled by user.");
        } else {
          await setStatus(`Availability check failed: ${String(err?.message || err)}`);
        }
      } finally {
        if (probeTabId) {
          await chrome.tabs.remove(probeTabId).catch(() => {});
        }
        await chrome.storage.local.set({ generation_running: false });
        isRunning = false;
        finishGenerationCancelState();
        stopKeepAlive();
      }
    })();

    return false;
  }

  if (message?.type !== "generate_resume") {
    return undefined;
  }

  if (isRunning) {
    safeSendResponse(sendResponse, { ok: false, error: "Generation already in progress." });
    return undefined;
  }

  isRunning = true;
  clearGenerationCancel();
  startKeepAlive();
  chrome.storage.local.set({ generation_running: true });
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
        await setStatus("Generation cancelled by user.");
      } else {
        await setStatus(`Generation failed: ${String(err?.message || err)}`);
      }
    } finally {
      isRunning = false;
      finishGenerationCancelState();
      stopKeepAlive();
    }
  })();

  return false;
});
