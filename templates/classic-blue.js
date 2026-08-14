import {
  contactLine,
  escapeHtml,
  renderCerts,
  renderEducationBlock,
  renderJobsFlex,
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
      text-align: center;
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
      columns: 1;
      margin: 3px 0 0;
      padding-left: 17px;
    }

    .certifications li { break-inside: avoid; }

    .job {
      margin: 0 0 9px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .job-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-weight: 700;
    }

    .company { color: #1f3b5a; }

    .date {
      flex-shrink: 0;
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
    }

    li {
      margin: 0 0 3px;
      padding-left: 1px;
    }
`;

export const classicBlueTemplate = {
  id: "classic-blue",
  label: "Classic Blue (Arial)",
  description: "Modern layout with blue header accents and flex job rows.",
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");
    const edu = data.education || {};

    return wrapHtmlDocument({
      title: `${name} - Resume`,
      css: CSS,
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

    <section>
      <h2>Education</h2>
      ${renderEducationBlock(edu)}
    </section>

    <section>
      <h2>Certifications</h2>
      ${renderCerts(data.certifications)}
    </section>

    <section class="skills">
      <h2>Skills</h2>
      ${renderSkills(data.skills)}
    </section>

    <section>
      <h2>Experience</h2>
      ${renderJobsFlex(data.experience)}
    </section>
  </main>`
    });
  }
};
