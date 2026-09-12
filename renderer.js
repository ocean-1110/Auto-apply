function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSectionHeading(line) {
  return /^(summary|skills|experience|education|projects|certifications)$/i.test(line.trim());
}

export function extractName(text) {
  const lines = text
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return "resume";
  const safe = lines[0].replace(/[^a-zA-Z0-9 _-]/g, "").trim();
  const first = safe.split(/\s+/)[0] || "resume";
  return first.toLowerCase();
}

export function toResumeHtml(rawText) {
  const lines = rawText.split("\n");
  const compact = lines.map((x) => x.trim()).filter(Boolean);
  const name = compact[0] || "Resume";
  const contact = compact[1] || "";

  const body = [];
  let inList = false;
  let inExperienceSection = false;
  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line === name || line === contact) continue;

    if (isSectionHeading(line) || /^[A-Z &]+$/.test(line)) {
      closeList();
      const title = line.toUpperCase();
      inExperienceSection = title === "EXPERIENCE";
      body.push(`<h2>${escapeHtml(title)}</h2>`);
      continue;
    }

    if (inExperienceSection && /\|\s*[A-Za-z]{3}\s+\d{4}\s*-\s*(Present|[A-Za-z]{3}\s+\d{4})/i.test(line)) {
      closeList();
      body.push(`<h3 class="role-company">${escapeHtml(line)}</h3>`);
      continue;
    }

    if (inExperienceSection && /^[A-Za-z].*\|\s*.+/.test(line) && !line.startsWith("-")) {
      closeList();
      body.push(`<p class="role-meta">${escapeHtml(line)}</p>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }

    closeList();
    body.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(name)}</title>
  <style>
    @page { size: A4; margin: 14mm; }
    body {
      font-family: "Times New Roman", Times, serif;
      color: #000;
      line-height: 1.28;
      font-size: 10pt;
      margin: 0;
      background: #ffffff;
    }
    .top {
      padding-bottom: 3px;
      margin-bottom: 8px;
    }
    h1 {
      margin: 0 0 2px;
      font-size: 25pt;
      letter-spacing: 0;
      color: #000;
      font-weight: 700;
      text-align: center;
    }
    .contact {
      margin-bottom: 2px;
      font-size: 10pt;
      color: #000;
      word-break: break-word;
      text-align: center;
    }
    h2 {
      margin: 9px 0 5px;
      font-size: 11pt;
      border-bottom: 1px solid #8b8b8b;
      padding-bottom: 2px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #000;
    }
    h3.role-company {
      margin: 6px 0 0;
      font-size: 10.6pt;
      color: #000;
      font-weight: 700;
    }
    p.role-meta {
      margin: 0 0 3px;
      color: #000;
      font-style: italic;
    }
    p {
      margin: 0 0 4px;
      white-space: pre-wrap;
      text-align: left;
    }
    ul {
      margin: 0 0 5px 18px;
      padding: 0;
    }
    li {
      margin: 0 0 2px;
      text-align: left;
    }
  </style>
</head>
<body>
  <div class="top">
    <h1>${escapeHtml(name)}</h1>
    <div class="contact">${escapeHtml(contact)}</div>
  </div>
  ${body.join("")}
</body>
</html>`;
}

export function toCoverLetterHtml(rawText) {
  const lines = String(rawText || "")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const paragraphs = lines.length
    ? lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n")
    : "<p></p>";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cover Letter</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body {
      font-family: "Times New Roman", Times, serif;
      color: #000;
      font-size: 11pt;
      line-height: 1.45;
      margin: 0;
      background: #ffffff;
    }
    p {
      margin: 0 0 12px 0;
      text-align: left;
    }
  </style>
</head>
<body>
  ${paragraphs}
</body>
</html>`;
}

function escapePdfText(text) {
  const ascii = text
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ascii.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function wrapTextForPdf(text, maxChars) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function toBase64(uint8) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < uint8.length; i += chunk) {
    const slice = uint8.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function looksLikeRoleHeader(line) {
  return /\|\s*[A-Za-z]{3}\s+\d{4}\s*-\s*(Present|[A-Za-z]{3}\s+\d{4})/i.test(line);
}

function looksLikeMetaLine(line) {
  return /^[A-Za-z].*\|\s*.+/.test(line) || /^[A-Za-z].*,\s*[A-Za-z].*/.test(line);
}

function wrapByFont(text, fontSize, maxWidth) {
  const approxCharWidth = fontSize * 0.52;
  const maxChars = Math.max(20, Math.floor(maxWidth / approxCharWidth));
  return wrapTextForPdf(text, maxChars);
}

export function buildPdfBase64(rawText) {
  const lines = rawText
    .split("\n")
    .map((x) => x.trimEnd())
    .filter((x, i, arr) => !(x === "" && arr[i - 1] === ""));

  const nonEmpty = lines.map((x) => x.trim()).filter(Boolean);
  const name = nonEmpty[0] || "Resume";
  const contact = nonEmpty[1] || "";

  const contentLines = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) {
      contentLines.push({ type: "space", text: "" });
      continue;
    }
    if (skipped < 2 && (line.trim() === name || line.trim() === contact)) {
      skipped += 1;
      continue;
    }
    if (isSectionHeading(line) || /^[A-Z &]+$/.test(line.trim())) {
      contentLines.push({ type: "section", text: line.trim().toUpperCase() });
      continue;
    }
    const bullet = line.trim().match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      contentLines.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }
    if (looksLikeRoleHeader(line.trim())) {
      contentLines.push({ type: "role", text: line.trim() });
      continue;
    }
    if (looksLikeMetaLine(line.trim())) {
      contentLines.push({ type: "meta", text: line.trim() });
      continue;
    }
    contentLines.push({ type: "para", text: line.trim() });
  }

  const pageWidth = 595;
  const pageHeight = 842;
  const marginLeft = 52;
  const marginRight = 52;
  const top = 800;
  const bottom = 42;
  const contentWidth = pageWidth - marginLeft - marginRight;

  const pages = [];
  let stream = [];
  let y = top;

  const flushPage = () => {
    if (!stream.length) return;
    pages.push(stream.join("\n"));
    stream = [];
    y = top;
  };

  const ensureSpace = (needed) => {
    if (y - needed < bottom) {
      flushPage();
    }
  };

  const pushText = (text, x, font, size) => {
    stream.push("BT");
    stream.push(`/${font} ${size} Tf`);
    stream.push(`${x} ${y} Td`);
    stream.push(`(${escapePdfText(text)}) Tj`);
    stream.push("ET");
  };

  const pushRule = () => {
    stream.push("q");
    stream.push("0.55 0.55 0.55 RG");
    stream.push("1 w");
    stream.push(`${marginLeft} ${y} m ${pageWidth - marginRight} ${y} l S`);
    stream.push("Q");
  };

  ensureSpace(34);
  const nameLines = wrapByFont(name, 23, contentWidth);
  for (const nLine of nameLines) {
    pushText(nLine, marginLeft, "F2", 23);
    y -= 22;
  }
  if (contact) {
    const contactLines = wrapByFont(contact, 10, contentWidth);
    for (const c of contactLines) {
      ensureSpace(11);
      pushText(c, marginLeft, "F1", 10);
      y -= 11;
    }
  }
  y -= 3;
  pushRule();
  y -= 10;

  for (const item of contentLines) {
    if (item.type === "space") {
      y -= 6;
      continue;
    }

    if (item.type === "section") {
      ensureSpace(20);
      pushText(item.text, marginLeft, "F2", 11);
      y -= 11;
      pushRule();
      y -= 7;
      continue;
    }

    if (item.type === "role") {
      const wrapped = wrapByFont(item.text, 10.7, contentWidth);
      ensureSpace(wrapped.length * 12 + 2);
      for (const line of wrapped) {
        pushText(line, marginLeft, "F2", 10.7);
        y -= 12;
      }
      y -= 1;
      continue;
    }

    if (item.type === "meta") {
      const wrapped = wrapByFont(item.text, 10, contentWidth);
      ensureSpace(wrapped.length * 11 + 2);
      for (const line of wrapped) {
        pushText(line, marginLeft, "F3", 10);
        y -= 11;
      }
      y -= 2;
      continue;
    }

    if (item.type === "bullet") {
      const bulletX = marginLeft + 8;
      const textX = marginLeft + 20;
      const wrapped = wrapByFont(item.text, 10, contentWidth - 20);
      ensureSpace(wrapped.length * 11 + 2);
      pushText("-", bulletX, "F1", 10);
      for (const [idx, line] of wrapped.entries()) {
        pushText(line, textX, "F1", 10);
        y -= 11;
        if (idx === 0 && wrapped.length === 1) {
          // no-op
        }
      }
      y -= 1;
      continue;
    }

    const paraLines = wrapByFont(item.text, 10, contentWidth);
    ensureSpace(paraLines.length * 11 + 1);
    for (const line of paraLines) {
      pushText(line, marginLeft, "F1", 10);
      y -= 11;
    }
    y -= 1;
  }
  flushPage();
  if (!pages.length) pages.push("");

  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${
    pages.length
  } >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>";

  pages.forEach((pageLines, index) => {
    const pageObj = 6 + index * 2;
    const contentObj = pageObj + 1;
    const contentStream = pageLines;

    objects[contentObj] = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObj} 0 R >>`;
  });

  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  for (let i = 1; i < objects.length; i += 1) {
    offsets[i] = new TextEncoder().encode(parts.join("")).length;
    parts.push(`${i} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefOffset = new TextEncoder().encode(parts.join("")).length;
  parts.push(`xref\n0 ${objects.length}\n`);
  parts.push("0000000000 65535 f \n");
  for (let i = 1; i < objects.length; i += 1) {
    parts.push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const bytes = new TextEncoder().encode(parts.join(""));
  return toBase64(bytes);
}
