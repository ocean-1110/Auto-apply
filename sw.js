import { appendJobToSpreadsheet } from "./sheets.js";
import { buildPrompt, buildCoverLetterPrompt } from "./profiles.js";
import { resumeJsonToHtml, extractResumeJson } from "./resume-json.js";
import { DEFAULT_TEMPLATE_ID } from "./templates/index.js";
import {
  chatCompletion,
  DEFAULT_OPENAI_MODEL,
  RESUME_JSON_SYSTEM_PROMPT
} from "./openai.js";
import { getEnv } from "./env.js";
import { getApplicantInfo } from "./applicant-info.js";
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

// Service worker entry (v1.3.5)
let isRunning = false;
let keepAliveTimer = null;
let panelWindowId = null;

const PANEL_WIDTH = 520;
const PANEL_HEIGHT = 760;
const PANEL_WINDOW_ID_KEY = "panel_window_id";
const PANEL_URL = () => chrome.runtime.getURL("popup.html");

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
});

async function handleOpenPanel() {
  try {
    await openPanelWindow();
  } catch (err) {
    console.error("Failed to open panel:", err);
  }
}

// Icon click opens the single panel. Keyboard: Ctrl+Shift+G (_execute_action).
chrome.action.onClicked.addListener(() => {
  handleOpenPanel();
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

chrome.runtime.onInstalled.addListener(() => {
  isRunning = false;
  stopKeepAlive();
  chrome.storage.local.set({
    generation_running: false,
    generation_status: "Ready."
  });
});

chrome.runtime.onStartup.addListener(() => {
  isRunning = false;
  stopKeepAlive();
  chrome.storage.local.set({
    generation_running: false,
    generation_status: "Ready."
  });
});

async function setStatus(status) {
  await chrome.storage.local.set({ generation_status: status });
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

async function ensureAutofillScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "autofill_ping" });
    return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/autofill.js"]
  });
}

/**
 * Prefer the active tab in a normal browser window (not this extension panel).
 */
async function getCurrentApplicationTab() {
  const normalWindows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ["normal"]
  });

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
 * Autofill the currently open application page using the selected profile's answers.
 * Also injects last generated resume / cover letter PDFs into matching file inputs.
 * Unmatched question fields are answered via OpenAI (generate + humanize).
 */
async function startAutofillOnCurrentPage(profileId) {
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

  const tab = await getCurrentApplicationTab();
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

  await ensureAutofillScript(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, {
    type: "autofill_application",
    applicantInfo,
    uploadFiles: {
      resume: docs?.resume || null,
      coverLetter: docs?.coverLetter || null
    }
  });

  let aiFilledCount = 0;
  const unmatched = Array.isArray(result?.unmatchedQuestions) ? result.unmatchedQuestions : [];

  if (unmatched.length) {
    await setStatus(`Generating human-style answers for ${unmatched.length} extra question(s)...`);
    try {
      const { apiKey, model } = await getOpenAiSettings();
      const stored = await chrome.storage.local.get([
        "last_job_title",
        "last_company_name",
        "last_jd_text",
        "last_response"
      ]);
      const answers = await generateHumanizedApplicationAnswers({
        apiKey,
        model,
        questions: unmatched,
        applicantInfo,
        jobMeta: {
          jobTitle: stored.last_job_title || "",
          companyName: stored.last_company_name || "",
          jdText: stored.last_jd_text || ""
        },
        resumeText: stored.last_response || ""
      });

      if (answers.length) {
        await setStatus(`Humanizing complete. Filling ${answers.length} AI answer(s)...`);
        const aiResult = await chrome.tabs.sendMessage(tab.id, {
          type: "autofill_ai_answers",
          answers
        });
        aiFilledCount = Number(aiResult?.filledCount || 0);
      }
    } catch (aiErr) {
      // Keep profile/file autofill success even if AI Q&A fails.
      return {
        ok: Boolean(result?.ok),
        tabId: tab.id,
        tabUrl: tab.url || "",
        ...result,
        aiFilledCount: 0,
        aiError: String(aiErr?.message || aiErr)
      };
    }
  }

  return {
    ok: Boolean(result?.ok),
    tabId: tab.id,
    tabUrl: tab.url || "",
    ...result,
    aiFilledCount
  };
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
  const { apiKey, model } = await getOpenAiSettings();
  const stored = await chrome.storage.local.get([
    "last_job_title",
    "last_company_name",
    "last_jd_text",
    "last_response"
  ]);

  const answers = await generateHumanizedApplicationAnswers({
    apiKey,
    model,
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
    `Could not save into the selected folder (${lastError}). Keep the extension window open and try again.`
  );
}

async function saveResumeAndCoverLetter(output, resumeData, jobMeta, { apiKey, model, runCoverLetter = true } = {}) {
  await setStatus("Rendering resume from JSON...");
  const bundle = await buildResumeFileBundle(output, resumeData, jobMeta);
  const { folderName, resumeFileBase, files } = bundle;

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
    } catch (coverErr) {
      const savedDir = await commitOutputBundle(folderName, files);
      return {
        savedDir,
        status: `Saved to ${savedDir}, but cover letter failed: ${String(coverErr?.message || coverErr)}`
      };
    }
  }

  const savedDir = await commitOutputBundle(folderName, files);
  let status = `Saved to ${savedDir} (${resumeFileBase}_Resume.pdf${
    runCoverLetter ? " + Cover_Letter.pdf" : ""
  } + jd.txt + HTML)`;

  if (jobMeta.spreadsheetUrl || jobMeta.sheetsWebAppUrl) {
    await setStatus("Appending row to Google Sheet...");
    try {
      await appendJobToSpreadsheet({
        spreadsheetUrl: jobMeta.spreadsheetUrl,
        webAppUrl: jobMeta.sheetsWebAppUrl,
        jobTitle: jobMeta.jobTitle,
        companyName: jobMeta.companyName,
        jdLink: jobMeta.jdLink
      });
      status = `${status} and appended to Google Sheet`;
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

  await setStatus("Building resume prompt...");
  const resumePrompt = await buildPrompt(profileId, jobMeta.jdText || "", {
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || ""
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

  const saved = await saveResumeAndCoverLetter(rawText, data, jobMeta || {}, {
    apiKey,
    model,
    runCoverLetter: true
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
          (result.uploadedCount ? `, uploaded ${result.uploadedCount} file(s)` : "") +
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
