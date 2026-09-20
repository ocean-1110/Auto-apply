/**
 * HiringCafe extractor.
 *
 * When the job-details sidebar is open, HiringCafe loads:
 *   GET /api/job-description?id={objectID}
 * Response shape:
 *   { job: { id, objectID, requisition_id, apply_url?,
 *            job_information: { title?, description },
 *            v5_processed_job_data?, v5_processed_company_data? } }
 *
 * Description HTML is stripped the same way as Greenhouse / JazzHR dumps.
 */
(function () {
  const Ocean = globalThis.OceanScrape;
  if (!Ocean?.helpers) return;
  const H = Ocean.helpers;
  const ID_RE = /[a-z0-9-]+___[a-z0-9._-]+___[A-Za-z0-9._-]+/i;

  function originBase() {
    try {
      return `${location.protocol}//${location.host}`;
    } catch {
      return "https://hiringcafe.com";
    }
  }

  function firstJobId(...cands) {
    for (const c of cands) {
      const s = String(c || "").trim();
      if (!s) continue;
      const m = s.match(ID_RE);
      if (m) return m[0];
      if (/^[A-Za-z0-9._-]{8,}$/.test(s) && /___/.test(s)) return s;
    }
    return "";
  }

  function idFromUrl(url = location.href) {
    try {
      const u = new URL(String(url || ""), location.href);
      const fromQuery = firstJobId(
        u.searchParams.get("id"),
        u.searchParams.get("jobId"),
        u.searchParams.get("job_id"),
        u.searchParams.get("objectID"),
        u.searchParams.get("selectedJobId"),
        u.searchParams.get("selected_job_id")
      );
      if (fromQuery) return fromQuery;

      const ss = u.searchParams.get("searchState");
      if (ss) {
        try {
          const parsed = JSON.parse(ss);
          const hit = firstJobId(
            parsed?.selectedJobId,
            parsed?.selected_job_id,
            parsed?.jobId,
            parsed?.id,
            parsed?.objectID
          );
          if (hit) return hit;
        } catch {
          const hit = firstJobId(ss);
          if (hit) return hit;
        }
      }

      const parts = u.pathname.split("/").filter(Boolean);
      const jobIdx = parts.findIndex((p) => /^jobs?$/i.test(p));
      if (jobIdx >= 0 && parts[jobIdx + 1]) {
        const slug = decodeURIComponent(parts[jobIdx + 1]);
        const hit = firstJobId(slug) || firstJobId(slug.split("-").pop());
        if (hit) return hit;
      }
      return firstJobId(decodeURIComponent(u.pathname), u.hash);
    } catch {
      return "";
    }
  }

  function walkForJobId(node, depth = 0) {
    if (depth > 12 || node == null) return "";
    if (typeof node === "string") return firstJobId(node);
    if (typeof node !== "object") return "";
    const preferred = [
      "selectedJobId",
      "selected_job_id",
      "objectID",
      "objectId"
    ];
    for (const k of preferred) {
      const hit = firstJobId(node[k]);
      if (hit) return hit;
    }
    if (node.job && typeof node.job === "object") {
      const hit = firstJobId(node.job.id || node.job.objectID || node.job.objectId);
      if (hit) return hit;
    }
    const idHit = firstJobId(node.id);
    if (idHit && node.job_information) return idHit;
    if (Array.isArray(node)) return "";
    for (const [k, v] of Object.entries(node)) {
      if (/ssrHits|hits|results|jobs/i.test(k) && Array.isArray(v)) continue;
      const hit = walkForJobId(v, depth + 1);
      if (hit) return hit;
    }
    return "";
  }

  function idFromNextData(doc = document) {
    const raw = doc.getElementById("__NEXT_DATA__")?.textContent || "";
    if (!raw) return "";
    try {
      return walkForJobId(JSON.parse(raw));
    } catch {
      return firstJobId(raw);
    }
  }

  function idFromHistory() {
    try {
      return walkForJobId(history.state);
    } catch {
      return "";
    }
  }

  function idFromPerformance() {
    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const name = String(entries[i].name || "");
        const m = name.match(/\/api\/job-description\?[^#]*\bid=([^&]+)/i);
        if (m) {
          const hit = firstJobId(decodeURIComponent(m[1]));
          if (hit) return hit;
        }
      }
    } catch {
      /* ignore */
    }
    return "";
  }

  function attrJobId(el) {
    if (!el) return "";
    const attrs = [
      "data-job-id",
      "data-object-id",
      "data-objectid",
      "data-id",
      "data-requisition-id",
      "id"
    ];
    for (const a of attrs) {
      const hit = firstJobId(el.getAttribute?.(a));
      if (hit) return hit;
    }
    return "";
  }

  function idFromDom(doc = document) {
    const selected =
      doc.querySelector('[aria-selected="true"]') ||
      doc.querySelector('[aria-current="true"]') ||
      doc.querySelector("[data-selected='true']") ||
      doc.querySelector("[class*='selected'][class*='job']");
    const fromSelected = attrJobId(selected) || firstJobId(selected?.getAttribute?.("href"));
    if (fromSelected) return fromSelected;

    const nodes = doc.querySelectorAll(
      "[data-job-id], [data-object-id], [data-objectid], a[href*='___'], [id*='___']"
    );
    for (const el of nodes) {
      const hit =
        attrJobId(el) ||
        firstJobId(el.getAttribute?.("href"), el.getAttribute?.("id"), el.textContent);
      if (hit) return hit;
    }
    return (
      firstJobId(doc.documentElement?.innerHTML?.slice?.(0, 250000)) ||
      firstJobId(String(doc.documentElement?.innerHTML || "").slice(-250000))
    );
  }

  function hiringCafeJobId(doc = document, hints = {}) {
    return (
      firstJobId(hints.jobId || hints.hiringCafeJobId) ||
      idFromUrl() ||
      idFromNextData(doc) ||
      idFromHistory() ||
      idFromPerformance() ||
      idFromDom(doc)
    );
  }

  function applyHrefFromDom(doc = document) {
    const buttons = Array.from(
      doc.querySelectorAll("a[href], button[data-href], a[data-url]")
    );
    for (const el of buttons) {
      const label = H.elementText(el);
      if (!/^(apply|apply now|easy apply|view job)$/i.test(label) && !/apply/i.test(label)) {
        continue;
      }
      const href = el.getAttribute("href") || el.getAttribute("data-href") || el.getAttribute("data-url") || "";
      if (/^https?:\/\//i.test(href) && !/hiring\.?cafe/i.test(href)) return href;
    }
    const ext = doc.querySelector('a[href^="http"]:not([href*="hiringcafe"]):not([href*="hiring.cafe"])');
    return ext?.href || "";
  }

  function scrapeHiringCafeDom(doc = document) {
    const panel =
      doc.querySelector('[class*="JobDetail"]') ||
      doc.querySelector('[class*="job-detail"]') ||
      doc.querySelector('[class*="JobSidebar"]') ||
      doc.querySelector('[class*="job-sidebar"]') ||
      doc.querySelector('[class*="JobPanel"]') ||
      doc.querySelector('[class*="drawer"]') ||
      doc.querySelector("aside") ||
      doc.querySelector('[role="dialog"]') ||
      doc.querySelector("article") ||
      doc.body;
    const titleEl =
      panel.querySelector("h1") ||
      panel.querySelector("h2") ||
      panel.querySelector('[class*="job-title"]') ||
      panel.querySelector('[class*="JobTitle"]') ||
      doc.querySelector("h1");
    const companyEl =
      panel.querySelector('[class*="company"] a') ||
      panel.querySelector('[class*="CompanyName"]') ||
      panel.querySelector('[class*="company-name"]') ||
      panel.querySelector("h2, h3");
    const locEl =
      panel.querySelector('[class*="location"]') ||
      panel.querySelector('[class*="JobLocation"]');
    const descEl =
      panel.querySelector('[class*="JobDescription"]') ||
      panel.querySelector('[class*="job-description"]') ||
      panel.querySelector('[class*="description"]') ||
      panel.querySelector('[class*="Prose"]') ||
      panel.querySelector("article") ||
      panel.querySelector("[class*='rich-text']");
    let descriptionHtml = String(descEl?.innerHTML || "").trim();
    if (!descriptionHtml && panel && panel !== doc.body) {
      descriptionHtml = String(panel.innerHTML || "").trim();
    }
    return {
      jobTitle: H.elementText(titleEl),
      companyName: H.elementText(companyEl),
      jobLocation: H.elementText(locEl),
      applyLink: applyHrefFromDom(panel) || applyHrefFromDom(doc),
      descriptionHtml
    };
  }

  function compensationFromProcessed(processed = {}) {
    const yearlyMin = processed.yearly_min_compensation ?? processed.yearlyMinCompensation;
    const yearlyMax = processed.yearly_max_compensation ?? processed.yearlyMaxCompensation;
    if (yearlyMin != null || yearlyMax != null) {
      return {
        salaryMin: yearlyMin != null ? String(yearlyMin) : "",
        salaryMax: yearlyMax != null ? String(yearlyMax) : ""
      };
    }
    return { salaryMin: "", salaryMax: "" };
  }

  function workplaceFromProcessed(processed = {}) {
    const raw = String(processed.workplace_type || processed.workplaceType || "").trim();
    if (/remote/i.test(raw)) return "Remote";
    if (/hybrid/i.test(raw)) return "Hybrid";
    if (/on[-\s]?site|onsite/i.test(raw)) return "On-site";
    return "";
  }

  function commitmentFromProcessed(processed = {}) {
    const raw = processed.commitment;
    const first = Array.isArray(raw) ? raw[0] : raw;
    return H.normalizeEmploymentType(first || "");
  }

  function parseHiringCafeJob(payload, { fallbackUrl = "", dom = null } = {}) {
    const job =
      payload?.job && typeof payload.job === "object"
        ? payload.job
        : payload?.data?.job && typeof payload.data.job === "object"
          ? payload.data.job
          : payload;
    if (!job || typeof job !== "object") return null;

    const info = job.job_information || job.jobInformation || {};
    const processed = job.v5_processed_job_data || job.processed_job_data || {};
    const companyObj = job.v5_processed_company_data || job.processed_company_data || {};
    const html = String(
      info.description || info.content || job.description || dom?.descriptionHtml || ""
    ).trim();
    const jdText = H.htmlToPlainText(html);
    if (!jdText && !info.title && !dom?.jobTitle) return null;

    const fromJd = H.salaryBoundsFromText(jdText);
    const fromProcessed = compensationFromProcessed(processed);
    const id = String(job.id || job.objectID || job.requisition_id || "").trim();
    const applyUrl = String(job.apply_url || job.applyUrl || job.url || "").trim();
    const loc = String(
      processed.formatted_workplace_location ||
        processed.formattedWorkplaceLocation ||
        (Array.isArray(processed.workplace_cities) ? processed.workplace_cities[0] : "") ||
        ""
    ).trim();

    const jobTitle =
      String(info.title || processed.core_job_title || processed.coreJobTitle || "").trim() ||
      String(dom?.jobTitle || "").trim() ||
      H.inferTitleFromJd(jdText);
    const companyName =
      String(companyObj.name || processed.company_name || processed.companyName || "").trim() ||
      String(dom?.companyName || "").trim() ||
      H.inferCompanyFromJd(jdText);

    return {
      jobId: id,
      jobTitle,
      companyName,
      jdLink: applyUrl || fallbackUrl || H.canonicalPageUrl(),
      jdText,
      applyLink: applyUrl || String(dom?.applyLink || "").trim(),
      workArrangement:
        workplaceFromProcessed(processed) ||
        H.inferRemoteFromText(`${loc} ${jdText}`) ||
        "",
      employmentType: commitmentFromProcessed(processed) || H.inferEmploymentFromJd(jdText),
      salaryMin: fromProcessed.salaryMin || fromJd.salaryMin,
      salaryMax: fromProcessed.salaryMax || fromJd.salaryMax,
      datePosted: String(processed.estimated_publish_date || job.created_at || "").trim(),
      jobLocation: loc || String(dom?.jobLocation || "").trim() || H.inferLocationFromJd(jdText),
      source: "hiringcafe"
    };
  }

  function jobPayloadFromNextData(doc = document) {
    const raw = doc.getElementById("__NEXT_DATA__")?.textContent || "";
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      const job = data?.props?.pageProps?.job;
      if (job && typeof job === "object") return { job };
    } catch {
      /* ignore */
    }
    return null;
  }

  async function fetchJobDescription(id) {
    if (!id) return null;
    const url = `${originBase()}/api/job-description?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!res.ok) return null;
    return res.json();
  }

  async function waitForJobId(tries = 8, hints = {}) {
    for (let i = 0; i < tries; i += 1) {
      const id = hiringCafeJobId(document, hints);
      if (id) return id;
      await new Promise((r) => setTimeout(r, 250));
    }
    return hiringCafeJobId(document, hints);
  }

  async function scrapeHiringCafe(hints = {}) {
    const dom = scrapeHiringCafeDom();
    const id = await waitForJobId(8, hints);
    let apiJob = null;
    if (id) {
      try {
        apiJob = await fetchJobDescription(id);
      } catch {
        apiJob = null;
      }
    }

    const parsed =
      parseHiringCafeJob(apiJob, {
        fallbackUrl: H.canonicalPageUrl(),
        dom
      }) ||
      parseHiringCafeJob(jobPayloadFromNextData(), {
        fallbackUrl: H.canonicalPageUrl(),
        dom
      }) ||
      parseHiringCafeJob(
        {
          job: {
            id,
            job_information: {
              title: dom.jobTitle,
              description: dom.descriptionHtml
            }
          }
        },
        { fallbackUrl: H.canonicalPageUrl(), dom }
      );
    const data = H.mergeJobData(parsed, {
      jobTitle: dom.jobTitle,
      companyName: dom.companyName,
      jobLocation: dom.jobLocation,
      applyLink: dom.applyLink,
      source: "hiringcafe",
      jobId: id
    });

    if (data && (data.jobTitle || data.jdText)) return data;
    return null;
  }

  Ocean.register({
    id: "hiringcafe",
    label: "HiringCafe",
    hosts: [/(^|\.)hiringcafe\.com$/i, /(^|\.)hiring\.cafe$/i],
    scrape: scrapeHiringCafe
  });
})();
