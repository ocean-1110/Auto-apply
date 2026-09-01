import {
  contactLine,
  escapeHtml,
  renderCerts,
  renderEducationBlock,
  renderJobsUs,
  renderOptionalSection,
  renderSkills,
  wrapHtmlDocument
} from "./shared.js";

const BASE = `
    @page { size: Letter; margin: 0.55in; }
    * { box-sizing: border-box; }
    html, body {
      width: 8.5in;
      margin: 0;
      padding: 0;
      background: #fff;
    }
    .resume { width: 100%; margin: 0 auto; }
    p { margin: 0 0 5px; }
    ul { margin: 3px 0 0; padding-left: 17px; }
    li { margin: 0 0 3px; }
    .job { margin: 0 0 9px; break-inside: avoid; page-break-inside: avoid; }
    .job-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
    }
    .date { flex-shrink: 0; white-space: nowrap; font-weight: 400; }
    .project { margin: 2px 0 3px; font-style: italic; }
    .skills p { margin: 0 0 3px; }
    .certifications { margin: 3px 0 0; padding-left: 17px; }
    .certifications li { break-inside: avoid; }
    section.skills { break-inside: auto; page-break-inside: auto; }
    a { text-decoration: underline; }
`;

function makeTemplate({ id, label, description, css }) {
  return {
    id,
    label,
    description,
    render(data) {
      const name = escapeHtml(data.name || "Resume");
      const headline = escapeHtml(data.headline || "");
      const edu = data.education || {};
      return wrapHtmlDocument({
        title: `${name} - Resume`,
        css,
        pageMargin: "0.55in",
        pageWidth: "8.5in",
        body: `  <main class="resume">
    <header class="top">
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data)}</p>
    </header>
    <section>
      <h2>Summary</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>
    ${renderOptionalSection("Education", renderEducationBlock(edu))}
    ${renderOptionalSection("Certifications", renderCerts(data.certifications))}
    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}
    ${renderOptionalSection("Experience", renderJobsUs(data.experience))}
  </main>`
      });
    }
  };
}

/** Most common US ATS format: Calibri, Letter, title/dates on one line. */
export const atsCalibriTemplate = makeTemplate({
  id: "ats-calibri",
  label: "ATS Calibri (US Letter)",
  description: "Recruiter-standard Calibri, left-aligned, high ATS parse rate.",
  css: `
    ${BASE}
    body {
      font-family: Calibri, "Segoe UI", Arial, sans-serif;
      color: #222;
      font-size: 10.5pt;
      line-height: 1.28;
    }
    header.top { margin-bottom: 10px; }
    h1 {
      margin: 0 0 2px;
      font-size: 20pt;
      font-weight: 700;
      color: #111;
      letter-spacing: 0.2px;
    }
    .headline { margin: 0 0 3px; font-size: 11pt; font-weight: 700; color: #333; }
    .contact { margin: 0; font-size: 9.5pt; }
    a { color: #111; }
    section { margin: 8px 0; }
    h2 {
      margin: 0 0 4px;
      padding-bottom: 2px;
      font-size: 11pt;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      border-bottom: 1px solid #444;
      color: #111;
    }
    .role { font-weight: 700; }
    .company { margin: 0 0 2px; color: #333; }
    .date { font-size: 10pt; }
  `
});

export const executiveNavyTemplate = makeTemplate({
  id: "executive-navy",
  label: "Executive Navy",
  description: "Corporate US look with a navy nameplate — still single-column ATS.",
  css: `
    ${BASE}
    body {
      font-family: Calibri, "Segoe UI", Arial, sans-serif;
      color: #1a1a1a;
      font-size: 10.5pt;
      line-height: 1.28;
    }
    header.top {
      margin: 0 0 12px;
      padding: 10px 12px 9px;
      background: #1b365d;
      color: #fff;
    }
    h1 {
      margin: 0 0 2px;
      font-size: 20pt;
      font-weight: 700;
      color: #fff;
    }
    .headline { margin: 0 0 4px; font-size: 11pt; font-weight: 600; color: #dbe7f5; }
    .contact, .contact a { margin: 0; font-size: 9.5pt; color: #fff; }
    section { margin: 9px 0; }
    h2 {
      margin: 0 0 5px;
      padding-bottom: 2px;
      font-size: 11pt;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #1b365d;
      border-bottom: 2px solid #1b365d;
    }
    .role { font-weight: 700; color: #1b365d; }
    .company { margin: 0 0 2px; }
    .date { font-size: 10pt; color: #334155; }
    a { color: #1b365d; }
  `
});

export const modernSlateTemplate = makeTemplate({
  id: "modern-slate",
  label: "Modern Slate",
  description: "Tech/product style with a charcoal header and clean rules.",
  css: `
    ${BASE}
    body {
      font-family: Arial, Helvetica, sans-serif;
      color: #1f2937;
      font-size: 10pt;
      line-height: 1.32;
    }
    header.top {
      margin: 0 0 12px;
      padding-bottom: 8px;
      border-bottom: 3px solid #334155;
    }
    h1 {
      margin: 0 0 2px;
      font-size: 21pt;
      font-weight: 800;
      letter-spacing: -0.3px;
      color: #0f172a;
    }
    .headline { margin: 0 0 4px; font-size: 10.5pt; font-weight: 700; color: #475569; }
    .contact { margin: 0; font-size: 9pt; color: #334155; }
    a { color: #0f172a; }
    section { margin: 9px 0; }
    h2 {
      margin: 0 0 5px;
      font-size: 10pt;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: #0f172a;
    }
    .role { font-weight: 700; }
    .company { margin: 0 0 2px; color: #475569; }
    .date { font-size: 9pt; color: #64748b; }
  `
});

export const georgiaTraditionalTemplate = makeTemplate({
  id: "georgia-traditional",
  label: "Georgia Traditional",
  description: "US print-style Georgia serif — finance, ops, and conservative ATS.",
  css: `
    ${BASE}
    body {
      font-family: Georgia, "Times New Roman", serif;
      color: #111;
      font-size: 10.5pt;
      line-height: 1.3;
    }
    header.top {
      text-align: center;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 1px solid #111;
    }
    h1 {
      margin: 0 0 3px;
      font-size: 20pt;
      font-weight: 700;
    }
    .headline { margin: 0 0 4px; font-size: 11pt; font-style: italic; }
    .contact { margin: 0; font-size: 9.5pt; }
    a { color: #111; }
    section { margin: 9px 0; }
    h2 {
      margin: 0 0 4px;
      padding-bottom: 1px;
      font-size: 11.5pt;
      font-variant: small-caps;
      letter-spacing: 1px;
      border-bottom: 1px solid #111;
    }
    .job-header { font-family: Georgia, serif; }
    .role { font-weight: 700; font-style: italic; }
    .company { margin: 0 0 2px; font-weight: 700; }
    .date { font-size: 10pt; }
  `
});

export const tealProfessionalTemplate = makeTemplate({
  id: "teal-professional",
  label: "Teal Professional",
  description: "Modern US tech/startup layout with teal section accents.",
  css: `
    ${BASE}
    body {
      font-family: Calibri, "Segoe UI", Arial, sans-serif;
      color: #1f2937;
      font-size: 10.5pt;
      line-height: 1.28;
    }
    header.top { margin-bottom: 10px; }
    h1 {
      margin: 0 0 2px;
      font-size: 21pt;
      font-weight: 700;
      color: #0f766e;
    }
    .headline { margin: 0 0 3px; font-size: 11pt; font-weight: 700; color: #334155; }
    .contact { margin: 0; font-size: 9.5pt; }
    a { color: #0f766e; }
    section { margin: 9px 0; }
    h2 {
      margin: 0 0 5px;
      padding: 3px 0 3px 8px;
      font-size: 11pt;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: #fff;
      background: #0f766e;
    }
    .role { font-weight: 700; color: #115e59; }
    .company { margin: 0 0 2px; }
    .date { font-size: 10pt; color: #475569; }
  `
});

export const US_MARKET_TEMPLATES = [
  atsCalibriTemplate,
  executiveNavyTemplate,
  modernSlateTemplate,
  georgiaTraditionalTemplate,
  tealProfessionalTemplate
];
