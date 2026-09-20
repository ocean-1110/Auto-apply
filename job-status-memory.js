/**
 * Long-lived memory of what happened to each job.
 *
 * `imported_jobs_by_id` is the *queue*: it is emptied, pruned and re-imported all
 * the time, so it cannot answer "did I already generate a resume for this role?".
 * This store keeps the outcome of every job keyed by its job link (and id), so a
 * role that is removed and later re-imported comes back showing its real status
 * instead of a fresh "imported".
 */

import { normalizeJobLink } from "./capture-jobs.js";

export const JOB_STATUS_MEMORY_KEY = "job_status_memory";

/** Keep the store bounded; oldest entries are dropped first. */
const MAX_ENTRIES = 5000;

/** Mid-run states are not outcomes — never archive them. */
const TRANSIENT_STATUSES = new Set(["opening", "generating", "opening_form", "filling", "imported"]);

/** Fields worth carrying across a remove/re-import cycle. */
const REMEMBERED_FIELDS = [
  "status",
  "statusDetail",
  "attempts",
  "lastAttemptAt",
  "completedAt",
  "appliedAt",
  "profileId",
  "hasGeneratedResume",
  "resumeFolder",
  "resumeFileName",
  "coverLetterFileName",
  "atsScore",
  "atsReport"
];

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Stable company + title key for duplicate detection across URLs/sources. */
export function companyTitleKey(job) {
  if (!job || typeof job !== "object") return "";
  const company = normalizeText(job.companyName);
  const title = normalizeText(job.jobTitle);
  if (!company || !title) return "";
  return `${company}|${title}`;
}

/**
 * All keys a job may be filed under, most specific first.
 * The link is the stable identity across sources; the id and company+title are
 * fallbacks for jobs captured without a usable URL.
 */
export function jobStatusKeys(job) {
  if (!job || typeof job !== "object") return [];
  const keys = [];
  const link = normalizeJobLink(job.jdLink || job.url || "").toLowerCase();
  if (link) keys.push(`url:${link}`);
  const id = String(job.id || "").trim();
  if (id) keys.push(`id:${id}`);
  const ct = companyTitleKey(job);
  if (ct) keys.push(`ct:${ct}`);
  return keys;
}

/** The key a new record is written under (the others are written as aliases). */
export function jobStatusKey(job) {
  return jobStatusKeys(job)[0] || "";
}

export async function readJobStatusMemory() {
  try {
    const data = await chrome.storage.local.get(JOB_STATUS_MEMORY_KEY);
    const memory = data[JOB_STATUS_MEMORY_KEY];
    return memory && typeof memory === "object" ? memory : {};
  } catch {
    return {};
  }
}

async function writeJobStatusMemory(memory) {
  let next = memory;
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys
      .map((key) => [key, Number(next[key]?.updatedAt || 0)])
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    next = Object.fromEntries(sorted.map(([key]) => [key, memory[key]]));
  }
  await chrome.storage.local.set({ [JOB_STATUS_MEMORY_KEY]: next });
}

function pickRememberedFields(job) {
  const out = {};
  for (const field of REMEMBERED_FIELDS) {
    const value = job[field];
    if (value === undefined || value === null || value === "") continue;
    out[field] = value;
  }
  return out;
}

/**
 * Archive a job's outcome. In-progress states are ignored so a stopped run does
 * not overwrite the last real result.
 */
export async function rememberJobStatus(job) {
  if (!job || typeof job !== "object") return;
  const status = String(job.status || "").trim();
  if (!status || TRANSIENT_STATUSES.has(status)) return;

  const keys = jobStatusKeys(job);
  if (!keys.length) return;

  const memory = await readJobStatusMemory();
  const record = {
    ...pickRememberedFields(job),
    status,
    jobTitle: String(job.jobTitle || ""),
    companyName: String(job.companyName || ""),
    jdLink: String(job.jdLink || job.url || ""),
    updatedAt: Date.now()
  };
  for (const key of keys) memory[key] = record;
  await writeJobStatusMemory(memory);
}

/** Archive several jobs in one storage write. */
export async function rememberJobStatuses(jobs = []) {
  const list = (Array.isArray(jobs) ? jobs : []).filter(
    (job) => job && !TRANSIENT_STATUSES.has(String(job.status || "").trim()) && String(job.status || "").trim()
  );
  if (!list.length) return;

  const memory = await readJobStatusMemory();
  const now = Date.now();
  let changed = false;
  for (const job of list) {
    const keys = jobStatusKeys(job);
    if (!keys.length) continue;
    const record = {
      ...pickRememberedFields(job),
      status: String(job.status || ""),
      jobTitle: String(job.jobTitle || ""),
      companyName: String(job.companyName || ""),
      jdLink: String(job.jdLink || job.url || ""),
      updatedAt: now
    };
    for (const key of keys) memory[key] = record;
    changed = true;
  }
  if (changed) await writeJobStatusMemory(memory);
}

/** The archived record for a job, or null. */
export function lookupJobStatus(memory, job) {
  if (!memory) return null;
  for (const key of jobStatusKeys(job)) {
    const hit = memory[key];
    if (hit && typeof hit === "object" && hit.status) return hit;
  }
  return null;
}

const APPLIED_STATUSES = new Set(["completed", "unavailable", "already_applied"]);

/**
 * Company|title keys for roles already applied / closed.
 * Same company with a different title is allowed; same company+title is a duplicate.
 */
export function collectAppliedCompanyTitleKeys(memory = {}, extraJobs = []) {
  const keys = new Set();
  const add = (job) => {
    if (!job || typeof job !== "object") return;
    const status = String(job.status || "").trim();
    if (!APPLIED_STATUSES.has(status)) return;
    const ct = companyTitleKey(job);
    if (ct) keys.add(ct);
  };
  for (const rec of Object.values(memory || {})) add(rec);
  for (const job of Array.isArray(extraJobs) ? extraJobs : []) add(job);
  return keys;
}

/**
 * Merge an archived outcome onto a freshly imported job.
 * Job content (title, JD, salary…) always comes from the fresh import; only the
 * outcome fields are restored.
 */
export function applyRememberedStatus(job, memory) {
  const hit = lookupJobStatus(memory, job);
  if (!hit) return job;

  const restored = { ...job };
  for (const field of REMEMBERED_FIELDS) {
    if (hit[field] === undefined) continue;
    restored[field] = hit[field];
  }
  restored.statusRestoredAt = Date.now();
  restored.statusRestoredFrom = hit.updatedAt || 0;
  if (!restored.statusDetail) {
    restored.statusDetail = `Previously ${hit.status}.`;
  }
  return restored;
}

/** Drop a job's archived outcome (used by "forget"/reset actions). */
export async function forgetJobStatus(job) {
  const keys = jobStatusKeys(job);
  if (!keys.length) return;
  const memory = await readJobStatusMemory();
  let changed = false;
  for (const key of keys) {
    if (memory[key]) {
      delete memory[key];
      changed = true;
    }
  }
  if (changed) await writeJobStatusMemory(memory);
}
