/**
 * Dice job-page extractor.
 * Register a new file like this (and add it to catalog.js + AUTOFILL_CONTENT_FILES) to scale.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean?.helpers) return;
  const {
    htmlToPlainText,
    canonicalPageUrl,
    normalizeEmploymentType,
    elementText,
    findJobPostingLdJson,
    queryAllDeep
  } = Ocean.helpers;

function diceIdFromUrl(url = location.href) {
  try {
    const u = new URL(String(url || ""), "https://www.dice.com");
    const selected = u.searchParams.get("selectedJobId");
    if (selected) return selected;
    const parts = u.pathname.split("/").filter(Boolean);
    const detailIdx = parts.findIndex((p) => p === "job-detail" || p === "detail");
    if (detailIdx >= 0 && parts[detailIdx + 1]) {
      // Modern Dice: /job-detail/{uuid}
      // Legacy: /job-detail/{slug}/{id} or /jobs/detail/{id}
      if (parts[detailIdx] === "job-detail" && parts[detailIdx + 2]) {
        return parts[detailIdx + 2];
      }
      return parts[detailIdx + 1];
    }
    return u.searchParams.get("jobId") || u.searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function cleanDiceTitle(title) {
  const t = String(title || "").trim();
  if (!t) return "";
  if (/^(dice|find jobs|search jobs|jobs|home|job search)$/i.test(t)) return "";
  return t.replace(/\s*\|\s*Dice.*$/i, "").trim();
}

function locationFromLd(ld) {
  if (!ld) return "";
  if (ld.applicantLocationRequirements?.name) {
    return String(ld.applicantLocationRequirements.name).trim();
  }
  const loc = ld.jobLocation;
  if (typeof loc === "string") return loc.trim();
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (!first) return "";
  if (typeof first === "string") return first.trim();
  const addr = first.address || {};
  return (
    [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .join(", ") ||
    String(first.name || "").trim()
  );
}

function salaryBoundsFromLd(ld) {
  const raw = ld?.baseSalary?.value ?? ld?.estimatedSalary?.value;
  if (raw == null || raw === "") return { min: "", max: "" };
  if (typeof raw === "number" || typeof raw === "string") {
    const n = String(raw).trim();
    return { min: n, max: n };
  }
  return {
    min: raw.minValue != null ? String(raw.minValue) : "",
    max: raw.maxValue != null ? String(raw.maxValue) : ""
  };
}

function diceDetailRoot(doc = document) {
  const deep = typeof queryAllDeep === "function"
    ? queryAllDeep('[class*="@container/job-detail"], [class*="job-detail"]', doc)
    : [];
  return (
    deep[0] ||
    doc.querySelector('[class*="@container/job-detail"]') ||
    doc.querySelector('[class*="job-detail"]') ||
    doc.querySelector("main") ||
    doc.body ||
    doc
  );
}

function diceCompanyFromDom(root) {
  const links = Array.from(root.querySelectorAll('a[href*="/company-profile/"]'));
  for (const a of links) {
    const t = elementText(a);
    if (t) return t;
  }
  return (
    elementText(root.querySelector('[data-cy="companyNameLink"]')) ||
    elementText(root.querySelector('[data-cy="companyName"]')) ||
    elementText(root.querySelector("[class*='companyName']")) ||
    ""
  );
}

function diceIdFromDom(doc = document) {
  const fromUrl = diceIdFromUrl(doc.defaultView?.location?.href || location.href);
  if (fromUrl) return fromUrl;
  const root = diceDetailRoot(doc);
  const href =
    root.querySelector('a[href*="/job-detail/"]')?.getAttribute("href") ||
    doc.querySelector('a[href*="/job-detail/"]')?.getAttribute("href") ||
    "";
  return diceIdFromUrl(href) || "";
}

function diceCanonicalLink(jobId) {
  if (jobId) return `https://www.dice.com/job-detail/${jobId}`;
  try {
    if (/\/job-detail\//i.test(location.pathname)) {
      const u = new URL(location.href);
      u.hash = "";
      u.search = "";
      return u.toString();
    }
  } catch {
    /* ignore */
  }
  return canonicalPageUrl();
}

function assembleDiceFromLd(ld, { jobId = "", dom = null } = {}) {
  if (!ld && !dom) return null;
  ld = ld || {};
  dom = dom || {};

  const ldOrg = ld.hiringOrganization;
  const ldCompany =
    (ldOrg && (ldOrg.name || ldOrg.legalName)) ||
    (typeof ldOrg === "string" ? ldOrg : "") ||
    "";
  const salary = salaryBoundsFromLd(ld);
  const remoteFromLd =
    String(ld.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

  let jdText = String(dom.jdText || "").trim();
  if (!jdText && ld.description) jdText = htmlToPlainText(ld.description);

  const skills = Array.isArray(dom.skills) ? dom.skills.filter(Boolean) : [];
  if (skills.length && jdText && !/^Key skills:/i.test(jdText)) {
    jdText = `Key skills:\n${skills.join("; ")}\n\n${jdText}`;
  } else if (skills.length && !jdText) {
    jdText = `Key skills:\n${skills.join("; ")}`;
  }

  const id =
    jobId ||
    String(ld.identifier?.value || "") ||
    diceIdFromUrl(String(ld.url || "")) ||
    "";
  const jobTitle = cleanDiceTitle(
    String(dom.jobTitle || "").trim() || String(ld.title || ld.name || "").trim()
  );
  const companyName = String(dom.companyName || "").trim() || String(ldCompany).trim();

  if (!jobTitle && !jdText) return null;

  return {
    jobId: id,
    jobTitle,
    companyName,
    jdLink: diceCanonicalLink(id),
    jdText,
    applyLink: String(ld.url || "").trim(),
    workArrangement: String(dom.workArrangement || "").trim() || remoteFromLd,
    employmentType: normalizeEmploymentType(
      dom.employmentType || ld.employmentType
    ),
    salaryMin: salary.min,
    salaryMax: salary.max,
    datePosted:
      String(dom.datePosted || "").trim() || String(ld.datePosted || "").trim(),
    jobLocation: String(dom.jobLocation || "").trim() || locationFromLd(ld)
  };
}

/**
 * Dice scrape for the current redesigned UI:
 * - Dedicated /job-detail/{uuid} pages embed schema.org JobPosting JSON-LD.
 * - Search SERP uses a side panel (`?selectedJobId=`) with NO JSON-LD and no
 *   legacy data-cy hooks; JD lives in a CSS-module class containing
 *   "jobDescription". When the panel is incomplete we fetch the detail URL.
 */
function scrapeDiceDom(doc = document) {
  const root = diceDetailRoot(doc);
  const text = elementText;

  const titleEl =
    root.querySelector('[data-cy="jobTitle"]') ||
    (typeof queryAllDeep === "function" ? queryAllDeep("h1", root)[0] : null) ||
    root.querySelector("h1") ||
    root.querySelector('[class*="jobTitle"]') ||
    doc.querySelector("h1");

  const locationEl =
    root.querySelector('[data-cy="location"]') ||
    root.querySelector('[data-cy="jobLocation"]');

  // Modern Dice: job-detail-description-module__…__jobDescription
  // Legacy: #jobDescription / data-cy / job-description
  const descCandidates =
    typeof queryAllDeep === "function"
      ? queryAllDeep(
          '[class*="jobDescription"], [class*="job-detail-description"], #jobDescription, [data-cy="jobDescription"], [class*="job-description"]',
          root
        )
      : [];
  const descEl =
    descCandidates[0] ||
    root.querySelector('[class*="jobDescription"]') ||
    root.querySelector('[class*="job-detail-description"]') ||
    root.querySelector("#jobDescription") ||
    root.querySelector('[data-cy="jobDescription"]') ||
    root.querySelector('[class*="job-description"]') ||
    root.querySelector('[id*="description"]');

  let jdText = "";
  if (descEl) {
    jdText = String(descEl.innerText || descEl.textContent || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const skills = Array.from(
    root.querySelectorAll(
      '[data-cy="skillsList"] li, [data-cy="chip"], [class*="skill"] li, [class*="SkillChip"], [class*="SkillBadge"]'
    )
  )
    .map((el) => text(el))
    .filter(Boolean)
    .slice(0, 40);

  // Header line often looks like "Remote or Olympia, Washington•Today"
  let workArrangement = "";
  let datePosted = "";
  const headerBits = Array.from(
    root.querySelectorAll("span, div, p, li, time")
  )
    .map((el) => text(el))
    .filter((t) => t && t.length < 80);
  for (const t of headerBits) {
    if (!workArrangement && /\b(Remote|Hybrid|On-?site)\b/i.test(t)) {
      if (/remote/i.test(t)) workArrangement = "Remote";
      else if (/hybrid/i.test(t)) workArrangement = "Hybrid";
      else workArrangement = "On-site";
    }
    if (!datePosted && /^(today|yesterday|\d+\s*(day|hour|week|month)s?\s*ago)$/i.test(t)) {
      datePosted = t;
    }
  }
  datePosted =
    datePosted ||
    text(root.querySelector('[data-cy="postedDate"]')) ||
    text(root.querySelector("time")) ||
    "";

  return {
    jobTitle: text(titleEl),
    companyName: diceCompanyFromDom(root),
    jobLocation: text(locationEl),
    jdText,
    workArrangement:
      workArrangement ||
      text(root.querySelector('[data-cy="workplaceType"]')) ||
      text(root.querySelector('[data-cy="workSettings"]')) ||
      "",
    employmentType:
      text(root.querySelector('[data-cy="employmentDetails"]')) ||
      text(root.querySelector('[data-cy="employmentType"]')) ||
      "",
    datePosted,
    skills
  };
}

function scrapeDiceOnce(doc = document) {
  const jobId = diceIdFromDom(doc);
  const dom = scrapeDiceDom(doc);
  const ld =
    typeof findJobPostingLdJson === "function" ? findJobPostingLdJson(doc) : null;
  return assembleDiceFromLd(ld, { jobId, dom });
}

async function fetchDiceDetailDocument(jobId) {
  if (!jobId) return null;
  try {
    const res = await fetch(`https://www.dice.com/job-detail/${jobId}`, {
      credentials: "include",
      headers: { Accept: "text/html" },
      cache: "no-store"
    });
    if (!res.ok) return null;
    const html = await res.text();
    return new DOMParser().parseFromString(html, "text/html");
  } catch {
    return null;
  }
}

function mergeDiceScrapes(base, next) {
  if (!base) return next;
  if (!next) return base;
  return {
    ...base,
    ...next,
    companyName: next.companyName || base.companyName || "",
    jobTitle: next.jobTitle || base.jobTitle || "",
    jdText: next.jdText || base.jdText || "",
    workArrangement: next.workArrangement || base.workArrangement || "",
    employmentType: next.employmentType || base.employmentType || "",
    salaryMin: next.salaryMin || base.salaryMin || "",
    salaryMax: next.salaryMax || base.salaryMax || "",
    datePosted: next.datePosted || base.datePosted || "",
    jobLocation: next.jobLocation || base.jobLocation || "",
    jobId: next.jobId || base.jobId || "",
    jdLink: next.jdLink || base.jdLink || ""
  };
}

async function scrapeDice(hints = {}) {
  let data = scrapeDiceOnce(document);
  if (data?.jobTitle && data?.companyName && data?.jdText) return data;

  // SERP side panel often has title/company in the DOM but no JSON-LD / incomplete
  // JD. Fetch the canonical /job-detail/{id} HTML (has JobPosting JSON-LD).
  const jobId =
    String(hints.jobId || "").trim() || data?.jobId || diceIdFromDom(document);
  if (jobId) {
    const detailDoc = await fetchDiceDetailDocument(jobId);
    if (detailDoc) {
      const fetched = scrapeDiceOnce(detailDoc);
      data = mergeDiceScrapes(data, fetched);
      if (data?.jobTitle && data?.companyName && data?.jdText) return data;
    }
  }

  // Brief retries for client-side hydration on the open tab.
  for (const waitMs of [400, 800]) {
    await new Promise((r) => setTimeout(r, waitMs));
    data = mergeDiceScrapes(data, scrapeDiceOnce(document));
    if (data?.jobTitle && data?.companyName && data?.jdText) return data;
  }

  return data && (data.jobTitle || data.jdText) ? data : null;
}

  Ocean.register({
    id: "dice",
    label: "Dice",
    hosts: [/(^|\.)dice\.com$/i],
    scrape: scrapeDice
  });
})();
