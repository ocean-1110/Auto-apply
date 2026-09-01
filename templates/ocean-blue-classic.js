import {
  contactLine,
  escapeHtml,
  normalizeCerts,
  renderOptionalSection,
  renderSkills,
  wrapHtmlDocument
} from "./shared.js";

/**
 * Albert Liu–style resume (US Letter):
 * - Header + section titles: Book Antiqua Bold
 * - Body: Trebuchet MS
 * - Left-aligned header, Title/Dates job rows, · bullets
 * Section accent color is Ocean blue (original PDF used terracotta).
 */
const BLUE = "#1a8cff";
const INK = "#1c1c1c";
const BODY = "#222222";
const MUTED = "#444444";
const SKILL_ITEMS = "#333333";
const SCHOOL = "#555555";

function renderJobsAlbert(jobs) {
  return (jobs || [])
    .map((job) => {
      const company = escapeHtml(job.company || "");
      const location = escapeHtml(job.location || "");
      const title = escapeHtml(job.title || "");
      const dates = escapeHtml(job.dates || "");
      const project = escapeHtml(job.project || "");
      const bullets = (job.bullets || [])
        .filter(Boolean)
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join("\n");
      const companyLine = [company, location].filter(Boolean).join(" · ");

      return `<article class="job">
  <div class="job-header">
    <span class="role">${title}</span>
    <span class="date">${dates}</span>
  </div>
  ${companyLine ? `<p class="company">${companyLine}</p>` : ""}
  ${project ? `<p class="project">${project}</p>` : ""}
  <ul class="bullets">
${bullets}
  </ul>
</article>`;
    })
    .join("\n");
}

function renderEducationAlbert(edu = {}) {
  const school = escapeHtml(edu.school || "");
  const degree = escapeHtml(String(edu.degree || "").trim());
  const year = escapeHtml(String(edu.year || "").trim());
  if (!school && !degree && !year) return "";

  return `<div class="education">
  <div class="edu-header">
    <span class="edu-degree">${degree}</span>
    <span class="edu-year">${year}</span>
  </div>
  ${school ? `<p class="edu-school">${school}</p>` : ""}
</div>`;
}

function renderCertsAlbert(certs) {
  const list = normalizeCerts(certs);
  if (!list.length) return "";
  return `<ul class="certifications">
${list.map((c) => `<li>${escapeHtml(c)}</li>`).join("\n")}
</ul>`;
}

const CSS = `
    @page { size: Letter; margin: 0.44in 0.385in 0.44in 0.385in; }

    * { box-sizing: border-box; }

    html, body {
      width: 8.5in;
      margin: 0;
      padding: 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      color: ${INK};
      background: #fff;
      font-size: 9.4pt;
      line-height: 1.55;
    }

    .resume {
      width: 100%;
      margin: 0 auto;
    }

    header.top {
      text-align: left;
      margin: 0 0 10px;
      padding: 0;
    }

    h1 {
      margin: 0 0 5px;
      font-family: "Book Antiqua", "Palatino Linotype", Palatino, "Times New Roman", serif;
      font-size: 24pt;
      font-weight: 700;
      line-height: 1.15;
      letter-spacing: 0.2px;
      color: ${INK};
      text-transform: uppercase;
    }

    .headline {
      margin: 0 0 6px;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.8pt;
      font-weight: 400;
      line-height: 1.2;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: ${BLUE};
    }

    .contact {
      margin: 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 8.6pt;
      line-height: 1.25;
      color: ${MUTED};
      word-break: break-word;
    }

    a, a:visited {
      color: ${BLUE};
      text-decoration: none;
    }

    section {
      margin: 0 0 8px;
      break-inside: auto;
      page-break-inside: auto;
    }

    section h2 {
      break-after: avoid;
      page-break-after: avoid;
    }

    h2 {
      margin: 0 0 0;
      padding: 0 0 3px;
      font-family: "Book Antiqua", "Palatino Linotype", Palatino, "Times New Roman", serif;
      font-size: 10.5pt;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: 0;
      text-transform: none;
      color: ${BLUE};
      border-bottom: 1.5pt solid ${BLUE};
    }

    h2 + p,
    h2 + div,
    h2 + ul,
    h2 + .skills,
    section > p:first-of-type {
      margin-top: 8px;
    }

    p {
      margin: 0 0 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.4pt;
      line-height: 1.55;
      color: ${BODY};
      text-align: left;
      white-space: pre-wrap;
    }

    .profile p {
      color: ${BODY};
    }

    .skills p {
      margin: 0 0 4.5px;
      font-size: 9.4pt;
      line-height: 1.45;
      color: ${SKILL_ITEMS};
    }

    .skills strong {
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-weight: 700;
      color: ${INK};
    }

    .job {
      margin: 8px 0 4px;
      break-inside: auto;
      page-break-inside: auto;
    }

    .job-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin: 0;
      break-after: avoid;
      page-break-after: avoid;
    }

    .role {
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 10.1pt;
      font-weight: 700;
      color: ${INK};
      line-height: 1.2;
    }

    .date {
      flex-shrink: 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 8.6pt;
      font-weight: 700;
      color: ${BLUE};
      white-space: nowrap;
      line-height: 1.2;
    }

    .company {
      margin: 2px 0 4px;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.4pt;
      font-weight: 700;
      color: ${INK};
      line-height: 1.2;
    }

    .project {
      margin: 0 0 3px;
      font-style: italic;
      font-size: 9pt;
      color: ${SCHOOL};
    }

    ul.bullets {
      margin: 2px 0 0;
      padding: 0 0 0 12px;
      list-style: none;
    }

    ul.bullets li {
      position: relative;
      margin: 0 0 3.5px;
      padding-left: 2px;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.4pt;
      line-height: 1.45;
      color: ${INK};
      text-align: left;
    }

    ul.bullets li::before {
      content: "·";
      position: absolute;
      left: -11px;
      top: -2px;
      font-size: 12pt;
      font-weight: 700;
      color: ${BLUE};
      line-height: 1;
    }

    .education {
      margin: 8px 0 0;
    }

    .edu-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
    }

    .edu-degree {
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.8pt;
      font-weight: 700;
      color: ${INK};
    }

    .edu-year {
      flex-shrink: 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 8.6pt;
      font-weight: 700;
      color: ${BLUE};
      white-space: nowrap;
    }

    .edu-school {
      margin: 2px 0 0;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9pt;
      font-style: italic;
      color: ${SCHOOL};
      line-height: 1.2;
    }

    ul.certifications {
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }

    ul.certifications li {
      margin: 0 0 5px;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.8pt;
      font-weight: 700;
      color: ${INK};
      line-height: 1.2;
    }
`;

export const oceanBlueClassicTemplate = {
  id: "ocean-blue-classic",
  label: "Ocean Blue Classic",
  description:
    "Albert Liu–style: Book Antiqua titles, Trebuchet body, blue section rules (US Letter).",
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");
    const edu = data.education || {};

    return wrapHtmlDocument({
      title: `${name} - Resume`,
      css: CSS,
      pageMargin: "0.44in 0.385in 0.44in 0.385in",
      pageWidth: "8.5in",
      body: `  <main class="resume">
    <header class="top">
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data, { linkColor: BLUE })}</p>
    </header>

    <section class="profile">
      <h2>Summary</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>

    ${renderOptionalSection("Education", renderEducationAlbert(edu))}

    ${renderOptionalSection("Certifications", renderCertsAlbert(data.certifications))}

    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}

    ${renderOptionalSection("Professional Experience", renderJobsAlbert(data.experience), {
      className: "experience"
    })}
  </main>`
    });
  }
};
