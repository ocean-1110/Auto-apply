import {
  contactLine,
  escapeHtml,
  normalizeCerts,
  normalizeSkills,
  normalizeTechnicalSummary,
  renderOptionalSection,
  wrapHtmlDocument
} from "./shared.js";

/**
 * LaTeX-style navy serif resume (US Letter).
 *
 * The only template that renders a TECHNICAL SUMMARY section; it declares
 * `requiresTechnicalSummary` so the generator appends the Technical Summary
 * prompt rules when this template is selected (see templates/index.js).
 *
 * Layout: justified serif body, rule-above/rule-below section headings,
 * Core Competencies as a two-column table, section order
 * Summary → Technical Summary → Experience → Core Competencies → Education → Certifications.
 */
const NAVY = "#1f4e79";
const HEAD_BG = "#2e5c8a";
const BORDER = "#a9c1d9";
const INK = "#111111";
const BODY = "#1a1a1a";
const MUTED = "#333333";

const SERIF =
  '"Palatino Linotype", "Book Antiqua", Palatino, "URW Palladio L", Georgia, "Times New Roman", serif';

function renderJobs(jobs) {
  return (jobs || [])
    .map((job) => {
      const company = escapeHtml(job.company || "");
      const location = escapeHtml(job.location || "");
      const title = escapeHtml(job.title || "");
      const dates = escapeHtml(job.dates || "");
      const project = escapeHtml(job.project || "");
      const metaLine = [location, dates].filter(Boolean).join(" | ");
      const bullets = (job.bullets || [])
        .filter(Boolean)
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("\n");

      return `<article class="job">
  ${company ? `<p class="company">${company}</p>` : ""}
  ${title ? `<p class="role">${title}</p>` : ""}
  ${metaLine ? `<p class="job-meta">${metaLine}</p>` : ""}
  ${project ? `<p class="project">${project}</p>` : ""}
  ${bullets ? `<ul class="bullets">\n${bullets}\n  </ul>` : ""}
</article>`;
    })
    .join("\n");
}

function renderTechnicalSummary(value) {
  const bullets = normalizeTechnicalSummary(value);
  if (!bullets.length) return "";
  return `<ul class="bullets tech-summary">
${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n")}
</ul>`;
}

/** Core Competencies: Category | Technologies / Skills, like the reference PDF. */
function renderCompetencyTable(skills) {
  const rows = normalizeSkills(skills).filter(
    (row) => String(row?.category || "").trim() || String(row?.items || "").trim()
  );
  if (!rows.length) return "";

  const body = rows
    .map(
      (row) => `<tr>
    <td class="cat">${escapeHtml(String(row.category || "").trim())}</td>
    <td class="items">${escapeHtml(String(row.items || "").trim())}</td>
  </tr>`
    )
    .join("\n");

  return `<table class="competencies">
  <thead>
    <tr><th class="cat">Category</th><th class="items">Technologies / Skills</th></tr>
  </thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

/** Accepts the standard `{ school, degree, year }` object or an array of them. */
function renderEducation(education) {
  const list = (Array.isArray(education) ? education : [education])
    .filter((e) => e && typeof e === "object")
    .map((e) => ({
      school: String(e.school || e.university || e.institution || "").trim(),
      degree: String(e.degree || e.qualification || "").trim(),
      year: String(e.year || e.years || e.dates || "").trim()
    }))
    .filter((e) => e.school || e.degree || e.year);

  if (!list.length) return "";

  return list
    .map(
      (e) => `<div class="education">
  <div class="edu-header">
    <span class="edu-degree">${escapeHtml(e.degree)}</span>
    <span class="edu-year">${escapeHtml(e.year)}</span>
  </div>
  ${e.school ? `<p class="edu-school">${escapeHtml(e.school)}</p>` : ""}
</div>`
    )
    .join("\n");
}

function renderCertifications(certs) {
  const list = normalizeCerts(certs);
  if (!list.length) return "";
  return `<ul class="bullets certifications">
${list.map((c) => `<li>${escapeHtml(c)}</li>`).join("\n")}
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
      hyphens: auto;
      -webkit-hyphens: auto;
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
      word-break: break-word;
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

    /* Rule above and below the section title, as in the reference layout. */
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
      text-align: justify;
    }

    .profile p { text-align: justify; }

    ul.bullets {
      margin: 0;
      padding: 0 0 0 15px;
      list-style: disc;
    }

    ul.bullets li {
      margin: 0 0 3px;
      padding-left: 2px;
      font-family: ${SERIF};
      font-size: 9.7pt;
      line-height: 1.34;
      color: ${BODY};
      text-align: justify;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    ul.bullets li::marker { color: ${INK}; }

    .job {
      margin: 0 0 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .job .company {
      margin: 0;
      font-size: 10pt;
      font-weight: 700;
      color: ${INK};
      text-align: left;
      break-after: avoid;
      page-break-after: avoid;
    }

    .job .role {
      margin: 0;
      font-size: 10pt;
      font-weight: 700;
      color: ${NAVY};
      text-align: left;
      break-after: avoid;
      page-break-after: avoid;
    }

    .job .job-meta {
      margin: 0;
      font-size: 9.2pt;
      font-style: italic;
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
      text-align: justify;
      break-after: avoid;
      page-break-after: avoid;
    }

    table.competencies {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 9.2pt;
      break-inside: auto;
      page-break-inside: auto;
    }

    table.competencies th,
    table.competencies td {
      border: 0.6pt solid ${BORDER};
      padding: 3.5px 6px;
      vertical-align: top;
      text-align: left;
      line-height: 1.3;
      word-break: normal;
      overflow-wrap: break-word;
    }

    table.competencies thead th {
      background: ${HEAD_BG};
      color: #fff;
      font-weight: 700;
      font-size: 9pt;
      border-color: ${HEAD_BG};
    }

    table.competencies thead { display: table-header-group; }
    table.competencies tr { break-inside: avoid; page-break-inside: avoid; }

    /* Width applies to the column; the navy label colour is body-rows only,
       otherwise it would repaint the white header text navy-on-navy. */
    table.competencies .cat { width: 33%; }

    table.competencies tbody td.cat {
      font-weight: 700;
      color: ${NAVY};
    }

    table.competencies tbody td.items { color: ${BODY}; }

    .education { margin: 0 0 6px; }

    .edu-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
    }

    .edu-degree {
      font-size: 9.9pt;
      font-weight: 700;
      color: ${INK};
    }

    .edu-year {
      flex-shrink: 0;
      font-size: 9.9pt;
      font-weight: 700;
      color: ${NAVY};
      white-space: nowrap;
    }

    .edu-school {
      margin: 0;
      font-size: 9.5pt;
      color: ${BODY};
      text-align: left;
      line-height: 1.3;
    }

    ul.certifications li { margin: 0 0 2px; }
`;

export const navyTechnicalSerifTemplate = {
  id: "navy-technical-serif",
  label: "Navy Technical Serif (Technical Summary)",
  description:
    "LaTeX-style navy serif, justified text, Core Competencies table — the only template with a Technical Summary section.",
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

    ${renderOptionalSection("Professional Experience", renderJobs(data.experience), {
      className: "experience"
    })}

    ${renderOptionalSection("Core Competencies", renderCompetencyTable(data.skills), {
      className: "skills"
    })}

    ${renderOptionalSection("Education", renderEducation(data.education))}

    ${renderOptionalSection("Certifications", renderCertifications(data.certifications))}
  </main>`
    });
  }
};
