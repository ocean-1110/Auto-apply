import {
  contactLine,
  escapeHtml,
  renderCerts,
  renderJobsStacked,
  renderSkills,
  wrapHtmlDocument
} from "./shared.js";

const CSS = `
    @page { size: A4; margin: 10mm; }

    * { box-sizing: border-box; }

    html, body {
      width: 210mm;
      margin: 0;
      padding: 0;
      font-family: "Times New Roman", Times, serif;
      color: #000;
      background: #fff;
      font-size: 10.8pt;
      line-height: 1.18;
    }

    .resume {
      width: 100%;
      margin: 0 auto;
    }

    header.top {
      text-align: center;
      margin-bottom: 5px;
      padding-bottom: 3px;
    }

    h1 {
      margin: 0 0 3px;
      font-size: 22.5pt;
      font-weight: 700;
      letter-spacing: 0;
      color: #000;
      text-align: center;
    }

    .headline {
      margin: 0 0 4px;
      font-size: 11pt;
      font-weight: 700;
      text-align: center;
    }

    .contact {
      margin: 0 0 2px;
      font-size: 10pt;
      word-break: break-word;
      text-align: center;
    }

    a, a:visited {
      color: #1155cc;
      text-decoration: underline;
    }

    section {
      margin: 9px 0;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    h2 {
      margin: 9px 0 4px;
      padding-bottom: 2px;
      font-size: 11pt;
      border-bottom: 1px solid #8b8b8b;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #000;
    }

    h3.role-company {
      margin: 7px 0 0;
      font-size: 10.6pt;
      color: #000;
      font-weight: 700;
    }

    p.role-meta {
      margin: 0 0 6px;
      color: #000;
      font-style: italic;
    }

    p {
      margin: 0 0 2.6px;
      white-space: pre-wrap;
      text-align: justify;
      text-justify: inter-word;
    }

    .skills p {
      margin: 0 0 2.6px;
    }

    .skills strong {
      font-weight: 700;
    }

    .certifications {
      margin: 3px 0 6px;
      padding-left: 18px;
    }

    .certifications li {
      margin: 0 0 3px;
      text-align: justify;
    }

    .job {
      margin: 0 0 6px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .project {
      margin: 2px 0 3px;
      font-style: italic;
      font-size: 10pt;
    }

    ul {
      margin: 3px 0 6px;
      padding-left: 18px;
    }

    li {
      margin: 0 0 3px;
      text-align: justify;
      text-justify: inter-word;
      line-height: 1.18;
    }

    h2 + p, h2 + ul, h2 + div, h2 + h3 { margin-top: 3px; }
    h3 + p, h3 + ul, .role-meta + p { margin-top: 3px; }
    .role-meta + ul { margin-top: 10px; }
`;

export const timesClassicTemplate = {
  id: "times-classic",
  label: "Times Classic (Serif)",
  description: "Traditional centered header with underlined sections and stacked job titles.",
  render(data) {
    const name = escapeHtml(data.name || "Resume");
    const headline = escapeHtml(data.headline || "");
    const edu = data.education || {};

    return wrapHtmlDocument({
      title: `${name} - Resume`,
      css: CSS,
      body: `  <main class="resume">
    <header class="top">
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data, { linkColor: "#1155cc" })}</p>
    </header>

    <section>
      <h2>Profile</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>

    <section>
      <h2>Education</h2>
      <p><strong>${escapeHtml(edu.school || "")}</strong><br>
      ${escapeHtml(edu.degree || "")}<br>
      ${escapeHtml(edu.year || "")}</p>
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
      ${renderJobsStacked(data.experience)}
    </section>
  </main>`
    });
  }
};
