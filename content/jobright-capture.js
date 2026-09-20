/**
 * JobRight batch capture — recommend/search API using the user's Chrome session.
 * Injected on demand by the service worker (and safe to re-inject).
 */
(() => {
  if (window.__resumeBotJobrightCaptureLoaded) return;
  window.__resumeBotJobrightCaptureLoaded = true;

  const SALESFORCE_RE = /\bSalesforce\b/i;
  const SALESFORCE_EMPLOYER_RE = /^\s*salesforce(?:\.com|,?\s*inc\.?)?\s*$/i;
  const RECENT_DAYS = 3;

  function containsSalesforce(title, description) {
    return (
      SALESFORCE_RE.test(String(title || "")) ||
      SALESFORCE_RE.test(String(description || ""))
    );
  }

  function isSalesforceEmployer(organization) {
    return SALESFORCE_EMPLOYER_RE.test(String(organization || "").trim());
  }

  function isRemoteArrangement(workArrangement) {
    const w = String(workArrangement || "").toLowerCase();
    if (/hybrid/.test(w)) return false;
    if (/on[-\s]?site|onsite|in[-\s]?office|in[-\s]?person/.test(w)) return false;
    return true;
  }

  function parsePostedDate(value, now = new Date()) {
    if (value == null || value === "") return null;
    if (typeof value === "number" || /^\d+$/.test(String(value).trim())) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;
      const ms = String(Math.trunc(n)).length <= 10 ? n * 1000 : n;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(value).trim().toLowerCase();
    if (/(^|\b)(just posted|today|moments? ago|minutes? ago|hours? ago|<\s*1\s*day)/.test(s)) {
      return now;
    }
    if (/\byesterday\b/.test(s)) return new Date(now.getTime() - 864e5);
    const rel = s.match(/(\d+)\+?\s*(hour|day|week|month|year)s?\s*ago/);
    if (rel) {
      const unit = { hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[rel[2]];
      return new Date(now.getTime() - Number(rel[1]) * unit);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }

  function isWithinRecentDays(value, days, now = new Date()) {
    const d = parsePostedDate(value, now);
    if (!d) return null;
    const age = now.getTime() - d.getTime();
    if (age < 0) return true;
    return age <= days * 864e5;
  }

  function buildDescription(jr) {
    const parts = [];
    if (jr.jobSummary) parts.push(String(jr.jobSummary).trim());
    if (Array.isArray(jr.coreResponsibilities) && jr.coreResponsibilities.length) {
      parts.push("Responsibilities:\n- " + jr.coreResponsibilities.join("\n- "));
    }
    if (Array.isArray(jr.requirements) && jr.requirements.length) {
      parts.push("Requirements:\n- " + jr.requirements.join("\n- "));
    }
    return parts.join("\n\n").trim();
  }

  function parseSalary(salaryDesc) {
    const s = String(salaryDesc || "");
    const nums = [...s.matchAll(/\$?\s*([\d.]+)\s*K/gi)].map((m) =>
      Math.round(Number(m[1]) * 1000)
    );
    if (nums.length >= 2) return { min: String(nums[0]), max: String(nums[1]), unit: "YEAR" };
    if (nums.length === 1) return { min: String(nums[0]), max: "", unit: "YEAR" };
    return { min: "", max: "", unit: "" };
  }

  function mapItem(item) {
    const jr = item?.jobResult || {};
    const company = item?.companyResult || {};
    if (!jr.jobId) return null;
    const salary = parseSalary(jr.salaryDesc);
    const url = `https://jobright.ai/jobs/info/${jr.jobId}`.split("?")[0];
    const postedAbs =
      parsePostedDate(jr.publishTime) || parsePostedDate(jr.publishTimeDesc);
    const datePosted = postedAbs
      ? postedAbs.toISOString().slice(0, 10)
      : String(jr.publishTime || jr.publishTimeDesc || "");
    return {
      id: `jobright_${jr.jobId}`,
      title: jr.jobTitle || jr.jobNlpTitle || "",
      organization: company.companyName || "",
      location: jr.jobLocation || (jr.jobLocations || [])[0] || "",
      work_arrangement: jr.workModel || (jr.isRemote ? "Remote" : ""),
      employment_type: jr.employmentType || "",
      salary_min: salary.min || (jr.minSalary != null ? String(jr.minSalary) : ""),
      salary_max: salary.max || (jr.maxSalary != null ? String(jr.maxSalary) : ""),
      key_skills: "",
      source: "jobright",
      date_posted: datePosted,
      url,
      description: buildDescription(jr),
      _applyLink: String(jr.applyLink || jr.originalUrl || "")
    };
  }

  function isLinkedinApply(mapped) {
    const link = String(mapped._applyLink || "");
    const url = String(mapped.url || "");
    return /linkedin\.com/i.test(link) || /linkedin\.com/i.test(url);
  }

  function isSalesforceJob(mapped) {
    if (isSalesforceEmployer(mapped.organization)) return false;
    return containsSalesforce(mapped.title, mapped.description);
  }

  async function fetchRecommendJobs(query, count = 50) {
    const value = query || "Salesforce";
    const body = {
      searchType: "job_title",
      value,
      jobTaxonomyList: [{ taxonomyId: "00-00-00", title: value }],
      country: "US",
      jobTypes: [],
      seniority: [],
      workModel: [],
      locations: [],
      companies: [],
      isH1BOnly: false,
      companyCategory: null,
      annualSalaryMinimum: null,
      roleType: null,
      companyStages: null,
      skills: [],
      excludedCompanies: [],
      excludedSkills: null,
      excludeStaffingAgency: false,
      minYearsOfExperienceRange: null,
      excludeCompanyCategory: [],
      excludeSecurityClearance: false,
      excludeUsCitizen: false,
      refresh: true,
      position: 0,
      sortCondition: 0
    };
    const url =
      `https://jobright.ai/swan/recommend/search?searchType=job_title` +
      `&refresh=true&count=${count}&position=0&sortCondition=0`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*"
      },
      body: JSON.stringify(body),
      credentials: "include"
    });
    if (!res.ok) throw new Error(`recommend/search HTTP ${res.status}`);
    const json = await res.json();
    return {
      list: json?.result?.jobList || [],
      jobNum: json?.result?.jobNum,
      success: !!json?.success
    };
  }

  async function fetchAppliedJobIds() {
    const ids = new Set();
    let cursor = null;
    for (let i = 0; i < 20; i += 1) {
      let res;
      try {
        res = await fetch("https://jobright.ai/swan/job/applied/jobs-v3", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
            "x-client-type": "web"
          },
          body: JSON.stringify({ cursor, pageSize: 50, applyStatus: 0 }),
          credentials: "include"
        });
      } catch {
        break;
      }
      if (!res.ok) break;
      const json = await res.json().catch(() => null);
      const result = json?.result || {};
      const list = Array.isArray(result.list) ? result.list : [];
      for (const it of list) {
        const jobId = it?.jobResult?.jobId || it?.jobId;
        if (jobId) ids.add(`jobright_${jobId}`);
      }
      if (!result.hasMore || !result.cursor) break;
      cursor = result.cursor;
    }
    return ids;
  }

  async function scrapeAutofillJobs(query) {
    const { list, jobNum, success } = await fetchRecommendJobs(query, 50);
    const appliedIds = await fetchAppliedJobIds();

    const kept = [];
    let skippedLinkedin = 0;
    let skippedApplied = 0;
    let skippedStale = 0;

    for (const item of list) {
      const mapped = mapItem(item);
      if (!mapped) continue;
      if (appliedIds.has(mapped.id)) {
        skippedApplied += 1;
        continue;
      }
      if (isLinkedinApply(mapped)) {
        skippedLinkedin += 1;
        continue;
      }
      if (!isRemoteArrangement(mapped.work_arrangement)) continue;
      if (!isSalesforceJob(mapped)) continue;
      if (isWithinRecentDays(mapped.date_posted, RECENT_DAYS) === false) {
        skippedStale += 1;
        continue;
      }
      delete mapped._applyLink;
      kept.push(mapped);
    }

    return {
      ok: true,
      jobs: kept,
      stats: {
        apiCount: list.length,
        jobNum: jobNum ?? null,
        apiOk: success,
        kept: kept.length,
        skippedLinkedin,
        skippedApplied,
        skippedStale,
        appliedTotal: appliedIds.size,
        href: location.href
      }
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "SCRAPE_JOBRIGHT_BATCH") return;
    scrapeAutofillJobs(msg.query || "Salesforce")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err), jobs: [] }));
    return true;
  });
})();
