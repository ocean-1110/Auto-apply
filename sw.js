import { appendJobToSpreadsheet } from "./sheets.js";
import {
  ensureCaptureAlarm,
  registerCaptureAlarmListener,
  runUnifiedJobCapture,
  isCaptureRunning as isJobCaptureRunning
} from "./capture-runner.js";
import { buildPrompt, buildCoverLetterPrompt } from "./profiles.js";
import { resumeJsonToHtml, extractResumeJson } from "./resume-json.js";
import { DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import {
  chatCompletion,
  DEFAULT_OPENAI_MODEL,
  RESUME_JSON_SYSTEM_PROMPT
} from "./openai.js";
import { getEnv } from "./env.js";
import { getApplicantInfo, saveApplicantInfo } from "./applicant-info.js";
import { awaitTabComplete } from "./tab-utils.js";
import {
  getOutputDirectoryHandle,
  getOutputDirectoryName,
  setPendingOutputFiles,
  clearPendingOutputFiles,
  setLastSaveMeta
} from "./fs-output.js";
import { setLastGeneratedDocs, pickUploadDocsFromBundle, getLastGeneratedDocs } from "./upload-assets.js";
import { generateHumanizedApplicationAnswers } from "./ai-answers.js";
import { findQaMatch, saveQa, recordQaUsage } from "./qa-store.js";

// Service worker entry (v1.3.5)
let isRunning = false;
let keepAliveTimer = null;
let panelWindowId = null;

// The last real browser window the user looked at, so "scrape/autofill the
// current page" targets the tab they were viewing — not this extension panel
// (a popup-type window) that steals focus when they click a button in it.
let lastFocusedNormalWindowId = null;

const PANEL_WIDTH = 1000;
const PANEL_HEIGHT = 760;
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
  stopKeepAlive();
  await chrome.storage.local.set({
    generation_running: false,
    generation_status: "Ready."
  });
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  isRunning = false;
  stopKeepAlive();
  await chrome.storage.local.set({
    generation_running: false,
    generation_status: "Ready."
  });
  recoverInterruptedImportedJobs().catch(() => {});
  ensureCaptureAlarm().catch(() => {});
});

registerCaptureAlarmListener();

async function setStatus(status) {
  await chrome.storage.local.set({ generation_status: status });
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

async function setImportedJobStatus(jobId, { status, statusDetail = "", markAttempt = false } = {}) {
  if (!jobId) return;
  const byId = await getImportedJobsById();
  const job = byId[jobId];
  if (!job) return;
  const now = Date.now();

  byId[jobId] = {
    ...job,
    status: status || job.status || "imported",
    statusDetail: statusDetail || job.statusDetail || "",
    updatedAt: now,
    ...(markAttempt ? { attempts: Number(job.attempts || 0) + 1, lastAttemptAt: now } : null)
  };

  await setImportedJobsById(byId, { bumpVersion: true });
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
const AUTOFILL_SCRIPT_BUILD = "2026-08-10.2";

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

/**
 * Answer free-text application questions. These depend on the role/JD (e.g.
 * "describe your most challenging project"), so they are always generated fresh
 * by OpenAI and never read from or written to the Q&A bank. Reusable structured
 * answers (dropdowns/checkboxes/radios) are handled separately by the bank.
 * @returns {Promise<Array<{ id: string, answer: string }>>}
 */
async function resolveTextAnswers({ questions, applicantInfo, jobMeta = {}, resumeText = "" }) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  if (!list.length) return [];

  const { apiKey, model } = await getOpenAiSettings();
  const aiAnswers = await generateHumanizedApplicationAnswers({
    apiKey,
    model,
    questions: list,
    applicantInfo,
    jobMeta,
    resumeText
  });

  const byId = new Map(aiAnswers.map((a) => [a.id, String(a?.answer || "").trim()]));
  return list
    .map((q) => ({ id: q.id, answer: byId.get(q.id) || "" }))
    .filter((row) => row.answer);
}

/**
 * Resolve stored answers for novel CHOICE questions (dropdown / checkbox /
 * radio) from the Q&A bank only — never AI. Returns just the ones with a match.
 * @returns {Promise<Array<{ id: string, answer: string }>>}
 */
async function resolveChoiceAnswersFromBank(profileId, questions) {
  const list = (questions || []).filter((q) => q?.id && q?.label);
  const resolved = [];
  for (const q of list) {
    let match = null;
    try {
      match = await findQaMatch(profileId, q.label);
    } catch {
      match = null;
    }
    if (match?.record?.answer) {
      resolved.push({ id: q.id, answer: match.record.answer });
      recordQaUsage(match.record.id).catch(() => {});
    }
  }
  return resolved;
}

/**
 * Autofill the currently open application page using the selected profile's answers.
 * Also injects last generated resume / cover letter PDFs into matching file inputs.
 * Unmatched question fields are answered from the Q&A bank, then OpenAI.
 */
async function startAutofillOnCurrentPage(profileId, tabId = null) {
  const applicantInfo = await getApplicantInfo(profileId);
  const hasAnyValue = Object.values(applicantInfo).some((v) => String(v || "").trim());
  const docs = await getLastGeneratedDocs();
  const hasUploadDocs = Boolean(docs?.resume?.base64 || docs?.coverLetter?.base64);

  if (!hasAnyValue && !hasUploadDocs) {
    return {
      ok: false,
      skipped: true,
      error:
        "No applicant info or generated PDFs found. Edit profile info and/or generate a resume first."
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
    uploadFiles: {
      resume: docs?.resume || null,
      coverLetter: docs?.coverLetter || null
    }
  });
  const result = mergeAutofillFrameResults(frameResults);

  let aiFilledCount = 0;
  let choiceFilledCount = 0;
  const unmatched = Array.isArray(result?.unmatchedQuestions) ? result.unmatchedQuestions : [];
  const unmatchedChoice = Array.isArray(result?.unmatchedChoiceQuestions)
    ? result.unmatchedChoiceQuestions
    : [];

  // Reuse stored answers for novel dropdown/checkbox/radio questions (bank only).
  if (unmatchedChoice.length) {
    try {
      const byFrame = new Map();
      for (const q of unmatchedChoice) {
        const fid = q.frameId;
        if (!byFrame.has(fid)) byFrame.set(fid, []);
        byFrame.get(fid).push(q);
      }
      for (const [frameId, questions] of byFrame) {
        const choiceAnswers = await resolveChoiceAnswersFromBank(profileId, questions);
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
    await setStatus(`Generating fresh AI answer(s) for ${unmatched.length} question(s)...`);
    try {
      const stored = await chrome.storage.local.get([
        "last_job_title",
        "last_company_name",
        "last_jd_text",
        "last_response"
      ]);
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
          jobMeta: {
            jobTitle: stored.last_job_title || "",
            companyName: stored.last_company_name || "",
            jdText: stored.last_jd_text || ""
          },
          resumeText: stored.last_response || ""
        });
        if (!answers.length) continue;
        await setStatus(`Filling ${answers.length} AI answer(s)...`);
        const aiResult = await sendMessageToTab(
          tab.id,
          { type: "autofill_ai_answers", answers },
          { attempts: 2, frameId }
        );
        aiFilledCount += Number(aiResult?.filledCount || 0);
      }
    } catch (aiErr) {
      // Keep profile/file autofill success even if AI Q&A fails.
      return {
        ok: Boolean(result?.ok),
        tabId: tab.id,
        tabUrl: tab.url || "",
        ...result,
        aiFilledCount: 0,
        choiceFilledCount,
        aiError: String(aiErr?.message || aiErr)
      };
    }
  }

  return {
    ok: Boolean(result?.ok),
    tabId: tab.id,
    tabUrl: tab.url || "",
    ...result,
    aiFilledCount,
    choiceFilledCount
  };
}

/**
 * Drive a multi-step "Easy Apply" flow (Dice / Jobright) on a tab: fill each
 * step from profile + Q&A bank + AI, advance through the modal, and stop before
 * the final submit (never auto-submits). The content script owns the DOM loop
 * and calls back for answers via `easy_apply_answer_questions`.
 */
async function startEasyApplyOnTab(profileId, tabId = null) {
  const applicantInfo = await getApplicantInfo(profileId);
  const docs = await getLastGeneratedDocs();

  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : await getCurrentApplicationTab();
  if (!tab?.id) {
    return { ok: false, error: "No application tab found. Open the Dice/Jobright job page first." };
  }
  if (!/^https?:\/\//i.test(tab.url || "")) {
    return { ok: false, error: "The current tab is not a web page. Open the job page, then run Easy Apply." };
  }

  const site = detectSiteFromUrl(tab.url);
  const stored = await chrome.storage.local.get([
    "last_job_title",
    "last_company_name",
    "last_jd_text"
  ]);

  const credentials = await getAccountCredentials();

  await ensureAutofillScript(tab.id);
  const summary = await sendMessageToTab(
    tab.id,
    {
      type: "easy_apply_run",
      profileId,
      site,
      applicantInfo,
      credentials,
      uploadFiles: {
        resume: docs?.resume || null,
        coverLetter: docs?.coverLetter || null
      },
      jobMeta: {
        jobTitle: stored.last_job_title || "",
        companyName: stored.last_company_name || "",
        jdText: stored.last_jd_text || ""
      }
    },
    { attempts: 2 }
  );

  return { ok: Boolean(summary?.ok ?? true), tabId: tab.id, tabUrl: tab.url || "", site, ...summary };
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
    "last_response"
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
    resumeText: stored.last_response || ""
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
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function joinDownloadPath(...parts) {
  return parts
    .map((part) => String(part || "").replace(/^\/+|\/+$/g, "").replace(/\\/g, "/"))
    .filter(Boolean)
    .join("/");
}

/** Job folder: {job_title}-{company}-{name} */
function buildJobFolderName(jobMeta = {}, personName = "") {
  const role = sanitizePathSegment(jobMeta.jobTitle || "Role", "Role");
  const company = sanitizePathSegment(jobMeta.companyName || "Company", "Company");
  const name = sanitizePathSegment(personName || "Candidate", "Candidate");
  return sanitizePathSegment(`${role}-${company}-${name}`, "Role-Company-Candidate");
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
    return `${prefix}<p class="role-company">${c} ${d}</p><p class="role-meta">${t}${
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
  const folderName = buildJobFolderName(jobMeta, personName);
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
      iconUrl: chrome.runtime.getURL("icons/j-icon.svg"),
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
async function commitOutputBundle(folderName, files) {
  try {
    await setLastGeneratedDocs(pickUploadDocsFromBundle(folderName, files));
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
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const flushResult = await notifyPanelToFlushOutput();
    if (flushResult?.ok) {
      const pathLabel = flushResult.pathLabel || `${rootLabel} / ${folderName}`;
      await showSaveNotification(pathLabel);
      return pathLabel;
    }

    if (flushResult?.needsPermission) {
      const pathLabel = await waitForPanelFolderUnlock(rootLabel, folderName);
      if (pathLabel) return pathLabel;
      lastError =
        "Chrome needs one click in the extension panel to unlock the output folder.";
      break;
    }

    lastError = flushResult?.error || "Panel did not confirm the save.";
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }

  const stillPending = (await chrome.storage.local.get("pending_fs_write")).pending_fs_write;
  if (!stillPending) {
    const pathLabel = `${rootLabel || "Selected folder"} / ${folderName}`;
    await showSaveNotification(pathLabel);
    return pathLabel;
  }

  throw new Error(
    `Could not save into the selected folder (${lastError}). The files are still queued — click "Grant access" in the extension panel to finish writing them.`
  );
}

async function saveResumeAndCoverLetter(output, resumeData, jobMeta, { apiKey, model, runCoverLetter = true } = {}) {
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
      const coverOutput = await chatCompletion({
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
      if (!coverOutput) throw new Error("Empty cover letter response.");
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
  }

  const savedDir = await commitOutputBundle(folderName, files);
  let status = `Saved to ${savedDir} (${resumeFileBase}_Resume.pdf${
    coverLetterCreated ? " + Cover_Letter.pdf" : ""
  } + jd.txt + HTML)${coverLetterWarning}`;

  if (jobMeta.spreadsheetUrl || jobMeta.sheetsWebAppUrl) {
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
        datePosted: jobMeta.datePosted || ""
      });
      const sheetLabel = sheetResult.sheetName
        ? `"${sheetResult.sheetName}" row ${sheetResult.row}`
        : `row ${sheetResult.row}`;
      status = `${status} and appended to Google Sheet (${sheetLabel})`;
    } catch (sheetErr) {
      status = `${status}, but sheet append failed: ${String(sheetErr?.message || sheetErr)}`;
    }
  }

  return { savedDir, status };
}

function coverLetterTextToParagraphs(raw) {
  let s = String(raw || "");

  // If the model returned HTML anyway, convert block boundaries to newlines, then strip tags.
  if (/<\/?[a-z][^>]*>/i.test(s)) {
    s = s
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*(p|div|h[1-6]|li|section|article)\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ");
  }

  // Strip markdown code fences if present.
  s = s.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "");

  return s
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

function cleanCoverLetterParagraphs(paragraphs, name) {
  const nameLc = String(name || "").toLowerCase().trim();
  const firstNameLc = nameLc.split(/\s+/)[0] || "";
  const closingRe = /^(sincerely|regards|best regards|kind regards|warm regards|best|respectfully|thank you)\b[,.]?$/i;

  return paragraphs.filter((p) => {
    const lc = p.toLowerCase().trim();
    if (!lc) return false;
    if (closingRe.test(lc)) return false; // local signature adds this
    if (nameLc && lc === nameLc) return false; // trailing full-name line
    if (firstNameLc && lc === firstNameLc) return false; // trailing first-name line
    if (/^(email|phone|linkedin|mobile|tel)\s*:/i.test(p)) return false; // contact echoes
    return true;
  });
}

// Replace every markdown link `[text](url)` with its destination URL.
function stripMarkdownLink(value) {
  return String(value || "")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, _text, url) => url)
    .trim();
}

function buildCoverLetterHtml(rawText, contact = {}) {
  const esc = (v) =>
    String(v || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");

  const name = String(contact.name || "Steven Avon").trim();
  const paragraphs = cleanCoverLetterParagraphs(coverLetterTextToParagraphs(rawText), name);

  const headerParts = [`<p class="cl-name">${esc(name)}</p>`];
  if (contact.headline) headerParts.push(`<p class="cl-headline">${esc(contact.headline)}</p>`);

  const contactParts = [];
  if (contact.location) contactParts.push(esc(contact.location));
  if (contact.phone) contactParts.push(esc(contact.phone));
  if (contact.email) {
    const email = stripMarkdownLink(contact.email).replace(/^mailto:/i, "").trim();
    contactParts.push(`<a href="mailto:${esc(email)}">${esc(email)}</a>`);
  }
  if (contact.linkedin) {
    const url = stripMarkdownLink(contact.linkedin).replace(/\/+$/, "").trim();
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    contactParts.push(`<a href="${esc(href)}">${esc(href)}</a>`);
  }
  if (contactParts.length) {
    headerParts.push(`<p class="cl-contact">${contactParts.join(" | ")}</p>`);
  }

  const bodyHtml = paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 18mm; }
  body {
    font-family: "Times New Roman", Times, serif;
    font-size: 11pt;
    line-height: 1.45;
    color: #000;
    margin: 0;
  }
  .cl-header { margin-bottom: 16px; text-align: center; }
  .cl-header p { text-align: center; }
  .cl-name { font-size: 16pt; font-weight: 700; margin: 0 0 2px 0; }
  .cl-headline { font-weight: 700; margin: 0 0 6px 0; }
  .cl-contact { margin: 0; font-size: 10.5pt; }
  p { margin: 0 0 12px 0; text-align: justify; }
  .signature { margin-top: 6px; }
  .signature p { margin: 0; text-align: left; }
  .signature .cl-name-sign { font-weight: 700; }
</style>
</head>
<body>
  <div class="cl-header">
    ${headerParts.join("\n    ")}
  </div>
  ${bodyHtml}
  <div class="signature">
    <p>Sincerely,</p>
    <p class="cl-name-sign">${esc(name)}</p>
  </div>
</body>
</html>`;
}

async function runGenerationPipeline({ profileId, jobMeta }) {
  const { apiKey, model } = await getOpenAiSettings();
  const meta = jobMeta || {};
  const resumeOnly = meta.resumeOnly === true;

  await setStatus("Building resume prompt...");
  const resumePrompt = await buildPrompt(profileId, meta.jdText || "", {
    jobTitle: meta.jobTitle || "",
    companyName: meta.companyName || ""
  });

  await setStatus("Calling OpenAI for resume JSON...");
  const jsonText = await chatCompletion({
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

  const data = extractResumeJson(jsonText);
  if (!data) {
    throw new Error(
      "OpenAI response is not valid resume JSON. Try again or check the profile prompt."
    );
  }
  const rawText = JSON.stringify(data, null, 2);
  await chrome.storage.local.set({ last_response: rawText });
  await setStatus(
    resumeOnly
      ? "Resume JSON ready. Rendering PDF (skipping cover letter)..."
      : "Resume JSON ready. Rendering PDF + cover letter..."
  );

  const saved = await saveResumeAndCoverLetter(rawText, data, meta, {
    apiKey,
    model,
    runCoverLetter: !resumeOnly
  });

  return {
    ...saved,
    status: `${saved.status} Click Autofill on the application page when ready.`
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
  if (message?.type === "reset_generation_state") {
    (async () => {
      try {
        isRunning = false;
        stopKeepAlive();
        await chrome.storage.local.set({
          generation_status: "Reset complete. Ready for next run.",
          generation_running: false,
          last_response: ""
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
          (result.choiceFilledCount ? `, reused ${result.choiceFilledCount} saved choice(s)` : "") +
          (result.aiFilledCount ? `, AI-answered ${result.aiFilledCount} question(s)` : "") +
          (result.aiError ? ` (AI answers failed: ${result.aiError})` : "") +
          " on the current page.";
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
        const stored = await chrome.storage.local.get([
          "last_job_title",
          "last_company_name",
          "last_jd_text",
          "last_response"
        ]);
        const answers = await resolveTextAnswers({
          questions,
          applicantInfo,
          jobMeta: message.jobMeta || {
            jobTitle: stored.last_job_title || "",
            companyName: stored.last_company_name || "",
            jdText: stored.last_jd_text || ""
          },
          resumeText: stored.last_response || ""
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
        const answers = await resolveChoiceAnswersFromBank(
          message.profileId,
          Array.isArray(message.questions) ? message.questions : []
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
        await setStatus("Running Easy Apply on the current page...");
        const result = await startEasyApplyOnTab(profileId);
        if (!result.ok) {
          await setStatus(`Easy Apply failed: ${result.error}`);
          safeSendResponse(sendResponse, result);
          return;
        }
        const msg =
          `Easy Apply (${result.site || "site"}): ${result.status || "done"} — ` +
          `${result.steps || 0} step(s), filled ${result.filled || 0}, ` +
          `uploaded ${result.uploaded || 0}, answered ${result.answered || 0}. ${result.detail || ""}`.trim();
        await setStatus(msg);
        safeSendResponse(sendResponse, { ...result, status: msg });
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Easy Apply failed: ${error}`);
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
    startKeepAlive();
    chrome.storage.local.set({ generation_running: true });

    safeSendResponse(sendResponse, { ok: true, started: true });

    (async () => {
      try {
        await setStatus(`Imported job: opening URL...`);
        await setImportedJobStatus(importedJobId, {
          status: "opening",
          statusDetail: "Opening job URL...",
          markAttempt: true
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
          if (existingTab.status !== "complete") {
            await awaitTabComplete(tabId, 30000);
          }
        } else {
          const tab = await chrome.tabs.create({ url, active: true });
          tabId = tab?.id;
          if (!tabId) throw new Error("Failed to open browser tab.");
          await awaitTabComplete(tabId, 30000);
        }

        // Stop early if the posting is gone (expired / filled / removed / 404) so
        // we don't waste an OpenAI call, and mark the job as no longer available.
        try {
          await ensureAutofillScript(tabId);
          const availProbe = await sendMessageToTab(
            tabId,
            { type: "probe_application_form" },
            { attempts: 2 }
          );
          if (availProbe?.jobUnavailable) {
            await setImportedJobStatus(importedJobId, {
              status: "unavailable",
              statusDetail: `No longer available: ${availProbe.jobUnavailable}`
            });
            await setStatus(`Imported job skipped — no longer available: ${availProbe.jobUnavailable}`);
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

        const resumeOnlyStored =
          (await chrome.storage.local.get("generate_resume_only")).generate_resume_only === true;
        const genMeta = { ...jobMeta, resumeOnly: resumeOnlyStored };
        await setImportedJobStatus(importedJobId, {
          status: "generating",
          statusDetail: resumeOnlyStored
            ? "Generating resume only..."
            : "Generating resume & cover letter..."
        });
        await setStatus(`Generating resume for imported job...`);
        await runGenerationPipeline({ profileId, jobMeta: genMeta });

        await setImportedJobStatus(importedJobId, {
          status: "opening_form",
          statusDetail: "Locating application form..."
        });

        // Dice / Jobright use an in-page Easy Apply modal rather than a standalone
        // form page — drive that flow directly (fills each step, stops before submit).
        const liveTab = await chrome.tabs.get(tabId).catch(() => null);
        const site = detectSiteFromUrl(liveTab?.url || url);
        if (site === "dice" || site === "jobright") {
          await setImportedJobStatus(importedJobId, {
            status: "filling",
            statusDetail: `Running ${site} Easy Apply...`
          });
          await setStatus(`Running ${site} Easy Apply...`);

          const ea = await startEasyApplyOnTab(profileId, tabId);
          if (!ea.ok && ea.error) throw new Error(ea.error);

          const nextStatus =
            ea.status === "submitted"
              ? "completed"
              : ea.status === "unavailable"
                ? "unavailable"
                : ea.status === "needs_review"
                  ? "needs_review"
                  : "ready_for_review";
          await setImportedJobStatus(importedJobId, {
            status: nextStatus,
            statusDetail:
              `Easy Apply (${site}): ${ea.status || "done"}. ` +
              `Steps ${ea.steps || 0}, filled ${ea.filled || 0}, uploaded ${ea.uploaded || 0}, ` +
              `answered ${ea.answered || 0}. ${ea.detail || ""}`.trim()
          });
          await setStatus(`Imported job Easy Apply: ${ea.status || "done"} (no submit).`);
          return;
        }

        // Best-effort: probe page for fillable fields; if missing, try candidate Apply URLs.
        let probe = null;
        const probeTab = async () => {
          await ensureAutofillScript(tabId);
          const res = await sendMessageToTab(tabId, { type: "probe_application_form" }, { attempts: 2 });
          return res;
        };

        try {
          probe = await probeTab();
        } catch {
          probe = { ok: false, isApplicationForm: false, applyUrls: [] };
        }

        const visited = new Set([tab?.url]);
        let tries = 0;
        while (
          tries < 2 &&
          probe &&
          probe.ok !== false &&
          !probe.isApplicationForm &&
          !probe.blockedReason &&
          !probe.jobUnavailable &&
          Array.isArray(probe.applyUrls) &&
          probe.applyUrls.length
        ) {
          const nextUrl = String(probe.applyUrls[0] || "").trim();
          if (!nextUrl || visited.has(nextUrl)) break;
          visited.add(nextUrl);

          await setImportedJobStatus(importedJobId, {
            status: "opening_form",
            statusDetail: "Clicking through to application form..."
          });

          await chrome.tabs.update(tabId, { url: nextUrl });
          await awaitTabComplete(tabId, 30000);
          probe = await probeTab().catch(() => ({
            ok: false,
            isApplicationForm: false,
            applyUrls: []
          }));
          tries += 1;
        }

        // The posting became unavailable while we clicked through: stop and mark it.
        if (probe?.jobUnavailable) {
          await setImportedJobStatus(importedJobId, {
            status: "unavailable",
            statusDetail: `No longer available: ${probe.jobUnavailable}`
          });
          await setStatus(`Imported job unavailable: ${probe.jobUnavailable}`);
          return;
        }

        // Stop rather than typing profile answers into a listing page's search
        // and filter inputs, or into a login / CAPTCHA wall.
        if (probe?.blockedReason || probe?.isApplicationForm === false) {
          const reason =
            probe?.blockedReason ||
            "No application form found on this page. Open the apply form, then use Autofill.";

          // If it's a sign-in / register wall, prefill saved credentials so the
          // user only has to submit (we never auto-submit login forms).
          let credNote = "";
          try {
            const credentials = await getAccountCredentials();
            if (credentials.email || credentials.username || credentials.password) {
              const credRes = await sendMessageToTab(
                tabId,
                { type: "autofill_credentials", credentials },
                { attempts: 2 }
              );
              if (Number(credRes?.filledCount || 0) > 0) {
                credNote = ` Saved login prefilled (${credRes.filled.join(", ")}) — sign in, then click Autofill.`;
              }
            }
          } catch {
            /* credential prefill is best-effort */
          }

          await setImportedJobStatus(importedJobId, {
            status: "needs_review",
            statusDetail: `${reason}${credNote} Resume and cover letter are saved.`
          });
          await setStatus(`Imported job needs review: ${reason}${credNote}`);
          return;
        }

        await setImportedJobStatus(importedJobId, {
          status: "filling",
          statusDetail: "Autofilling application form..."
        });
        await setStatus("Autofilling application form...");

        const autoRes = await startAutofillOnCurrentPage(profileId, tabId);

        if (autoRes?.skipped) {
          throw new Error(autoRes.error || "Autofill skipped.");
        }
        if (!autoRes?.ok) {
          throw new Error(autoRes.error || "Autofill failed.");
        }

        const filledCount = Number(autoRes.filledCount || 0);
        const uploadedCount = Number(autoRes.uploadedCount || 0);
        const aiFilledCount = Number(autoRes.aiFilledCount || 0);
        const choiceFilledCount = Number(autoRes.choiceFilledCount || 0);

        await setImportedJobStatus(importedJobId, {
          status: "ready_for_review",
          statusDetail: `Autofill complete. Filled ${filledCount} field(s), uploaded ${uploadedCount} file(s), reused ${choiceFilledCount} saved choice(s), AI answered ${aiFilledCount} question(s).`
        });

        await setStatus("Imported job ready for review (no submit).");
      } catch (err) {
        const error = String(err?.message || err);
        await setStatus(`Imported job failed: ${error}`);
        await setImportedJobStatus(importedJobId, {
          status: "failed",
          statusDetail: error
        });
      } finally {
        await chrome.storage.local.set({ generation_running: false });
        isRunning = false;
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

  if (message?.type !== "generate_resume") {
    return undefined;
  }

  if (isRunning) {
    safeSendResponse(sendResponse, { ok: false, error: "Generation already in progress." });
    return undefined;
  }

  isRunning = true;
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
      await setStatus(`Generation failed: ${String(err?.message || err)}`);
    } finally {
      isRunning = false;
      stopKeepAlive();
    }
  })();

  return false;
});
