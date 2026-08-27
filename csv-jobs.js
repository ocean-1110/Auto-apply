/**
 * CSV parsing + normalization for imported job applications.
 *
 * Supports:
 * - Capture/ATS export: id, title, organization, key_skills, source, url, description
 * - Google Sheet export: JOB URL, JOB TITLE, COMPANY NAME, … (no id/description required)
 *
 * Requirements:
 * - RFC4180-style quoted fields (commas/newlines inside quotes).
 * - Escaped quotes as "" within quoted fields.
 * - UTF-8 text (the file may include a BOM).
 */

import { normalizeJobLink } from "./capture-jobs.js";

const HEADER_ALIASES = {
  id: ["id", "job_id", "job id"],
  url: ["url", "job url", "job link", "job_link", "jd link", "jd_link", "link"],
  title: ["title", "job title", "job_title", "role", "position"],
  organization: ["organization", "company name", "company_name", "company", "employer"],
  key_skills: ["key_skills", "key skills", "skills"],
  source: ["source", "job source", "site"],
  description: ["description", "job description", "jd", "jd text", "jd_text"],
  work_arrangement: ["work_arrangement", "work arrangement", "work model"],
  employment_type: ["employment_type", "employment type"],
  salary_min: ["salary_min", "salary min"],
  salary_max: ["salary_max", "salary max"],
  date_posted: ["date_posted", "date posted", "posted", "posted date"],
  application_date: ["application date", "application_date", "applied", "applied date"],
  status: ["status", "application status", "application_status"]
};

function stripBom(s) {
  return String(s || "").replace(/^\uFEFF/, "");
}

/**
 * Parse a CSV string into an array of rows (each row is an array of fields).
 * Minimal RFC4180 implementation: handles quotes, escaped quotes, and newlines inside quotes.
 */
export function parseCsvRfc(text) {
  const input = stripBom(text);
  const rows = [];

  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = input[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }

      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (ch === "\r") {
      if (input[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0].trim() !== "") rows.push(row);
      row = [];
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);

  while (rows.length && rows[rows.length - 1].every((c) => String(c || "").trim() === "")) {
    rows.pop();
  }

  return rows;
}

function normalizeHeaderLabel(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function resolveCanonicalHeader(raw) {
  const label = normalizeHeaderLabel(raw);
  if (!label) return "";
  for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
    if (label === canon.replace(/_/g, " ") || aliases.includes(label)) return canon;
  }
  return label.replace(/ /g, "_");
}

function buildHeaderIndex(headerRow) {
  const index = {};
  headerRow.forEach((cell, i) => {
    const canon = resolveCanonicalHeader(cell);
    if (canon && index[canon] == null) index[canon] = i;
  });
  return index;
}

function fieldByCanon(row, headerIndex, key) {
  const idx = headerIndex[key];
  if (idx == null) return "";
  return String(row[idx] ?? "");
}

function detectCsvFormat(headerIndex) {
  const hasCapture =
    headerIndex.id != null &&
    headerIndex.url != null &&
    (headerIndex.description != null || headerIndex.key_skills != null);
  const hasSheet =
    headerIndex.url != null && headerIndex.title != null && headerIndex.organization != null;

  if (hasCapture) return "capture";
  if (hasSheet) return "sheet";
  return null;
}

function isHeaderLikeUrl(value) {
  return /^job\s*(url|link)$/i.test(String(value || "").trim());
}

export function jobIdFromLink(jdLink) {
  const raw = String(jdLink || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    let id = `${url.hostname}${url.pathname}`.replace(/\/+$/, "");
    if (url.search) id += url.search;
    return id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200);
  } catch {
    return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200);
  }
}

function inferSourceFromUrl(url, explicit) {
  const source = String(explicit || "").trim().toLowerCase();
  if (source) return source;
  const raw = String(url || "").toLowerCase();
  if (raw.includes("jobright.ai")) return "jobright";
  if (raw.includes("dice.com")) return "dice";
  if (raw.includes("linkedin.com")) return "linkedin";
  if (raw.includes("greenhouse.io")) return "greenhouse";
  if (raw.includes("hiringcafe.com") || raw.includes("hiring.cafe")) return "hiringcafe";
  if (raw.includes("myworkdayjobs.com") || raw.includes("workdayjobs.com")) return "workday";
  if (raw.includes("indeed.com")) return "indeed";
  return "sheet";
}

export function isLinkedInSource(source) {
  return String(source || "").trim().toLowerCase() === "linkedin";
}

export function isDiceSource(source) {
  return String(source || "").trim().toLowerCase() === "dice";
}

export function isJobrightSource(source) {
  return String(source || "").trim().toLowerCase() === "jobright";
}

export function isGreenhouseSource(source) {
  return String(source || "").trim().toLowerCase() === "greenhouse";
}

export function isWorkdaySource(source) {
  return String(source || "").trim().toLowerCase() === "workday";
}

export function isIndeedSource(source) {
  return String(source || "").trim().toLowerCase() === "indeed";
}

function buildJdText({ description, keySkills, prependKeySkills }) {
  const jd = String(description || "").trim();
  const skills = String(keySkills || "").trim();

  if (!prependKeySkills) return jd;
  if (!skills) return jd;

  return `Key skills:\n${skills}\n\n${jd}`;
}

/**
 * @param {string} csvText
 * @returns {{
 *  jobs: Array<{id:string, jobTitle:string, companyName:string, jdLink:string, keySkills:string, jdText:string, source:string, description:string}>,
 *  skipped: number,
 *  duplicateUrls: number,
 *  imported: number,
 *  format: string,
 *  errors: Array<{rowIndex:number, message:string}>
 * }}
 */
export function parseImportedJobsCsvText(csvText) {
  const rows = parseCsvRfc(csvText);
  if (!rows.length) {
    return {
      jobs: [],
      skipped: 0,
      duplicateUrls: 0,
      imported: 0,
      format: "",
      errors: [{ rowIndex: 0, message: "CSV is empty." }]
    };
  }

  const headerIndex = buildHeaderIndex(rows[0]);
  const format = detectCsvFormat(headerIndex);
  if (!format) {
    return {
      jobs: [],
      skipped: 0,
      duplicateUrls: 0,
      imported: 0,
      format: "",
      errors: [
        {
          rowIndex: 0,
          message:
            'CSV must include job URL, job title, and company name columns (or capture export columns: id, title, organization, url, description).'
        }
      ]
    };
  }

  const jobs = [];
  const errors = [];
  const seenLinks = new Set();
  let skipped = 0;
  let duplicateUrls = 0;

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || [];

    let id = fieldByCanon(row, headerIndex, "id").trim();
    const title = fieldByCanon(row, headerIndex, "title").trim();
    const organization = fieldByCanon(row, headerIndex, "organization").trim();
    const keySkills = fieldByCanon(row, headerIndex, "key_skills").trim();
    const sourceRaw = fieldByCanon(row, headerIndex, "source").trim();
    const jdLink = fieldByCanon(row, headerIndex, "url").trim();
    const description = fieldByCanon(row, headerIndex, "description");

    const workArrangement = fieldByCanon(row, headerIndex, "work_arrangement").trim();
    const employmentType = fieldByCanon(row, headerIndex, "employment_type").trim();
    const salaryMin = fieldByCanon(row, headerIndex, "salary_min").trim();
    const salaryMax = fieldByCanon(row, headerIndex, "salary_max").trim();
    const datePosted = fieldByCanon(row, headerIndex, "date_posted").trim();

    if (!jdLink || isHeaderLikeUrl(jdLink)) {
      skipped += 1;
      continue;
    }

    if (!title || !organization) {
      skipped += 1;
      continue;
    }

    if (format === "capture") {
      if (!description || !String(description).trim()) {
        skipped += 1;
        continue;
      }
      if (!id) id = jobIdFromLink(jdLink);
      if (!id) {
        skipped += 1;
        continue;
      }
    } else {
      id = id || jobIdFromLink(jdLink);
      if (!id) {
        skipped += 1;
        continue;
      }
    }

    const linkKey = normalizeJobLink(jdLink).toLowerCase();
    if (linkKey && seenLinks.has(linkKey)) {
      duplicateUrls += 1;
      continue;
    }
    if (linkKey) seenLinks.add(linkKey);

    const source = inferSourceFromUrl(jdLink, sourceRaw);
    const jdText = buildJdText({ description, keySkills, prependKeySkills: true });

    jobs.push({
      id,
      jobTitle: title,
      companyName: organization,
      jdLink,
      keySkills,
      jdText,
      source,
      description: String(description || "").trim(),
      workArrangement,
      employmentType,
      salaryMin,
      salaryMax,
      datePosted
    });
  }

  return { jobs, skipped, duplicateUrls, imported: jobs.length, format, errors };
}
