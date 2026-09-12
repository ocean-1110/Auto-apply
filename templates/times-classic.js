import {
  contactLine,
  escapeHtml,
  renderCerts,
  renderEducationBlock,
  renderJobsStacked,
  renderOptionalSection,
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
      text-align: left;
      margin-bottom: 5px;
      padding-bottom: 3px;
    }

    h1 {
      margin: 0 0 3px;
      font-size: 22.5pt;
      font-weight: 700;
      letter-spacing: 0;
      color: #000;
      text-align: left;
    }

    .headline {
      margin: 0 0 4px;
      font-size: 11pt;
      font-weight: 700;
      text-align: left;
    }

    .contact {
      margin: 0 0 2px;
      font-size: 10pt;
      word-break: normal;
      text-align: left;
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

    /* Large skills blocks must be allowed to split or they can be clipped off-page */
    section.skills {
      break-inside: auto;
      page-break-inside: auto;
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

    p.education {
      margin: 0 0 2.6px;
      line-height: 1.2;
    }

    /* One blank line between Education heading and school/degree content */
    h2 + p.education {
      margin-top: 1.15em;
    }

    /* Breathing room between a second (or third) university */
    p.education + p.education {
      margin-top: 5px;
    }

    p.education br {
      line-height: 1.15;
    }

    p {
      margin: 0 0 2.6px;
      white-space: normal;
      text-align: left;
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
      list-style: disc;
    }

    .certifications li {
      margin: 0 0 3px;
      text-align: left;
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
      text-align: left;
      line-height: 1.18;
    }

    h2 + p, h2 + ul, h2 + div, h2 + h3 { margin-top: 3px; }
    h2 + p.education { margin-top: 1.15em; }
    h3 + p, h3 + ul, .role-meta + p { margin-top: 3px; }
    .role-meta + ul { margin-top: 10px; }
`;

export const timesClassicTemplate = {
  id: "times-classic",
  label: "Times Classic (Serif)",
  description: "Traditional left-aligned serif with underlined sections and stacked job titles.",
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
    <header class="top">
      <h1>${name}</h1>
      ${headline ? `<p class="headline">${headline}</p>` : ""}
      <p class="contact">${contactLine(data, { linkColor: "#1155cc" })}</p>
    </header>

    <section>
      <h2>Profile</h2>
      <p>${escapeHtml(data.profile || "")}</p>
    </section>

    ${renderOptionalSection("Education", renderEducationBlock(edu))}

    ${renderOptionalSection("Certifications", renderCerts(data.certifications))}

    ${renderOptionalSection("Skills", renderSkills(data.skills), { className: "skills" })}

    ${renderOptionalSection("Experience", renderJobsStacked(data.experience))}
  </main>`
    });
  }
};
