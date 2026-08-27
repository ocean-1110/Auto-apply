/**
 * Greenhouse job-page extractor.
 * Register a new file like this (and add it to catalog.js + AUTOFILL_CONTENT_FILES) to scale.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean?.helpers) return;
  const {
    htmlToPlainText,
    readJsonScript,
    canonicalPageUrl,
    normalizeEmploymentType,
    elementText,
    salaryBoundsFromText,
    scrapeSchemaOrgJobPosting
  } = Ocean.helpers;

function greenhouseIdsFromUrl(url = location.href) {
  try {
    const u = new URL(String(url || ""), location.href);
    const path = u.pathname || "";
    const parts = path.split("/").filter(Boolean);
    const jobsIdx = parts.findIndex((p) => p === "jobs" || p === "job");
    const boardFromPath = jobsIdx > 0 ? parts[jobsIdx - 1] : parts[0] || "";
    const idFromPath =
      jobsIdx >= 0 && parts[jobsIdx + 1] ? String(parts[jobsIdx + 1]).replace(/\D/g, "") : "";
    const board =
      u.searchParams.get("for") ||
      u.searchParams.get("gh_src") ||
      (/^(jobs|embed|job)$/i.test(boardFromPath) ? "" : boardFromPath);
    const id =
      u.searchParams.get("gh_jid") ||
      u.searchParams.get("token") ||
      u.searchParams.get("id") ||
      idFromPath;
    return { board: String(board || "").trim(), id: String(id || "").replace(/\D/g, "") };
  } catch {
    return { board: "", id: "" };
  }
}

function parseGreenhouseJobJson(raw, { board = "", fallbackUrl = "" } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const title = String(raw.title || raw.jobTitle || raw.name || "").trim();
  const html = String(raw.content || raw.description || raw.jobDescription || "").trim();
  const jdText = htmlToPlainText(html);
  if (!title && !jdText) return null;

  const loc =
    raw.location && typeof raw.location === "object"
      ? String(raw.location.name || raw.location.location || "").trim()
      : String(raw.location || raw.jobLocation || "").trim();
  const company =
    String(
      raw.company_name ||
        raw.companyName ||
        (typeof raw.company === "string" ? raw.company : raw.company?.name) ||
        raw.hiringOrganization?.name ||
        ""
    ).trim() ||
    String(board || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const absUrl = String(raw.absolute_url || raw.url || raw.applyUrl || fallbackUrl || "").trim();
  const depts = Array.isArray(raw.departments)
    ? raw.departments.map((d) => d?.name).filter(Boolean)
    : [];
  const fromJd = salaryBoundsFromText(jdText);
  const remote = /\bremote\b/i.test(loc) || /\bthis position is remote\b/i.test(jdText);
  const id = String(raw.id || raw.internal_job_id || greenhouseIdsFromUrl(absUrl).id || "").trim();
  const titleFromJd = (jdText.match(/seeking a\s+([A-Z][A-Za-z0-9 /&+-]{3,80})\s+to join/i) || [])[1] || "";
  const companyFromJd = (jdText.match(/^([A-Z][A-Za-z0-9 .,&'-]{2,80})\s+is (?:the|a|an|seeking)/m) || [])[1] || "";
  const locFromJd = (jdText.match(/\bbased in\s+([^.\n]{4,80})/i) || [])[1] || "";
  const empFromJd = /\bfull[-\s]?time\b/i.test(jdText)
    ? "Full-time"
    : /\bpart[-\s]?time\b/i.test(jdText)
      ? "Part-time"
      : /\bcontract\b/i.test(jdText)
        ? "Contract"
        : "";

  return {
    jobTitle: title || titleFromJd,
    companyName: company || companyFromJd,
    jdLink: absUrl || fallbackUrl || canonicalPageUrl(),
    jdText,
    applyLink: absUrl || fallbackUrl || canonicalPageUrl(),
    workArrangement: remote ? "Remote" : "",
    employmentType: normalizeEmploymentType(raw.employment_type || raw.employmentType || "") || empFromJd,
    salaryMin: fromJd.salaryMin,
    salaryMax: fromJd.salaryMax,
    datePosted: String(raw.first_published || raw.updated_at || raw.published_at || "").trim(),
    jobLocation: loc || locFromJd,
    source: "greenhouse",
    id: id ? `gh-${id}` : ""
  };
}

function walkGreenhouseJobNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  const parsed = parseGreenhouseJobJson(node);
  if (parsed?.jobTitle && parsed?.jdText) return parsed;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = walkGreenhouseJobNode(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of ["job", "jobPosting", "jobPost", "props", "pageProps", "data", "jobResult"]) {
    if (node[key]) {
      const hit = walkGreenhouseJobNode(node[key], depth + 1);
      if (hit) return hit;
    }
  }
  return parsed;
}

function scrapeGreenhouseEmbeddedJson(doc = document) {
  const next = readJsonScript("__NEXT_DATA__", doc);
  const fromNext = walkGreenhouseJobNode(next);
  if (fromNext?.jdText) return fromNext;

  const scripts = doc.querySelectorAll?.("script") || [];
  for (const el of scripts) {
    const type = String(el.type || "").toLowerCase();
    const text = String(el.textContent || "");
    if (type.includes("json") || type.includes("ld+json")) {
      try {
        const hit = walkGreenhouseJobNode(JSON.parse(text));
        if (hit?.jdText) return hit;
      } catch {
        /* ignore */
      }
    }
    if (!/"description"\s*:|"content"\s*:/.test(text) || text.length < 80) continue;
    try {
      const hit = walkGreenhouseJobNode(JSON.parse(text));
      if (hit?.jdText) return hit;
    } catch {
      /* fragment like `"description": "<p>..."` */
      const m = text.match(/"(?:description|content)"\s*:\s*"((?:\\.|[^"\\])*)"/);
      if (m) {
        try {
          const html = JSON.parse(`"${m[1]}"`);
          const jdText = htmlToPlainText(html);
          if (jdText.length > 80) {
            const titleEl = doc.querySelector("h1, .app-title, [class*='job-title']");
            return parseGreenhouseJobJson(
              {
                title: elementText(titleEl),
                description: html
              },
              { fallbackUrl: canonicalPageUrl() }
            );
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

function scrapeGreenhouseDom(doc = document) {
  const titleEl =
    doc.querySelector(".app-title") ||
    doc.querySelector("h1.app-title") ||
    doc.querySelector("[class*='JobPostingTitle']") ||
    doc.querySelector("h1");
  const companyEl =
    doc.querySelector(".company-name") ||
    doc.querySelector("[class*='company-name']") ||
    doc.querySelector("[class*='CompanyName']");
  const locEl =
    doc.querySelector(".location") ||
    doc.querySelector("[class*='job-location']") ||
    doc.querySelector("[class*='JobLocation']");
  const descEl =
    doc.querySelector("#content") ||
    doc.querySelector(".job__description") ||
    doc.querySelector("[class*='job-post']") ||
    doc.querySelector("[class*='JobDescription']") ||
    doc.querySelector("[data-testid*='job-description']") ||
    doc.querySelector("article");
  const jobTitle = elementText(titleEl);
  const jdText = htmlToPlainText(descEl?.innerHTML || descEl?.innerText || "");
  if (!jobTitle && jdText.length < 80) return null;
  const loc = elementText(locEl);
  const salary = salaryBoundsFromText(jdText);
  return {
    jobTitle,
    companyName: elementText(companyEl),
    jdLink: canonicalPageUrl(),
    jdText,
    applyLink: canonicalPageUrl(),
    workArrangement: /\bremote\b/i.test(loc) || /\bthis position is remote\b/i.test(jdText) ? "Remote" : "",
    employmentType: "",
    salaryMin: salary.salaryMin,
    salaryMax: salary.salaryMax,
    datePosted: "",
    jobLocation: loc,
    source: "greenhouse"
  };
}

async function fetchGreenhouseJobApi(board, id) {
  if (!board || !id) return null;
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}`;
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) return null;
  const json = await res.json();
  return parseGreenhouseJobJson(json, { board, fallbackUrl: canonicalPageUrl() });
}

async function scrapeGreenhouse() {
  const { board, id } = greenhouseIdsFromUrl();
  const embedded = scrapeGreenhouseEmbeddedJson();
  const schema = scrapeSchemaOrgJobPosting();
  const api = await fetchGreenhouseJobApi(board, id).catch(() => null);
  const dom = scrapeGreenhouseDom();

  const pick = (...cands) => {
    let best = null;
    for (const c of cands) {
      if (!c) continue;
      if (!best) best = { ...c };
      else {
        for (const [k, v] of Object.entries(c)) {
          if (v && !best[k]) best[k] = v;
          if (k === "jdText" && String(v).length > String(best.jdText || "").length) best.jdText = v;
          if (k === "jobTitle" && v && !best.jobTitle) best.jobTitle = v;
        }
      }
    }
    return best;
  };

  const data = pick(api, embedded, schema, dom);
  if (!data) return null;
  if (!data.companyName && board) {
    data.companyName = board.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  data.source = "greenhouse";
  data.jdLink = data.jdLink || canonicalPageUrl();
  return data.jobTitle || data.jdText ? data : null;
}

  Ocean.register({
    id: "greenhouse",
    label: "Greenhouse",
    hosts: [/(^|\.)greenhouse\.io$/i],
    scrape: scrapeGreenhouse
  });
})();
