import { getResumeProfiles } from "./profiles.js";
import { getApplicationLog, buildDashboardStats, STATUS_META, groupJobStatus } from "./application-log.js";
import { closeHostWindow } from "./close-host.js";

const els = {
  profileFilter: document.getElementById("profileFilter"),
  dateFilter: document.getElementById("dateFilter"),
  categoryFilter: document.getElementById("categoryFilter"),
  searchFilter: document.getElementById("searchFilter"),
  refreshBtn: document.getElementById("refreshBtn"),
  closeBtn: document.getElementById("closeBtn"),
  statCards: document.getElementById("statCards"),
  profileGrid: document.getElementById("profileGrid"),
  sourceBars: document.getElementById("sourceBars"),
  jobsBody: document.getElementById("jobsBody"),
  emptyState: document.getElementById("emptyState"),
  activityHint: document.getElementById("activityHint")
};

let profiles = [];
let rawJobs = [];
let log = [];
let appliedUrlFilter = false;
let searchTimer = null;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatWhen(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  const diff = Date.now() - n;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days}d ago`;
  return new Date(n).toLocaleDateString();
}

function formatApplyDate(ts) {
  const n = Number(ts || 0);
  if (!n) return "—";
  return new Date(n).toLocaleDateString();
}

function chip(group, count) {
  if (!count) return "";
  const meta = STATUS_META[group] || { label: group };
  return `<span class="chip ${group}"><b>${count}</b> ${escapeHtml(meta.label)}</span>`;
}

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dateRangeStart(range) {
  const now = Date.now();
  if (range === "today") return startOfDay(now);
  if (range === "7d") return now - 7 * 24 * 60 * 60 * 1000;
  if (range === "30d") return now - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

function activityTs(jobOrEvent) {
  return Number(
    jobOrEvent.completedAt ||
      jobOrEvent.appliedAt ||
      jobOrEvent.updatedAt ||
      jobOrEvent.createdAt ||
      jobOrEvent.at ||
      0
  );
}

function matchesSearch(jobOrEvent, q) {
  if (!q) return true;
  const title = String(jobOrEvent.jobTitle || "").toLowerCase();
  const company = String(jobOrEvent.companyName || "").toLowerCase();
  return title.includes(q) || company.includes(q);
}

async function loadData() {
  const [stored, resumeProfiles, events] = await Promise.all([
    chrome.storage.local.get(["imported_jobs_by_id"]),
    getResumeProfiles(),
    getApplicationLog()
  ]);
  profiles = resumeProfiles || [];
  const byId = stored.imported_jobs_by_id || {};
  rawJobs = Object.entries(byId).map(([id, job]) => ({ id, ...(job || {}) }));
  log = events;
}

function filteredInputs() {
  const profileId = els.profileFilter?.value || "";
  const dateRange = els.dateFilter?.value || "all";
  const category = els.categoryFilter?.value || "all";
  const q = String(els.searchFilter?.value || "")
    .trim()
    .toLowerCase();
  const since = dateRangeStart(dateRange);

  const jobs = rawJobs.filter((job) => {
    if (profileId && String(job.profileId || "") !== profileId) return false;
    if (!matchesSearch(job, q)) return false;
    if (since) {
      const ts = activityTs(job);
      if (ts && ts < since) return false;
    }
    return true;
  });

  const events = log.filter((event) => {
    if (profileId && String(event.profileId || "") !== profileId) return false;
    if (!matchesSearch(event, q)) return false;
    if (since) {
      const ts = activityTs(event);
      if (ts && ts < since) return false;
    }
    return true;
  });

  const profileSet = profileId ? profiles.filter((p) => p.id === profileId) : profiles;
  return { jobs, events, profileSet, category, dateRange, q };
}

function currentStats() {
  const { jobs, events, profileSet, category } = filteredInputs();
  let jobsIn = jobs;
  let eventsIn = events;
  if (category && category !== "all") {
    jobsIn = jobs.filter((job) => groupJobStatus(job.status) === category);
    eventsIn = events.filter((event) => groupJobStatus(event.status) === category);
  }
  const stats = buildDashboardStats({ jobs: jobsIn, profiles: profileSet, log: eventsIn });
  return {
    ...stats,
    recent: (stats.rows || stats.recent || []).slice(0, 100)
  };
}

function renderFilter() {
  const selected = els.profileFilter.value;
  els.profileFilter.innerHTML = `<option value="">All profiles</option>`;
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label;
    els.profileFilter.appendChild(opt);
  }
  if ([...els.profileFilter.options].some((o) => o.value === selected)) {
    els.profileFilter.value = selected;
  }
}

function renderStats(stats) {
  const cards = [
    {
      key: "applied",
      label: "Jobs applied",
      value: stats.applied,
      note: `${stats.appliedToday} today · ${stats.appliedThisWeek} this week`,
      cls: "is-applied"
    },
    {
      key: "ready",
      label: "Ready to submit",
      value: stats.totals.ready,
      note: STATUS_META.ready.hint,
      cls: "is-ready"
    },
    {
      key: "review",
      label: "Needs review",
      value: stats.totals.review + stats.totals.failed,
      note: `${stats.totals.review} review · ${stats.totals.failed} failed`,
      cls: "is-review"
    },
    {
      key: "queue",
      label: "In pipeline",
      value: stats.totals.queued + stats.totals.progress,
      note: `${stats.totals.progress} running · ${stats.totals.queued} queued`,
      cls: ""
    }
  ];
  els.statCards.innerHTML = cards
    .map(
      (c) => `<article class="stat ${c.cls}">
        <p class="label">${escapeHtml(c.label)}</p>
        <p class="value">${c.value}</p>
        <p class="note">${escapeHtml(c.note)}</p>
      </article>`
    )
    .join("");
}

function renderProfiles(stats) {
  if (!stats.byProfile.length) {
    els.profileGrid.innerHTML = `<p class="empty">No profile activity yet.</p>`;
    return;
  }
  els.profileGrid.innerHTML = stats.byProfile
    .map((p) => {
      const groups = ["applied", "ready", "review", "progress", "queued", "failed", "blocked"];
      const chips = groups.map((g) => chip(g, p[g])).filter(Boolean).join("");
      const total = Math.max(1, p.total);
      const bar = groups
        .map((g) => (p[g] ? `<i class="${g}" style="width:${Math.round((100 * p[g]) / total)}%"></i>` : ""))
        .join("");
      return `<article class="profile-card">
        <h3>${escapeHtml(p.label)} <span class="muted">· ${p.total}</span></h3>
        <div class="mix-bar" aria-hidden="true">${bar}</div>
        <div class="mix">${chips || `<span class="muted">No jobs yet</span>`}</div>
      </article>`;
    })
    .join("");
}

function renderSources(stats) {
  const entries = Object.entries(stats.bySource).filter(([, n]) => n > 0);
  if (!entries.length) {
    els.sourceBars.innerHTML = `<p class="empty">No captured jobs yet.</p>`;
    return;
  }
  const max = Math.max(1, ...entries.map(([, n]) => n));
  els.sourceBars.innerHTML = entries
    .map(([name, count]) => {
      const width = Math.round((100 * count) / max);
      return `<div class="bar-row">
        <span>${escapeHtml(name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
        <span>${count}</span>
      </div>`;
    })
    .join("");
}

function renderTable(stats) {
  const rows = stats.recent || [];
  els.emptyState.hidden = rows.length > 0;
  const { dateRange, category, q } = filteredInputs();
  const bits = [`${stats.totalJobs} jobs in view`];
  if (dateRange !== "all") bits.push(dateRange === "today" ? "today" : dateRange);
  if (category !== "all") bits.push(STATUS_META[category]?.label || category);
  if (q) bits.push(`“${q}”`);
  els.activityHint.textContent = bits.join(" · ");
  els.jobsBody.innerHTML = rows
    .map((row) => {
      const meta = STATUS_META[row.group] || { label: row.status };
      const title = row.jdLink
        ? `<a href="${escapeHtml(row.jdLink)}" target="_blank" rel="noreferrer">${escapeHtml(row.jobTitle || "Untitled")}</a>`
        : escapeHtml(row.jobTitle || "Untitled");
      const appliedAt = row.completedAt || (row.group === "applied" ? row.updatedAt : 0);
      return `<tr>
        <td class="role">${title}</td>
        <td>${escapeHtml(row.companyName || "—")}</td>
        <td>${escapeHtml(row.profileLabel)}</td>
        <td>${escapeHtml(row.source)}</td>
        <td><span class="chip ${row.group}">${escapeHtml(meta.label)}</span></td>
        <td class="muted">${escapeHtml(formatApplyDate(appliedAt))}</td>
        <td class="muted">${escapeHtml(formatWhen(row.updatedAt))}</td>
      </tr>`;
    })
    .join("");
}

function render() {
  const stats = currentStats();
  renderStats(stats);
  renderProfiles(stats);
  renderSources(stats);
  renderTable(stats);
}

async function boot() {
  await loadData();
  renderFilter();
  if (!appliedUrlFilter) {
    const params = new URLSearchParams(location.search);
    const preselect = params.get("profileId") || "";
    if (preselect && [...els.profileFilter.options].some((o) => o.value === preselect)) {
      els.profileFilter.value = preselect;
    }
    const date = params.get("date") || "";
    if (date && [...(els.dateFilter?.options || [])].some((o) => o.value === date)) {
      els.dateFilter.value = date;
    }
    const category = params.get("category") || "";
    if (category && [...(els.categoryFilter?.options || [])].some((o) => o.value === category)) {
      els.categoryFilter.value = category;
    }
    appliedUrlFilter = true;
  }
  render();
}

els.profileFilter.addEventListener("change", render);
els.dateFilter?.addEventListener("change", render);
els.categoryFilter?.addEventListener("change", render);
els.searchFilter?.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 160);
});
els.refreshBtn.addEventListener("click", () => {
  boot().catch(() => {});
});
els.closeBtn.addEventListener("click", () => closeHostWindow());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.imported_jobs_by_id && !changes.application_log && !changes.imported_jobs_version) {
    return;
  }
  boot().catch(() => {});
});

boot().catch(() => {});
