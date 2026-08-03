import { appendJobToSpreadsheet } from "./sheets.js";
import { buildCoverLetterPrompt } from "./profiles.js";
import { resumeJsonToHtml, extractResumeJson } from "./resume-json.js";
import { DEFAULT_TEMPLATE_ID } from "./templates/index.js";

let isRunning = false;
let keepAliveTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  // MV3 service workers can sleep during long ChatGPT waits; ping storage periodically.
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

function isChatGptUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/"))
  );
}

async function getOpenChatGptTab() {
  const tabs = await chrome.tabs.query({});
  const chatTabs = tabs.filter((tab) => isChatGptUrl(tab.url) && typeof tab.id === "number");
  if (!chatTabs.length) return null;

  // Prefer the ChatGPT tab the user is actually looking at, then the most
  // recently used one, so the prompt lands in the expected tab.
  chatTabs.sort((a, b) => {
    if (!!b.active !== !!a.active) return (b.active ? 1 : 0) - (a.active ? 1 : 0);
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return chatTabs[0];
}

async function setStatus(status) {
  await chrome.storage.local.set({ generation_status: status });
}

async function downloadDataUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

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
    return `${prefix}<p class="role-company">${c} ${d}</p><p class="role-meta">${t} ${l}</p>`;
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

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      finish(new Error("Timed out waiting for render tab."));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // data: URLs often finish loading before the listener is attached.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab?.status === "complete") finish();
      })
      .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
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
    await waitForTabComplete(tabId);
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

async function autoDownloadResumeFiles(rawText, resumeData, jobMeta = {}) {
  const templateId = jobMeta.templateId || DEFAULT_TEMPLATE_ID;
  const html = resumeJsonToHtml(resumeData, templateId);
  const pdfBase64 = await htmlToPdfBase64(html);

  const outputDir = sanitizePathSegment(jobMeta.outputDir || "Resume Applications", "Resume Applications");
  const companyPart = String(jobMeta.companyName || "").trim() || "Company";
  const titlePart = String(jobMeta.jobTitle || "").trim() || "untitled-job";
  const jobFolder = sanitizePathSegment(`${companyPart} - ${titlePart}`, "untitled-job");
  const jobDir = joinDownloadPath(outputDir, jobFolder);

  const jdTxt = buildJdTxtContent({
    jobTitle: jobMeta.jobTitle || "",
    companyName: jobMeta.companyName || "",
    jdLink: jobMeta.jdLink || "",
    jdText: jobMeta.jdText || ""
  });

  try {
    await chrome.storage.local.set({
      last_response: String(rawText || "").slice(0, 200000),
      last_resume_json: resumeData,
      last_output_dir: jobDir
    });
  } catch {
    // Storage quota should not block downloads.
  }

  await downloadTextFile(jdTxt, "text/plain", joinDownloadPath(jobDir, "jd.txt"));
  await downloadBase64File(pdfBase64, "application/pdf", joinDownloadPath(jobDir, "Steven_Resume.pdf"));

  return jobDir;
}

function coverLetterTextToParagraphs(raw) {
  let s = String(raw || "");

  // If ChatGPT returned HTML anyway, convert block boundaries to newlines, then strip tags.
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

async function autoDownloadCoverLetterPdf(rawText, jobDir, contact = {}) {
  const html = buildCoverLetterHtml(rawText, contact);
  const pdfBase64 = await htmlToPdfBase64(html);

  try {
    await chrome.storage.local.set({
      last_cover_letter_response: String(rawText || "").slice(0, 100000)
    });
  } catch {
    // ignore storage failures
  }

  await downloadBase64File(pdfBase64, "application/pdf", joinDownloadPath(jobDir, "Cover Letter.pdf"));
}

async function focusTabForInput(tabId) {
  // ChatGPT's ProseMirror composer only accepts execCommand/paste insertion
  // when its tab is the active, focused tab. Bring it to the foreground first.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    // Give the page a moment to regain focus before we type into it.
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {
    // Best-effort focusing; injection below still attempts insertion.
  }
}

async function chatgptSendPrompt(tabId, prompt, startNewChat) {
  await focusTabForInput(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    args: [prompt, startNewChat],
    func: async (fullPrompt, shouldStartNewChat) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      const clickIfExists = (selectors) => {
        for (const selector of selectors) {
          if (selector.startsWith("text:")) {
            const wanted = selector.slice(5).toLowerCase();
            const btn = Array.from(document.querySelectorAll("button")).find((b) =>
              (b.textContent || "").toLowerCase().includes(wanted)
            );
            if (btn) {
              btn.click();
              return true;
            }
            continue;
          }
          const el = document.querySelector(selector);
          if (el instanceof HTMLElement) {
            el.click();
            return true;
          }
        }
        return false;
      };

      const findInput = () => {
        const selectors = [
          "#prompt-textarea",
          "textarea[placeholder*='Message']",
          "textarea",
          "div[contenteditable='true'][id*='prompt']",
          "div[contenteditable='true']"
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el instanceof HTMLElement) return el;
        }
        return null;
      };

      const setInputValue = (el, text) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          el.focus();
          const prototype =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
          if (descriptor && typeof descriptor.set === "function") {
            descriptor.set.call(el, text);
          } else {
            el.value = text;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        if (el.isContentEditable) {
          el.focus();
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(el);
          range.deleteContents();
          range.collapse(true);
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }

          // 1) Preferred: simulate a paste. ProseMirror (ChatGPT's editor)
          //    handles clipboard paste reliably, including multi-line text.
          let inserted = false;
          try {
            const dt = new DataTransfer();
            dt.setData("text/plain", text);
            const pasteEvent = new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: dt
            });
            el.dispatchEvent(pasteEvent);
            inserted = (el.innerText || el.textContent || "").trim().length > 0;
          } catch {
            inserted = false;
          }

          // 2) Fallback: execCommand insertText (works when tab is focused).
          if (!inserted) {
            try {
              inserted = document.execCommand("insertText", false, text);
            } catch {
              inserted = false;
            }
          }

          // 3) Last resort: build paragraphs directly so text at least appears.
          if (!inserted && !(el.innerText || el.textContent || "").trim()) {
            el.innerHTML = "";
            for (const line of String(text).split("\n")) {
              const p = document.createElement("p");
              p.textContent = line;
              el.appendChild(p);
            }
          }

          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      };

      const inputHasText = (el) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          return (el.value || "").trim().length > 0;
        }
        return (el.innerText || el.textContent || "").trim().length > 0;
      };

      const clickSendButton = () => {
        const selectors = [
          "button[data-testid='send-button']",
          "button[data-testid='composer-send-button']",
          "#composer-submit-button",
          "button[aria-label*='Send']",
          "button[aria-label*='send']"
        ];
        for (const selector of selectors) {
          const btn = document.querySelector(selector);
          if (btn instanceof HTMLButtonElement && !btn.disabled) {
            btn.click();
            return true;
          }
        }
        const btnByText = Array.from(document.querySelectorAll("button")).find((b) => {
          const text = (b.textContent || "").trim().toLowerCase();
          return text === "send" && b instanceof HTMLButtonElement && !b.disabled;
        });
        if (btnByText instanceof HTMLButtonElement) {
          btnByText.click();
          return true;
        }
        return false;
      };

      const sendMessage = (el) => {
        if (clickSendButton()) return true;
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true
          })
        );
        return clickSendButton();
      };

      const getAssistantBlocks = () =>
        Array.from(document.querySelectorAll("[data-message-author-role='assistant']"));

      const scorePayload = (text) => {
        const t = String(text || "");
        let score = t.length;
        if (t.includes('"experience"')) score += 100000;
        if (t.includes('"certifications"')) score += 50000;
        if (t.includes('"profile"')) score += 25000;
        return score;
      };

      const readAssistantBlock = (block) => {
        if (!block) return "";
        const candidates = [];
        for (const pre of block.querySelectorAll("pre")) {
          const text = (pre.innerText || pre.textContent || "").trim();
          if (text) candidates.push(text);
        }
        for (const code of block.querySelectorAll("pre code")) {
          const text = (code.innerText || code.textContent || "").trim();
          if (text) candidates.push(text);
        }
        if (candidates.length) {
          candidates.sort((a, b) => scorePayload(b) - scorePayload(a));
          return candidates[0];
        }
        return (block.innerText || block.textContent || "").trim();
      };

      if (shouldStartNewChat) {
        clickIfExists(["button[data-testid='new-chat-button']", "text:new chat"]);
        await sleep(800);
      }

      const blocks = getAssistantBlocks();
      const blocksBefore = blocks.length;
      const latestBefore = blocks.length ? readAssistantBlock(blocks[blocks.length - 1]) : "";

      let input = null;
      for (let i = 0; i < 30; i += 1) {
        input = findInput();
        if (input) break;
        await sleep(500);
      }
      if (!input) {
        throw new Error("Cannot find ChatGPT message input box.");
      }

      let filled = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        setInputValue(input, fullPrompt);
        await sleep(300);
        input = findInput() || input;
        if (inputHasText(input)) {
          filled = true;
          break;
        }
      }
      if (!filled) {
        throw new Error(
          "Prompt text did not appear in the ChatGPT input. Keep the ChatGPT tab visible and try again."
        );
      }

      // Wait briefly for ChatGPT to enable the send button after typing.
      let sent = false;
      for (let i = 0; i < 20; i += 1) {
        sent = sendMessage(input);
        if (sent) break;
        await sleep(200);
      }
      if (!sent) {
        throw new Error("Prompt was typed but the Send button could not be triggered.");
      }

      return { blocksBefore, latestBefore };
    }
  });

  if (!results?.length) throw new Error("No response from content script.");
  if (results[0].result === undefined && results[0].error) {
    throw new Error(String(results[0].error.message || results[0].error));
  }
  return results[0].result || { blocksBefore: 0, latestBefore: "" };
}

async function chatgptPollState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const isGenerating = () => {
        const stopBtn =
          document.querySelector("button[data-testid='stop-button']") ||
          document.querySelector("button[aria-label='Stop streaming']") ||
          document.querySelector("button[aria-label='Stop generating']") ||
          document.querySelector("button[aria-label*='Stop generating']") ||
          document.querySelector("button[aria-label*='Stop streaming']");
        if (stopBtn) return true;
        return Array.from(document.querySelectorAll("button")).some((b) => {
          const label = `${b.getAttribute("aria-label") || ""} ${(b.textContent || "")}`.toLowerCase();
          return label.includes("stop generating") || label.includes("stop streaming");
        });
      };

      const scorePayload = (text) => {
        const t = String(text || "");
        let score = t.length;
        if (t.includes('"experience"')) score += 100000;
        if (t.includes('"certifications"')) score += 50000;
        if (t.includes('"profile"')) score += 25000;
        if (/^\s*\{/.test(t) && t.includes("}")) score += 20000;
        if (/<!doctype html|<html[\s>]/i.test(t)) score += 10000;
        return score;
      };

      const readAssistantBlock = (block) => {
        if (!block) return "";
        const candidates = [];
        for (const pre of block.querySelectorAll("pre")) {
          const text = (pre.innerText || pre.textContent || "").trim();
          if (text) candidates.push(text);
        }
        for (const code of block.querySelectorAll("pre code")) {
          const text = (code.innerText || code.textContent || "").trim();
          if (text) candidates.push(text);
        }
        if (candidates.length) {
          candidates.sort((a, b) => scorePayload(b) - scorePayload(a));
          return candidates[0];
        }
        return (block.innerText || block.textContent || "").trim();
      };

      const blocks = Array.from(
        document.querySelectorAll("[data-message-author-role='assistant']")
      );
      if (blocks.length) {
        blocks[blocks.length - 1].scrollIntoView({ block: "end", inline: "nearest" });
      }
      window.scrollTo(0, document.body.scrollHeight);

      const latest = blocks.length ? readAssistantBlock(blocks[blocks.length - 1]) : "";
      return {
        blockCount: blocks.length,
        latest,
        generating: isGenerating()
      };
    }
  });

  if (!results?.length) throw new Error("No response from content script.");
  if (results[0].result === undefined && results[0].error) {
    throw new Error(String(results[0].error.message || results[0].error));
  }
  return results[0].result || { blockCount: 0, latest: "", generating: false };
}

function looksSettledAssistantText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/<!doctype html|<html[\s>]/i.test(t) && /<\/html>/i.test(t)) return true;
  if (!(t.includes('"experience"') && t.includes('"certifications"'))) {
    // Cover letters / plain HTML may not be JSON.
    if (/<!doctype html|<html[\s>]/i.test(t)) return /<\/html>/i.test(t);
    // Non-JSON replies: settled if reasonably long and closed.
    return t.length > 200;
  }
  const end = t.lastIndexOf("}");
  if (end < 0) return false;
  const after = t.slice(end + 1).replace(/```/g, "").trim();
  return after.length === 0;
}

async function automateChatGpt(tabId, prompt, options = {}) {
  const startNewChat = options.newChat !== false;
  const label = options.statusLabel || "Waiting for ChatGPT response...";

  const { blocksBefore, latestBefore } = await chatgptSendPrompt(tabId, prompt, startNewChat);

  const timeoutMs = 6 * 60 * 1000;
  const start = Date.now();
  let lastText = "";
  let sawGeneration = false;
  let stableHits = 0;
  let lastLen = 0;

  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const state = await chatgptPollState(tabId);
    if (state.generating) sawGeneration = true;
    if (state.latest) lastText = state.latest;

    const elapsedSec = Math.round((Date.now() - start) / 1000);
    if (elapsedSec > 0 && elapsedSec % 6 === 0) {
      await setStatus(
        `${label} (${elapsedSec}s, ${lastText.length || 0} chars${state.generating ? ", streaming" : ""})`
      );
    }

    // Never treat the pre-send assistant message as the new reply.
    const isFreshText = Boolean(lastText) && lastText !== (latestBefore || "");
    const isNewBlock = state.blockCount > blocksBefore;
    if (!isFreshText && !isNewBlock) continue;
    if (!isFreshText) continue;

    if (state.generating) {
      stableHits = 0;
      lastLen = lastText.length;
      continue;
    }

    // Require either seen streaming, or enough time + a new assistant block.
    if (!(sawGeneration || (isNewBlock && Date.now() - start > 8000))) continue;

    if (lastText.length > lastLen) {
      lastLen = lastText.length;
      stableHits = 0;
      continue;
    }

    stableHits += 1;
    if (stableHits >= 2 && looksSettledAssistantText(lastText)) {
      return lastText;
    }
    if (stableHits >= 5 && sawGeneration) {
      return lastText;
    }
  }

  throw new Error("Timed out waiting for ChatGPT response.");
}

async function saveResumeAndCoverLetter(tabId, output, resumeData, jobMeta, { runCoverLetter = true } = {}) {
  await setStatus("Rendering resume from JSON, then saving jd.txt + PDF...");
  const savedDir = await autoDownloadResumeFiles(output, resumeData, jobMeta);

  let status = `Saved resume to Downloads / ${savedDir} (jd.txt + Steven_Resume.pdf)`;

  if (runCoverLetter && typeof tabId === "number") {
    try {
      await setStatus("Resume saved. Sending CoverLetter prompt and waiting for response...");
      const coverPrompt = await buildCoverLetterPrompt({
        jdText: jobMeta.jdText || "",
        jobTitle: jobMeta.jobTitle || "",
        companyName: jobMeta.companyName || ""
      });
      const coverOutput = await automateChatGpt(tabId, coverPrompt, {
        newChat: true,
        statusLabel: "Waiting for cover letter from ChatGPT..."
      });
      if (!coverOutput) throw new Error("Empty cover letter response.");

      await setStatus("Saving Cover Letter.pdf...");
      await autoDownloadCoverLetterPdf(coverOutput, savedDir, {
        name: resumeData?.name,
        headline: resumeData?.headline,
        location: resumeData?.location,
        email: resumeData?.email,
        phone: resumeData?.phone,
        linkedin: resumeData?.linkedin
      });
      status = `Saved to Downloads / ${savedDir} (jd.txt + Steven_Resume.pdf + Cover Letter.pdf)`;
    } catch (coverErr) {
      status = `${status}, but cover letter failed: ${String(coverErr?.message || coverErr)}`;
    }
  } else if (runCoverLetter) {
    status = `${status}. Cover letter skipped: open a ChatGPT tab to auto-generate it.`;
  }

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

async function runGenerationPipeline({ jobMeta, jsonText }) {
  // Strict manual path: parse the pasted JSON, render + save, then cover letter.
  const data = extractResumeJson(jsonText);
  if (!data) {
    throw new Error(
      "Pasted text is not valid resume JSON. Copy the full JSON object (starting with { and ending with })."
    );
  }
  const rawText = JSON.stringify(data, null, 2);
  const tab = await getOpenChatGptTab();
  await chrome.storage.local.set({ last_response: rawText });
  return saveResumeAndCoverLetter(tab?.id, rawText, data, jobMeta || {}, {
    runCoverLetter: true
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "reset_generation_state") {
    (async () => {
      try {
        // Always unlock — previous runs can leave storage stuck after reload/crash.
        isRunning = false;
        stopKeepAlive();
        const tab = await getOpenChatGptTab();
        if (tab?.id) {
          await chrome.tabs.reload(tab.id);
        }
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

  if (message?.type === "send_prompt") {
    (async () => {
      try {
        const tab = await getOpenChatGptTab();
        if (!tab || typeof tab.id !== "number") {
          safeSendResponse(sendResponse, {
            ok: false,
            error: "Open ChatGPT in a browser tab first."
          });
          return;
        }
        await chatgptSendPrompt(tab.id, message.prompt || "", true);
        try {
          await chrome.tabs.update(tab.id, { active: true });
        } catch {
          // focusing the tab is best-effort
        }
        safeSendResponse(sendResponse, { ok: true });
      } catch (err) {
        safeSendResponse(sendResponse, { ok: false, error: String(err?.message || err) });
      }
    })();

    return true;
  }

  if (message?.type !== "save_from_json") {
    return undefined;
  }

  if (isRunning) {
    safeSendResponse(sendResponse, { ok: false, error: "Generation already in progress." });
    return undefined;
  }

  isRunning = true;
  startKeepAlive();
  chrome.storage.local.set({ generation_running: true });
  setStatus("Rendering resume from pasted JSON...");

  // Acknowledge immediately so the popup does not sit on a closed message port for minutes.
  safeSendResponse(sendResponse, { ok: true, started: true });

  (async () => {
    try {
      const result = await runGenerationPipeline({
        jobMeta: message.jobMeta || {},
        jsonText: message.jsonText || ""
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
