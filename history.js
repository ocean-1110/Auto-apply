/**
 * Build work-history and education payloads for ATS form fill
 * from last resume JSON + saved applicant info.
 */

import { normalizeEducation } from "./templates/shared.js";

const MONTHS = [
  { num: "01", names: ["January", "Jan"] },
  { num: "02", names: ["February", "Feb"] },
  { num: "03", names: ["March", "Mar"] },
  { num: "04", names: ["April", "Apr"] },
  { num: "05", names: ["May", "May"] },
  { num: "06", names: ["June", "Jun"] },
  { num: "07", names: ["July", "Jul"] },
  { num: "08", names: ["August", "Aug"] },
  { num: "09", names: ["September", "Sep", "Sept"] },
  { num: "10", names: ["October", "Oct"] },
  { num: "11", names: ["November", "Nov"] },
  { num: "12", names: ["December", "Dec"] }
];

const MONTH_LOOKUP = (() => {
  const map = new Map();
  for (const row of MONTHS) {
    map.set(row.num, row);
    map.set(String(Number(row.num)), row);
    for (const name of row.names) {
      map.set(name.toLowerCase(), row);
    }
  }
  return map;
})();

function monthRow(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return MONTH_LOOKUP.get(raw.toLowerCase()) || MONTH_LOOKUP.get(raw.padStart(2, "0")) || null;
}

export function monthCandidates(monthValue) {
  const row = monthRow(monthValue);
  if (!row) return [];
  const out = [row.names[0], row.names[1] || row.names[0], row.num, String(Number(row.num))];
  return [...new Set(out.filter(Boolean))];
}

function dateBundle(monthValue, yearValue) {
  const year = String(yearValue || "").replace(/\D/g, "").slice(0, 4);
  const row = monthRow(monthValue);
  const monthNum = row?.num || "";
  const monthName = row?.names[0] || "";
  const monthShort = row?.names[1] || monthName;
  return {
    month: monthName,
    monthShort,
    monthNum,
    year,
    candidates: year ? monthCandidates(monthNum || monthValue) : monthCandidates(monthValue),
    isoMonth: year && monthNum ? `${year}-${monthNum}` : "",
    isoDate: year && monthNum ? `${year}-${monthNum}-01` : "",
    display: [monthShort || monthName, year].filter(Boolean).join(" ")
  };
}

/**
 * Parse resume date strings such as "Feb 2023 – Present", "07/2022 – 07/2026", "2016".
 */
export function parseDateRange(raw) {
  const text = String(raw || "")
    .replace(/[–—]/g, "-")
    .replace(/\bto\b/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
  const empty = {
    startMonth: "",
    startYear: "",
    endMonth: "",
    endYear: "",
    current: false
  };
  if (!text) return empty;

  const present = /\b(present|current|now|ongoing)\b/i.test(text);
  const tokenRe =
    /\b(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[.]?\s+)?(\d{4})\b|\b(\d{1,2})\s*[\/.-]\s*(\d{4})\b/gi;

  const hits = [];
  let match;
  while ((match = tokenRe.exec(text))) {
    if (match[2]) {
      hits.push({ month: match[1] || "", year: match[2] });
    } else if (match[4]) {
      hits.push({ month: match[3], year: match[4] });
    }
  }

  if (!hits.length) {
    const yearOnly = text.match(/\b(19|20)\d{2}\b/g) || [];
    if (yearOnly.length === 1) {
      return { ...empty, endYear: yearOnly[0], current: present };
    }
    if (yearOnly.length >= 2) {
      return {
        startMonth: "",
        startYear: yearOnly[0],
        endMonth: "",
        endYear: yearOnly[1],
        current: present
      };
    }
    return { ...empty, current: present };
  }

  const start = hits[0];
  const end = hits[1] || null;

  if (!end) {
    if (present) {
      return {
        startMonth: start.month || "",
        startYear: start.year || "",
        endMonth: "",
        endYear: "",
        current: true
      };
    }
    if (!start.month) {
      return { ...empty, endYear: start.year || "", current: false };
    }
    return {
      startMonth: start.month || "",
      startYear: start.year || "",
      endMonth: "",
      endYear: "",
      current: false
    };
  }

  return {
    startMonth: start.month || "",
    startYear: start.year || "",
    endMonth: present ? "" : end.month || "",
    endYear: present ? "" : end.year || "",
    current: present
  };
}

function bulletsToFallbackSummary(bullets = []) {
  const lines = (Array.isArray(bullets) ? bullets : [])
    .map((b) => String(b || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (!lines.length) return "";
  return lines.map((b) => b.replace(/[.]+$/, "")).join(". ") + ".";
}

function fieldOfStudyFromDegree(degree) {
  const text = String(degree || "").trim();
  if (!text) return "";
  const parts = text.split(/,| in /i).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(1).join(" ");
  return text;
}

function defaultEducationSpan(degree, endYear, endMonth) {
  const d = String(degree || "").toLowerCase();
  let years = 4;
  if (/\b(master|msc|mba|ms\b|ma\b)/i.test(d)) years = 2;
  if (/\b(phd|doctor|doctorate)\b/i.test(d)) years = 4;
  if (/\b(associate)\b/i.test(d)) years = 2;
  const endY = Number(endYear);
  if (!Number.isFinite(endY) || endY < 1970) {
    return { startYear: "", startMonth: endMonth || "08" };
  }
  return { startYear: String(endY - years), startMonth: "08" };
}

export function buildWorkHistory(resumeData = {}) {
  const jobs = Array.isArray(resumeData?.experience) ? resumeData.experience : [];
  return jobs
    .map((job, index) => {
      const parsed = parseDateRange(job?.dates || "");
      const start = dateBundle(parsed.startMonth, parsed.startYear);
      const end = dateBundle(parsed.endMonth, parsed.endYear);
      const company = String(job?.company || "").trim();
      const title = String(job?.title || "").trim();
      if (!company && !title) return null;
      const summary = String(job?.formSummary || job?.summary || "").trim() || bulletsToFallbackSummary(job?.bullets);
      return {
        index,
        company,
        title,
        location: String(job?.location || "").trim(),
        dates: String(job?.dates || "").trim(),
        current: Boolean(parsed.current),
        start,
        end,
        summary,
        bullets: Array.isArray(job?.bullets) ? job.bullets.filter(Boolean).slice(0, 8) : []
      };
    })
    .filter(Boolean);
}

/**
 * One entry per school, so a resume listing two universities fills two
 * education groups on the application form. Saved applicant info describes the
 * primary school only, so it fills gaps in the first entry alone; any further
 * school comes from the resume JSON as-is.
 */
export function buildEducationHistory(resumeData = {}, applicantInfo = {}) {
  const schools = normalizeEducation(resumeData?.education);
  const list = schools.length ? schools : [{ school: "", degree: "", year: "" }];

  return list
    .map((edu, position) => {
      const primary = position === 0;
      const school = String(edu.school || (primary ? applicantInfo.schoolName : "") || "").trim();
      const degree = String(edu.degree || "").trim();
      const fieldOfStudy =
        (primary ? String(applicantInfo.fieldOfStudy || "").trim() : "") ||
        fieldOfStudyFromDegree(degree);

      const parsedYear = parseDateRange(edu.year || "");
      const gradRaw = primary ? String(applicantInfo.graduationDate || "").trim() : "";
      const gradParts = gradRaw.match(/^(\d{4})-(\d{1,2})/);
      const endYear = gradParts?.[1] || parsedYear.endYear || parsedYear.startYear || String(edu.year || "").replace(/\D/g, "").slice(0, 4);
      const endMonth = gradParts?.[2] || parsedYear.endMonth || "05";

      if (!school && !degree && !endYear) return null;

      const span = defaultEducationSpan(
        degree || (primary ? applicantInfo.highestDegree : ""),
        endYear,
        endMonth
      );
      const startMonth = parsedYear.startMonth || span.startMonth || "08";
      const startYear = parsedYear.startYear || span.startYear;

      return {
        school,
        degree,
        fieldOfStudy,
        current: false,
        start: dateBundle(startMonth, startYear),
        end: dateBundle(endMonth, endYear)
      };
    })
    .filter(Boolean)
    .map((entry, index) => ({ index, ...entry }));
}

export function hasFormHistory(workHistory = [], educationHistory = []) {
  return (Array.isArray(workHistory) && workHistory.length > 0) ||
    (Array.isArray(educationHistory) && educationHistory.length > 0);
}

export async function getStoredResumeJson() {
  const data = await chrome.storage.local.get("last_resume_json");
  const resume = data.last_resume_json;
  return resume && typeof resume === "object" ? resume : null;
}

export async function persistRoleSummaries(workHistory = []) {
  const data = await chrome.storage.local.get("last_resume_json");
  const resume = data.last_resume_json;
  if (!resume || !Array.isArray(resume.experience)) return;
  let changed = false;
  for (const row of workHistory) {
    const job = resume.experience[row.index];
    if (!job || !row.summary) continue;
    if (String(job.formSummary || "") === row.summary) continue;
    job.formSummary = row.summary;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ last_resume_json: resume });
}
