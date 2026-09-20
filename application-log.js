/** Capped log of apply attempts (imported + manual Auto Apply). */

const LOG_KEY = "application_log";
const MAX_LOG = 400;

export async function getApplicationLog() {
  const data = await chrome.storage.local.get(LOG_KEY);
  return Array.isArray(data[LOG_KEY]) ? data[LOG_KEY] : [];
}

export async function appendApplicationEvent(event = {}) {
  const row = {
    id: `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    profileId: String(event.profileId || "").trim(),
    jobTitle: String(event.jobTitle || "").trim(),
    companyName: String(event.companyName || "").trim(),
    jdLink: String(event.jdLink || "").trim(),
    status: String(event.status || "").trim() || "ready_for_review",
    source: String(event.source || "").trim(),
    detail: String(event.detail || "").trim().slice(0, 400),
    importedJobId: String(event.importedJobId || "").trim()
  };
  if (!row.jobTitle && !row.companyName && !row.jdLink) return row;

  const log = await getApplicationLog();
  const next = [row, ...log.filter((e) => e?.id !== row.id)].slice(0, MAX_LOG);
  await chrome.storage.local.set({ [LOG_KEY]: next });
  return row;
}

export function groupJobStatus(status) {
  const s = String(status || "").trim();
  if (s === "completed") return "applied";
  if (s === "ready_for_review") return "ready";
  if (s === "needs_review") return "review";
  if (["opening", "generating", "opening_form", "filling"].includes(s)) return "progress";
  if (s === "failed") return "failed";
  if (s === "unavailable") return "blocked";
  return "queued";
}

export const STATUS_META = {
  applied: { label: "Applied", hint: "Marked complete / submitted" },
  ready: { label: "Ready to submit", hint: "Form filled — waiting on you" },
  review: { label: "Needs review", hint: "Blocked on a field or login" },
  progress: { label: "In progress", hint: "Generate or Auto Apply running" },
  queued: { label: "Queued", hint: "Captured, not started" },
  failed: { label: "Failed", hint: "Apply or generate error" },
  blocked: { label: "Blocked", hint: "Job no longer available" }
};

export function emptyStatusCounts() {
  return {
    applied: 0,
    ready: 0,
    review: 0,
    progress: 0,
    queued: 0,
    failed: 0,
    blocked: 0
  };
}

function sourceBucket(source, url = "") {
  const s = String(source || "").toLowerCase();
  const u = String(url || "").toLowerCase();
  if (s.includes("dice") || u.includes("dice.com")) return "Dice";
  if (s.includes("jobright") || u.includes("jobright.ai")) return "Jobright";
  if (s.includes("linkedin") || u.includes("linkedin.com")) return "LinkedIn";
  return "Other";
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildDashboardStats({ jobs = [], profiles = [], log = [] } = {}) {
  const profileLabel = (id) => {
    if (!id) return "Unassigned";
    return profiles.find((p) => p.id === id)?.label || id;
  };

  const rows = jobs.map((job) => ({
    id: job.id || job.importedJobId || "",
    jobTitle: job.jobTitle || "",
    companyName: job.companyName || "",
    jdLink: job.jdLink || job.url || "",
    source: sourceBucket(job.source, job.jdLink || job.url),
    status: String(job.status || "imported"),
    group: groupJobStatus(job.status),
    profileId: String(job.profileId || "").trim(),
    profileLabel: profileLabel(job.profileId),
    updatedAt: Number(job.updatedAt || job.completedAt || job.createdAt || 0),
    completedAt: Number(job.completedAt || 0),
    createdAt: Number(job.createdAt || 0),
    statusDetail: String(job.statusDetail || "")
  }));

  const byImportedId = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
  const seenLinks = new Set(rows.map((r) => String(r.jdLink || "").replace(/\/+$/, "").toLowerCase()).filter(Boolean));
  for (const event of log) {
    const existing = event.importedJobId ? byImportedId.get(event.importedJobId) : null;
    if (existing) {
      if (!existing.profileId && event.profileId) {
        existing.profileId = event.profileId;
        existing.profileLabel = profileLabel(event.profileId);
      }
      continue;
    }
    const link = String(event.jdLink || "").replace(/\/+$/, "").toLowerCase();
    if (link && seenLinks.has(link)) continue;
    if (link) seenLinks.add(link);
    rows.push({
      id: event.id || "",
      jobTitle: event.jobTitle || "",
      companyName: event.companyName || "",
      jdLink: event.jdLink || "",
      source: sourceBucket(event.source, event.jdLink),
      status: event.status || "ready_for_review",
      group: groupJobStatus(event.status),
      profileId: String(event.profileId || "").trim(),
      profileLabel: profileLabel(event.profileId),
      updatedAt: Number(event.at || 0),
      completedAt: event.status === "completed" ? Number(event.at || 0) : 0,
      createdAt: Number(event.at || 0),
      statusDetail: event.detail || ""
    });
  }

  const totals = emptyStatusCounts();
  const byProfile = new Map();
  const bySource = { Dice: 0, Jobright: 0, LinkedIn: 0, Other: 0 };
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const dayStart = startOfDay(now);
  let appliedThisWeek = 0;
  let appliedToday = 0;

  const ensureProfile = (id, label) => {
    if (!byProfile.has(id)) {
      byProfile.set(id, {
        profileId: id,
        label,
        ...emptyStatusCounts(),
        total: 0
      });
    }
    return byProfile.get(id);
  };

  for (const p of profiles) ensureProfile(p.id, p.label);

  for (const row of rows) {
    totals[row.group] = (totals[row.group] || 0) + 1;
    const bucket = ensureProfile(row.profileId, row.profileLabel);
    bucket[row.group] += 1;
    bucket.total += 1;
    bySource[row.source] = (bySource[row.source] || 0) + 1;
    const appliedAt = row.completedAt || (row.group === "applied" ? row.updatedAt : 0);
    if (appliedAt >= weekAgo && row.group === "applied") appliedThisWeek += 1;
    if (appliedAt >= dayStart && row.group === "applied") appliedToday += 1;
  }

  const sortedRows = [...rows].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const recent = sortedRows.slice(0, 40);

  return {
    totals,
    totalJobs: rows.length,
    applied: totals.applied,
    appliedThisWeek,
    appliedToday,
    byProfile: [...byProfile.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)),
    bySource,
    rows: sortedRows,
    recent,
    generatedAt: now
  };
}
