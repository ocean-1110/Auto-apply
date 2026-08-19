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

/**
 * Normalize skills from common LLM shapes into [{ category, items }].
 * Accepts arrays of objects/strings, or a category→items object map.
 */
export function normalizeSkills(skills) {
  if (!skills) return [];

  const toItems = (value) => {
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .join(", ");
    }
    return String(value ?? "").trim();
  };

  const fromRow = (row) => {
    if (row == null) return null;
    if (typeof row === "string") {
      const text = row.trim();
      if (!text) return null;
      const match = text.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        return { category: match[1].trim(), items: match[2].trim() };
      }
      return { category: "", items: text };
    }
    if (typeof row !== "object" || Array.isArray(row)) return null;

    let category = String(
      row.category || row.name || row.title || row.label || row.group || ""
    ).trim();
    let items = toItems(
      row.items ?? row.skills ?? row.technologies ?? row.value ?? row.content ?? ""
    );

    if (!category && !items) {
      const entries = Object.entries(row).filter(
        ([key, value]) =>
          value != null &&
          String(value).trim() &&
          !["id", "order", "priority"].includes(String(key).toLowerCase())
      );
      if (entries.length === 1) {
        category = String(entries[0][0] || "").trim();
        items = toItems(entries[0][1]);
      }
    }

    if (!category && !items) return null;
    return { category, items };
  };

  if (!Array.isArray(skills) && typeof skills === "object") {
    return Object.entries(skills)
      .map(([category, items]) => fromRow({ category, items }))
      .filter(Boolean);
  }

  if (!Array.isArray(skills)) return [];
  return skills.map(fromRow).filter(Boolean);
}

export function renderSkills(skills) {
  return normalizeSkills(skills)
    .map((row) => {
      const category = String(row?.category || "").trim();
      const items = String(row?.items || "").trim();
      if (!category && !items) return "";
      if (!category) return `<p>${escapeHtml(items)}</p>`;
      if (!items) return `<p><strong>${escapeHtml(category)}</strong></p>`;
      return `<p><strong>${escapeHtml(category)}:</strong> ${escapeHtml(items)}</p>`;
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizeCerts(certs) {
  const list = Array.isArray(certs)
    ? certs
    : typeof certs === "string" && certs.trim()
      ? certs.split(/\n|;/).map((s) => s.trim())
      : [];
  return list
    .map((c) => {
      if (c == null) return "";
      if (typeof c === "string") return c.trim();
      if (typeof c === "object") {
        return String(
          c.name || c.title || c.certification || c.label || c.text || ""
        ).trim();
      }
      return String(c).trim();
    })
    .filter(Boolean);
}

export function renderCerts(certs, { listClass = "certifications" } = {}) {
  const items = normalizeCerts(certs);
  if (!items.length) return "";
  return `<ul class="${listClass}">${items.map((c) => `<li>${escapeHtml(c)}</li>`).join("\n")}</ul>`;
}

/** Omit the whole section when inner HTML is empty (e.g. no certifications). */
export function renderOptionalSection(title, innerHtml, { className = "" } = {}) {
  const inner = String(innerHtml || "").trim();
  if (!inner) return "";
  const cls = className ? ` class="${escapeHtml(className)}"` : "";
  return `<section${cls}>
      <h2>${escapeHtml(title)}</h2>
      ${inner}
    </section>`;
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

/**
 * Stacked ATS-friendly header (Times-style):
 *   Company | Dates
 *   Title | Location
 */
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

      const companyLine = [company, dates].filter(Boolean).join(" | ");
      const roleLine = [title, location].filter(Boolean).join(" | ");

      return `<article class="job">
  <h3 class="role-company">${companyLine}</h3>
  <p class="role-meta">${roleLine}</p>
  ${project ? `<p class="project">${project}</p>` : ""}
  <ul>
${bullets}
  </ul>
</article>`;
    })
    .join("\n");
}

/**
 * US recruiter standard:
 *   Title                                          Dates
 *   Company · Location
 */
export function renderJobsUs(jobs) {
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
