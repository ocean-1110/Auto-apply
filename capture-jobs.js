/**
 * Bridge between dice-jobright-sf-job-capture and the imported-jobs queue.
 */

export const CAPTURE_API_DEFAULT = "http://127.0.0.1:3847";
export const CAPTURE_ALARM_NAME = "unified_job_capture_4h";
export const CAPTURE_PERIOD_MINUTES = 4 * 60;
export const AUTO_CAPTURE_ENABLED_KEY = "auto_capture_enabled";
export const CAPTURE_API_BASE_KEY = "capture_api_base";
export const LAST_CAPTURE_STATUS_KEY = "last_capture_status";
export const CAPTURE_SEARCH_Q_KEY = "capture_search_q";

export function normalizeJobLink(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function buildJdText(description, keySkills) {
  const jd = String(description || "").trim();
  const skills = String(keySkills || "").trim();
  if (!skills) return jd;
  return `Key skills:\n${skills}\n\n${jd}`;
}

/**
 * Normalize a capture-API / JobRight content-script job into the imported-queue shape.
 * @param {Record<string, unknown>} raw
 */
export function normalizeCaptureJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const jobTitle = String(raw.title || raw.jobTitle || "").trim();
  const companyName = String(raw.organization || raw.companyName || "").trim();
  const jdLink = String(raw.url || raw.jdLink || "").trim();
  const description = String(raw.description || "").trim();
  const keySkills = String(raw.key_skills || raw.keySkills || "").trim();
  const source = String(raw.source || "").trim().toLowerCase();

  if (!id || !jobTitle || !companyName || !jdLink || !description) return null;

  return {
    id,
    jobTitle,
    companyName,
    jdLink,
    keySkills,
    jdText: buildJdText(description, keySkills),
    source: source || "unknown",
    description,
    workArrangement: String(raw.work_arrangement || raw.workArrangement || "").trim(),
    employmentType: String(raw.employment_type || raw.employmentType || "").trim(),
    salaryMin: String(raw.salary_min ?? raw.salaryMin ?? "").trim(),
    salaryMax: String(raw.salary_max ?? raw.salaryMax ?? "").trim(),
    datePosted: String(raw.date_posted || raw.datePosted || "").trim()
  };
}

/**
 * Merge new jobs into the queue without wiping in-progress / existing entries.
 * Skips ids already queued and URLs already on the tracking sheet (already applied/tracked).
 */
export function mergeJobsIntoQueue({
  existingById = {},
  existingOrder = [],
  incoming = [],
  sheetLinks = []
} = {}) {
  const byId = { ...existingById };
  const order = [...existingOrder];
  const sheetSet = new Set(
    (sheetLinks || []).map(normalizeJobLink).filter(Boolean).map((u) => u.toLowerCase())
  );
  const queuedLinks = new Set(
    Object.values(byId)
      .map((j) => normalizeJobLink(j?.jdLink || j?.url))
      .filter(Boolean)
      .map((u) => u.toLowerCase())
  );

  let added = 0;
  let skippedSheet = 0;
  let skippedSheetJobright = 0;
  let skippedSheetDice = 0;
  let skippedQueued = 0;
  let skippedQueuedJobright = 0;
  let skippedQueuedDice = 0;
  let skippedInvalid = 0;
  const now = Date.now();
  const addedIds = [];

  for (const raw of incoming) {
    const job = normalizeCaptureJob(raw);
    if (!job) {
      skippedInvalid += 1;
      continue;
    }
    const src = String(job.source || "").toLowerCase();
    if (byId[job.id]) {
      skippedQueued += 1;
      if (src === "jobright") skippedQueuedJobright += 1;
      else if (src === "dice") skippedQueuedDice += 1;
      continue;
    }
    const link = normalizeJobLink(job.jdLink).toLowerCase();
    if (link && sheetSet.has(link)) {
      skippedSheet += 1;
      if (src === "jobright") skippedSheetJobright += 1;
      else if (src === "dice") skippedSheetDice += 1;
      continue;
    }
    if (link && queuedLinks.has(link)) {
      skippedQueued += 1;
      if (src === "jobright") skippedQueuedJobright += 1;
      else if (src === "dice") skippedQueuedDice += 1;
      continue;
    }

    byId[job.id] = {
      ...job,
      status: "imported",
      attempts: 0,
      statusDetail: "",
      createdAt: now,
      updatedAt: now
    };
    order.unshift(job.id);
    if (link) queuedLinks.add(link);
    added += 1;
    addedIds.push(job.id);
  }

  return {
    byId,
    order,
    added,
    addedIds,
    skippedSheet,
    skippedSheetJobright,
    skippedSheetDice,
    skippedQueued,
    skippedQueuedJobright,
    skippedQueuedDice,
    skippedInvalid,
    version: now
  };
}

/** Count valid capture jobs by source before queue merge. */
export function countCaptureJobsBySource(jobs = []) {
  let jobright = 0;
  let dice = 0;
  let invalid = 0;
  for (const raw of jobs) {
    const normalized = normalizeCaptureJob(raw);
    if (!normalized) {
      invalid += 1;
      continue;
    }
    const src = String(normalized.source || "").toLowerCase();
    if (src === "jobright") jobright += 1;
    else if (src === "dice") dice += 1;
  }
  return { total: jobright + dice, jobright, dice, invalid };
}

/**
 * Human-readable one-line summary for popup status + notifications.
 * Example: Found 45 jobs (Jobright 23, Dice 22). Added 42 (Jobright 20, Dice 22). 3 already on sheet.
 */
export function buildCaptureSummary(status, { running = false } = {}) {
  if (running) return "Capturing Dice + Jobright jobs…";
  if (!status) {
    return "Auto-capture every 4h adds jobs not already on your tracking sheet.";
  }
  if (!status.ok && status.error && !(status.found?.total > 0)) {
    return `Capture failed: ${status.error}`;
  }

  const found = status.found || {};
  const added = status.added || {};
  const skipped = status.skipped || {};
  const foundJr = found.jobright ?? 0;
  const foundDice = found.dice ?? 0;
  const foundTotal = found.total ?? foundJr + foundDice;
  const addedJr = added.jobright ?? status.jobright?.added ?? 0;
  const addedDice = added.dice ?? status.dice?.added ?? 0;
  const addedTotal = added.total ?? addedJr + addedDice;

  const onSheet = skipped.alreadyOnSheet ?? status.skippedSheet ?? 0;
  const inList = skipped.alreadyInList ?? status.skippedQueued ?? 0;
  const jrApplied =
    skipped.appliedOnSite?.jobright ?? status.jobright?.stats?.skippedApplied ?? 0;
  const diceApplied = skipped.appliedOnSite?.dice ?? status.dice?.stats?.skippedApplied ?? 0;

  let msg = `Found ${foundTotal} jobs (Jobright ${foundJr}, Dice ${foundDice})`;
  if (addedTotal > 0) {
    msg += `. Added ${addedTotal} (Jobright ${addedJr}, Dice ${addedDice})`;
  } else {
    msg += ". No new jobs added to the list";
  }

  const skipParts = [];
  if (onSheet) skipParts.push(`${onSheet} already on sheet`);
  if (inList) skipParts.push(`${inList} already in list`);
  if (jrApplied) skipParts.push(`${jrApplied} already applied on Jobright`);
  if (diceApplied) skipParts.push(`${diceApplied} already applied on Dice`);
  if (skipParts.length) msg += `. ${skipParts.join(", ")}`;

  if (status.error && foundTotal > 0) {
    msg += `. Warning: ${status.error}`;
  }

  return msg;
}

export async function captureApiFetch(base, path, { method = "GET", body } = {}) {
  const root = String(base || CAPTURE_API_DEFAULT).replace(/\/+$/, "");
  const opts = { method, headers: { Accept: "application/json" } };
  if (body != null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${root}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Capture API HTTP ${res.status}`);
  }
  return data;
}
