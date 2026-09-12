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

/**
 * Albert Liu–style resume (US Letter):
 * - Header + section titles: Book Antiqua Bold
 * - Body: Trebuchet MS
 * - Title | Dates on one extractable line, real list bullets
 * Section accent color is Ocean blue (original PDF used terracotta).
 */
const BLUE = "#1a8cff";
const INK = "#1c1c1c";
const BODY = "#222222";
const MUTED = "#444444";
const SKILL_ITEMS = "#333333";
const SCHOOL = "#555555";

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
      white-space: normal;
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
      display: block;
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
      padding: 0 0 0 18px;
      list-style: disc;
    }

    ul.bullets li {
      margin: 0 0 3.5px;
      padding-left: 2px;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.4pt;
      line-height: 1.45;
      color: ${INK};
      text-align: left;
    }

    ul.bullets li::marker { color: ${BLUE}; }

    .education {
      margin: 8px 0 0;
    }

    .edu-degree {
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      font-size: 9.8pt;
      font-weight: 700;
      color: ${INK};
    }

    .edu-year {
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
      padding-left: 18px;
      list-style: disc;
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
    "Albert Liu–style: Book Antiqua titles, Trebuchet body, blue rules — single-column ATS text.",
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");
    const edu = data.education;

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

    ${renderOptionalSection("Education", renderEducationBlock(edu))}

    ${renderOptionalSection("Certifications", renderCerts(data.certifications))}

    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}

    ${renderOptionalSection("Professional Experience", renderJobsUs(data.experience), {
      className: "experience"
    })}
  </main>`
    });
  }
};
