import { escapeHtml } from "./templates/shared.js";

function coverLetterTextToParagraphs(raw) {
  let s = String(raw || "");
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
  s = s.replace(/```[a-z]*\s*/gi, "").replace(/```/g, "");
  return s
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

function cleanCoverLetterParagraphs(paragraphs, name) {
  const nameLc = String(name || "").toLowerCase().trim();
  const firstNameLc = nameLc.split(/\s+/)[0] || "";
  const closingRe =
    /^(sincerely|regards|best regards|kind regards|warm regards|best|respectfully|thank you)\b[,.]?$/i;

  return paragraphs.filter((p) => {
    const lc = p.toLowerCase().trim();
    if (!lc) return false;
    if (closingRe.test(lc)) return false;
    if (nameLc && lc === nameLc) return false;
    if (firstNameLc && lc === firstNameLc) return false;
    if (/^(email|phone|linkedin|mobile|tel)\s*:/i.test(p)) return false;
    return true;
  });
}

function stripMarkdownLink(value) {
  return String(value || "")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, _text, url) => url)
    .trim();
}

export function buildCoverLetterHtml(rawText, contact = {}) {
  const name = String(contact.name || "Candidate").trim();
  const paragraphs = cleanCoverLetterParagraphs(coverLetterTextToParagraphs(rawText), name);

  const headerParts = [`<p class="cl-name">${escapeHtml(name)}</p>`];
  if (contact.headline) {
    headerParts.push(`<p class="cl-headline">${escapeHtml(contact.headline)}</p>`);
  }

  const contactParts = [];
  if (contact.location) contactParts.push(escapeHtml(contact.location));
  if (contact.phone) contactParts.push(escapeHtml(contact.phone));
  if (contact.email) {
    const email = stripMarkdownLink(contact.email).replace(/^mailto:/i, "").trim();
    contactParts.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
  }
  if (contact.linkedin) {
    const url = stripMarkdownLink(contact.linkedin).replace(/\/+$/, "").trim();
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    contactParts.push(`<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`);
  }
  if (contactParts.length) {
    headerParts.push(`<p class="cl-contact">${contactParts.join(" | ")}</p>`);
  }

  const bodyHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(name)} - Cover letter</title>
<style>
  @page { size: Letter; margin: 0.7in; }
  body {
    font-family: "Times New Roman", Times, serif;
    font-size: 11pt;
    line-height: 1.45;
    color: #000;
    margin: 0;
    background: #fff;
  }
  .cl-header { margin-bottom: 16px; text-align: left; }
  .cl-header p { text-align: left; }
  .cl-name { font-size: 16pt; font-weight: 700; margin: 0 0 2px 0; }
  .cl-headline { font-weight: 700; margin: 0 0 6px 0; }
  .cl-contact { margin: 0; font-size: 10.5pt; }
  p { margin: 0 0 12px 0; text-align: left; hyphens: none; -webkit-hyphens: none; }
  .signature { margin-top: 6px; }
  .signature p { margin: 0; text-align: left; }
  .signature .cl-name-sign { font-weight: 700; }

  @media screen {
    html:not([data-ocean-pdf="1"]) { background: #d7e6f7; }
    html:not([data-ocean-pdf="1"]) body {
      box-sizing: border-box;
      width: 8.5in;
      max-width: 100%;
      min-height: calc(100vh - 32px);
      margin: 16px auto;
      padding: 0.7in;
      box-shadow: 0 8px 28px rgba(15, 39, 68, 0.14);
    }
  }
  html[data-ocean-pdf="1"] {
    background: #fff !important;
  }
  html[data-ocean-pdf="1"] body {
    box-sizing: border-box !important;
    width: 8.5in !important;
    max-width: none !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    box-shadow: none !important;
    background: #fff !important;
    hyphens: none !important;
    -webkit-hyphens: none !important;
  }
  @media print {
    html { background: #fff; }
    body {
      margin: 0;
      padding: 0;
      width: auto;
      max-width: none;
      min-height: 0;
      box-shadow: none;
    }
  }
</style>
</head>
<body>
  <div class="cl-header">
    ${headerParts.join("\n    ")}
  </div>
  ${bodyHtml}
  <div class="signature">
    <p>Sincerely,</p>
    <p class="cl-name-sign">${escapeHtml(name)}</p>
  </div>
</body>
</html>`;
}
