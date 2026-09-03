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

export function normalizeExperience(experience) {
  if (!Array.isArray(experience)) return [];
  return experience.map((job) => {
    if (!job || typeof job !== "object") return job;
    const company = String(
      job.company || job.employer || job.employerName || job.organization || job.companyName || ""
    ).trim();
    return {
      ...job,
      company,
      title: String(job.title || job.role || job.position || "").trim(),
      dates: String(job.dates || job.date || job.period || "").trim(),
      location: String(job.location || "").trim(),
      bullets: Array.isArray(job.bullets)
        ? job.bullets.filter(Boolean)
        : Array.isArray(job.responsibilities)
          ? job.responsibilities.filter(Boolean)
          : []
    };
  });
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

export function wrapHtmlDocument({
  title,
  css,
  body,
  pageMargin = "0.55in",
  pageWidth = "8.5in"
}) {
  const margin = String(pageMargin || "0.55in").trim() || "0.55in";
  const width = String(pageWidth || "8.5in").trim() || "8.5in";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${css}

    /* Preview iframe only — never used for PDF capture. */
    @media screen {
      html:not([data-ocean-pdf="1"]) {
        background: #d7e6f7;
      }
      html:not([data-ocean-pdf="1"]) body {
        box-sizing: border-box !important;
        width: ${width} !important;
        max-width: 100% !important;
        min-height: calc(100vh - 32px);
        margin: 16px auto !important;
        padding: ${margin} !important;
        background: #fff !important;
        box-shadow: 0 8px 28px rgba(15, 39, 68, 0.14);
      }
    }

    /* PDF print path: @page margins control spacing — no body padding. */
    html[data-ocean-pdf="1"] body {
      box-sizing: border-box !important;
      width: ${width} !important;
      max-width: none !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #fff !important;
      box-shadow: none !important;
    }

    /* PDF pagination: flow sections continuously; keep headings with content. */
    html[data-ocean-pdf="1"] section {
      break-inside: auto !important;
      page-break-inside: auto !important;
    }
    html[data-ocean-pdf="1"] section h2 {
      break-after: avoid !important;
      page-break-after: avoid !important;
    }
    html[data-ocean-pdf="1"] .job,
    html[data-ocean-pdf="1"] article.job {
      break-inside: auto !important;
      page-break-inside: auto !important;
    }
    html[data-ocean-pdf="1"] .job-header {
      break-after: avoid !important;
      page-break-after: avoid !important;
    }

    @media print {
      html { background: #fff !important; }
      html[data-ocean-pdf="1"] body,
      body {
        margin: 0 !important;
        padding: 0 !important;
        width: auto !important;
        max-width: none !important;
        min-height: 0 !important;
        box-shadow: none !important;
      }
      section {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }
      section.experience {
        break-before: auto !important;
        page-break-before: auto !important;
      }
      section h2 {
        break-after: avoid !important;
        page-break-after: avoid !important;
      }
      .job,
      article.job {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }
      .job-header {
        break-after: avoid !important;
        page-break-after: avoid !important;
      }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
