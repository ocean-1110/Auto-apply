export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripMarkdownLink(value) {
  return String(value || "")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, _text, url) => url)
    .trim();
}

function cleanEmail(value) {
  return stripMarkdownLink(value).replace(/^mailto:/i, "").trim();
}

function cleanUrl(value) {
  let url = stripMarkdownLink(value)
    .replace(/[[\]]/g, "")
    .trim();
  const match = url.match(/https?:\/\/\S+/i);
  if (match) url = match[0];
  return url.replace(/[),.]+$/, "").replace(/\/+$/, "").trim();
}

export function contactLine(data, { linkColor } = {}) {
  const parts = [];
  if (data.location) parts.push(escapeHtml(data.location));
  if (data.phone) parts.push(escapeHtml(data.phone));
  if (data.email) {
    const email = cleanEmail(data.email);
    parts.push(`<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`);
  }
  if (data.linkedin) {
    const url = cleanUrl(data.linkedin);
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(href)}</a>`);
  }
  const style = linkColor ? ` style="color:${linkColor}"` : "";
  if (style) {
    return parts
      .map((part) => (part.startsWith("<a ") ? part.replace("<a ", `<a${style} `) : part))
      .join(" | ");
  }
  return parts.join(" | ");
}

export function renderSkills(skills) {
  return (skills || [])
    .map((row) => {
      const category = String(row?.category || "").trim();
      const items = String(row?.items || "").trim();
      if (!category && !items) return "";
      return `<p><strong>${escapeHtml(category)}:</strong> ${escapeHtml(items)}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

export function renderCerts(certs, { listClass = "certifications" } = {}) {
  const items = (certs || [])
    .map((c) => `<li>${escapeHtml(c)}</li>`)
    .join("\n");
  return `<ul class="${listClass}">${items}</ul>`;
}

/** Flex header: company (location) — title | dates on the right. */
export function renderJobsFlex(jobs) {
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

      return `<article class="job">
  <div class="job-header">
    <span class="company">${company}${location ? ` (${location})` : ""} — ${title}</span>
    <span class="date">${dates}</span>
  </div>
  ${project ? `<p class="project">${project}</p>` : ""}
  <ul>
${bullets}
  </ul>
</article>`;
    })
    .join("\n");
}

/** Stacked header: company dates, then title | location (Times-style). */
export function renderJobsStacked(jobs) {
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

      const roleLine = [title, location].filter(Boolean).join(" | ");

      return `<article class="job">
  <h3 class="role-company">${company} ${dates}</h3>
  <p class="role-meta">${roleLine}</p>
  ${project ? `<p class="project">${project}</p>` : ""}
  <ul>
${bullets}
  </ul>
</article>`;
    })
    .join("\n");
}

/** School on one line; degree and year on one ATS-friendly line. */
export function renderEducationBlock(edu = {}) {
  const school = escapeHtml(edu.school || "");
  const degree = String(edu.degree || "").trim();
  const year = String(edu.year || "").trim();
  const degreeYear = [degree, year].filter(Boolean).join(" - ");

  if (!school && !degreeYear) return "";

  const lines = [];
  if (school) lines.push(`<strong>${school}</strong>`);
  if (degreeYear) lines.push(escapeHtml(degreeYear));
  return `<p class="education">${lines.join("<br>\n")}</p>`;
}

export function wrapHtmlDocument({ title, css, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${css}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
