import {
  contactLine,
  escapeHtml,
  renderCerts,
  renderEducationBlock,
  renderJobsFlex,
  renderOptionalSection,
  renderSkills,
  wrapHtmlDocument
} from "./shared.js";

const CSS = `
    @page { size: A4; margin: 10mm; }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      font-family: Arial, Helvetica, sans-serif;
      color: #222;
      background: #fff;
      font-size: 10pt;
      line-height: 1.35;
    }

    .resume {
      width: 100%;
      margin: 0 auto;
    }

    header {
      text-align: left;
      border-bottom: 2px solid #1f3b5a;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }

    h1 {
      margin: 0;
      color: #1f3b5a;
      font-size: 23pt;
      line-height: 1.1;
    }

    .headline {
      margin: 4px 0;
      font-size: 11pt;
      font-weight: 700;
    }

    .contact {
      margin: 0;
      font-size: 9pt;
    }

    a {
      color: #1f3b5a;
      text-decoration: underline;
    }

    section {
      margin: 9px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    section.skills {
      break-inside: auto;
      page-break-inside: auto;
    }

    h2 {
      margin: 0 0 5px;
      padding-bottom: 2px;
      color: #1f3b5a;
      border-bottom: 1px solid #b8c4d0;
      font-size: 11pt;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }

    p { margin: 0 0 5px; }

    .skills p { margin: 0 0 3px; }

    .certifications {
      margin: 3px 0 0;
      padding-left: 17px;
      list-style: disc;
    }

    .certifications li { break-inside: avoid; }

    .job {
      margin: 0 0 9px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .job-header {
      display: block;
      font-weight: 700;
    }

    .company { color: #1f3b5a; }

    .date {
      white-space: nowrap;
      font-size: 9pt;
      font-weight: 400;
    }

    .project {
      margin: 2px 0 3px;
      font-style: italic;
      font-size: 9.2pt;
    }

    ul {
      margin: 3px 0 0;
      padding-left: 17px;
      list-style: disc;
    }

    li {
      margin: 0 0 3px;
      padding-left: 1px;
    }
`;

export const classicBlueTemplate = {
  id: "classic-blue",
  label: "Classic Blue (Arial)",
  description: "Arial layout with blue header accents; title and dates on one extractable line.",
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");
    const edu = data.education || {};

    return wrapHtmlDocument({
      title: `${name} - Resume`,
      css: CSS,
      pageMargin: "10mm",
      pageWidth: "210mm",
      body: `  <main class="resume">
    <header>
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data)}</p>
    </header>

    <section>
      <h2>Profile</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>

    ${renderOptionalSection("Education", renderEducationBlock(edu))}

    ${renderOptionalSection("Certifications", renderCerts(data.certifications))}

    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}

    ${renderOptionalSection("Experience", renderJobsFlex(data.experience))}
  </main>`
    });
  }
};
