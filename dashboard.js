import { getResumeProfiles } from "./profiles.js";
import { getApplicationLog, buildDashboardStats, STATUS_META } from "./application-log.js";

const els = {
  profileFilter: document.getElementById("profileFilter"),
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

function chip(group, count) {
  if (!count) return "";
  const meta = STATUS_META[group] || { label: group };
  return `<span class="chip ${group}"><b>${count}</b> ${escapeHtml(meta.label)}</span>`;
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

function currentStats() {
  const filter = els.profileFilter.value || "";
  const jobs = filter ? rawJobs.filter((j) => String(j.profileId || "") === filter) : rawJobs;
  const events = filter ? log.filter((e) => String(e.profileId || "") === filter) : log;
  const profileSet = filter ? profiles.filter((p) => p.id === filter) : profiles;
  return buildDashboardStats({ jobs, profiles: profileSet, log: events });
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
  const rows = stats.recent;
  els.emptyState.hidden = rows.length > 0;
  els.activityHint.textContent = rows.length
    ? `${stats.totalJobs} jobs in view`
    : "Latest applications and queue updates";
  els.jobsBody.innerHTML = rows
    .map((row) => {
      const meta = STATUS_META[row.group] || { label: row.status };
      const title = row.jdLink
        ? `<a href="${escapeHtml(row.jdLink)}" target="_blank" rel="noreferrer">${escapeHtml(row.jobTitle || "Untitled")}</a>`
        : escapeHtml(row.jobTitle || "Untitled");
      return `<tr>
        <td class="role">${title}</td>
        <td>${escapeHtml(row.companyName || "—")}</td>
        <td>${escapeHtml(row.profileLabel)}</td>
        <td>${escapeHtml(row.source)}</td>
        <td><span class="chip ${row.group}">${escapeHtml(meta.label)}</span></td>
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
    const preselect = new URLSearchParams(location.search).get("profileId") || "";
    if (preselect && [...els.profileFilter.options].some((o) => o.value === preselect)) {
      els.profileFilter.value = preselect;
    }
    appliedUrlFilter = true;
  }
  render();
}

els.profileFilter.addEventListener("change", render);
els.refreshBtn.addEventListener("click", () => {
  boot().catch(() => {});
});
els.closeBtn.addEventListener("click", () => window.close());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.imported_jobs_by_id && !changes.application_log && !changes.imported_jobs_version) {
    return;
  }
  boot().catch(() => {});
});

boot().catch((err) => {
  els.emptyState.hidden = false;
  els.emptyState.textContent = String(err?.message || err);
});
