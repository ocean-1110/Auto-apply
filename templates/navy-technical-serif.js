import {
  contactLine,
  escapeHtml,
  normalizeTechnicalSummary,
  renderCerts,
  renderEducationBlock,
  renderJobsUs,
  renderOptionalSection,
  renderSkills,
  wrapHtmlDocument
} from "./shared.js";

/**
 * LaTeX-style navy serif resume (US Letter).
 *
 * The only template that renders a TECHNICAL SUMMARY section; it declares
 * `requiresTechnicalSummary` so the generator appends the Technical Summary
 * prompt rules when this template is selected (see templates/index.js).
 *
 * Layout: left-aligned serif body, rule-above/rule-below section headings,
 * skills as Category: items paragraphs (not a table), section order
 * Summary → Technical Summary → Skills → Experience → Education → Certifications.
 */
const NAVY = "#1f4e79";
const INK = "#111111";
const BODY = "#1a1a1a";
const MUTED = "#333333";

const SERIF = 'Georgia, "Times New Roman", Times, serif';

function renderTechnicalSummary(value) {
  const bullets = normalizeTechnicalSummary(value);
  if (!bullets.length) return "";
  return `<ul class="bullets tech-summary">
${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n")}
</ul>`;
}

const CSS = `
    @page { size: Letter; margin: 0.55in 0.6in; }

    * { box-sizing: border-box; }

    html, body {
      width: 8.5in;
      margin: 0;
      padding: 0;
      font-family: ${SERIF};
      color: ${BODY};
      background: #fff;
      font-size: 9.7pt;
      line-height: 1.34;
      hyphens: none;
      -webkit-hyphens: none;
    }

    .resume { width: 100%; margin: 0 auto; }

    header.top {
      text-align: left;
      margin: 0 0 9px;
    }

    h1 {
      margin: 0 0 2px;
      font-family: ${SERIF};
      font-size: 21pt;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: 0.2px;
      color: ${NAVY};
    }

    .headline {
      margin: 0 0 3px;
      font-size: 10.2pt;
      font-weight: 700;
      line-height: 1.25;
      color: ${INK};
      text-align: left;
    }

    .contact {
      margin: 0;
      font-size: 8.9pt;
      line-height: 1.3;
      color: ${MUTED};
      text-align: left;
      word-break: normal;
    }

    a, a:visited {
      color: ${NAVY};
      text-decoration: underline;
    }

    section {
      margin: 0 0 9px;
      break-inside: auto;
      page-break-inside: auto;
    }

    section h2 {
      break-after: avoid;
      page-break-after: avoid;
    }

    h2 {
      margin: 9px 0 6px;
      padding: 2.5px 0;
      font-family: ${SERIF};
      font-size: 10.4pt;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: 0.7px;
      text-transform: uppercase;
      color: ${NAVY};
      border-top: 0.8pt solid ${NAVY};
      border-bottom: 0.8pt solid ${NAVY};
    }

    p {
      margin: 0;
      font-family: ${SERIF};
      font-size: 9.7pt;
      line-height: 1.34;
      color: ${BODY};
      text-align: left;
    }

    .skills p {
      margin: 0 0 4px;
      text-align: left;
    }

    .skills strong {
      font-weight: 700;
      color: ${NAVY};
    }

    ul.bullets {
      margin: 0;
      padding: 0 0 0 18px;
      list-style: disc;
    }

    ul.bullets li {
      margin: 0 0 3px;
      padding-left: 2px;
      font-family: ${SERIF};
      font-size: 9.7pt;
      line-height: 1.34;
      color: ${BODY};
      text-align: left;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    ul.bullets li::marker { color: ${INK}; }

    .job {
      margin: 0 0 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .job-header {
      display: block;
      margin: 0;
      break-after: avoid;
      page-break-after: avoid;
    }

    .job .role {
      font-size: 10pt;
      font-weight: 700;
      color: ${NAVY};
    }

    .job .date {
      font-size: 9.2pt;
      font-weight: 700;
      color: ${INK};
      white-space: nowrap;
    }

    .job .company {
      margin: 0 0 2px;
      font-size: 10pt;
      font-weight: 700;
      color: ${INK};
      text-align: left;
      break-after: avoid;
      page-break-after: avoid;
    }

    .job .project {
      margin: 0 0 2px;
      font-size: 9.2pt;
      font-style: italic;
      color: ${MUTED};
      text-align: left;
      break-after: avoid;
      page-break-after: avoid;
    }

    .education { margin: 0 0 6px; }

    .edu-degree {
      font-size: 9.9pt;
      font-weight: 700;
      color: ${INK};
    }

    .edu-year {
      font-size: 9.9pt;
      font-weight: 700;
      color: ${NAVY};
      white-space: nowrap;
    }

    .edu-school {
      font-size: 9.5pt;
      color: ${BODY};
      line-height: 1.3;
    }

    ul.certifications {
      margin: 0;
      padding-left: 18px;
      list-style: disc;
    }

    ul.certifications li { margin: 0 0 2px; }
`;

export const navyTechnicalSerifTemplate = {
  id: "navy-technical-serif",
  label: "Navy Technical Serif (Technical Summary)",
  description:
    "LaTeX-style navy serif, left-aligned, paragraph skills — the only template with a Technical Summary section.",
  /** Signals the generator to append the Technical Summary prompt rules. */
  requiresTechnicalSummary: true,
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");

    return wrapHtmlDocument({
      title: `${name} - Resume`,
      css: CSS,
      pageMargin: "0.55in 0.6in",
      pageWidth: "8.5in",
      body: `  <main class="resume">
    <header class="top">
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data, { linkColor: NAVY })}</p>
    </header>

    <section class="profile">
      <h2>Professional Summary</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>

    ${renderOptionalSection(
      "Technical Summary",
      renderTechnicalSummary(data.technical_summary ?? data.technicalSummary),
      { className: "technical-summary" }
    )}

    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}

    ${renderOptionalSection("Professional Experience", renderJobsUs(data.experience), {
      className: "experience"
    })}

    ${renderOptionalSection("Education", renderEducationBlock(data.education))}

    ${renderOptionalSection("Certifications", renderCerts(data.certifications, { listClass: "bullets certifications" }))}
  </main>`
    });
  }
};
