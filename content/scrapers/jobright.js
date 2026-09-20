/**
 * Jobright job-page extractor.
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
    sectionLines
  } = Ocean.helpers;

function jobrightIdFromUrl() {
  const m = String(location.pathname || "").match(/\/jobs\/info\/([A-Za-z0-9]+)/);
  return m ? m[1] : "";
}

function buildJobrightJdText(jr = {}, cr = {}) {
  const lines = [];
  const summary = String(jr.jobSummary || "").trim();
  if (summary) lines.push(summary, "");
  lines.push(...sectionLines("Responsibilities", jr.coreResponsibilities));
  lines.push(...sectionLines("Qualifications / Skills", jr.skillSummaries));
  lines.push(...sectionLines("Education", jr.educationSummaries));
  lines.push(...sectionLines("Benefits", jr.benefitsSummaries));
  const companyDesc = String(cr.companyDesc || "").trim();
  if (companyDesc) lines.push("Company Overview:", companyDesc);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function companyFromJobrightChrome(doc = document) {
  const title = String(
    doc.querySelector?.("title")?.textContent || doc.title || ""
  ).trim();
  // e.g. "Sr Applications Developer (Salesforce) @ HealthEquity | Jobright.ai"
  let m = title.match(/\s@\s(.+?)\s*\|\s*Jobright/i);
  if (m?.[1]) return m[1].trim();

  const og = doc.querySelector?.('meta[property="og:title"], meta[name="title"]');
  const ogTitle = String(og?.getAttribute?.("content") || "").trim();
  m = ogTitle.match(/\s@\s(.+?)\s*\|\s*Jobright/i);
  if (m?.[1]) return m[1].trim();

  return "";
}

/**
 * Pull the job/company/posting payloads out of a document, keeping only the
 * ones that belong to `urlId`. Jobright is a Next.js SPA: `__NEXT_DATA__` is
 * baked in at the FIRST server render and is NOT updated on client-side
 * navigation, so it can describe a previously viewed job. Matching on the job
 * id in the URL is what prevents returning the wrong (stale) job.
 */
function pickJobrightSources(doc, urlId) {
  const nextDs = readJsonScript("__NEXT_DATA__", doc)?.props?.pageProps?.dataSource || null;
  const helper = readJsonScript("jobright-helper-job-detail-info", doc);
  const posting = readJsonScript("job-posting", doc);

  const candidates = [];
  // Prefer sources that include companyResult (helper is the head-managed
  // payload that updates on SPA navigation; __NEXT_DATA__ can be stale).
  if (helper?.jobResult) {
    candidates.push([helper.jobResult, helper.companyResult || {}]);
  }
  if (nextDs?.jobResult) {
    candidates.push([nextDs.jobResult, nextDs.companyResult || {}]);
  }

  let jr = null;
  let cr = {};
  for (const [cjr, ccr] of candidates) {
    if (urlId && String(cjr.jobId || "") !== urlId) continue;
    if (!jr) jr = cjr;
    if (ccr?.companyName) {
      cr = ccr;
      break;
    }
    if (!cr?.companyName && ccr && Object.keys(ccr).length) cr = ccr;
  }

  // If we matched a job without company, steal companyResult from any
  // same-id candidate (e.g. helper job + nextData company, or vice versa).
  if (jr && !cr?.companyName) {
    for (const [cjr, ccr] of candidates) {
      if (String(cjr.jobId || "") === String(jr.jobId || "") && ccr?.companyName) {
        cr = ccr;
        break;
      }
    }
    if (!cr?.companyName && helper?.companyResult?.companyName) {
      const helperJobId = String(helper?.jobResult?.jobId || "");
      if (!urlId || !helperJobId || helperJobId === urlId) {
        cr = helper.companyResult;
      }
    }
  }

  let validPosting = null;
  if (posting) {
    const pid = String(posting?.identifier?.value || "");
    // Accept posting when id matches, or when id is absent (SPA-updated head
    // scripts sometimes omit identifier while still describing the open job).
    if (!urlId || !pid || pid === urlId) validPosting = posting;
  }

  return {
    jr,
    cr,
    posting: validPosting,
    pageCompany: companyFromJobrightChrome(doc)
  };
}

function assembleJobright({ jr, cr, posting, pageCompany }) {
  if (!jr && !posting) return null;
  jr = jr || {};
  cr = cr || {};

  const jobTitle = String(jr.jobTitle || jr.jobNlpTitle || posting?.title || "")
    .replace(/^\[Remote\]\s*/i, "")
    .trim();
  const socialCompany = Array.isArray(jr.socialConnections)
    ? String(
        jr.socialConnections.find((c) => c?.companyName)?.companyName || ""
      ).trim()
    : "";
  const companyName = String(
    cr.companyName ||
      jr.companyName ||
      socialCompany ||
      posting?.hiringOrganization?.name ||
      pageCompany ||
      ""
  ).trim();

  // Prefer the full schema.org JobPosting description (richest, includes
  // responsibilities/skills/benefits/company overview), then fall back to
  // rebuilding the JD from the structured jobResult fields.
  let jdText = htmlToPlainText(posting?.description || "");
  if (!jdText) jdText = buildJobrightJdText(jr, cr);

  const sal = posting?.baseSalary?.value || {};
  const remoteFromPosting =
    String(posting?.jobLocationType || "").toUpperCase() === "TELECOMMUTE" ? "Remote" : "";

  return {
    jobId: String(jr.jobId || posting?.identifier?.value || ""),
    jobTitle,
    companyName,
    jdLink: canonicalPageUrl(),
    jdText,
    applyLink: String(jr.applyLink || jr.originalUrl || posting?.url || "").trim(),
    workArrangement: String(
      jr.workModel || (jr.isRemote ? "Remote" : "") || remoteFromPosting
    ).trim(),
    employmentType: normalizeEmploymentType(jr.employmentType || posting?.employmentType),
    salaryMin:
      jr.minSalary != null && jr.minSalary !== ""
        ? String(jr.minSalary)
        : sal.minValue != null
          ? String(sal.minValue)
          : "",
    salaryMax:
      jr.maxSalary != null && jr.maxSalary !== ""
        ? String(jr.maxSalary)
        : sal.maxValue != null
          ? String(sal.maxValue)
          : "",
    datePosted: String(jr.publishTime || posting?.datePosted || "").trim(),
    jobLocation: String(jr.jobLocation || "").trim()
  };
}

async function scrapeJobright() {
  const urlId = jobrightIdFromUrl();

  // 1) Use the in-page data, but only if it belongs to the job in the URL.
  let data = assembleJobright(pickJobrightSources(document, urlId));
  // Prefer a complete scrape (company included). If company is missing, keep
  // going to the fresh HTML fetch — SPA pages often have job text but no
  // companyResult until the server render is re-fetched.
  if (
    data &&
    (!urlId || data.jobId === urlId) &&
    (data.jobTitle || data.jdText) &&
    data.companyName
  ) {
    return data;
  }

  // 2) The embedded payload was stale (SPA navigation) or missing company —
  //    re-fetch the current URL's server-rendered HTML and parse it.
  try {
    const res = await fetch(location.href, {
      credentials: "include",
      headers: { Accept: "text/html" },
      cache: "no-store"
    });
    if (res.ok) {
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const fetched = assembleJobright(pickJobrightSources(doc, urlId));
      if (fetched && (fetched.jobTitle || fetched.jdText)) {
        // Merge: prefer fetched company/title, keep any richer in-page JD.
        if (data) {
          return {
            ...data,
            ...fetched,
            companyName: fetched.companyName || data.companyName || "",
            jobTitle: fetched.jobTitle || data.jobTitle || "",
            jdText: fetched.jdText || data.jdText || ""
          };
        }
        return fetched;
      }
    }
  } catch {
    /* network/parse failure — fall back to whatever we had */
  }

  return data && (data.jobTitle || data.jdText) ? data : null;
}

  Ocean.register({
    id: "jobright",
    label: "Jobright",
    hosts: [/(^|\.)jobright\.ai$/i],
    scrape: scrapeJobright
  });
})();
